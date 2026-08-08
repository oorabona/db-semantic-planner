import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerHome,
	LedgerPayload,
} from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import { DBSP_LEDGER_EVENT_TABLE, DBSP_META_SCHEMA } from './constants.js';
import type { TransitionJournalQueryable } from './journal.js';

export interface PgLedgerAddressChain {
	readonly ledger: LedgerHome;
	readonly address: LedgerAddress;
	/** Every member is returned so the core projector can diagnose malformed chains. */
	readonly events: readonly LedgerChainMember[];
	/** Undefined means there is no unique terminal member; it is never inferred by row order. */
	readonly terminalMember?: LedgerChainMember;
}

interface PgLedgerEventRow {
	readonly event_id: unknown;
	readonly address_engine: unknown;
	readonly address_database: unknown;
	readonly address_schema: unknown;
	readonly address_parent: unknown;
	readonly address_kind: unknown;
	readonly address_name: unknown;
	readonly execution_id: unknown;
	readonly planned_claim_key: unknown;
	readonly claim_group_id: unknown;
	readonly root_claim_id: unknown;
	readonly catalogue_identity: unknown;
	readonly event_kind: unknown;
	readonly predecessor: unknown;
	readonly pair_id: unknown;
	readonly declared: unknown;
	readonly declared_digest: unknown;
	readonly observed: unknown;
	readonly observed_digest: unknown;
	readonly controller: unknown;
	readonly recorded_at: unknown;
}

function quoteIdent(value: string, type: 'schema' | 'table'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function ledgerSchema(ledger: LedgerHome): string {
	if (ledger.scope === 'database') return DBSP_META_SCHEMA;
	if (!ledger.schema)
		throw new Error('schema ledger target is missing its schema');
	return ledger.schema;
}

function eventTable(ledger: LedgerHome): string {
	return `${quoteIdent(ledgerSchema(ledger), 'schema')}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE, 'table')}`;
}

function addressParameters(address: LedgerAddress): readonly unknown[] {
	return [
		address.engine,
		address.database,
		address.schema ?? '',
		JSON.stringify(address.parent ?? null),
		address.kind,
		address.name,
	];
}

function asString(value: unknown, column: string): string {
	if (typeof value !== 'string')
		throw new Error(`ledger event ${column} is unreadable`);
	return value;
}

function nullableString(value: unknown, column: string): string | undefined {
	if (value === null || value === undefined) return undefined;
	return asString(value, column);
}

function jsonValue(value: unknown, column: string): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`ledger event ${column} is unreadable`);
	}
}

function payload(
	value: unknown,
	digest: unknown,
	column: 'declared' | 'observed',
): LedgerChainMember['declared'] | undefined {
	if (value === null || value === undefined) {
		if (digest !== null && digest !== undefined)
			throw new Error(`ledger event ${column} digest is unreadable`);
		return undefined;
	}
	return {
		value: jsonValue(value, column) as LedgerPayload['value'],
		digest: asString(digest, `${column}_digest`),
	};
}

function memberFromRow(
	row: PgLedgerEventRow,
	scope: LedgerAddress['scope'],
): LedgerChainMember {
	const parent = jsonValue(row.address_parent, 'address_parent');
	const declared = payload(row.declared, row.declared_digest, 'declared');
	const observed = payload(row.observed, row.observed_digest, 'observed');
	const predecessor = nullableString(row.predecessor, 'predecessor');
	const executionId = nullableString(row.execution_id, 'execution_id');
	const plannedClaimKey = nullableString(
		row.planned_claim_key,
		'planned_claim_key',
	);
	const claimGroupId = nullableString(row.claim_group_id, 'claim_group_id');
	const rootClaimId = nullableString(row.root_claim_id, 'root_claim_id');
	const pairId = nullableString(row.pair_id, 'pair_id');
	const recordedAt = nullableString(row.recorded_at, 'recorded_at');
	return {
		eventId: asString(row.event_id, 'event_id'),
		...(executionId === undefined ? {} : { executionId }),
		...(plannedClaimKey === undefined ? {} : { plannedClaimKey }),
		...(claimGroupId === undefined ? {} : { claimGroupId }),
		...(rootClaimId === undefined ? {} : { rootClaimId }),
		address: {
			scope,
			engine: asString(row.address_engine, 'address_engine'),
			database: asString(row.address_database, 'address_database'),
			...(row.address_schema === ''
				? {}
				: { schema: asString(row.address_schema, 'address_schema') }),
			...(parent === null
				? {}
				: { parent: parent as Exclude<LedgerAddress['parent'], undefined> }),
			kind: asString(row.address_kind, 'address_kind'),
			name: asString(row.address_name, 'address_name'),
		},
		...(row.catalogue_identity === null || row.catalogue_identity === undefined
			? {}
			: {
					catalogueIdentity: jsonValue(
						row.catalogue_identity,
						'catalogue_identity',
					) as Exclude<LedgerChainMember['catalogueIdentity'], undefined>,
				}),
		// Deliberately preserve an unknown database spelling for the pure projector.
		eventKind: asString(
			row.event_kind,
			'event_kind',
		) as LedgerChainMember['eventKind'],
		...(predecessor === undefined ? {} : { predecessor }),
		...(pairId === undefined ? {} : { pairId }),
		...(declared === undefined ? {} : { declared }),
		...(observed === undefined ? {} : { observed }),
		controller: asString(row.controller, 'controller'),
		...(recordedAt === undefined ? {} : { recordedAt }),
	};
}

/** Finds a terminal by predecessor topology only; callers must not use row position. */
export function findPgLedgerTerminalMember(
	events: readonly LedgerChainMember[],
): LedgerChainMember | undefined {
	const predecessors = new Set(
		events
			.map((event) => event.predecessor)
			.filter(
				(predecessor): predecessor is string => predecessor !== undefined,
			),
	);
	const terminals = events.filter((event) => !predecessors.has(event.eventId));
	return terminals.length === 1 ? terminals[0] : undefined;
}

/**
 * Reads one address without imposing an insertion order. The resulting full
 * chain feeds the core projection, which owns all lifecycle interpretation.
 */
export async function readPgLedgerAddressChain(
	executor: TransitionJournalQueryable,
	ledger: LedgerHome,
	address: LedgerAddress,
): Promise<PgLedgerAddressChain> {
	if (address.scope !== ledger.scope)
		throw new Error(
			`ledger ${ledger.scope} does not match ${address.scope}-scoped address ${address.name}`,
		);
	if (ledger.scope === 'schema' && ledger.schema !== address.schema)
		throw new Error(
			`ledger schema ${String(ledger.schema)} does not match address schema ${String(address.schema)} for ${address.name}`,
		);
	const result = await executor.query(
		`SELECT event_id, address_engine, address_database, address_schema, address_parent, address_kind, address_name, execution_id, planned_claim_key, claim_group_id, root_claim_id, catalogue_identity, event_kind, predecessor, pair_id, declared, declared_digest, observed, observed_digest, controller::text AS controller, recorded_at::text AS recorded_at FROM ${eventTable(ledger)} WHERE address_engine = $1 AND address_database = $2 AND address_schema = $3 AND address_parent = $4::jsonb AND address_kind = $5 AND address_name = $6`,
		addressParameters(address),
	);
	const events = result.rows.map((row) =>
		memberFromRow(row as unknown as PgLedgerEventRow, address.scope),
	);
	const terminalMember = findPgLedgerTerminalMember(events);
	return {
		ledger,
		address,
		events,
		...(terminalMember === undefined ? {} : { terminalMember }),
	};
}
