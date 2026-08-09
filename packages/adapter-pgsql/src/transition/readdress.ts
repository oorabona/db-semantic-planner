import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectLedgerChain } from '@dbsp/core';
import type {
	LedgerAddress,
	LedgerHome,
	LedgerPayload,
	LedgerReservationRow,
	ResourceAddress,
	TableReaddressDeclaration,
} from '@dbsp/types';
import { refusalFor } from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import { readPgCatalogueIdentity } from './catalogue-identity.js';
import { readPgLedgerAddressChain } from './chain-reader.js';
import type { TransitionJournalQueryable } from './journal.js';
import {
	acquirePgLedgerLocks,
	appendPgLedgerClaim,
	appendPgLedgerResolution,
} from './ledger.js';

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

export interface PgReaddressRequest {
	readonly database: string;
	readonly targetSchema: string;
	readonly declaration: TableReaddressDeclaration;
	readonly executionId: string;
}

interface ClosureMember {
	readonly source: LedgerAddress;
	readonly target: LedgerAddress;
	readonly sourceChain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
	readonly targetChain: Awaited<ReturnType<typeof readPgLedgerAddressChain>>;
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

export function classifyPgReaddressSupport(
	request: PgReaddressRequest,
): PgReaddressResult | undefined {
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
	let begun = false;
	try {
		await executor.query('BEGIN');
		begun = true;
		const lock = await acquirePgLedgerLocks(
			executor,
			reservations.map((reservation) => reservation.homeLedger),
		);
		if (lock.kind !== 'acquired') {
			await executor.query('ROLLBACK');
			begun = false;
			return {
				kind: 'readdress-recovery-pending-pair',
				pairId: input.pairId,
				reason:
					lock.kind === 'busy'
						? 'ledger advisory lock is busy'
						: lock.error instanceof Error
							? lock.error.message
							: String(lock.error),
			};
		}
		let unreadable = false;
		let completeSourceClosure = reservations.length >= 2;
		for (const reservation of reservations) {
			try {
				const side = readdressPairSide(input.pairId, reservation.rootClaimId);
				const chain = await readPgLedgerAddressChain(
					executor,
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
					executor,
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
					!predecessor?.catalogueIdentity ||
					!sameIdentity(live.catalogueIdentity, predecessor.catalogueIdentity)
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
		if (answer.kind === 'pending-pair') {
			await executor.query('COMMIT');
			begun = false;
			return {
				kind: 'readdress-recovery-pending-pair',
				pairId: input.pairId,
				reason: 're-address closure catalogue or ledger read is unavailable',
			};
		}
		if (answer.kind === 'indeterminate-pair') {
			await executor.query('COMMIT');
			begun = false;
			return {
				kind: 'readdress-recovery-indeterminate-pair',
				pairId: input.pairId,
				reason:
					're-address closure is not the complete original source closure',
			};
		}
		for (const reservation of reservations) {
			await appendPgLedgerResolution(
				executor,
				reservation.homeLedger,
				{
					eventId: `${reservation.rootClaimId}:reconcile:${input.executionId}:refused`,
					address: reservation.address,
					eventKind: 'refused',
					predecessor: reservation.rootClaimId,
					pairId: input.pairId,
					refusal: refusalFor('ERR-11', {
						address: reservation.address,
						state: 'unknown',
					}),
				},
				reservation.rootClaimId,
				[reservation],
			);
		}
		await executor.query('COMMIT');
		begun = false;
		return { kind: 'readdress-recovery-refused-pair', pairId: input.pairId };
	} catch (error) {
		if (begun) await executor.query('ROLLBACK');
		return {
			kind: 'readdress-recovery-pending-pair',
			pairId: input.pairId,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Execute the ADR 0006 three-step protocol for one declared table address change. */
export async function executePgTableReaddress(
	executor: TransitionJournalQueryable,
	request: PgReaddressRequest,
): Promise<PgReaddressResult> {
	const refused = classifyPgReaddressSupport(request);
	if (refused) return refused;
	const source = endpointAddress(
		request.database,
		request.targetSchema,
		request.declaration.from,
	);
	const target = endpointAddress(
		request.database,
		request.targetSchema,
		request.declaration.to,
	);
	if (source.name === target.name && source.schema === target.schema)
		return { outcome: 'no-op' };
	const targetLive = await readPgCatalogueIdentity(executor, target);
	const sourceLive = await readPgCatalogueIdentity(executor, source);
	if (!sourceLive && targetLive) {
		const chain = await readPgLedgerAddressChain(
			executor,
			home(target),
			target,
		);
		const projection = projectLedgerChain(chain);
		if (
			projection.kind === 'projected-ledger-chain' &&
			projection.stableState === 'managed' &&
			chain.terminalMember?.eventKind === 'readdressed-from'
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

	let begun = false;
	try {
		await executor.query('BEGIN');
		begun = true;
		const refuse = async (detail: string): Promise<PgReaddressResult> => {
			await executor.query('ROLLBACK');
			begun = false;
			return { outcome: 'readdress-refused', detail };
		};
		const members = await readClosure(executor, source, target);
		if (members.length === 0)
			return refuse(`source ${source.name} has no readable closure`);
		const lock = await acquirePgLedgerLocks(
			executor,
			members.flatMap((member) => [home(member.source), home(member.target)]),
		);
		if (lock.kind !== 'acquired') return refuse('ledger advisory lock is busy');
		for (const member of members) {
			const sourceProjection = projectLedgerChain(member.sourceChain);
			const targetProjection = projectLedgerChain(member.targetChain);
			if (sourceProjection.kind !== 'projected-ledger-chain')
				return refuse(
					`source ${member.source.kind} ${member.source.name} has an invalid chain`,
				);
			const sourceIsRoot = member.source.kind === 'table';
			if (
				(sourceIsRoot && sourceProjection.stableState !== 'managed') ||
				(!sourceIsRoot &&
					!['managed', 'unknown'].includes(sourceProjection.stableState))
			)
				return refuse(
					`source ${member.source.kind} ${member.source.name} has no managed chain`,
				);
			if (
				targetProjection.kind !== 'projected-ledger-chain' ||
				!['unknown', 'absent'].includes(targetProjection.stableState)
			)
				return refuse(
					`target ${member.target.kind} ${member.target.name} has a non-vacant chain`,
				);
			const live = await readPgCatalogueIdentity(executor, member.source);
			if (
				!live ||
				(sourceProjection.stableState === 'managed' &&
					!sameIdentity(
						live.catalogueIdentity,
						member.sourceChain.terminalMember?.catalogueIdentity,
					))
			)
				return refuse(
					`source identity mismatch for ${member.source.kind} ${member.source.name}`,
				);
			const targetLive = await readPgCatalogueIdentity(executor, member.target);
			if (targetLive && !isPgReaddressSelfOccupancy(live, targetLive))
				return refuse(
					`target ${member.target.kind} ${member.target.name} is occupied`,
				);
		}
		const pairId = `dbsp.readdress.${randomUUID()}`;
		for (const member of members) {
			const id = claimId(pairId, 'source', member.source);
			await appendPgLedgerClaim(
				executor,
				home(member.source),
				{
					eventId: id,
					address: member.source,
					eventKind: 'readdress-intent',
					...(member.sourceChain.terminalMember?.eventId
						? { predecessor: member.sourceChain.terminalMember.eventId }
						: {}),
					pairId,
				},
				[reservation(member.source, request.executionId, pairId, id)],
			);
			const targetId = claimId(pairId, 'target', member.target);
			await appendPgLedgerClaim(
				executor,
				home(member.target),
				{
					eventId: targetId,
					address: member.target,
					eventKind: 'readdress-intent',
					...(member.targetChain.terminalMember?.eventId
						? { predecessor: member.targetChain.terminalMember.eventId }
						: {}),
					pairId,
				},
				[reservation(member.target, request.executionId, pairId, targetId)],
			);
		}
		for (const statement of renderPgTableReaddressStatements(source, target))
			await executor.query(statement);
		for (const member of members) {
			const sourceId = claimId(pairId, 'source', member.source);
			const targetId = claimId(pairId, 'target', member.target);
			const live = await readPgCatalogueIdentity(executor, member.target);
			if (!live)
				throw new Error(
					`re-address target read-back is absent for ${member.target.name}`,
				);
			await appendPgLedgerResolution(
				executor,
				home(member.source),
				{
					eventId: `${sourceId}:readdressed-to`,
					address: member.source,
					eventKind: 'readdressed-to',
					predecessor: sourceId,
					pairId,
				},
				sourceId,
				[reservation(member.source, request.executionId, pairId, sourceId)],
			);
			const sourceProjection = projectLedgerChain(member.sourceChain);
			await appendPgLedgerResolution(
				executor,
				home(member.target),
				{
					eventId: `${targetId}:readdressed-from`,
					address: member.target,
					...(live.catalogueIdentity
						? { catalogueIdentity: live.catalogueIdentity }
						: {}),
					eventKind: 'readdressed-from',
					predecessor: targetId,
					pairId,
					declared: rekeyDeclaration(
						sourceProjection.kind === 'projected-ledger-chain'
							? sourceProjection.declaration
							: undefined,
						member.target,
					),
					observed: observed(member.target),
				},
				targetId,
				[reservation(member.target, request.executionId, pairId, targetId)],
			);
		}
		await executor.query('COMMIT');
		begun = false;
		return { outcome: 'completed', pairId };
	} catch (error) {
		if (begun) await executor.query('ROLLBACK');
		throw error;
	}
}
