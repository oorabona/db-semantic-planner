import { createHash } from 'node:crypto';
import type {
	LedgerChainMember,
	LedgerClaimKind,
	LedgerEventKind,
	LedgerHome,
	LedgerIdentity,
	LedgerReservationRow,
} from '@dbsp/types';
import { validateIdentifier } from '../validate.js';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
	DBSP_META_SCHEMA,
} from './constants.js';
import { classifyPgWrite } from './database-writability.js';
import type { TransitionJournalQueryable } from './journal.js';

const LEDGER_EVENT_KINDS_SQL = [
	'adopt-intent',
	'adopt',
	'intent',
	'retire-intent',
	'readdress-intent',
	'refused',
	'executing',
	'observed',
	'absent',
	'indeterminate',
	'resolved',
	'readdressed-to',
	'readdressed-from',
	'released',
]
	.map((kind) => `'${kind}'`)
	.join(', ');

const CLAIM_EVENT_KINDS = new Set<LedgerEventKind>([
	'adopt-intent',
	'intent',
	'retire-intent',
	'readdress-intent',
]);

const RESOLUTION_EVENT_KINDS = new Set<LedgerEventKind>([
	'adopt',
	'refused',
	'observed',
	'absent',
	'indeterminate',
	'resolved',
	'readdressed-to',
	'readdressed-from',
	'released',
]);

export const PG_LEDGER_MIN_SERVER_VERSION_NUM = 150000;
export const PG_LEDGER_SHAPE_VERSION = 1;

export class PgLedgerStorageUnsupportedError extends Error {
	constructor(observed: unknown) {
		super(
			`ledger-storage-postgresql-15-required: PostgreSQL >= 15 is required for NULLS NOT DISTINCT (server_version_num ${String(observed)})`,
		);
		this.name = 'PgLedgerStorageUnsupportedError';
	}
}

export type PgLedgerLockResult =
	| { readonly kind: 'acquired' }
	| { readonly kind: 'busy'; readonly ledger: LedgerHome }
	| {
			readonly kind: 'refused';
			readonly ledger: LedgerHome;
			readonly error: unknown;
	  };

export type PgLedgerTarget = LedgerHome;

/** Read only reservations explicitly linked to one durable execution/run. */
export async function readPgLedgerReservationsForExecution(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	executionId: string,
): Promise<readonly LedgerReservationRow[]> {
	const result = await executor.query(
		`SELECT address_engine, address_database, address_schema, address_parent, address_kind, address_name, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema FROM ${reservationTable(target)} WHERE execution_id = $1 ORDER BY root_claim_id, address_kind, address_name`,
		[executionId],
	);
	return result.rows.map((row) => {
		const schema = String(row.address_schema ?? '');
		const homeSchema = String(row.home_ledger_schema ?? '');
		const parent = row.address_parent;
		return {
			address: {
				scope: target.scope,
				engine: String(row.address_engine),
				database: String(row.address_database),
				...(schema ? { schema } : {}),
				...(parent == null
					? {}
					: {
							parent: typeof parent === 'string' ? JSON.parse(parent) : parent,
						}),
				kind: String(row.address_kind),
				name: String(row.address_name),
			},
			claimKind: String(row.claim_kind) as LedgerReservationRow['claimKind'],
			executionId: String(row.execution_id),
			...(row.pair_id == null ? {} : { pairId: String(row.pair_id) }),
			rootClaimId: String(row.root_claim_id),
			homeLedger:
				row.home_ledger_scope === 'database'
					? { scope: 'database' }
					: { scope: 'schema', schema: homeSchema },
		};
	});
}

type LedgerWriteMember = Omit<LedgerChainMember, 'controller' | 'recordedAt'>;

function quoteIdent(value: string, type: 'schema' | 'table' | 'alias'): string {
	validateIdentifier(value, type);
	return `"${value.replaceAll('"', '""')}"`;
}

function qualified(schema: string, table: string): string {
	return `${quoteIdent(schema, 'schema')}.${quoteIdent(table, 'table')}`;
}

function eventTable(target: PgLedgerTarget): string {
	return qualified(ledgerSchema(target), DBSP_LEDGER_EVENT_TABLE);
}

function reservationTable(target: PgLedgerTarget): string {
	return qualified(ledgerSchema(target), DBSP_LEDGER_RESERVATION_TABLE);
}

function ledgerSchema(target: PgLedgerTarget): string {
	if (target.scope === 'database') return DBSP_META_SCHEMA;
	if (!target.schema)
		throw new Error('schema ledger target is missing its schema');
	return target.schema;
}

function addressColumns(prefix = ''): string {
	return [
		`${prefix}address_engine`,
		`${prefix}address_database`,
		`${prefix}address_schema`,
		`${prefix}address_parent`,
		`${prefix}address_kind`,
		`${prefix}address_name`,
	].join(', ');
}

function addressValues(member: LedgerWriteMember): readonly unknown[] {
	return [
		member.address.engine,
		member.address.database,
		// PostgreSQL MATCH SIMPLE skips a composite foreign key containing NULL.
		// The empty spelling keeps database-scoped addresses non-null, so the
		// same-address predecessor constraint is enforced for them too.
		member.address.schema ?? '',
		JSON.stringify(member.address.parent ?? null),
		member.address.kind,
		member.address.name,
	];
}

function assertTargetMatchesAddress(
	target: PgLedgerTarget,
	member: Pick<LedgerWriteMember, 'address'>,
): void {
	if (member.address.scope !== target.scope) {
		throw new Error(
			`ledger target ${target.scope} does not match ${member.address.scope}-scoped address ${member.address.name}`,
		);
	}
	if (
		target.scope === 'schema' &&
		(target.schema !== member.address.schema || !target.schema)
	) {
		throw new Error(
			`ledger target schema ${String(target.schema)} does not match address schema ${String(member.address.schema)} for ${member.address.name}`,
		);
	}
}

function targetForAddress(
	address: LedgerReservationRow['address'],
): PgLedgerTarget {
	if (address.scope === 'database') return { scope: 'database' };
	if (!address.schema) {
		throw new Error(
			`schema-scoped reservation ${address.name} is missing its schema`,
		);
	}
	return { scope: 'schema', schema: address.schema };
}

function ensureClaimEvent(
	kind: LedgerEventKind,
): asserts kind is LedgerClaimKind {
	if (!CLAIM_EVENT_KINDS.has(kind)) {
		throw new Error(`ledger event ${kind} is not a claim event`);
	}
}

function ensureResolutionEvent(kind: LedgerEventKind): void {
	if (!RESOLUTION_EVENT_KINDS.has(kind)) {
		throw new Error(`ledger event ${kind} is not a resolution event`);
	}
}

function memberValues(member: LedgerWriteMember): readonly unknown[] {
	return [
		member.eventId,
		...addressValues(member),
		member.catalogueIdentity ? JSON.stringify(member.catalogueIdentity) : null,
		member.eventKind,
		member.predecessor ?? null,
		member.pairId ?? null,
		member.declared ? JSON.stringify(member.declared.value) : null,
		member.declared?.digest ?? null,
		member.observed ? JSON.stringify(member.observed.value) : null,
		member.observed?.digest ?? null,
	];
}

function eventInsertSql(target: PgLedgerTarget): string {
	return `INSERT INTO ${eventTable(target)} (event_id, ${addressColumns()}, catalogue_identity, event_kind, predecessor, pair_id, declared, declared_digest, observed, observed_digest) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $13, $14::jsonb, $15) RETURNING event_id`;
}

export function renderCreateLedgerEventTableSql(
	target: PgLedgerTarget,
): string {
	const table = eventTable(target);
	const address = addressColumns();
	return (
		`CREATE TABLE IF NOT EXISTS ${table} (` +
		'event_id text PRIMARY KEY, ' +
		'address_engine text NOT NULL, address_database text NOT NULL, address_schema text NOT NULL, address_parent jsonb NOT NULL, address_kind text NOT NULL, address_name text NOT NULL, ' +
		'catalogue_identity jsonb, event_kind text NOT NULL, predecessor text, pair_id text, ' +
		'declared jsonb, declared_digest text, observed jsonb, observed_digest text, controller name NOT NULL DEFAULT current_user, recorded_at timestamptz NOT NULL DEFAULT now(), ' +
		`CONSTRAINT dbsp_ledger_event_kind_closed CHECK (event_kind IN (${LEDGER_EVENT_KINDS_SQL})), ` +
		'CONSTRAINT dbsp_ledger_declared_digest_pair CHECK ((declared IS NULL) = (declared_digest IS NULL)), ' +
		'CONSTRAINT dbsp_ledger_observed_digest_pair CHECK ((observed IS NULL) = (observed_digest IS NULL)), ' +
		`CONSTRAINT dbsp_ledger_event_address_event_unique UNIQUE (${address}, event_id), ` +
		`CONSTRAINT dbsp_ledger_event_one_child UNIQUE NULLS NOT DISTINCT (${address}, predecessor), ` +
		`CONSTRAINT dbsp_ledger_event_same_address_predecessor FOREIGN KEY (${address}, predecessor) REFERENCES ${table} (${address}, event_id)` +
		')'
	);
}

export function renderCreateLedgerTerminalMemberIndexSql(
	target: PgLedgerTarget,
): string {
	return `CREATE INDEX IF NOT EXISTS ${quoteIdent('dbsp_ledger_event_terminal_member', 'table')} ON ${eventTable(target)} (predecessor)`;
}

export function renderCreateLedgerReservationTableSql(
	target: PgLedgerTarget,
): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${reservationTable(target)} (` +
		'address_engine text NOT NULL, address_database text NOT NULL, address_schema text NOT NULL, address_parent jsonb NOT NULL, address_kind text NOT NULL, address_name text NOT NULL, ' +
		`claim_kind text NOT NULL CHECK (claim_kind IN ('adopt-intent', 'intent', 'retire-intent', 'readdress-intent')), execution_id text NOT NULL, pair_id text, root_claim_id text NOT NULL, home_ledger_scope text NOT NULL CHECK (home_ledger_scope IN ('schema', 'database')), home_ledger_schema text, ` +
		`PRIMARY KEY (${addressColumns()}), ` +
		"CHECK ((home_ledger_scope = 'database' AND home_ledger_schema IS NULL) OR (home_ledger_scope = 'schema' AND home_ledger_schema IS NOT NULL))" +
		')'
	);
}

export function renderCreateLedgerIdentityTableSql(
	target: PgLedgerTarget,
): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${qualified(ledgerSchema(target), DBSP_LEDGER_IDENTITY_TABLE)} (` +
		'id boolean PRIMARY KEY DEFAULT true CHECK (id), cluster_system_identifier text NOT NULL, database_oid text NOT NULL, namespace_oid text' +
		')'
	);
}

export function renderCreateLedgerMarkerTableSql(
	target: PgLedgerTarget,
): string {
	return (
		`CREATE TABLE IF NOT EXISTS ${qualified(ledgerSchema(target), DBSP_LEDGER_MARKER_TABLE)} (` +
		'id boolean PRIMARY KEY DEFAULT true CHECK (id), version integer NOT NULL CHECK (version >= 1)' +
		')'
	);
}

export function renderCreateLedgerImmutabilityFunctionSql(
	target: PgLedgerTarget,
): string {
	return `CREATE OR REPLACE FUNCTION ${qualified(ledgerSchema(target), 'dbsp_ledger_reject_event_mutation')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dbsp ledger events are append-only for address %', OLD.address_name USING ERRCODE = '55000'; END; $$`;
}

export function renderCreateLedgerImmutabilityTriggerSql(
	target: PgLedgerTarget,
): string {
	const schema = ledgerSchema(target).replaceAll("'", "''");
	return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE t.tgname = 'dbsp_ledger_event_immutable' AND n.nspname = '${schema}' AND c.relname = '${DBSP_LEDGER_EVENT_TABLE}') THEN CREATE TRIGGER dbsp_ledger_event_immutable BEFORE UPDATE OR DELETE ON ${eventTable(target)} FOR EACH ROW EXECUTE FUNCTION ${qualified(ledgerSchema(target), 'dbsp_ledger_reject_event_mutation')}(); END IF; END $$`;
}

/** Proves the PG 15 requirement before emitting a NULLS NOT DISTINCT table. */
export async function ensurePgLedgerStorageVersion(
	executor: TransitionJournalQueryable,
): Promise<void> {
	const raw = (await executor.query('SHOW server_version_num')).rows[0]
		?.server_version_num;
	const version = Number(raw);
	if (
		!Number.isSafeInteger(version) ||
		version < PG_LEDGER_MIN_SERVER_VERSION_NUM
	) {
		throw new PgLedgerStorageUnsupportedError(raw);
	}
}

export async function ensurePgLedger(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	options: { readonly writeMarker?: boolean } = {},
): Promise<void> {
	await ensurePgLedgerStorageVersion(executor);
	await executor.query(renderCreateLedgerEventTableSql(target));
	await executor.query(renderCreateLedgerTerminalMemberIndexSql(target));
	await executor.query(renderCreateLedgerReservationTableSql(target));
	await executor.query(renderCreateLedgerIdentityTableSql(target));
	await executor.query(renderCreateLedgerMarkerTableSql(target));
	if (options.writeMarker !== false)
		await writePgLedgerShapeMarker(executor, target);
	await executor.query(renderCreateLedgerImmutabilityFunctionSql(target));
	await executor.query(renderCreateLedgerImmutabilityTriggerSql(target));
}

export async function ensureDbspMetaLedger(
	executor: TransitionJournalQueryable,
	options: { readonly writeMarker?: boolean } = {},
): Promise<void> {
	await executor.query(
		`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(DBSP_META_SCHEMA, 'schema')}`,
	);
	await ensurePgLedger(executor, { scope: 'database' }, options);
}

/** Writes the marker separately when a cutover must make it the final step. */
export async function writePgLedgerShapeMarker(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
): Promise<void> {
	await executor.query(
		`INSERT INTO ${qualified(ledgerSchema(target), DBSP_LEDGER_MARKER_TABLE)} (id, version) VALUES (true, $1) ON CONFLICT (id) DO NOTHING`,
		[PG_LEDGER_SHAPE_VERSION],
	);
}

/** Records lineage once; a mismatching identity is an admission concern of unit 5. */
export async function recordPgLedgerIdentity(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	identity: LedgerIdentity,
): Promise<void> {
	await executor.query(
		`INSERT INTO ${qualified(ledgerSchema(target), DBSP_LEDGER_IDENTITY_TABLE)} (id, cluster_system_identifier, database_oid, namespace_oid) VALUES (true, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
		[
			identity.clusterSystemIdentifier,
			identity.databaseOid,
			identity.namespaceOid ?? null,
		],
	);
}

export async function appendPgLedgerProgress(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	if (
		member.eventKind !== 'executing' &&
		member.eventKind !== 'indeterminate'
	) {
		throw new Error(
			`ledger event ${member.eventKind} changes reservation state; use the claim or resolution append primitive`,
		);
	}
	await classifyPgWrite(() =>
		executor.query(eventInsertSql(target), memberValues(member)),
	);
}

/**
 * Appends the root claim and every reservation in one PostgreSQL statement.
 * Callers can include this statement in a larger DDL transaction, but cannot
 * accidentally split this claim's append from its durable reservation rows.
 */
export async function appendPgLedgerClaim(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
	reservations: readonly LedgerReservationRow[],
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	ensureClaimEvent(member.eventKind);
	if (reservations.length === 0) {
		throw new Error(
			`ledger claim ${member.eventId} has an empty effects closure`,
		);
	}
	const reservationsByLedger = new Map<
		string,
		{
			target: PgLedgerTarget;
			rows: LedgerReservationRow[];
		}
	>();
	for (const reservation of reservations) {
		if (reservation.claimKind !== member.eventKind) {
			throw new Error(
				`ledger reservation ${reservation.address.name} claim kind does not match claim ${member.eventId}`,
			);
		}
		if (reservation.rootClaimId !== member.eventId) {
			throw new Error(
				`ledger reservation ${reservation.address.name} is not anchored to claim ${member.eventId}`,
			);
		}
		if (
			reservation.homeLedger.scope !== target.scope ||
			reservation.homeLedger.schema !== target.schema
		) {
			throw new Error(
				`ledger reservation ${reservation.address.name} does not name claim ${member.eventId}'s home ledger`,
			);
		}
		const reservationTarget = targetForAddress(reservation.address);
		const key = `${reservationTarget.scope}:${reservationTarget.schema ?? ''}`;
		const group = reservationsByLedger.get(key) ?? {
			target: reservationTarget,
			rows: [],
		};
		group.rows.push(reservation);
		reservationsByLedger.set(key, group);
	}
	const values = [...memberValues(member)] as unknown[];
	const reservationInserts = [...reservationsByLedger.values()].map((group) => {
		const rows = group.rows.map((reservation) => {
			const start = values.length + 1;
			values.push(
				...addressValues({ address: reservation.address } as LedgerWriteMember),
				reservation.claimKind,
				reservation.executionId,
				reservation.pairId ?? null,
				reservation.rootClaimId,
				reservation.homeLedger.scope,
				reservation.homeLedger.schema ?? null,
			);
			return `($${start}, $${start + 1}, $${start + 2}, $${start + 3}::jsonb, $${start + 4}, $${start + 5}, $${start + 6}, $${start + 7}, $${start + 8}, $${start + 9}, $${start + 10}, $${start + 11})`;
		});
		return `INSERT INTO ${reservationTable(group.target)} (${addressColumns()}, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema) VALUES ${rows.join(', ')} RETURNING root_claim_id`;
	});
	const [lastReservationInsert] = reservationInserts.slice(-1);
	const leadingReservationInserts = reservationInserts.slice(0, -1);
	await classifyPgWrite(() =>
		executor.query(
			`WITH appended AS (${eventInsertSql(target)})${leadingReservationInserts.map((insert, index) => `, reserved_${index} AS (${insert})`).join('')} ${lastReservationInsert}`,
			values,
		),
	);
}

/** Appends a terminal member and releases its closure reservations atomically. */
export async function appendPgLedgerResolution(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
	rootClaimId: string,
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	ensureResolutionEvent(member.eventKind);
	if (reservations.length === 0) {
		throw new Error(
			`ledger resolution ${member.eventId} has an empty effects closure`,
		);
	}
	const values = [...memberValues(member), rootClaimId] as unknown[];
	const reservationsByLedger = new Map<
		string,
		{
			target: PgLedgerTarget;
			rows: Pick<LedgerReservationRow, 'address'>[];
		}
	>();
	for (const reservation of reservations) {
		const reservationTarget = targetForAddress(reservation.address);
		const key = `${reservationTarget.scope}:${reservationTarget.schema ?? ''}`;
		const group = reservationsByLedger.get(key) ?? {
			target: reservationTarget,
			rows: [],
		};
		group.rows.push(reservation);
		reservationsByLedger.set(key, group);
	}
	const reservationDeletes = [...reservationsByLedger.values()].map((group) => {
		const addressPredicates = group.rows.map((reservation) => {
			const start = values.length + 1;
			values.push(
				...addressValues({ address: reservation.address } as LedgerWriteMember),
			);
			return `(${addressColumns('r.')}) = ($${start}, $${start + 1}, $${start + 2}, $${start + 3}::jsonb, $${start + 4}, $${start + 5})`;
		});
		return `DELETE FROM ${reservationTable(group.target)} r WHERE r.root_claim_id = $16 AND (${addressPredicates.join(' OR ')}) RETURNING r.root_claim_id`;
	});
	const [lastReservationDelete] = reservationDeletes.slice(-1);
	const leadingReservationDeletes = reservationDeletes.slice(0, -1);
	await classifyPgWrite(() =>
		executor.query(
			`WITH appended AS (${eventInsertSql(target)})${leadingReservationDeletes.map((deletion, index) => `, released_${index} AS (${deletion})`).join('')} ${lastReservationDelete}`,
			values,
		),
	);
}

function orderedLedgerHomes(
	homes: readonly LedgerHome[],
): readonly LedgerHome[] {
	const byKey = new Map<string, LedgerHome>();
	for (const home of homes) {
		if (home.scope === 'schema' && !home.schema) {
			throw new Error('schema ledger lock target is missing its schema');
		}
		const key = home.scope === 'database' ? '0' : `1:${home.schema}`;
		byKey.set(key, home);
	}
	return [...byKey.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, home]) => home);
}

function ledgerLockKey(home: LedgerHome): string {
	return createHash('sha256')
		.update('dbsp.managed-ledger.lock.v1:\0')
		.update(home.scope === 'database' ? DBSP_META_SCHEMA : (home.schema ?? ''))
		.digest()
		.readBigInt64BE(0)
		.toString();
}

/**
 * Transaction-scoped, non-waiting locks for one effects closure. The ordering
 * is dbsp_meta first and then schema name, so opposing closures cannot deadlock.
 */
export async function acquirePgLedgerLocks(
	executor: TransitionJournalQueryable,
	homes: readonly LedgerHome[],
): Promise<PgLedgerLockResult> {
	for (const home of orderedLedgerHomes(homes)) {
		try {
			const result = await executor.query(
				'SELECT pg_catalog.pg_try_advisory_xact_lock($1::bigint) AS locked',
				[ledgerLockKey(home)],
			);
			if (result.rows[0]?.locked !== true)
				return { kind: 'busy', ledger: home };
		} catch (error) {
			return { kind: 'refused', ledger: home, error };
		}
	}
	return { kind: 'acquired' };
}
