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
	DBSP_LEDGER_TABLES,
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

type LedgerTableRow = {
	readonly table_name: unknown;
	readonly relation_kind: unknown;
};

type LedgerColumnRow = {
	readonly table_name: unknown;
	readonly column_name: unknown;
	readonly column_type: unknown;
	readonly is_not_null: unknown;
};

type LedgerConstraintRow = {
	readonly table_name: unknown;
	readonly contype: unknown;
	readonly connullsnotdistinct: unknown;
	readonly is_self_referential: unknown;
	readonly key_columns: unknown;
	readonly referenced_columns: unknown;
};

type LedgerIndexRow = {
	readonly table_name: unknown;
	readonly indisprimary: unknown;
	readonly indisunique: unknown;
	readonly index_columns: unknown;
};

type LedgerColumnDefinition = {
	readonly name: string;
	/** Use PostgreSQL's catalog spelling, so this is also the shape assertion. */
	readonly type: string;
	readonly nullable: boolean;
	readonly defaultSql?: string;
};

type LedgerConstraintDefinition = {
	readonly name: string;
	readonly type: 'c' | 'f' | 'p' | 'u';
	readonly render: (target: PgLedgerTarget) => string;
	readonly nullsNotDistinct?: boolean;
	readonly requiresForeignKeyPrefix?: boolean;
};

type LedgerIndexDefinition = {
	readonly name: string;
	readonly columnsSql: string;
};

type LedgerTableDefinition = {
	readonly name: (typeof DBSP_LEDGER_TABLES)[number];
	readonly columns: readonly LedgerColumnDefinition[];
	readonly constraints: readonly LedgerConstraintDefinition[];
	readonly indexes?: readonly LedgerIndexDefinition[];
};

const NOT_NULL = false;
const NULLABLE = true;

/**
 * The single ledger DDL definition rendered by `ensurePgLedger`.
 * Admission deliberately checks only the independent catalog invariants that
 * protect chain closure, not PostgreSQL's normalized type or constraint names.
 */
const PG_LEDGER_TABLE_DEFINITIONS: readonly LedgerTableDefinition[] = [
	{
		name: DBSP_LEDGER_EVENT_TABLE,
		columns: [
			{ name: 'event_id', type: 'text', nullable: NOT_NULL },
			{ name: 'address_engine', type: 'text', nullable: NOT_NULL },
			{ name: 'address_database', type: 'text', nullable: NOT_NULL },
			{ name: 'address_schema', type: 'text', nullable: NOT_NULL },
			{ name: 'address_parent', type: 'jsonb', nullable: NOT_NULL },
			{ name: 'address_kind', type: 'text', nullable: NOT_NULL },
			{ name: 'address_name', type: 'text', nullable: NOT_NULL },
			{ name: 'execution_id', type: 'text', nullable: NULLABLE },
			{ name: 'planned_claim_key', type: 'text', nullable: NULLABLE },
			{ name: 'claim_group_id', type: 'text', nullable: NULLABLE },
			{ name: 'root_claim_id', type: 'text', nullable: NULLABLE },
			{ name: 'catalogue_identity', type: 'jsonb', nullable: NULLABLE },
			{ name: 'event_kind', type: 'text', nullable: NOT_NULL },
			{ name: 'predecessor', type: 'text', nullable: NULLABLE },
			{ name: 'pair_id', type: 'text', nullable: NULLABLE },
			{ name: 'declared', type: 'jsonb', nullable: NULLABLE },
			{ name: 'declared_digest', type: 'text', nullable: NULLABLE },
			{ name: 'observed', type: 'jsonb', nullable: NULLABLE },
			{ name: 'observed_digest', type: 'text', nullable: NULLABLE },
			{ name: 'refusal_code', type: 'text', nullable: NULLABLE },
			{ name: 'refusal_cause', type: 'text', nullable: NULLABLE },
			{ name: 'refusal_state', type: 'text', nullable: NULLABLE },
			{ name: 'refusal_withheld_authority', type: 'text', nullable: NULLABLE },
			{ name: 'refusal_resolving_command', type: 'text', nullable: NULLABLE },
			{
				name: 'controller',
				type: 'name',
				nullable: NOT_NULL,
				defaultSql: 'current_user',
			},
			{
				name: 'controller_oid',
				type: 'oid',
				nullable: NOT_NULL,
				defaultSql: 'current_user::regrole::oid',
			},
			{
				name: 'recorded_at',
				type: 'timestamp with time zone',
				nullable: NOT_NULL,
				defaultSql: 'now()',
			},
		],
		constraints: [
			{
				name: 'dbsp_ledger_event_pkey',
				type: 'p',
				render: () => 'PRIMARY KEY (event_id)',
			},
			{
				name: 'dbsp_ledger_event_kind_closed',
				type: 'c',
				render: () => `CHECK (event_kind IN (${LEDGER_EVENT_KINDS_SQL}))`,
			},
			{
				name: 'dbsp_ledger_declared_digest_pair',
				type: 'c',
				render: () => 'CHECK ((declared IS NULL) = (declared_digest IS NULL))',
			},
			{
				name: 'dbsp_ledger_observed_digest_pair',
				type: 'c',
				render: () => 'CHECK ((observed IS NULL) = (observed_digest IS NULL))',
			},
			{
				name: 'dbsp_ledger_refusal_payload',
				type: 'c',
				render: () =>
					"CHECK ((event_kind = 'refused') = (refusal_code IS NOT NULL AND refusal_cause IS NOT NULL AND refusal_state IS NOT NULL AND refusal_withheld_authority IS NOT NULL AND refusal_resolving_command IS NOT NULL))",
			},
			{
				name: 'dbsp_ledger_event_address_event_unique',
				type: 'u',
				render: () => `UNIQUE (${addressColumns()}, event_id)`,
			},
			{
				name: 'dbsp_ledger_event_one_child',
				type: 'u',
				nullsNotDistinct: true,
				render: () =>
					`UNIQUE NULLS NOT DISTINCT (${addressColumns()}, predecessor)`,
			},
			{
				name: 'dbsp_ledger_event_same_address_predecessor',
				type: 'f',
				requiresForeignKeyPrefix: true,
				render: (target) =>
					`FOREIGN KEY (${addressColumns()}, predecessor) REFERENCES ${eventTable(target)} (${addressColumns()}, event_id)`,
			},
		],
		indexes: [
			{
				name: 'dbsp_ledger_event_terminal_member',
				columnsSql: '(predecessor)',
			},
		],
	},
	{
		name: DBSP_LEDGER_RESERVATION_TABLE,
		columns: [
			{ name: 'address_engine', type: 'text', nullable: NOT_NULL },
			{ name: 'address_database', type: 'text', nullable: NOT_NULL },
			{ name: 'address_schema', type: 'text', nullable: NOT_NULL },
			{ name: 'address_parent', type: 'jsonb', nullable: NOT_NULL },
			{ name: 'address_kind', type: 'text', nullable: NOT_NULL },
			{ name: 'address_name', type: 'text', nullable: NOT_NULL },
			{ name: 'claim_kind', type: 'text', nullable: NOT_NULL },
			{ name: 'execution_id', type: 'text', nullable: NOT_NULL },
			{ name: 'pair_id', type: 'text', nullable: NULLABLE },
			{ name: 'root_claim_id', type: 'text', nullable: NOT_NULL },
			{ name: 'home_ledger_scope', type: 'text', nullable: NOT_NULL },
			{ name: 'home_ledger_schema', type: 'text', nullable: NULLABLE },
		],
		constraints: [
			{
				name: 'dbsp_ledger_reservation_pkey',
				type: 'p',
				render: () => `PRIMARY KEY (${addressColumns()})`,
			},
			{
				name: 'dbsp_ledger_reservation_claim_kind_check',
				type: 'c',
				render: () =>
					"CHECK (claim_kind IN ('adopt-intent', 'intent', 'retire-intent', 'readdress-intent'))",
			},
			{
				name: 'dbsp_ledger_reservation_home_ledger_scope_check',
				type: 'c',
				render: () => "CHECK (home_ledger_scope IN ('schema', 'database'))",
			},
			{
				name: 'dbsp_ledger_reservation_check',
				type: 'c',
				render: () =>
					"CHECK ((home_ledger_scope = 'database' AND home_ledger_schema IS NULL) OR (home_ledger_scope = 'schema' AND home_ledger_schema IS NOT NULL))",
			},
		],
	},
	{
		name: DBSP_LEDGER_IDENTITY_TABLE,
		columns: [
			{ name: 'id', type: 'boolean', nullable: NOT_NULL, defaultSql: 'true' },
			{
				name: 'cluster_system_identifier',
				type: 'text',
				nullable: NOT_NULL,
			},
			{ name: 'database_oid', type: 'text', nullable: NOT_NULL },
			{ name: 'namespace_oid', type: 'text', nullable: NULLABLE },
		],
		constraints: [
			{
				name: 'dbsp_ledger_identity_pkey',
				type: 'p',
				render: () => 'PRIMARY KEY (id)',
			},
			{
				name: 'dbsp_ledger_identity_id_check',
				type: 'c',
				render: () => 'CHECK (id)',
			},
		],
	},
	{
		name: DBSP_LEDGER_MARKER_TABLE,
		columns: [
			{ name: 'id', type: 'boolean', nullable: NOT_NULL, defaultSql: 'true' },
			{ name: 'version', type: 'integer', nullable: NOT_NULL },
		],
		constraints: [
			{
				name: 'dbsp_ledger_marker_pkey',
				type: 'p',
				render: () => 'PRIMARY KEY (id)',
			},
			{
				name: 'dbsp_ledger_marker_id_check',
				type: 'c',
				render: () => 'CHECK (id)',
			},
			{
				name: 'dbsp_ledger_marker_version_check',
				type: 'c',
				render: () => 'CHECK (version >= 1)',
			},
		],
	},
];

function ledgerTableDefinition(
	name: string,
): LedgerTableDefinition | undefined {
	return PG_LEDGER_TABLE_DEFINITIONS.find((table) => table.name === name);
}

function stringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
		return undefined;
	return value;
}

function hasColumns(value: unknown, expected: readonly string[]): boolean {
	const columns = stringArray(value);
	return (
		columns !== undefined &&
		columns.length === expected.length &&
		columns.every((column, index) => column === expected[index])
	);
}

function hasExpectedConstraintFamilies(
	rows: readonly LedgerConstraintRow[],
	definition: LedgerTableDefinition,
): boolean {
	const expected = new Map<string, number>();
	const actual = new Map<string, number>();
	for (const constraint of definition.constraints)
		expected.set(constraint.type, (expected.get(constraint.type) ?? 0) + 1);
	for (const row of rows) {
		if (typeof row.contype !== 'string') return false;
		actual.set(row.contype, (actual.get(row.contype) ?? 0) + 1);
	}
	return (
		expected.size === actual.size &&
		[...expected].every(([type, count]) => actual.get(type) === count)
	);
}

function ledgerPhysicalShapeError(
	target: PgLedgerTarget,
	table: string,
	invariant: string,
): Error {
	return new Error(
		`ledger physical shape: ${ledgerSchema(target)}.${table} ${invariant}; run dbsp preflight --reinitialize`,
	);
}

/**
 * Verify catalog facts before an existing relation is accepted as a ledger.
 * CREATE ... IF NOT EXISTS is deliberately not evidence of this shape.
 */
export async function validatePgLedgerPhysicalShape(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
): Promise<void> {
	const tables = await executor.query(
		`SELECT relation.relname AS table_name, relation.relkind AS relation_kind FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) ORDER BY relation.relname`,
		[ledgerSchema(target), DBSP_LEDGER_TABLES],
	);
	const tableRows = tables.rows as readonly LedgerTableRow[];
	for (const table of DBSP_LEDGER_TABLES) {
		const row = tableRows.find((candidate) => candidate.table_name === table);
		if (!row) throw ledgerPhysicalShapeError(target, table, 'is missing');
		if (row.relation_kind !== 'r')
			throw ledgerPhysicalShapeError(target, table, 'is not an ordinary table');
	}

	const columns = await executor.query(
		`SELECT relation.relname AS table_name, attribute.attname AS column_name, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS column_type, attribute.attnotnull AS is_not_null FROM pg_catalog.pg_attribute attribute JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND attribute.attnum > 0 AND NOT attribute.attisdropped ORDER BY relation.relname, attribute.attnum`,
		[ledgerSchema(target), DBSP_LEDGER_TABLES],
	);
	const columnRows = columns.rows as readonly LedgerColumnRow[];
	for (const definition of PG_LEDGER_TABLE_DEFINITIONS) {
		const actual = columnRows.filter(
			(row) => row.table_name === definition.name,
		);
		const hasExpectedColumns =
			actual.length === definition.columns.length &&
			definition.columns.every((expected, index) => {
				const row = actual[index];
				return (
					row?.column_name === expected.name &&
					row.column_type === expected.type &&
					row.is_not_null === !expected.nullable
				);
			});
		if (!hasExpectedColumns)
			throw ledgerPhysicalShapeError(
				target,
				definition.name,
				'has an unexpected column shape',
			);
	}

	const constraints = await executor.query(
		`SELECT relation.relname AS table_name, constraint_item.contype, constraint_index.indnullsnotdistinct AS connullsnotdistinct, constraint_item.conrelid = constraint_item.confrelid AS is_self_referential, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.conkey) WITH ORDINALITY AS key_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.conrelid AND attribute.attnum = key_column.attnum ORDER BY key_column.position) AS key_columns, ARRAY(SELECT attribute.attname::text FROM unnest(constraint_item.confkey) WITH ORDINALITY AS referenced_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = constraint_item.confrelid AND attribute.attnum = referenced_column.attnum ORDER BY referenced_column.position) AS referenced_columns FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace LEFT JOIN pg_catalog.pg_index constraint_index ON constraint_index.indexrelid = constraint_item.conindid WHERE namespace.nspname = $1 AND relation.relname = ANY($2::text[]) AND constraint_item.contype IN ('p', 'c', 'u', 'f') ORDER BY relation.relname, constraint_item.oid`,
		[ledgerSchema(target), DBSP_LEDGER_TABLES],
	);
	// PostgreSQL 18 records NOT NULL as pg_constraint rows with contype = 'n'.
	// NOT NULL belongs to the column-shape assertion above, never this set.
	const constraintRows = (
		constraints.rows as readonly LedgerConstraintRow[]
	).filter(
		(row) =>
			row.contype === 'p' ||
			row.contype === 'c' ||
			row.contype === 'u' ||
			row.contype === 'f',
	);
	const predecessorKeyColumns = [
		...addressColumns().split(', '),
		'predecessor',
	];
	const predecessorReferenceColumns = [
		...addressColumns().split(', '),
		'event_id',
	];
	const hasPredecessorForeignKey = constraintRows.some(
		(row) =>
			row.table_name === DBSP_LEDGER_EVENT_TABLE &&
			row.contype === 'f' &&
			row.is_self_referential === true &&
			hasColumns(row.key_columns, predecessorKeyColumns) &&
			hasColumns(row.referenced_columns, predecessorReferenceColumns),
	);
	if (!hasPredecessorForeignKey)
		throw ledgerPhysicalShapeError(
			target,
			DBSP_LEDGER_EVENT_TABLE,
			'missing self-referential predecessor foreign key',
		);

	const hasOneChildConstraint = constraintRows.some(
		(row) =>
			row.table_name === DBSP_LEDGER_EVENT_TABLE &&
			row.contype === 'u' &&
			row.connullsnotdistinct === true &&
			hasColumns(row.key_columns, predecessorKeyColumns),
	);
	if (!hasOneChildConstraint)
		throw ledgerPhysicalShapeError(
			target,
			DBSP_LEDGER_EVENT_TABLE,
			'missing UNIQUE NULLS NOT DISTINCT on address and predecessor',
		);

	for (const definition of PG_LEDGER_TABLE_DEFINITIONS) {
		const actual = constraintRows.filter(
			(row) => row.table_name === definition.name,
		);
		if (!hasExpectedConstraintFamilies(actual, definition))
			throw ledgerPhysicalShapeError(
				target,
				definition.name,
				'has unexpected primary, check, unique, or foreign-key constraints',
			);
	}

	const indexes = await executor.query(
		`SELECT relation.relname AS table_name, index_definition.indisprimary, index_definition.indisunique, ARRAY(SELECT attribute.attname::text FROM unnest(index_definition.indkey) WITH ORDINALITY AS index_column(attnum, position) JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = index_column.attnum ORDER BY index_column.position) AS index_columns FROM pg_catalog.pg_index index_definition JOIN pg_catalog.pg_class relation ON relation.oid = index_definition.indrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relname = $2 ORDER BY index_definition.indexrelid`,
		[ledgerSchema(target), DBSP_LEDGER_EVENT_TABLE],
	);
	const hasTerminalIndex = (indexes.rows as readonly LedgerIndexRow[]).some(
		(row) =>
			row.table_name === DBSP_LEDGER_EVENT_TABLE &&
			row.indisprimary === false &&
			row.indisunique === false &&
			hasColumns(row.index_columns, ['predecessor']),
	);
	if (!hasTerminalIndex)
		throw ledgerPhysicalShapeError(
			target,
			DBSP_LEDGER_EVENT_TABLE,
			'missing terminal predecessor index',
		);
}

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

/**
 * A re-address pair can cross ledger homes. Discover every existing reservation
 * table before reading the pair so recovery cannot accidentally treat one side
 * of a cross-schema closure as the entire operation.
 */
export async function readPgLedgerReservationsForPair(
	executor: TransitionJournalQueryable,
	pairId: string,
): Promise<readonly LedgerReservationRow[]> {
	const homes = await executor.query(
		`SELECT namespace.nspname FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE relation.relname = $1 AND relation.relkind = 'r' ORDER BY namespace.nspname`,
		[DBSP_LEDGER_RESERVATION_TABLE],
	);
	const targets = homes.rows.map((row) => {
		if (typeof row.nspname !== 'string')
			throw new Error('ledger reservation schema is unreadable');
		return row.nspname === DBSP_META_SCHEMA
			? ({ scope: 'database' } as const)
			: ({ scope: 'schema', schema: row.nspname } as const);
	});
	return readPgLedgerReservationsForPairInHomes(executor, pairId, targets);
}

/** Read a re-address pair only from ledger homes already admitted by a caller. */
export async function readPgLedgerReservationsForPairInHomes(
	executor: TransitionJournalQueryable,
	pairId: string,
	targets: readonly PgLedgerTarget[],
): Promise<readonly LedgerReservationRow[]> {
	const rows = await Promise.all(
		targets.map(async (target) => {
			const result = await executor.query(
				`SELECT address_engine, address_database, address_schema, address_parent, address_kind, address_name, claim_kind, execution_id, pair_id, root_claim_id, home_ledger_scope, home_ledger_schema FROM ${reservationTable(target)} WHERE pair_id = $1 ORDER BY root_claim_id, address_kind, address_name`,
				[pairId],
			);
			return result.rows.map((value) => {
				const schema = String(value.address_schema ?? '');
				const homeSchema = String(value.home_ledger_schema ?? '');
				return {
					address: {
						scope: target.scope,
						engine: String(value.address_engine),
						database: String(value.address_database),
						...(schema ? { schema } : {}),
						...(value.address_parent == null
							? {}
							: {
									parent:
										typeof value.address_parent === 'string'
											? JSON.parse(value.address_parent)
											: value.address_parent,
								}),
						kind: String(value.address_kind),
						name: String(value.address_name),
					},
					claimKind: String(
						value.claim_kind,
					) as LedgerReservationRow['claimKind'],
					executionId: String(value.execution_id),
					...(value.pair_id == null ? {} : { pairId: String(value.pair_id) }),
					rootClaimId: String(value.root_claim_id),
					homeLedger:
						value.home_ledger_scope === 'database'
							? { scope: 'database' as const }
							: { scope: 'schema' as const, schema: homeSchema },
				};
			});
		}),
	);
	return rows.flat();
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
		member.executionId ?? null,
		member.plannedClaimKey ?? null,
		member.claimGroupId ?? null,
		member.rootClaimId ?? null,
		member.catalogueIdentity ? JSON.stringify(member.catalogueIdentity) : null,
		member.eventKind,
		member.predecessor ?? null,
		member.pairId ?? null,
		member.declared ? JSON.stringify(member.declared.value) : null,
		member.declared?.digest ?? null,
		member.observed ? JSON.stringify(member.observed.value) : null,
		member.observed?.digest ?? null,
		member.refusal?.code ?? null,
		member.refusal?.cause ?? null,
		member.refusal?.state ?? null,
		member.refusal?.withheldAuthority ?? null,
		member.refusal?.resolvingCommand ?? null,
	];
}

function eventInsertSql(target: PgLedgerTarget): string {
	return `INSERT INTO ${eventTable(target)} (event_id, ${addressColumns()}, execution_id, planned_claim_key, claim_group_id, root_claim_id, catalogue_identity, event_kind, predecessor, pair_id, declared, declared_digest, observed, observed_digest, refusal_code, refusal_cause, refusal_state, refusal_withheld_authority, refusal_resolving_command) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19, $20, $21, $22, $23, $24) RETURNING event_id`;
}

function renderLedgerColumn(column: LedgerColumnDefinition): string {
	return `${column.name} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.defaultSql ? ` DEFAULT ${column.defaultSql}` : ''}`;
}

function renderCreateLedgerTableSql(
	target: PgLedgerTarget,
	definition: LedgerTableDefinition,
): string {
	const columns = definition.columns.map(renderLedgerColumn);
	const constraints = definition.constraints.map(
		(constraint) =>
			`CONSTRAINT ${quoteIdent(constraint.name, 'table')} ${constraint.render(target)}`,
	);
	return `CREATE TABLE IF NOT EXISTS ${qualified(ledgerSchema(target), definition.name)} (${[...columns, ...constraints].join(', ')})`;
}

export function renderCreateLedgerEventTableSql(
	target: PgLedgerTarget,
): string {
	const definition = ledgerTableDefinition(DBSP_LEDGER_EVENT_TABLE);
	if (!definition) throw new Error('ledger event definition is missing');
	return renderCreateLedgerTableSql(target, definition);
}

export function renderCreateLedgerTerminalMemberIndexSql(
	target: PgLedgerTarget,
): string {
	const definition = ledgerTableDefinition(DBSP_LEDGER_EVENT_TABLE);
	const index = definition?.indexes?.[0];
	if (!index)
		throw new Error('ledger terminal-member index definition is missing');
	return `CREATE INDEX IF NOT EXISTS ${quoteIdent(index.name, 'table')} ON ${eventTable(target)} ${index.columnsSql}`;
}

export function renderCreateLedgerReservationTableSql(
	target: PgLedgerTarget,
): string {
	const definition = ledgerTableDefinition(DBSP_LEDGER_RESERVATION_TABLE);
	if (!definition) throw new Error('ledger reservation definition is missing');
	return renderCreateLedgerTableSql(target, definition);
}

export function renderCreateLedgerIdentityTableSql(
	target: PgLedgerTarget,
): string {
	const definition = ledgerTableDefinition(DBSP_LEDGER_IDENTITY_TABLE);
	if (!definition) throw new Error('ledger identity definition is missing');
	return renderCreateLedgerTableSql(target, definition);
}

export function renderCreateLedgerMarkerTableSql(
	target: PgLedgerTarget,
): string {
	const definition = ledgerTableDefinition(DBSP_LEDGER_MARKER_TABLE);
	if (!definition) throw new Error('ledger marker definition is missing');
	return renderCreateLedgerTableSql(target, definition);
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
	reservationRootClaimId = member.eventId,
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
		if (reservation.rootClaimId !== reservationRootClaimId) {
			throw new Error(
				`ledger reservation ${reservation.address.name} is not anchored to claim group ${reservationRootClaimId}`,
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

/**
 * Appends an entire destructive closure as one ledger group.  The caller owns
 * the surrounding locked transaction; consequently a failed member insert
 * rolls back the root, every member and every reservation together.
 */
export async function appendPgLedgerClaimGroup(
	executor: TransitionJournalQueryable,
	root: LedgerWriteMember,
	members: readonly LedgerWriteMember[],
	reservations: readonly LedgerReservationRow[],
): Promise<void> {
	const claims = [root, ...members];
	if (claims.length < 2)
		throw new Error(
			'ledger claim group requires a root and at least one member',
		);
	if (reservations.length !== claims.length)
		throw new Error(
			'ledger claim group requires exactly one reservation per claim',
		);
	const byAddress = new Map<string, LedgerWriteMember>();
	const addressKey = (member: Pick<LedgerWriteMember, 'address'>) =>
		JSON.stringify(addressValues(member as LedgerWriteMember));
	for (const claim of claims) {
		ensureClaimEvent(claim.eventKind);
		assertTargetMatchesAddress(targetForAddress(claim.address), claim);
		const key = addressKey(claim);
		if (byAddress.has(key))
			throw new Error(
				`ledger claim group repeats address ${claim.address.name}`,
			);
		byAddress.set(key, claim);
	}
	for (const reservation of reservations) {
		const claim = byAddress.get(addressKey({ address: reservation.address }));
		if (!claim)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} has no claim`,
			);
		if (reservation.rootClaimId !== root.eventId)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} is not anchored to root ${root.eventId}`,
			);
		if (reservation.claimKind !== claim.eventKind)
			throw new Error(
				`ledger claim group reservation ${reservation.address.name} claim kind does not match its claim`,
			);
	}
	for (const claim of claims) {
		const reservation = reservations.find(
			(candidate) =>
				addressKey({ address: candidate.address }) === addressKey(claim),
		);
		if (!reservation)
			throw new Error(
				`ledger claim group claim ${claim.eventId} has no reservation`,
			);
		await appendPgLedgerClaim(
			executor,
			targetForAddress(claim.address),
			claim,
			[reservation],
			root.eventId,
		);
	}
}

/** Resolves every closure terminal in the caller's one locked transaction. */
export async function appendPgLedgerResolutionGroup(
	executor: TransitionJournalQueryable,
	rootClaimId: string,
	members: readonly LedgerWriteMember[],
	reservations: readonly Pick<LedgerReservationRow, 'address'>[],
): Promise<void> {
	if (members.length < 2)
		throw new Error(
			'ledger resolution group requires a root and at least one member',
		);
	if (reservations.length !== members.length)
		throw new Error(
			'ledger resolution group requires exactly one reservation per terminal',
		);
	for (const member of members) {
		ensureResolutionEvent(member.eventKind);
		await appendPgLedgerResolution(
			executor,
			targetForAddress(member.address),
			member,
			member.predecessor ?? rootClaimId,
			[
				{
					address: member.address,
				},
			],
		);
	}
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
	if (member.eventKind === 'refused' && member.refusal === undefined)
		throw new Error(
			`ledger refusal ${member.eventId} is missing its durable refusal protocol`,
		);
	if (member.eventKind !== 'refused' && member.refusal !== undefined)
		throw new Error(
			`ledger event ${member.eventId} carries a refusal protocol but is not refused`,
		);
	if (reservations.length === 0) {
		throw new Error(
			`ledger resolution ${member.eventId} has an empty effects closure`,
		);
	}
	const values = [...memberValues(member), rootClaimId] as unknown[];
	const rootClaimIdParameter = values.length;
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
		return `DELETE FROM ${reservationTable(group.target)} r WHERE r.root_claim_id = $${rootClaimIdParameter} AND (${addressPredicates.join(' OR ')}) RETURNING r.root_claim_id`;
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

/**
 * `released` has no claim spelling in the closed event grammar. It is the
 * deliberate atomic managed-to-unknown transition, so it must not invent an
 * empty reservation closure merely to reuse ordinary claim resolution.
 */
export async function appendPgLedgerRelease(
	executor: TransitionJournalQueryable,
	target: PgLedgerTarget,
	member: LedgerWriteMember,
): Promise<void> {
	assertTargetMatchesAddress(target, member);
	if (member.eventKind !== 'released')
		throw new Error('ledger release append requires a released event');
	await classifyPgWrite(() =>
		executor.query(eventInsertSql(target), memberValues(member)),
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
