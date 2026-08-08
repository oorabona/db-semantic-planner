/** Resolve only the open managed claims durably linked to one run. */
import { createHash } from 'node:crypto';
import {
	assertPgDatabaseWritable,
	createPgTransitionPack,
	isPgDatabaseReadOnlyError,
	readPgLedgerReservationsForExecution,
	readPgLedgerReservationsForPair,
	readPgLedgerScopeCurrency,
	readPgObservationContextFromClient,
	readTransitionJournal,
	recoverPgOutcomeClaim,
	recoverPgReaddressPair,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import {
	acquireExclusiveTransitionLease,
	createPackRegistry,
	isOperationRuntime,
	type TransitionExecutionClient,
} from '@dbsp/core';
import type {
	LedgerHome,
	LedgerPayload,
	LedgerReservationRow,
	ProvenPlanStep,
} from '@dbsp/types';
import { Command } from 'commander';
import { createDbConnection } from '../utils/db-utils.js';

export interface ReconcileOptions {
	readonly db: string;
	readonly format?: 'text' | 'json';
}

export interface ReconcileResult {
	readonly outcome:
		| 'database-read-only'
		| 'reconcile-claim-selection-unavailable'
		| 'reconcile-run-unavailable'
		| 'reconcile-unresolved'
		| 'reconcile-completed';
	readonly runId: string;
	readonly addresses: readonly unknown[];
	readonly detail?: string;
	/** One entry per selected root claim; non-appends retain their reason. */
	readonly recovery?: readonly ReconcileRecoveryReport[];
}

export interface ReconcileRecoveryReport {
	readonly address: LedgerReservationRow['address'];
	readonly outcome: PgRecoveryReportKind;
	readonly reason?: string;
	/** Re-address recovery is reported and resolved as one reserved closure. */
	readonly pairId?: string;
}

type PgRecoveryReportKind =
	| 'appended'
	| 'already-appended'
	| 'no-open-claim'
	| 'pending'
	| 'blocked'
	| 'malformed-chain'
	| 'protocol-refused'
	| 'refused-pair'
	| 'indeterminate-pair';

function ledgerHome(address: LedgerReservationRow['address']): LedgerHome {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema)
		throw new Error(
			`schema-scoped managed claim ${address.name} has no schema`,
		);
	return { scope: 'schema', schema: address.schema };
}

function recoveryPayload(
	identity: Parameters<
		NonNullable<Parameters<typeof recoverPgOutcomeClaim>[1]['readBack']>
	>[2],
): LedgerPayload {
	const value = JSON.parse(
		JSON.stringify({ catalogueIdentity: identity }),
	) as LedgerPayload['value'];
	return {
		value,
		digest: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
	};
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

function recoveryObservationReader(step: ProvenPlanStep) {
	const registry = createPackRegistry([createPgTransitionPack({})]);
	const resolution = registry.resolveOperation(step.operation);
	const issuer = registry.resolveIssuer(step.operation.operationKind.artifact);
	if (!resolution.ok || !isOperationRuntime(resolution.semantics) || !issuer)
		return undefined;
	const semantics = resolution.semantics;
	return async (executor: {
		query: TransitionExecutionClient['opaqueClient']['query'];
	}) => {
		const client: TransitionExecutionClient = {
			opaqueClient: executor as TransitionExecutionClient['opaqueClient'],
		};
		const liveContext = await readPgObservationContextFromClient(
			client.opaqueClient,
			step.managedClaim?.address.schema,
		);
		const context = registry.contextWithDerivedCapabilities(
			await semantics.observeContext(client, step.operation, liveContext),
		);
		const result = await semantics.observeOperation(
			client,
			step.operation,
			context,
			'before',
			issuer,
		);
		const value = {
			observations: result.observations.map((observation) => ({
				request: observation.request,
				result: observation.result,
			})),
		} as unknown as LedgerPayload['value'];
		return {
			observed: {
				value,
				digest: createHash('sha256').update(canonicalJson(value)).digest('hex'),
			},
			effect:
				result.fingerprint.digest === step.expectedAfter.digest
					? ('applied' as const)
					: result.fingerprint.digest === step.expectedBefore.digest
						? ('no-effect' as const)
						: ('unverifiable' as const),
		};
	};
}

function recoveryReport(
	address: LedgerReservationRow['address'],
	result: Awaited<ReturnType<typeof recoverPgOutcomeClaim>>,
): ReconcileRecoveryReport {
	if (result.kind === 'outcome-recovery-appended') {
		return {
			address,
			outcome:
				result.append.kind === 'already-appended-outcome-resolution'
					? 'already-appended'
					: 'appended',
			reason: result.classification.resolution.reason,
		};
	}
	if (result.kind === 'outcome-recovery-no-open-claim')
		return { address, outcome: 'no-open-claim' };
	if (result.kind === 'outcome-recovery-pending')
		return { address, outcome: 'pending', reason: result.reason };
	if (result.kind === 'outcome-recovery-blocked')
		return { address, outcome: 'blocked', reason: result.reason };
	if (result.kind === 'outcome-recovery-malformed-chain')
		return { address, outcome: 'malformed-chain', reason: result.reason };
	return { address, outcome: 'protocol-refused', reason: result.reason };
}

function readdressRecoveryReport(
	reservations: readonly LedgerReservationRow[],
	result: Awaited<ReturnType<typeof recoverPgReaddressPair>>,
): ReconcileRecoveryReport {
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
	return {
		address: first.address,
		outcome: 'pending',
		reason: result.reason,
		pairId: result.pairId,
	};
}

function unresolvedRecoveryDetail(
	reports: readonly ReconcileRecoveryReport[],
): string | undefined {
	const unresolved = reports.filter(
		(report) =>
			report.outcome === 'pending' ||
			report.outcome === 'blocked' ||
			report.outcome === 'malformed-chain' ||
			report.outcome === 'protocol-refused' ||
			report.outcome === 'indeterminate-pair',
	);
	if (unresolved.length === 0) return undefined;
	return unresolved
		.map(
			(report) => `${report.address.name}: ${report.reason ?? report.outcome}`,
		)
		.join('; ');
}

/**
 * Reservations are the claim-to-run relation.  The plan only provides the
 * finite ledger scopes to inspect; a claim is eligible only after its stored
 * execution_id equals the requested run id.
 */
export async function runReconcile(
	runId: string,
	options: ReconcileOptions,
	pool?: import('pg').Pool,
): Promise<ReconcileResult> {
	const owned = pool ?? (await createDbConnection(options.db)).pool;
	try {
		const locked = await withPgTransitionRunLock(
			owned,
			runId,
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					try {
						await assertPgDatabaseWritable(lease.session);
					} catch (error) {
						if (isPgDatabaseReadOnlyError(error))
							return {
								kind: 'database-read-only' as const,
								detail: error.message,
							};
						throw error;
					}
					const journal = await readTransitionJournal(lease.session, runId, {
						ensure: false,
					});
					const material = journal.plan.steps
						.map((step) => step.managedClaim)
						.filter(
							(claim): claim is NonNullable<typeof claim> =>
								claim !== undefined,
						);
					if (material.length === 0)
						return {
							kind: 'selection-unavailable' as const,
							addresses:
								journal.plan.declarations?.declarations.map(
									(declaration) => declaration.address,
								) ?? [],
						};
					const stepByClaimId = new Map<string, ProvenPlanStep>();
					for (const step of journal.plan.steps) {
						if (step.managedClaim)
							stepByClaimId.set(step.managedClaim.claimId, step);
					}
					const homes = new Map<string, LedgerHome>();
					for (const claim of material) {
						const home = ledgerHome(claim.address);
						homes.set(`${home.scope}:${home.schema ?? ''}`, home);
					}
					const reservations = (
						await Promise.all(
							[...homes.values()].map((home) =>
								readPgLedgerReservationsForExecution(
									lease.session,
									home,
									runId,
								),
							),
						)
					).flat();
					if (reservations.length === 0)
						return {
							kind: 'selection-unavailable' as const,
							addresses: material.map((x) => x.address),
						};
					for (const home of homes.values()) {
						const currency = await readPgLedgerScopeCurrency(
							lease.session,
							home,
						);
						if (currency.kind !== 'current')
							return {
								kind: 'unresolved' as const,
								addresses: reservations.map((item) => item.address),
								detail:
									currency.kind === 'not-current' &&
									currency.reason === 'lineage'
										? 'ledger lineage mismatch; run dbsp preflight --reinitialize'
										: `ledger marker ${currency.marker.kind}; run dbsp preflight --reinitialize`,
								recovery: reservations.map((item) => ({
									address: item.address,
									outcome: 'blocked' as const,
									reason:
										currency.kind === 'not-current' &&
										currency.reason === 'lineage'
											? 'ledger lineage mismatch; run dbsp preflight --reinitialize'
											: `ledger marker ${currency.marker.kind}; run dbsp preflight --reinitialize`,
								})),
							};
					}
					const readdressPairs = new Map<string, LedgerReservationRow[]>();
					const byRoot = new Map<string, LedgerReservationRow[]>();
					for (const row of reservations) {
						if (
							row.claimKind === 'readdress-intent' &&
							row.pairId !== undefined
						) {
							readdressPairs.set(row.pairId, [
								...(readdressPairs.get(row.pairId) ?? []),
								row,
							]);
							continue;
						}
						byRoot.set(row.rootClaimId, [
							...(byRoot.get(row.rootClaimId) ?? []),
							row,
						]);
					}
					const recovery: ReconcileRecoveryReport[] = [];
					for (const [pairId, _rows] of readdressPairs) {
						const closure = await readPgLedgerReservationsForPair(
							lease.session,
							pairId,
						);
						const recovered = await recoverPgReaddressPair(lease.session, {
							pairId,
							executionId: runId,
							reservations: closure,
						});
						recovery.push(readdressRecoveryReport(closure, recovered));
					}
					for (const rows of byRoot.values()) {
						const first = rows[0];
						if (!first) continue;
						const step = stepByClaimId.get(first.rootClaimId);
						const operationReadBack = step
							? recoveryObservationReader(step)
							: undefined;
						const recovered = await recoverPgOutcomeClaim(lease.session, {
							address: first.address,
							reservations: rows,
							resolutionEventId: `${first.rootClaimId}:reconcile:${runId}`,
							acceptedExternalDdlExclusion: false,
							resolveIndeterminate: true,
							readBack: async (_executor, _address, identity) =>
								recoveryPayload(identity),
							...(operationReadBack === undefined ? {} : { operationReadBack }),
						});
						recovery.push(recoveryReport(first.address, recovered));
					}
					const unresolved = unresolvedRecoveryDetail(recovery);
					if (unresolved)
						return {
							kind: 'unresolved' as const,
							addresses: reservations.map((item) => item.address),
							detail: unresolved,
							recovery,
						};
					return {
						kind: 'completed' as const,
						addresses: reservations.map((item) => item.address),
						recovery,
					};
				} finally {
					await lease.release();
				}
			},
		);
		if (locked.kind === 'busy')
			return { outcome: 'reconcile-run-unavailable', runId, addresses: [] };
		if (locked.value.kind === 'selection-unavailable')
			return {
				outcome: 'reconcile-claim-selection-unavailable',
				runId,
				addresses: locked.value.addresses,
			};
		if (locked.value.kind === 'database-read-only')
			return {
				outcome: 'database-read-only',
				runId,
				addresses: [],
				detail: locked.value.detail,
			};
		if (locked.value.kind === 'unresolved')
			return {
				outcome: 'reconcile-unresolved',
				runId,
				addresses: locked.value.addresses,
				...(locked.value.detail ? { detail: locked.value.detail } : {}),
				...(locked.value.recovery ? { recovery: locked.value.recovery } : {}),
			};
		return {
			outcome: 'reconcile-completed',
			runId,
			addresses: locked.value.addresses,
			...(locked.value.recovery ? { recovery: locked.value.recovery } : {}),
		};
	} catch {
		return { outcome: 'reconcile-run-unavailable', runId, addresses: [] };
	} finally {
		if (pool === undefined) await owned.end();
	}
}

export const reconcileCommand = new Command('reconcile')
	.description('Resolve this run’s open managed claims from live evidence only')
	.argument('<run-id>', 'Durable run identifier')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--format <format>', 'Output format: text or json', 'text')
	.action(async (runId: string, options: ReconcileOptions) => {
		const result = await runReconcile(runId, options);
		if (options.format === 'json') console.log(JSON.stringify(result, null, 2));
		else console.log(`${result.outcome}: ${runId}`);
		process.exitCode = result.outcome === 'reconcile-completed' ? 0 : 1;
	});
