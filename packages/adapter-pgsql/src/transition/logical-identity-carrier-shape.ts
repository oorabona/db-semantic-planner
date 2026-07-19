import {
	DBSP_LOGICAL_IDENTITY_MARKER_COLUMN,
	DBSP_LOGICAL_IDENTITY_MARKER_VALUE,
	DBSP_LOGICAL_IDENTITY_TABLE,
	DBSP_META_SCHEMA,
} from './constants.js';

export type LogicalIdentityCarrierTableStatus =
	| 'absent'
	| 'managed'
	| 'unmanaged';

type QueryResultLike = {
	readonly rows: readonly Record<string, unknown>[];
};

export type LogicalIdentityCarrierShapeQueryExecutor = {
	query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
};

export type LogicalIdentityCarrierShapeRow = {
	readonly table_exists: boolean;
	readonly columns: unknown;
	readonly primary_key: unknown;
};

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value !== 'string') {
		return {};
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function jsonStringArray(value: unknown): readonly string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === 'string');
	}
	if (typeof value !== 'string') {
		return [];
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: [];
	} catch {
		return [];
	}
}

function columnShape(
	columns: Record<string, unknown>,
	name: string,
): Record<string, unknown> | undefined {
	const value = columns[name];
	return isRecord(value) ? value : undefined;
}

function columnMatches(
	columns: Record<string, unknown>,
	name: string,
	type: string,
	notNull: boolean,
): boolean {
	const shape = columnShape(columns, name);
	return shape?.type === type && shape.notNull === notNull;
}

export function qualifiedLogicalIdentitySideTable(): string {
	return `${quoteIdentifier(DBSP_META_SCHEMA)}.${quoteIdentifier(
		DBSP_LOGICAL_IDENTITY_TABLE,
	)}`;
}

export function logicalIdentityCarrierShapeIsManaged(
	row: LogicalIdentityCarrierShapeRow | undefined,
): boolean {
	if (!row?.table_exists) {
		return false;
	}
	const columns = jsonObject(row.columns);
	const primaryKey = jsonStringArray(row.primary_key);
	const expectedColumns = [
		'logical_id',
		'schema_name',
		'table_name',
		'column_name',
		'carrier_kind',
		DBSP_LOGICAL_IDENTITY_MARKER_COLUMN,
		'attached_at',
	];
	return (
		Object.keys(columns).sort().join('\0') ===
			[...expectedColumns].sort().join('\0') &&
		columnMatches(columns, 'logical_id', 'text', true) &&
		columnMatches(columns, 'schema_name', 'text', true) &&
		columnMatches(columns, 'table_name', 'text', true) &&
		columnMatches(columns, 'column_name', 'text', false) &&
		columnMatches(columns, 'carrier_kind', 'text', true) &&
		columnMatches(columns, DBSP_LOGICAL_IDENTITY_MARKER_COLUMN, 'text', true) &&
		columnMatches(columns, 'attached_at', 'timestamp with time zone', true) &&
		primaryKey.length === 1 &&
		primaryKey[0] === 'logical_id'
	);
}

export async function logicalIdentityCarrierTableStatus(
	executor: LogicalIdentityCarrierShapeQueryExecutor,
): Promise<LogicalIdentityCarrierTableStatus> {
	const qualifiedSideTable = qualifiedLogicalIdentitySideTable();
	const exists = await executor.query(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[qualifiedSideTable],
	);
	if (exists.rows[0]?.exists !== true) {
		return 'absent';
	}

	const shape = await executor.query(
		`SELECT ` +
			`pg_catalog.to_regclass($1) IS NOT NULL AS table_exists, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_object_agg(a.attname, pg_catalog.jsonb_build_object(` +
			`'type', pg_catalog.format_type(a.atttypid, a.atttypmod), ` +
			`'notNull', a.attnotnull)) ` +
			`FROM pg_catalog.pg_class c ` +
			`JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ` +
			`JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid ` +
			`WHERE n.nspname = $2 AND c.relname = $3 ` +
			`AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped` +
			`), '{}'::jsonb) AS columns, ` +
			`COALESCE((` +
			`SELECT pg_catalog.jsonb_agg(a.attname ORDER BY key.ordinality) ` +
			`FROM pg_catalog.pg_class c ` +
			`JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace ` +
			`JOIN pg_catalog.pg_constraint con ON con.conrelid = c.oid ` +
			`JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) ON true ` +
			`JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = key.attnum ` +
			`WHERE n.nspname = $2 AND c.relname = $3 AND con.contype = 'p'` +
			`), '[]'::jsonb) AS primary_key`,
		[qualifiedSideTable, DBSP_META_SCHEMA, DBSP_LOGICAL_IDENTITY_TABLE],
	);
	if (
		!logicalIdentityCarrierShapeIsManaged(
			shape.rows[0] as LogicalIdentityCarrierShapeRow | undefined,
		)
	) {
		return 'unmanaged';
	}

	const marker = await executor.query(
		`SELECT count(*)::text AS invalid_marker_rows ` +
			`FROM ${qualifiedSideTable} ` +
			`WHERE ${quoteIdentifier(
				DBSP_LOGICAL_IDENTITY_MARKER_COLUMN,
			)} IS DISTINCT FROM ${quoteLiteral(DBSP_LOGICAL_IDENTITY_MARKER_VALUE)}`,
	);
	return marker.rows[0]?.invalid_marker_rows === '0' ? 'managed' : 'unmanaged';
}

export function unmanagedLogicalIdentityCarrierTableError(): Error {
	return new Error(
		'existing PostgreSQL logical identity side table is not the dbsp-managed carrier shape',
	);
}

export async function assertLogicalIdentityCarrierTableManagedIfPresent(
	executor: LogicalIdentityCarrierShapeQueryExecutor,
): Promise<LogicalIdentityCarrierTableStatus> {
	const status = await logicalIdentityCarrierTableStatus(executor);
	if (status === 'unmanaged') {
		throw unmanagedLogicalIdentityCarrierTableError();
	}
	return status;
}
