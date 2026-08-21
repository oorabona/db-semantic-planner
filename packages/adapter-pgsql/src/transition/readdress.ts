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
import {
	decodeGeneratedPostcondition,
	type GeneratedPostconditionSession,
	type GeneratedPostconditionTarget,
	mintGeneratedPostconditionSession,
	verifyGeneratedCheckPostcondition,
	verifyGeneratedIndexPostcondition,
	verifyGeneratedTablePostcondition,
} from '../ddl/generated-postcondition-verifier.js';
import { validateIdentifier } from '../validate.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import { acquirePgLedgerLocks } from './ledger.js';
import { renderPgLockIdentifier } from './lock-identifier.js';
import {
	executePgAdmittedOperation,
	type PgLockedRun,
	type PgOutcomeCheckpointObserver,
	type PgPairedReaddressOperation,
	recoverPgAdmittedReaddressPair,
	setPgTransitionLockTimeout,
	withPgTransitionTransaction,
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
	| { readonly outcome: 'readdress-refused'; readonly detail: string }
	| {
			readonly outcome: 'recovery-required';
			readonly claimId: string;
			readonly detail: string;
	  }
	| { readonly outcome: 'transport-ambiguous'; readonly detail: string };

export interface PgPersistedReaddressInput {
	readonly executor: TransitionJournalQueryable;
	/** The durable-run witness is locked by apply before this lifecycle starts. */
	readonly run: PgLockedRun;
	readonly manifest: ValidatedManagedStepManifest;
	readonly recomputedPlanDigest: string;
	readonly approval: ScopedApprovalSet;
	/** Attempt namespace journaled before this lifecycle can open a claim. */
	readonly executionId: string;
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

function isVersion2Postcondition(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		(value as { readonly postconditionVersion?: unknown })
			.postconditionVersion === 2
	);
}

export function rekeyDeclaration(
	declaration: LedgerPayload | undefined,
	target: LedgerAddress,
): LedgerPayload {
	const previous = declaration?.value;
	// Version-2 postconditions describe a catalogue shape, not its address.
	// Preserve the covered value and digest literally: the strict decoder rejects
	// an address field and later readdress proof consumes this exact payload.
	if (declaration && isVersion2Postcondition(previous)) return declaration;
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

type GeneratedProof = {
	readonly kind: string;
	readonly prove: (
		session: GeneratedPostconditionSession,
	) => Promise<LedgerPayload>;
};

function generatedProofTarget(
	address: LedgerAddress,
): GeneratedPostconditionTarget {
	if (!address.schema)
		throw new Error(
			`generated postcondition for ${address.kind} ${address.name} has no schema`,
		);
	const table = address.kind === 'table' ? address.name : address.parent?.name;
	if (!table)
		throw new Error(
			`generated postcondition for ${address.kind} ${address.name} has no table parent`,
		);
	return { schema: address.schema, table, name: address.name };
}

/** The decode-and-dispatch definition for root admission, no-op and table proofs. */
function generatedPostconditionProof(
	declaration: LedgerPayload | undefined,
	address: LedgerAddress,
): GeneratedProof {
	if (!declaration)
		throw new Error(
			`generated postcondition is absent; replan to produce version 2 typed postconditions`,
		);
	const postcondition = decodeGeneratedPostcondition(declaration.value);
	const target = generatedProofTarget(address);
	const observe = (projection: unknown): LedgerPayload => {
		// Verifier projections may represent absent catalogue fields as undefined;
		// ledger JSON uses their canonical serialized form.
		const value = JSON.parse(
			JSON.stringify(projection),
		) as LedgerPayload['value'];
		return { value, digest: digest(value) };
	};
	switch (postcondition.kind) {
		case 'table':
			return {
				kind: postcondition.kind,
				prove: async (session) =>
					observe(
						(
							await verifyGeneratedTablePostcondition({
								session,
								postcondition,
								target,
							})
						).projection,
					),
			};
		case 'index':
			return {
				kind: postcondition.kind,
				prove: async (session) =>
					observe(
						(
							await verifyGeneratedIndexPostcondition({
								session,
								postcondition,
								target,
							})
						).projection,
					),
			};
		case 'constraint':
			return {
				kind: postcondition.kind,
				prove: async (session) =>
					observe(
						(
							await verifyGeneratedCheckPostcondition({
								session,
								postcondition,
								target,
							})
						).projection,
					),
			};
		default:
			throw new Error(
				`generated ${postcondition.kind} postcondition is unsupported; replan to produce version 2 typed postconditions`,
			);
	}
}

/**
 * The one three-way member rule: decodable v2 tables prove structure; a
 * declared undecodable payload refuses with replan wording; no declaration,
 * or a decodable-but-unprovable v2 kind (the #576 address-bearing format),
 * retains identity read-back with its declared payload.
 */
function readdressMemberReadBack(
	declaration: LedgerPayload | undefined,
	address: LedgerAddress,
): GeneratedProof | undefined {
	if (!declaration) return undefined;
	const postcondition = decodeGeneratedPostcondition(declaration.value);
	if (postcondition.kind !== 'table') return undefined;
	return generatedPostconditionProof(declaration, address);
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
 * The target-only outcome is still an admission decision. Its early live read
 * only selects this slower path; every fact that permits the no-op is re-read
 * while both ledger homes and the target relation are held on one session.
 */
async function verifyPgTargetOnlyReaddressNoOp(
	input: PgPersistedReaddressInput,
	source: LedgerAddress,
	target: LedgerAddress,
): Promise<PgReaddressResult> {
	try {
		return await withPgTransitionTransaction(
			input.executor,
			async (session) => {
				await setPgTransitionLockTimeout(session);
				const lock = await acquirePgLedgerLocks(session, [
					home(source),
					home(target),
				]);
				if (lock.kind !== 'acquired')
					return {
						outcome: 'readdress-refused',
						detail: `re-address ledger home is unavailable for ${target.name}`,
					};
				const sourceChain = await readPgLedgerAddressChain(
					session,
					home(source),
					source,
				);
				const targetChain = await readPgLedgerAddressChain(
					session,
					home(target),
					target,
				);
				const sourceProjection = projectLedgerChain(sourceChain);
				const targetProjection = projectLedgerChain(targetChain);
				const sourceTerminal = sourceChain.terminalMember;
				const targetTerminal = targetChain.terminalMember;
				if (
					sourceProjection.kind !== 'projected-ledger-chain' ||
					sourceProjection.stableState !== 'unknown' ||
					sourceProjection.openClaim !== undefined ||
					sourceTerminal?.eventKind !== 'readdressed-to' ||
					targetProjection.kind !== 'projected-ledger-chain' ||
					targetProjection.stableState !== 'managed' ||
					targetProjection.openClaim !== undefined ||
					targetTerminal?.eventKind !== 'readdressed-from' ||
					sourceTerminal.pairId !== targetTerminal.pairId
				)
					return {
						outcome: 'readdress-refused',
						detail: `source ${source.name} has no complete re-address chain`,
					};
				await session.query(
					`LOCK TABLE ${renderPgLockIdentifier(target.schema)}.${renderPgLockIdentifier(target.name)} IN SHARE UPDATE EXCLUSIVE MODE`,
				);
				const targetLive = await readPgCatalogueIdentity(session, target);
				if (
					!targetLive?.catalogueIdentity ||
					!targetTerminal.catalogueIdentity ||
					!sameIdentity(
						targetLive.catalogueIdentity,
						targetTerminal.catalogueIdentity,
					)
				)
					return {
						outcome: 'readdress-refused',
						detail: `target identity mismatch for ${target.kind} ${target.name}`,
					};
				try {
					const proof = generatedPostconditionProof(
						input.step.expectedDeclaration,
						target,
					);
					if (proof.kind !== 'table')
						throw new Error(
							`generated ${proof.kind} postcondition is unsupported; replan to produce version 2 typed table postconditions`,
						);
					await proof.prove(mintGeneratedPostconditionSession(session));
					return { outcome: 'no-op' };
				} catch (error) {
					return {
						outcome: 'readdress-refused',
						detail: `target ${target.name} structural proof failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
			},
		);
	} catch (error) {
		return {
			outcome: 'readdress-refused',
			detail: `target ${target.name} no-op verification failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
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
	const executionId = input.executionId;
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
	if (!sourceLive && targetLive)
		return verifyPgTargetOnlyReaddressNoOp(input, source, target);
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
	let operationMembers: PgPairedReaddressOperation['request']['members'];
	try {
		operationMembers = members.map((member) => {
			const sourceClaimId = sameLedgerAddress(member.source, source)
				? pairId
				: claimId(pairId, 'source', member.source);
			const targetClaimId = claimId(pairId, 'target', member.target);
			const sourceProjection = projectLedgerChain(member.sourceChain);
			const sourceDeclared =
				sourceProjection.kind === 'projected-ledger-chain'
					? sourceProjection.declaration
					: undefined;
			const targetDeclared = rekeyDeclaration(sourceDeclared, member.target);
			const sourceIsRoot = sameLedgerAddress(member.source, source);
			const postDdlProof = readdressMemberReadBack(
				sourceIsRoot ? input.step.expectedDeclaration : sourceDeclared,
				member.target,
			);
			return {
				source: member.source,
				target: member.target,
				sourceClaimId,
				targetClaimId,
				...(sourceDeclared ? { sourceDeclared } : {}),
				targetDeclared,
				targetObserved: observed(member.target),
				...(postDdlProof === undefined
					? {}
					: { postDdlReadBack: postDdlProof.prove }),
			};
		});
	} catch (error) {
		return {
			outcome: 'readdress-refused',
			detail: error instanceof Error ? error.message : String(error),
		};
	}
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
					if (
						root.sourceDeclared &&
						isVersion2Postcondition(root.sourceDeclared.value) &&
						input.step.expectedDeclaration &&
						root.sourceDeclared.digest !== input.step.expectedDeclaration.digest
					)
						return {
							kind: 'outcome-protocol-refused',
							reason: `recorded declaration does not match reviewed step for ${source.name}`,
						};
					try {
						const rootAdmissionProof = generatedPostconditionProof(
							input.step.expectedDeclaration,
							source,
						);
						if (rootAdmissionProof.kind !== 'table')
							throw new Error(
								`generated ${rootAdmissionProof.kind} postcondition is unsupported; replan to produce version 2 typed table postconditions`,
							);
						await rootAdmissionProof.prove(
							mintGeneratedPostconditionSession(session),
						);
					} catch (error) {
						return {
							kind: 'outcome-protocol-refused',
							reason: `source ${source.name} structural proof failed: ${error instanceof Error ? error.message : String(error)}`,
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
	if (result.kind === 'outcome-recovery-required')
		return {
			outcome: 'recovery-required',
			claimId: result.claimId,
			detail: `claim ${result.claimId} remains open and requires recovery: ${result.reason}`,
		};
	if (result.kind === 'outcome-transport-ambiguous')
		return { outcome: 'transport-ambiguous', detail: result.reason };
	return {
		outcome: 'readdress-refused',
		detail:
			'reason' in result
				? result.reason
				: `unexpected admitted result ${result.kind}`,
	};
}
