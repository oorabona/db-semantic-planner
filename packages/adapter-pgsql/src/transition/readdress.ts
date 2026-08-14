import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
	outcomeClaimId,
	projectLedgerChain,
	type ValidatedManagedStepManifest,
} from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerHome,
	LedgerPayload,
	LedgerReservationRow,
	NormalizedManagedStep,
	ResourceAddress,
	ScopedApprovalSet,
	TableReaddressDeclaration,
} from '@dbsp/types';
import { sameControllerIdentity, sameLedgerAddress } from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	executePgAdmittedOperation,
	type PgLockedRun,
	type PgOutcomeCheckpointObserver,
	recoverPgAdmittedReaddressPair,
} from './outcome-protocol.js';

export type ReaddressRecoveryAnswer =
	| { readonly kind: 'refused-pair' }
	| { readonly kind: 'pending-pair' }
	| { readonly kind: 'indeterminate-pair' };

export type PgReaddressPairRecoveryResult =
	| {
			readonly kind: 'readdress-recovery-refused-pair';
			readonly pairId: string;
	  }
	| {
			readonly kind: 'readdress-recovery-pending-pair';
			readonly pairId: string;
			readonly reason: string;
	  }
	| {
			readonly kind: 'readdress-recovery-indeterminate-pair';
			readonly pairId: string;
			readonly reason: string;
	  }
	| {
			readonly kind: 'readdress-recovery-transport-ambiguous-pair';
			readonly pairId: string;
			readonly reason: string;
	  };

/**
 * The pair recovery decision is deliberately tiny and exhaustive: it never
 * completes a DDL operation.  A readable shape other than the original,
 * complete source closure is outside interference.
 */
export function classifyPgReaddressRecovery(input: {
	readonly unreadable: boolean;
	readonly completeSourceClosure: boolean;
}): ReaddressRecoveryAnswer {
	if (input.unreadable) return { kind: 'pending-pair' };
	return input.completeSourceClosure
		? { kind: 'refused-pair' }
		: { kind: 'indeterminate-pair' };
}

export type PgReaddressResult =
	| { readonly outcome: 'completed'; readonly pairId: string }
	| { readonly outcome: 'no-op' }
	| { readonly outcome: 'readdress-unsupported'; readonly detail: string }
	| { readonly outcome: 'readdress-refused'; readonly detail: string };

export interface PgPersistedReaddressInput {
	readonly executor: TransitionJournalQueryable;
	/** The durable-run witness is locked by apply before this lifecycle starts. */
	readonly run: PgLockedRun;
	readonly manifest: ValidatedManagedStepManifest;
	readonly recomputedPlanDigest: string;
	readonly approval: ScopedApprovalSet;
	/** Exact digest-covered normalized step; this is the only operation source. */
	readonly step: NormalizedManagedStep;
	readonly database: string;
	readonly targetSchema: string;
	/** Test-only admitted-path observation; absent from normal callers. */
	readonly observer?: PgOutcomeCheckpointObserver;
}

interface ClosureMember {
	readonly source: LedgerAddress;
	readonly target: LedgerAddress;
	readonly sourceChain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
	readonly targetChain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
}

/**
 * A re-address closure is catalogue-ordered for stable comparison, never for
 * authority. The persisted lifecycle declaration names its root explicitly.
 */
export function selectPgReaddressClosureRoot<
	Member extends { readonly source: LedgerAddress },
>(members: readonly Member[], declaredRoot: LedgerAddress): Member | undefined {
	return members.find((member) =>
		sameLedgerAddress(member.source, declaredRoot),
	);
}

function home(address: LedgerAddress): LedgerHome {
	if (!address.schema)
		throw new Error(`re-address ${address.name} has no schema`);
	return { scope: 'schema', schema: address.schema };
}

function q(value: string, kind: 'schema' | 'table'): string {
	validateIdentifier(value, kind);
	return `"${value.replaceAll('"', '""')}"`;
}

/**
 * The immutable DDL material attributed to one paired table re-address.
 * Recovery fixtures use this same construction when they open a real
 * readdress-intent through outcome admission.
 */
export function renderPgTableReaddressStatements(
	source: LedgerAddress,
	target: LedgerAddress,
): readonly string[] {
	const statements: string[] = [];
	if (source.schema !== target.schema)
		statements.push(
			`ALTER TABLE ${q(source.schema!, 'schema')}.${q(source.name, 'table')} SET SCHEMA ${q(target.schema!, 'schema')}`,
		);
	if (source.name !== target.name)
		statements.push(
			`ALTER TABLE ${q(target.schema!, 'schema')}.${q(source.name, 'table')} RENAME TO ${q(target.name, 'table')}`,
		);
	return statements;
}

function sameIdentity(left: unknown, right: unknown): boolean {
	return isDeepStrictEqual(left, right);
}

/**
 * A same-schema table rename leaves contained PostgreSQL objects at their
 * physical names. Their ledger addresses nevertheless re-key through the
 * renamed table, so a target lookup can legitimately find that very member.
 * Only the same durable catalogue identity is self-occupancy; every other
 * target presence remains a conflicting occupant.
 */
export function isPgReaddressSelfOccupancy(
	source: Pick<ResourceAddress, 'catalogueIdentity'>,
	target: Pick<ResourceAddress, 'catalogueIdentity'>,
): boolean {
	return (
		source.catalogueIdentity !== undefined &&
		target.catalogueIdentity !== undefined &&
		sameIdentity(source.catalogueIdentity, target.catalogueIdentity)
	);
}

function readdressPairSide(
	pairId: string,
	rootClaimId: string,
): 'source' | 'target' | undefined {
	const prefix = `dbsp.readdress.${pairId}.`;
	if (!rootClaimId.startsWith(prefix)) return undefined;
	const side = rootClaimId.slice(prefix.length).split('.', 1)[0];
	return side === 'source' || side === 'target' ? side : undefined;
}

function digest(value: LedgerPayload['value']): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rekeyDeclaration(
	declaration: LedgerPayload | undefined,
	target: LedgerAddress,
): LedgerPayload {
	const previous = declaration?.value;
	const value =
		previous && typeof previous === 'object' && !Array.isArray(previous)
			? { ...previous, name: target.name }
			: { kind: target.kind, name: target.name };
	return { value, digest: digest(value) };
}

function observed(address: LedgerAddress): LedgerPayload {
	const value = { kind: address.kind, name: address.name };
	return { value, digest: digest(value) };
}

function endpointAddress(
	database: string,
	fallbackSchema: string,
	endpoint: TableReaddressDeclaration['from'],
): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: endpoint.database ?? database,
		schema: endpoint.schema ?? fallbackSchema,
		kind: endpoint.kind ?? 'table',
		name: endpoint.name,
	};
}

async function closureAddresses(
	executor: TransitionJournalQueryable,
	root: LedgerAddress,
	targetRoot: LedgerAddress,
): Promise<readonly { source: LedgerAddress; target: LedgerAddress }[]> {
	// A foreign key owned by another table is outside the table's physical
	// rename closure. Never silently move its root while a dependent could
	// escape the reservation set; a future expanded paired shape may reserve it.
	const escaping = await executor.query(
		`WITH root AS (SELECT relation.oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind IN ('r', 'p', 'f')) SELECT 1 FROM root JOIN pg_catalog.pg_constraint dependent ON dependent.confrelid = root.oid WHERE dependent.contype = 'f' AND dependent.conrelid <> root.oid LIMIT 1`,
		[root.schema, root.name],
	);
	if (escaping.rows.length > 0)
		throw new Error(
			`source ${root.name} has an escaping dependent outside the paired closure`,
		);
	const rows = await executor.query(
		`WITH root AS (SELECT relation.oid FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 AND relation.relkind IN ('r', 'p', 'f')) SELECT 'table'::text AS kind, $2::text AS name, NULL::text AS parent_name UNION ALL SELECT 'column', attribute.attname, $2 FROM root JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = root.oid WHERE attribute.attnum > 0 AND NOT attribute.attisdropped UNION ALL SELECT 'index', index_relation.relname, $2 FROM root JOIN pg_catalog.pg_index index_definition ON index_definition.indrelid = root.oid JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_definition.indexrelid UNION ALL SELECT 'constraint', constraint_row.conname, $2 FROM root JOIN pg_catalog.pg_constraint constraint_row ON constraint_row.conrelid = root.oid UNION ALL SELECT 'sequence', sequence_relation.relname, $2 FROM root JOIN pg_catalog.pg_depend dependency ON dependency.refobjid = root.oid JOIN pg_catalog.pg_class sequence_relation ON sequence_relation.oid = dependency.objid AND sequence_relation.relkind = 'S' WHERE dependency.deptype IN ('a', 'i', 'n') ORDER BY kind, name`,
		[root.schema, root.name],
	);
	if (rows.rows.length === 0) return [];
	return rows.rows.map((row) => {
		if (typeof row.kind !== 'string' || typeof row.name !== 'string')
			throw new Error('re-address closure row is unreadable');
		const kind = row.kind as LedgerAddress['kind'];
		const parent =
			kind === 'table'
				? undefined
				: ({ ...root, name: root.name, kind: 'table' } as LedgerAddress);
		const targetParent =
			kind === 'table'
				? undefined
				: ({
						...targetRoot,
						name: targetRoot.name,
						kind: 'table',
					} as LedgerAddress);
		return {
			source: { ...root, kind, name: row.name, ...(parent ? { parent } : {}) },
			target: {
				...targetRoot,
				kind,
				name: kind === 'table' ? targetRoot.name : row.name,
				...(targetParent ? { parent: targetParent } : {}),
			},
		};
	});
}

async function readClosure(
	executor: TransitionJournalQueryable,
	source: LedgerAddress,
	target: LedgerAddress,
): Promise<readonly ClosureMember[]> {
	const addresses = await closureAddresses(executor, source, target);
	const members: ClosureMember[] = [];
	for (const item of addresses) {
		members.push({
			...item,
			sourceChain: await readPgLedgerAddressChain(
				executor,
				home(item.source),
				item.source,
			),
			targetChain: await readPgLedgerAddressChain(
				executor,
				home(item.target),
				item.target,
			),
		});
	}
	return members;
}

function claimId(
	pairId: string,
	side: 'source' | 'target',
	address: LedgerAddress,
): string {
	return `dbsp.readdress.${pairId}.${side}.${address.kind}.${createHash('sha256').update(JSON.stringify(address)).digest('hex').slice(0, 16)}`;
}

function reservation(
	address: LedgerAddress,
	executionId: string,
	pairId: string,
	rootClaimId: string,
): LedgerReservationRow {
	return {
		address,
		claimKind: 'readdress-intent',
		executionId,
		pairId,
		rootClaimId,
		homeLedger: home(address),
	};
}

export function classifyPgReaddressSupport(request: {
	readonly database: string;
	readonly targetSchema?: string;
	readonly executionId?: string;
	readonly declaration: TableReaddressDeclaration;
}): PgReaddressResult | undefined {
	const { from, to } = request.declaration;
	if ((from.database ?? request.database) !== (to.database ?? request.database))
		return { outcome: 'readdress-unsupported', detail: 'cross-database' };
	const kind = from.kind ?? to.kind ?? 'table';
	if (kind !== 'table' || (to.kind !== undefined && to.kind !== 'table'))
		return {
			outcome: 'readdress-unsupported',
			detail: `unsupported-kind ${kind}`,
		};
	return undefined;
}

/**
 * Reconciles one interrupted re-address as one closure. Every live read is
 * complete before an append is considered, and the only closing outcome is a
 * verified refusal of the untouched source closure. Neither path issues DDL.
 */
export async function recoverPgReaddressPair(
	executor: TransitionJournalQueryable,
	input: {
		readonly pairId: string;
		readonly executionId: string;
		readonly reservations: readonly LedgerReservationRow[];
	},
): Promise<PgReaddressPairRecoveryResult> {
	const reservations = input.reservations.filter(
		(reservation) => reservation.pairId === input.pairId,
	);
	if (reservations.length === 0)
		return {
			kind: 'readdress-recovery-pending-pair',
			pairId: input.pairId,
			reason: 're-address pair has no reserved closure',
		};
	const decision = await recoverPgAdmittedReaddressPair(executor, {
		pairId: input.pairId,
		executionId: input.executionId,
		reservations,
		assess: async (session, durable) => {
			let unreadable = false;
			let completeSourceClosure = durable.length >= 2;
			for (const reservation of durable) {
				try {
					const side = readdressPairSide(input.pairId, reservation.rootClaimId);
					const chain = await readPgLedgerAddressChain(
						session,
						reservation.homeLedger,
						reservation.address,
					);
					const projection = projectLedgerChain(chain);
					const claim =
						projection.kind === 'projected-ledger-chain'
							? projection.openClaim
							: undefined;
					if (
						side === undefined ||
						claim?.event.eventId !== reservation.rootClaimId ||
						claim.kind !== 'readdress-intent' ||
						claim.event.pairId !== input.pairId
					) {
						completeSourceClosure = false;
						continue;
					}
					const live = await readPgCatalogueIdentity(
						session,
						reservation.address,
					);
					if (side === 'target') {
						if (live) completeSourceClosure = false;
						continue;
					}
					const predecessor = chain.events.find(
						(event) => event.eventId === claim.event.predecessor,
					);
					if (
						!live?.catalogueIdentity ||
						(predecessor !== undefined &&
							(!predecessor.catalogueIdentity ||
								!sameIdentity(
									live.catalogueIdentity,
									predecessor.catalogueIdentity,
								)))
					)
						completeSourceClosure = false;
				} catch {
					unreadable = true;
				}
			}
			const answer = classifyPgReaddressRecovery({
				unreadable,
				completeSourceClosure,
			});
			return answer.kind === 'refused-pair'
				? {
						kind: 'refused' as const,
						reason:
							're-address closure is the complete original source closure',
					}
				: answer.kind === 'indeterminate-pair'
					? {
							kind: 'indeterminate' as const,
							reason:
								're-address closure is not the complete original source closure',
						}
					: {
							kind: 'pending' as const,
							reason:
								're-address closure catalogue or ledger read is unavailable',
						};
		},
	});
	return decision.kind === 'refused'
		? { kind: 'readdress-recovery-refused-pair', pairId: input.pairId }
		: decision.kind === 'indeterminate'
			? {
					kind: 'readdress-recovery-indeterminate-pair',
					pairId: input.pairId,
					reason: decision.reason,
				}
			: decision.kind === 'outcome-transport-ambiguous'
				? {
						kind: 'readdress-recovery-transport-ambiguous-pair',
						pairId: input.pairId,
						reason: decision.reason,
					}
				: {
						kind: 'readdress-recovery-pending-pair',
						pairId: input.pairId,
						reason: decision.reason,
					};
}

/**
 * Execute the ADR 0006 pair from one exact, persisted normalized step.
 *
 * This deliberately has no direct-request form: the durable run, validated
 * manifest, digest and reviewed lifecycle material all arrive together from
 * the apply lock boundary.
 */
export async function executePgPersistedTableReaddress(
	input: PgPersistedReaddressInput,
): Promise<PgReaddressResult> {
	const lifecycle = input.step.lifecycle;
	if (
		lifecycle?.kind !== 'readdress' ||
		input.step.classification !== 'paired-readdress' ||
		input.step.claimKind !== 'readdress-intent' ||
		input.step.requiresVacancy
	)
		return {
			outcome: 'readdress-refused',
			detail: `persisted re-address step ${input.step.stepKey} has invalid lifecycle material`,
		};
	const plannedClaimKey = input.step.plannedClaimKeys[0];
	const source = input.step.address;
	if (!plannedClaimKey || !source || source.kind !== 'table')
		return {
			outcome: 'readdress-refused',
			detail: `persisted re-address step ${input.step.stepKey} has incomplete normalized material`,
		};
	const executionId = `dbsp.generator.execution.${input.run.runId}`;
	const request = {
		database: input.database,
		targetSchema: input.targetSchema,
		declaration: lifecycle.declaration,
		executionId,
	};
	const refused = classifyPgReaddressSupport(request);
	if (refused) return refused;
	const declaredSource = endpointAddress(
		request.database,
		request.targetSchema,
		request.declaration.from,
	);
	const target = endpointAddress(
		request.database,
		request.targetSchema,
		request.declaration.to,
	);
	if (!sameLedgerAddress(source, declaredSource))
		return {
			outcome: 'readdress-refused',
			detail: `persisted re-address step ${input.step.stepKey} does not bind its declared source`,
		};
	if (source.name === target.name && source.schema === target.schema)
		return { outcome: 'no-op' };
	const targetLive = await readPgCatalogueIdentity(input.executor, target);
	const sourceLive = await readPgCatalogueIdentity(input.executor, source);
	if (!sourceLive && targetLive) {
		const sourceChain = await readPgLedgerAddressChain(
			input.executor,
			home(source),
			source,
		);
		const chain = await readPgLedgerAddressChain(
			input.executor,
			home(target),
			target,
		);
		const projection = projectLedgerChain(chain);
		if (
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed' &&
			chain.terminalMember?.eventKind === 'readdressed-from' &&
			sourceChain.terminalMember?.eventKind === 'readdressed-to' &&
			sourceChain.terminalMember.pairId === chain.terminalMember.pairId
		)
			return { outcome: 'no-op' };
		return {
			outcome: 'readdress-refused',
			detail: `source ${source.name} has no re-address chain`,
		};
	}
	if (!sourceLive)
		return {
			outcome: 'readdress-refused',
			detail: `source ${source.name} is absent`,
		};
	if (targetLive)
		return {
			outcome: 'readdress-refused',
			detail: `target ${target.name} is occupied`,
		};

	let members: readonly ClosureMember[];
	try {
		members = await readClosure(input.executor, source, target);
	} catch (error) {
		return {
			outcome: 'readdress-refused',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	if (members.length === 0)
		return {
			outcome: 'readdress-refused',
			detail: `source ${source.name} has no readable closure`,
		};
	const pairId = outcomeClaimId(executionId, plannedClaimKey, source);
	const closureKey = (member: ClosureMember) =>
		JSON.stringify([member.source, member.target]);
	const operationMembers = members.map((member) => {
		const sourceClaimId = sameLedgerAddress(member.source, source)
			? pairId
			: claimId(pairId, 'source', member.source);
		const targetClaimId = claimId(pairId, 'target', member.target);
		const sourceProjection = projectLedgerChain(member.sourceChain);
		return {
			source: member.source,
			target: member.target,
			sourceClaimId,
			targetClaimId,
			...(sourceProjection.kind === 'projected-ledger-chain' &&
			sourceProjection.declaration
				? { sourceDeclared: sourceProjection.declaration }
				: {}),
			targetDeclared: rekeyDeclaration(
				sourceProjection.kind === 'projected-ledger-chain'
					? sourceProjection.declaration
					: undefined,
				member.target,
			),
			targetObserved: observed(member.target),
		};
	});
	const root = selectPgReaddressClosureRoot(operationMembers, source);
	if (!root)
		return {
			outcome: 'readdress-refused',
			detail: `re-address closure has no declared root ${source.name}`,
		};
	const statements = input.step.statementBundle.statements;
	const manifestPlan = {
		claimId: root.sourceClaimId,
		claimSpecies: 'sql-bearing' as const,
		executionId: request.executionId,
		plannedClaimKey,
		claimGroupId: pairId,
		rootClaimId: root.sourceClaimId,
		address: root.source,
		claimKind: 'readdress-intent' as const,
		statementBundle: input.step.statementBundle,
		requiresVacancy: false,
	};
	const result = await executePgAdmittedOperation(input.executor, {
		run: input.run,
		approval: input.approval,
		manifest: input.manifest,
		recomputedPlanDigest: input.recomputedPlanDigest,
		operation: {
			kind: 'paired-readdress',
			request: {
				pairId,
				executionId: request.executionId,
				members: operationMembers,
				reservations: operationMembers.flatMap((member) => [
					reservation(
						member.source,
						request.executionId,
						pairId,
						member.sourceClaimId,
					),
					reservation(
						member.target,
						request.executionId,
						pairId,
						member.targetClaimId,
					),
				]),
				statements,
				manifestPlan,
				verifyLiveAdmission: async (session, currentController) => {
					const lockedMembers = await readClosure(session, source, target);
					if (
						lockedMembers.length !== members.length ||
						lockedMembers.some(
							(member, index) =>
								closureKey(member) !== closureKey(members[index]!),
						)
					)
						return {
							kind: 'outcome-protocol-refused',
							reason:
								'source closure changed while member ledger homes were locked',
						};
					for (const member of lockedMembers) {
						const sourceProjection = projectLedgerChain(member.sourceChain);
						const targetProjection = projectLedgerChain(member.targetChain);
						if (sourceProjection.kind !== 'projected-ledger-chain')
							return {
								kind: 'outcome-protocol-refused',
								reason: `source ${member.source.kind} ${member.source.name} has an invalid chain`,
							};
						const sourceIsRoot = sameLedgerAddress(member.source, source);
						if (sourceIsRoot && sourceProjection.stableState !== 'managed')
							return {
								kind: 'outcome-protocol-refused',
								reason: `source ${member.source.kind} ${member.source.name} has no managed chain`,
							};
						// Closure members (constraints, indexes and owned sequences) do
						// not require a pre-existing chain. An empty chain receives its
						// first source-side pair event; an existing chain must be closable.
						if (
							!sourceIsRoot &&
							member.sourceChain.events.length > 0 &&
							!['managed', 'unknown'].includes(sourceProjection.stableState)
						)
							return {
								kind: 'outcome-protocol-refused',
								reason: `source ${member.source.kind} ${member.source.name} has no closable chain`,
							};
						const recorded = member.sourceChain.terminalMember;
						if (
							sourceIsRoot &&
							(!recorded?.controllerOid ||
								!sameControllerIdentity(
									{ name: recorded.controller, oid: recorded.controllerOid },
									currentController,
								))
						)
							return {
								kind: 'outcome-protocol-refused',
								reason: `source ${member.source.kind} ${member.source.name} is managed by a different controller`,
							};
						if (
							targetProjection.kind !== 'projected-ledger-chain' ||
							!['unknown', 'absent'].includes(targetProjection.stableState)
						)
							return {
								kind: 'outcome-protocol-refused',
								reason: `target ${member.target.kind} ${member.target.name} has a non-vacant chain`,
							};
						const live = await readPgCatalogueIdentity(session, member.source);
						if (
							!live?.catalogueIdentity ||
							(sourceProjection.stableState === 'managed' &&
								(!recorded?.catalogueIdentity ||
									!sameIdentity(
										live.catalogueIdentity,
										recorded.catalogueIdentity,
									)))
						)
							return {
								kind: 'outcome-protocol-refused',
								reason: `source identity mismatch for ${member.source.kind} ${member.source.name}`,
							};
						const targetLive = await readPgCatalogueIdentity(
							session,
							member.target,
						);
						if (targetLive && !isPgReaddressSelfOccupancy(live, targetLive))
							return {
								kind: 'outcome-protocol-refused',
								reason: `target ${member.target.kind} ${member.target.name} is occupied`,
							};
					}
					return undefined;
				},
				...(input.observer === undefined ? {} : { observer: input.observer }),
			},
		},
	});
	if (result.kind === 'executed-paired-readdress')
		return { outcome: 'completed', pairId };
	return {
		outcome: 'readdress-refused',
		detail:
			'reason' in result
				? result.reason
				: `unexpected admitted result ${result.kind}`,
	};
}
