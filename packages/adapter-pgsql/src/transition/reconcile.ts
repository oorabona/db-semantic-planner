import { createHash } from 'node:crypto';
import {
	acquireExclusiveTransitionLease,
	assumptionAccepted,
	canonicalJson,
	canonicalJsonDigest,
	outcomeClaimId,
	projectLedgerChain,
	resourceScopeCovers,
	transitionPlanDigest,
} from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerHome,
	LedgerPayload,
	LedgerReservationRow,
	OutcomeIndeterminateRecoveryEvidence,
	ResourceAddress,
} from '@dbsp/types';
import { sameLedgerAddress } from '@dbsp/types';
import type { Pool } from 'pg';
import { readPgLedgerAddressChain } from './chain-reader.js';
import {
	assertPgDatabaseWritable,
	isPgDatabaseReadOnlyError,
} from './database-writability.js';
import { readTransitionJournal } from './journal.js';
import { readPgLedgerReservationsForExecution } from './ledger.js';
import { withPgTransitionRunLock } from './lessor.js';
import { assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid } from './operations/create-unique-index-concurrently.js';
import { recoverPgOutcomeClaim } from './outcome-protocol.js';
import { recoverPgReaddressPair } from './readdress.js';
import {
	type PgLedgerScopeCurrency,
	readPgLedgerScopeCurrency,
	readVerifiedPgLedgerReservationsForPair,
} from './reinitialize-preflight.js';

export type PgReconcileRecoveryOutcome =
	| 'appended'
	| 'already-appended'
	| 'indeterminate-appended'
	| 'no-open-claim'
	| 'pending'
	| 'blocked'
	| 'malformed-chain'
	| 'protocol-refused'
	| 'transport-ambiguous'
	| 'refused-pair'
	| 'indeterminate-pair';

export type PgReconcileRecoveryFailureCause =
	| 'catalogue'
	| 'malformed-journal'
	| 'transport';

/** One ordered recovery attempt; diagnostics are raw and presentation-free. */
export interface PgReconcileRecoveryReport {
	readonly address: LedgerAddress;
	readonly outcome: PgReconcileRecoveryOutcome;
	readonly reason?: string;
	readonly pairId?: string;
	readonly failureCause?: PgReconcileRecoveryFailureCause;
}

/** The selected semantic refusal condition, never a CLI refusal document. */
export type PgReconcileSelectedIssue =
	| {
			readonly kind: 'ledger-not-current';
			readonly currency: Exclude<
				PgLedgerScopeCurrency,
				{ readonly kind: 'current' }
			>;
			readonly affectedAddresses: readonly LedgerAddress[];
	  }
	| {
			readonly kind: 'database-read-only';
			readonly reason: string;
			readonly affectedAddresses: readonly LedgerAddress[];
	  }
	| {
			readonly kind: 'catalogue-unavailable';
			readonly address: LedgerAddress;
	  }
	| {
			readonly kind: 'malformed-chain';
			readonly address: LedgerAddress;
	  };

interface PgReconcileBaseResult {
	readonly runId: string;
	readonly addresses: readonly ResourceAddress[];
	readonly recovery?: readonly PgReconcileRecoveryReport[];
	readonly selectedIssue?: PgReconcileSelectedIssue;
}

export type PgReconcileTransitionRunResult =
	| (PgReconcileBaseResult & {
			readonly kind: 'completed';
	  })
	| (PgReconcileBaseResult & {
			readonly kind: 'unresolved';
	  })
	| (PgReconcileBaseResult & {
			readonly kind: 'selection-unavailable';
			readonly detail?: string;
	  })
	| (PgReconcileBaseResult & {
			readonly kind: 'database-read-only';
			readonly selectedIssue: Extract<
				PgReconcileSelectedIssue,
				{ readonly kind: 'database-read-only' }
			>;
	  })
	| {
			readonly kind: 'busy';
			readonly runId: string;
			readonly addresses: readonly ResourceAddress[];
	  };

export type PgReconcileFailureStage = 'reconcile' | 'journal' | 'catalogue';

/** A read/recovery failure whose original cause remains available to callers. */
export class PgReconcileTransitionRunError extends Error {
	constructor(
		readonly stage: PgReconcileFailureStage,
		readonly originalCause: unknown,
	) {
		super('PostgreSQL transition-run reconciliation failed', {
			cause: originalCause,
		});
		this.name = 'PgReconcileTransitionRunError';
	}
}

function ledgerHome(address: LedgerAddress): LedgerHome {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema)
		throw new Error(
			`schema-scoped managed claim ${address.name} has no schema`,
		);
	return { scope: 'schema', schema: address.schema };
}

/** Canonicalizes catalogue identity for an outcome resolution payload. */
export function recoveryPayload(
	identity: Parameters<
		NonNullable<Parameters<typeof recoverPgOutcomeClaim>[1]['readBack']>
	>[2],
): LedgerPayload {
	const value = JSON.parse(
		canonicalJson({
			...(identity === undefined ? {} : { catalogueIdentity: identity }),
		}),
	) as LedgerPayload['value'];
	return { value, digest: canonicalJsonDigest(value) };
}

function recoveryReport(
	address: LedgerAddress,
	result: Awaited<ReturnType<typeof recoverPgOutcomeClaim>>,
): PgReconcileRecoveryReport {
	if (result.kind === 'outcome-recovery-appended') {
		const indeterminate =
			result.classification.resolution.eventKind === 'indeterminate';
		return {
			address,
			outcome: indeterminate
				? 'indeterminate-appended'
				: result.append.kind === 'already-appended-outcome-resolution'
					? 'already-appended'
					: 'appended',
			reason: result.classification.resolution.reason,
		};
	}
	if (result.kind === 'outcome-recovery-no-open-claim')
		return { address, outcome: 'no-open-claim' };
	if (result.kind === 'outcome-recovery-pending')
		return {
			address,
			outcome: 'pending',
			reason: result.reason,
			...(result.reasonCode === 'catalogue-unavailable'
				? { failureCause: 'catalogue' as const }
				: {}),
		};
	if (result.kind === 'outcome-recovery-blocked')
		return { address, outcome: 'blocked', reason: result.reason };
	if (result.kind === 'outcome-recovery-malformed-chain')
		return {
			address,
			outcome: 'malformed-chain',
			reason: result.reason,
			failureCause: 'malformed-journal',
		};
	if (result.kind === 'outcome-transport-ambiguous')
		return {
			address,
			outcome: 'transport-ambiguous',
			reason: result.reason,
			failureCause: 'transport',
		};
	return { address, outcome: 'protocol-refused', reason: result.reason };
}

function readdressRecoveryReport(
	reservations: readonly LedgerReservationRow[],
	result: Awaited<ReturnType<typeof recoverPgReaddressPair>>,
): PgReconcileRecoveryReport {
	const first = reservations[0];
	if (!first) throw new Error('re-address recovery has no reservation');
	if (result.kind === 'readdress-recovery-refused-pair')
		return {
			address: first.address,
			outcome: 'refused-pair',
			pairId: result.pairId,
		};
	if (result.kind === 'readdress-recovery-indeterminate-pair')
		return {
			address: first.address,
			outcome: 'indeterminate-pair',
			reason: result.reason,
			pairId: result.pairId,
		};
	if (result.kind === 'readdress-recovery-transport-ambiguous-pair')
		return {
			address: first.address,
			outcome: 'transport-ambiguous',
			reason: result.reason,
			failureCause: 'transport',
			pairId: result.pairId,
		};
	return {
		address: first.address,
		outcome: 'pending',
		reason: result.reason,
		pairId: result.pairId,
	};
}

function isUnresolvedRecoveryOutcome(
	report: PgReconcileRecoveryReport,
): boolean {
	return [
		'pending',
		'blocked',
		'malformed-chain',
		'protocol-refused',
		'transport-ambiguous',
		'no-open-claim',
		'indeterminate-appended',
		'indeterminate-pair',
	].includes(report.outcome);
}

function selectedRecoveryIssue(
	reports: readonly PgReconcileRecoveryReport[],
): PgReconcileSelectedIssue | undefined {
	for (const report of reports) {
		if (report.failureCause === 'malformed-journal')
			return { kind: 'malformed-chain', address: report.address };
		if (report.failureCause === 'catalogue')
			return { kind: 'catalogue-unavailable', address: report.address };
	}
	return undefined;
}

function statementBundleDigest(
	statements: readonly { readonly ordinal: number; readonly sql: string }[],
): string {
	return createHash('sha256')
		.update(
			JSON.stringify(statements.map(({ ordinal, sql }) => [ordinal, sql])),
		)
		.digest('hex');
}

function recoveryEvidenceForClaim(input: {
	readonly journal: Awaited<ReturnType<typeof readTransitionJournal>>;
	readonly row: LedgerReservationRow;
	readonly plannedClaimKey: string;
	readonly stableStateBeforeClaim: 'unknown' | 'managed' | 'absent';
}): OutcomeIndeterminateRecoveryEvidence | undefined {
	if (transitionPlanDigest(input.journal.plan) !== input.journal.run.planDigest)
		return undefined;
	const step = input.journal.plan.steps.find(
		(candidate) =>
			candidate.managedClaim?.plannedClaimKey === input.plannedClaimKey,
	);
	const claim = step?.managedClaim;
	if (
		!step ||
		!claim ||
		!sameLedgerAddress(claim.address, input.row.address) ||
		outcomeClaimId(
			input.row.executionId,
			input.plannedClaimKey,
			input.row.address,
		) !== input.row.rootClaimId
	)
		return undefined;
	const binding = step.guards.find(
		(guard) =>
			guard.protocol.binding.kind === 'external-ddl-exclusion' &&
			resourceScopeCovers(guard.protocol.binding.scope, [input.row.address]),
	)?.protocol.binding;
	if (binding?.kind !== 'external-ddl-exclusion') return undefined;
	const assumption = input.journal.plan.assumptions.find(
		(candidate) =>
			candidate.id === binding.assumption &&
			candidate.class === 'external-ddl-exclusion' &&
			step.restsOnAssumptions.includes(candidate.id) &&
			resourceScopeCovers(candidate.scope, [input.row.address]),
	);
	if (!assumption) return undefined;
	const accepted = input.journal.authorizations?.some((authorization) => {
		const grant = authorization.grants.find(
			(candidate) => candidate.assumptionId === assumption.id,
		);
		if (!grant) return false;
		const acceptance = authorization.policy[grant.grant];
		return (
			acceptance !== undefined &&
			assumptionAccepted(assumption, { accepts: [acceptance] })
		);
	});
	if (!accepted) return undefined;
	const bundleDigest = statementBundleDigest(claim.statementBundle.statements);
	return {
		runId: input.journal.run.runId,
		planDigest: input.journal.run.planDigest,
		executionId: input.row.executionId,
		claimId: input.row.rootClaimId,
		plannedClaimKey: input.plannedClaimKey,
		admittedBundleDigest: bundleDigest,
		persistedBundleDigest: bundleDigest,
		recordedPreState: input.stableStateBeforeClaim,
		externalDdlExclusion: {
			planDigest: input.journal.run.planDigest,
			address: input.row.address,
			trustRoot: JSON.stringify(assumption.asserter),
		},
	};
}

/**
 * Returns recovery decisions for one durable run without reissuing DDL.
 *
 * Reconciliation keeps the run-lock session while `recoverPgOutcomeClaim`
 * acquires its own outcome session. The supplied pool must allow at least two
 * concurrent connections: a pool with `max: 1` waits forever under the lock.
 */
export async function reconcilePgTransitionRun(
	pool: Pool,
	runId: string,
): Promise<PgReconcileTransitionRunResult> {
	let stage: PgReconcileFailureStage = 'reconcile';
	try {
		const locked = await withPgTransitionRunLock(
			pool,
			runId,
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					stage = 'journal';
					const journal = await readTransitionJournal(lease.session, runId, {
						ensure: false,
					});
					stage = 'reconcile';
					const material: Array<{
						readonly address: LedgerAddress;
						readonly plannedClaimKey?: string;
					}> = journal.plan.steps
						.map((step) => {
							const generatedStep = step as {
								readonly address?: LedgerAddress;
								readonly plannedClaimKeys?: readonly string[];
							};
							const generated = generatedStep.address;
							return (
								step.managedClaim ??
								(generated === undefined
									? undefined
									: {
											address: generated,
											...(generatedStep.plannedClaimKeys?.[0] === undefined
												? {}
												: {
														plannedClaimKey: generatedStep.plannedClaimKeys[0],
													}),
										})
							);
						})
						.filter(
							(claim): claim is NonNullable<typeof claim> =>
								claim !== undefined,
						);
					try {
						await assertPgDatabaseWritable(lease.session);
					} catch (error) {
						if (isPgDatabaseReadOnlyError(error)) {
							const addresses = material.map((claim) => claim.address);
							return {
								kind: 'database-read-only' as const,
								runId,
								addresses,
								selectedIssue: {
									kind: 'database-read-only' as const,
									reason: error.message,
									affectedAddresses: addresses,
								},
							};
						}
						throw error;
					}
					if (material.length === 0)
						return {
							kind: 'selection-unavailable' as const,
							runId,
							addresses:
								journal.plan.declarations?.declarations.map(
									(declaration) => declaration.address,
								) ?? [],
						};
					const homes = new Map<string, LedgerHome>();
					for (const claim of material) {
						const home = ledgerHome(claim.address);
						homes.set(`${home.scope}:${home.schema ?? ''}`, home);
					}
					for (const home of homes.values()) {
						const currency = await readPgLedgerScopeCurrency(
							lease.session,
							home,
						);
						if (currency.kind === 'current') continue;
						const affectedAddresses = material
							.filter((claim) => {
								const claimHome = ledgerHome(claim.address);
								return (
									claimHome.scope === home.scope &&
									claimHome.schema === home.schema
								);
							})
							.map((claim) => claim.address);
						return {
							kind: 'unresolved' as const,
							runId,
							addresses: affectedAddresses,
							recovery: affectedAddresses.map((address) => ({
								address,
								outcome: 'blocked' as const,
								reason:
									currency.kind === 'not-current'
										? currency.reason
										: currency.kind,
							})),
							selectedIssue: {
								kind: 'ledger-not-current' as const,
								currency,
								affectedAddresses,
							},
						};
					}
					const executionIds = executionIdsForRun(journal);
					const reservations = (
						await Promise.all(
							[...homes.values()].flatMap((home) =>
								executionIds.map((executionId) =>
									readPgLedgerReservationsForExecution(
										lease.session,
										home,
										executionId,
									),
								),
							),
						)
					).flat();
					if (reservations.length === 0)
						return {
							kind: 'selection-unavailable' as const,
							runId,
							addresses: material.map((claim) => claim.address),
						};
					const readdressPairs = new Map<string, LedgerReservationRow[]>();
					const byRoot = new Map<string, LedgerReservationRow[]>();
					for (const row of reservations) {
						if (
							row.claimKind === 'readdress-intent' &&
							row.pairId !== undefined
						) {
							const pairKey = `${row.executionId}:${row.pairId}`;
							readdressPairs.set(pairKey, [
								...(readdressPairs.get(pairKey) ?? []),
								row,
							]);
							continue;
						}
						byRoot.set(row.rootClaimId, [
							...(byRoot.get(row.rootClaimId) ?? []),
							row,
						]);
					}
					const recovery: PgReconcileRecoveryReport[] = [];
					for (const pairRows of readdressPairs.values()) {
						const pairId = pairRows[0]?.pairId;
						const executionId = pairRows[0]?.executionId;
						if (!pairId || !executionId) continue;
						const closure = await readVerifiedPgLedgerReservationsForPair(
							lease.session,
							pairId,
							[...homes.values()],
						);
						const recovered = await recoverPgReaddressPair(lease.session, {
							pairId,
							executionId,
							reservations: closure,
						});
						recovery.push(readdressRecoveryReport(closure, recovered));
					}
					for (const rows of byRoot.values()) {
						const rootClaimId = rows[0]?.rootClaimId;
						if (!rootClaimId) continue;
						if (
							rows.some(
								(row) =>
									!executionIds.includes(row.executionId) ||
									row.rootClaimId !== rootClaimId,
							)
						)
							return {
								kind: 'selection-unavailable' as const,
								runId,
								addresses: rows.map((row) => row.address),
								detail: `reservation disagreement for root claim ${rootClaimId}`,
							};
						const rootCandidates: Array<{
							readonly row: LedgerReservationRow;
							readonly plannedClaimKey?: string;
							readonly stableStateBeforeClaim: 'unknown' | 'managed' | 'absent';
						}> = [];
						for (const row of rows) {
							stage = 'catalogue';
							const chain = await readPgLedgerAddressChain(
								lease.session,
								ledgerHome(row.address),
								row.address,
							);
							stage = 'reconcile';
							const projection = projectLedgerChain(chain);
							if (
								projection.kind !== 'projected-ledger-chain' ||
								projection.openClaim === undefined
							)
								continue;
							const open = projection.openClaim.event;
							const openRoot = open.rootClaimId ?? open.eventId;
							if (
								open.executionId !== row.executionId ||
								openRoot !== rootClaimId
							)
								return {
									kind: 'selection-unavailable' as const,
									runId,
									addresses: rows.map((item) => item.address),
									detail: `open chain member disagrees with reservation root ${rootClaimId}`,
								};
							if (open.eventId === rootClaimId)
								rootCandidates.push({
									row,
									stableStateBeforeClaim:
										projection.openClaim.stableStateBeforeClaim,
									...(open.plannedClaimKey === undefined
										? {}
										: { plannedClaimKey: open.plannedClaimKey }),
								});
						}
						if (rootCandidates.length !== 1)
							return {
								kind: 'selection-unavailable' as const,
								runId,
								addresses: rows.map((row) => row.address),
								detail: `execution ${runId} has ${rootCandidates.length} open root members for ${rootClaimId}`,
							};
						const selected = rootCandidates[0];
						if (!selected) continue;
						if (
							!selected.plannedClaimKey ||
							!material.some(
								(claim) => claim.plannedClaimKey === selected.plannedClaimKey,
							)
						)
							return {
								kind: 'selection-unavailable' as const,
								runId,
								addresses: rows.map((row) => row.address),
								detail: `open root ${rootClaimId} has no matching persisted managed step`,
							};
						const step = journal.plan.steps.find(
							(candidate) =>
								candidate.managedClaim?.plannedClaimKey ===
									selected.plannedClaimKey ||
								('plannedClaimKeys' in candidate &&
									Array.isArray(candidate.plannedClaimKeys) &&
									candidate.plannedClaimKeys.includes(
										selected.plannedClaimKey,
									)),
						);
						const operationReadBack =
							step?.operation?.operationKind.name ===
							'CreateUniqueIndexConcurrently'
								? async (
										executor: Parameters<
											typeof assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid
										>[0],
										_address: LedgerAddress,
										identity: Parameters<typeof recoveryPayload>[0],
									) => {
										await assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid(
											executor,
											step.operation,
										);
										return {
											observed: recoveryPayload(identity),
											effect: 'unverifiable' as const,
										};
									}
								: undefined;
						const indeterminateEvidence = recoveryEvidenceForClaim({
							journal,
							row: selected.row,
							plannedClaimKey: selected.plannedClaimKey,
							stableStateBeforeClaim: selected.stableStateBeforeClaim,
						});
						for (const row of rows) {
							const isRoot = sameLedgerAddress(
								row.address,
								selected.row.address,
							);
							const recovered = await recoverPgOutcomeClaim(pool, {
								address: row.address,
								reservations: [row],
								resolutionEventId: isRoot
									? `${rootClaimId}:reconcile:${runId}`
									: `${rootClaimId}:reconcile:${runId}:${row.address.kind}:${row.address.name}`,
								acceptedExternalDdlExclusion:
									isRoot && indeterminateEvidence !== undefined,
								resolveIndeterminate: true,
								readBack: async (_executor, _address, identity) =>
									recoveryPayload(identity),
								...(isRoot && indeterminateEvidence !== undefined
									? { indeterminateEvidence }
									: {}),
								...(isRoot && operationReadBack !== undefined
									? { operationReadBack }
									: {}),
							});
							recovery.push(recoveryReport(row.address, recovered));
						}
					}
					const unresolved = recovery.some(isUnresolvedRecoveryOutcome);
					const issue = selectedRecoveryIssue(recovery);
					return unresolved
						? {
								kind: 'unresolved' as const,
								runId,
								addresses: reservations.map((item) => item.address),
								recovery,
								...(issue === undefined ? {} : { selectedIssue: issue }),
							}
						: {
								kind: 'completed' as const,
								runId,
								addresses: reservations.map((item) => item.address),
								recovery,
							};
				} finally {
					await lease.release();
				}
			},
		);
		if (locked.kind === 'busy') return { kind: 'busy', runId, addresses: [] };
		return locked.value;
	} catch (error) {
		throw new PgReconcileTransitionRunError(stage, error);
	}
}

/** Finds every execution id durably attributable to one transition run. */
export function executionIdsForRun(
	journal: Awaited<ReturnType<typeof readTransitionJournal>>,
): readonly string[] {
	const executionIds = new Set<string>([journal.run.runId]);
	for (const event of journal.events) {
		const record = event.record;
		if (
			event.event === 'intent' &&
			'executionId' in record &&
			typeof record.executionId === 'string'
		)
			executionIds.add(record.executionId);
		if (
			event.event === 'observed' &&
			'intent' in record &&
			record.intent &&
			typeof record.intent.executionId === 'string'
		)
			executionIds.add(record.intent.executionId);
	}
	if ('generator' in journal.plan)
		executionIds.add(`dbsp.generator.execution.${journal.run.runId}`);
	return [...executionIds];
}
