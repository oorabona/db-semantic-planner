/**
 * Schema Comparison Engine (DDL-PROV Block 1)
 *
 * Compares two ModelIRs (schema definition vs database state)
 * and produces a structured diff of changes needed.
 *
 * @module schema-diff
 */

import type {
	ColumnIR,
	DbCasing,
	DialectCapabilities,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	PartitionIR,
	PolicyIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import {
	getNamingPluginForDbCasing,
	type NamingPlugin,
} from '../naming-plugin.js';

// ============================================================================
// Types
// ============================================================================

export type ChangeKind =
	// Tables
	| 'create_table'
	| 'drop_table'
	// Columns
	| 'add_column'
	| 'drop_column'
	| 'alter_column_type'
	| 'alter_column_nullable'
	| 'alter_column_default'
	| 'alter_column_unique'
	// Constraints
	| 'add_primary_key'
	| 'drop_primary_key'
	| 'add_foreign_key'
	| 'drop_foreign_key'
	| 'alter_foreign_key'
	| 'validate_constraint'
	// Indexes
	| 'create_index'
	| 'drop_index'
	// CHECK constraints
	| 'add_check_constraint'
	| 'drop_check_constraint'
	// ENUM types
	| 'create_enum'
	| 'alter_enum_add_value'
	| 'drop_enum'
	// Column enhancements
	| 'alter_column_collation'
	| 'alter_column_identity'
	// Comments
	| 'add_comment'
	| 'drop_comment'
	// Extensions
	| 'create_extension'
	| 'drop_extension'
	// Sequences
	| 'create_sequence'
	| 'alter_sequence'
	| 'drop_sequence'
	// Row-Level Security
	| 'enable_rls'
	| 'disable_rls'
	| 'create_policy'
	| 'drop_policy';

export interface SchemaChange {
	readonly kind: ChangeKind;
	readonly table: string;
	readonly column?: string;
	readonly destructive: boolean;
	readonly details: string;
	/** Additional metadata for SQL generation */
	readonly meta?: Readonly<Record<string, unknown>>;
}

export interface DiffSummary {
	readonly tables: { readonly added: number; readonly dropped: number };
	readonly columns: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
	readonly indexes: { readonly added: number; readonly dropped: number };
	readonly constraints: {
		readonly added: number;
		readonly dropped: number;
		readonly altered: number;
	};
}

export interface SchemaDiff {
	readonly changes: readonly SchemaChange[];
	readonly hasDestructive: boolean;
	readonly summary: DiffSummary;
}

// ============================================================================
// Options
// ============================================================================

export interface CompareSchemataOptions {
	/**
	 * Database naming convention.
	 * When set, schema model names (camelCase) are converted to DB format
	 * (e.g. snake_case) before comparison with the introspected model.
	 */
	dbCasing?: DbCasing;
	/** Dialect capabilities — comparisons for unsupported features will be skipped */
	readonly dialectCapabilities?: DialectCapabilities;
	/**
	 * When `true`, extensions present in the live DB but absent from the model
	 * schema are silently ignored — no `drop_extension` change is emitted for them.
	 * Only extensions explicitly declared in the model are managed (created if missing).
	 *
	 * Use this when the database image pre-installs extensions that the application
	 * schema does not own (e.g. pgvector, pg_search bundled in a custom Postgres image).
	 * Default: `false` (full-sync behaviour — unmanaged DB extensions produce a
	 * `drop_extension` entry).
	 */
	readonly ignoreUnmanagedExtensions?: boolean;
}

// ============================================================================
// Comparison Engine
// ============================================================================

/**
 * Compare two ModelIRs and produce a structured diff.
 *
 * @param schema - The desired schema (from definition)
 * @param db - The current database state (from introspection)
 * @param options - Optional comparison settings (e.g. dbCasing)
 * @returns SchemaDiff with all changes needed to bring DB in sync with schema
 */
export function compareSchemata(
	schema: ModelIR,
	db: ModelIR,
	options?: CompareSchemataOptions,
): SchemaDiff {
	const changes: SchemaChange[] = [];

	const plugin =
		options?.dbCasing !== undefined
			? getNamingPluginForDbCasing(options.dbCasing)
			: undefined;
	const schemaTables = plugin
		? normalizeTableMap(schema.tables, plugin)
		: new Map(schema.tables);
	const dbTables = new Map(db.tables);
	const externalTables = new Set(
		[...(schema.externalTables ?? [])].map((name) =>
			plugin ? plugin.toDatabase(name) : name,
		),
	);

	const caps = options?.dialectCapabilities;
	// Helper: feature is supported if no caps provided (backward compat) OR flag is true
	/**
	 * Check whether a DDL feature is supported.
	 *
	 * - `undefined`: capability flag not set → feature is on by default (no caps = all features).
	 * - `false`: capability explicitly disabled → feature is skipped.
	 * - `true`: capability explicitly enabled → feature is included.
	 */
	const sup = (flag: boolean | undefined) => !caps || flag === true;

	// 0. Compare ENUM types (schema-level, before tables)
	if (sup(caps?.supportsDDLEnumTypes)) {
		compareEnums(schema, db, changes);
	}

	// 0a. Compare extensions (schema-level)
	if (sup(caps?.supportsDDLExtensions)) {
		compareExtensions(schema, db, changes, {
			ignoreUnmanaged: options?.ignoreUnmanagedExtensions ?? false,
		});
	}

	// 0b. Compare sequences (schema-level, before tables)
	if (sup(caps?.supportsDDLSequences)) {
		compareSequences(schema, db, changes);
	}

	// 1. Tables that exist in schema but not in DB → create_table
	for (const [name, schemaTable] of schemaTables) {
		if (!dbTables.has(name)) {
			changes.push({
				kind: 'create_table',
				table: name,
				destructive: false,
				details: `Create table "${name}" with ${schemaTable.columns.length} columns`,
				meta: { table: schemaTable },
			});
			// Emit FK constraints for new table (phase 9, after CREATE TABLE phase 5)
			for (const fk of schemaTable.foreignKeys) {
				changes.push({
					kind: 'add_foreign_key',
					table: name,
					destructive: false,
					details: `Add FK (${fk.columns.join(', ')}) → ${fk.references.table}(${fk.references.columns.join(', ')})`,
					meta: { fk },
				});
			}
			// Emit indexes for new table (phase 11, after FK phase 9)
			for (const idx of schemaTable.indexes) {
				changes.push({
					kind: 'create_index',
					table: name,
					destructive: false,
					details: `Create ${idx.unique ? 'unique ' : ''}index on (${idx.columns.join(', ')})`,
					meta: { index: idx },
				});
			}
			// Emit CHECK constraints for new table (phase 12, after indexes)
			if (sup(caps?.supportsDDLCheckConstraints)) {
				for (const check of schemaTable.checkConstraints ?? []) {
					changes.push({
						kind: 'add_check_constraint',
						table: name,
						destructive: false,
						details: `Add CHECK constraint "${check.name}" ${check.expression}`,
						meta: { check },
					});
				}
			}
			// Emit RLS enable + policies for new table (after table creation)
			if (sup(caps?.supportsDDLRowLevelSecurity)) {
				if (schemaTable.rlsEnabled) {
					changes.push({
						kind: 'enable_rls',
						table: name,
						destructive: false,
						details: `Enable RLS on table "${name}"`,
					});
				}
				for (const policy of schemaTable.policies ?? []) {
					changes.push({
						kind: 'create_policy',
						table: name,
						destructive: false,
						details: `Create policy "${policy.name}" on "${name}"`,
						meta: { policy },
					});
				}
			}
			continue;
		}

		// Table exists in both → compare columns, constraints, indexes
		const dbTable = dbTables.get(name)!;
		compareColumns(schemaTable, dbTable, changes);
		comparePrimaryKeys(schemaTable, dbTable, changes);
		compareForeignKeys(schemaTable, dbTable, changes);
		compareIndexes(schemaTable, dbTable, changes);
		if (sup(caps?.supportsDDLCheckConstraints)) {
			compareCheckConstraints(schemaTable, dbTable, changes);
		}
		if (sup(caps?.supportsDDLComments)) {
			compareComments(schemaTable, dbTable, changes);
		}
		comparePartitions(schemaTable, dbTable, changes);
		if (sup(caps?.supportsDDLRowLevelSecurity)) {
			comparePolicies(schemaTable, dbTable, changes);
		}
	}

	// 2. Tables that exist in DB but not in schema → drop_table
	for (const [name] of dbTables) {
		if (!schemaTables.has(name) && !externalTables.has(name)) {
			changes.push({
				kind: 'drop_table',
				table: name,
				destructive: true,
				details: `Drop table "${name}"`,
			});
		}
	}

	return {
		changes,
		hasDestructive: changes.some((c) => c.destructive),
		summary: buildSummary(changes),
	};
}

// ============================================================================
// Name Normalization (camelCase → DB format)
// ============================================================================

/**
 * Convert all identifiers in a table map from model format to database format.
 * This allows comparing a schema definition (camelCase) against an introspected
 * database (snake_case) without false positives.
 */
function normalizeTableMap(
	tables: ReadonlyMap<string, TableIR>,
	plugin: NamingPlugin,
): Map<string, TableIR> {
	const result = new Map<string, TableIR>();
	for (const [_key, table] of tables) {
		const dbName = plugin.toDatabase(table.name);
		result.set(dbName, normalizeTable(table, plugin));
	}
	return result;
}

function normalizeTable(table: TableIR, plugin: NamingPlugin): TableIR {
	const dbName = plugin.toDatabase(table.name);
	const toDb = (name: string) => plugin.toDatabase(name);

	return {
		name: dbName,
		columns: table.columns.map((col) => ({
			...col,
			name: toDb(col.name),
		})),
		...(table.primaryKey !== undefined && {
			primaryKey:
				typeof table.primaryKey === 'string'
					? toDb(table.primaryKey)
					: table.primaryKey.map(toDb),
		}),
		foreignKeys: table.foreignKeys.map((fk) => ({
			...fk,
			columns: fk.columns.map(toDb),
			references: {
				table: toDb(fk.references.table),
				columns: fk.references.columns.map(toDb),
			},
		})),
		indexes: table.indexes.map((idx) => ({
			...idx,
			columns: idx.columns.map(toDb),
		})),
		...(table.partition
			? {
					partition: {
						strategy: table.partition.strategy,
						columns: table.partition.columns.map(toDb),
					},
				}
			: {}),
	};
}

// ============================================================================
// Column Comparison
// ============================================================================

function compareColumns(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const schemaColMap = new Map(schema.columns.map((c) => [c.name, c]));
	const dbColMap = new Map(db.columns.map((c) => [c.name, c]));

	// Columns in schema but not in DB → add_column
	for (const [name, schemaCol] of schemaColMap) {
		if (!dbColMap.has(name)) {
			changes.push({
				kind: 'add_column',
				table: schema.name,
				column: name,
				destructive: false,
				details: `Add column "${name}" (${schemaCol.type}${schemaCol.nullable ? '' : ' NOT NULL'})`,
				meta: { column: schemaCol },
			});
			continue;
		}

		// Column exists in both → compare type, nullable, default
		const dbCol = dbColMap.get(name)!;
		compareColumnDetails(schema.name, schemaCol, dbCol, changes);
	}

	// Columns in DB but not in schema → drop_column
	for (const [name] of dbColMap) {
		if (!schemaColMap.has(name)) {
			changes.push({
				kind: 'drop_column',
				table: schema.name,
				column: name,
				destructive: true,
				details: `Drop column "${name}"`,
			});
		}
	}
}

function compareColumnDetails(
	tableName: string,
	schema: ColumnIR,
	db: ColumnIR,
	changes: SchemaChange[],
): void {
	// Type change — prefer originalDbType when both sides carry it (e.g. vector(768) → vector(1024))
	const schemaDbType = schema.originalDbType?.toLowerCase();
	const dbDbType = db.originalDbType?.toLowerCase();

	if (schemaDbType && dbDbType && schemaDbType !== dbDbType) {
		// Both have originalDbType and they differ → precision/type change
		changes.push({
			kind: 'alter_column_type',
			table: tableName,
			column: schema.name,
			destructive: true,
			details: `Change type of "${schema.name}" from ${db.originalDbType} to ${schema.originalDbType}`,
			meta: {
				fromType: db.originalDbType,
				toType: schema.originalDbType,
				column: schema,
			},
		});
	} else if (!areTypesEquivalent(schema.type, db.type)) {
		// Fall back to base type comparison (original behavior)
		changes.push({
			kind: 'alter_column_type',
			table: tableName,
			column: schema.name,
			destructive: true,
			details: `Change type of "${schema.name}" from ${db.type} to ${schema.type}`,
			meta: { fromType: db.type, toType: schema.type, column: schema },
		});
	}

	// Nullable change
	if (schema.nullable !== db.nullable) {
		changes.push({
			kind: 'alter_column_nullable',
			table: tableName,
			column: schema.name,
			destructive: false,
			details: `Change nullable of "${schema.name}" from ${db.nullable} to ${schema.nullable}`,
			meta: { nullable: schema.nullable, oldNullable: db.nullable },
		});
	}

	// Default change — compare normalized string representations
	const schemaDefault = normalizeDefault(schema.default);
	const dbDefault = normalizeDefault(db.default);
	if (schemaDefault !== dbDefault) {
		changes.push({
			kind: 'alter_column_default',
			table: tableName,
			column: schema.name,
			destructive: false,
			details: `Change default of "${schema.name}" from ${dbDefault ?? 'none'} to ${schemaDefault ?? 'none'}`,
			meta: { default: schema.default, oldDefault: db.default },
		});
	}

	// Unique change — missing unique is equivalent to false
	const schemaUnique = schema.unique === true;
	const dbUnique = db.unique === true;
	if (schemaUnique !== dbUnique) {
		changes.push({
			kind: 'alter_column_unique',
			table: tableName,
			column: schema.name,
			destructive: false,
			details: `Change unique of "${schema.name}" from ${dbUnique} to ${schemaUnique}`,
			meta: { unique: schemaUnique },
		});
	}

	// Collation change
	if ((schema.collation ?? null) !== (db.collation ?? null)) {
		changes.push({
			kind: 'alter_column_collation',
			table: tableName,
			column: schema.name,
			destructive: false,
			details: `Change collation of "${schema.name}" to ${schema.collation ?? 'default'}`,
			meta: { column: schema },
		});
	}

	// Identity change
	if ((schema.identity ?? null) !== (db.identity ?? null)) {
		changes.push({
			kind: 'alter_column_identity',
			table: tableName,
			column: schema.name,
			destructive: false,
			details: `Change identity of "${schema.name}" to ${schema.identity ?? 'none'}`,
			meta: { column: schema, previousIdentity: db.identity },
		});
	}
}

// ============================================================================
// Type Equivalence
// ============================================================================

/**
 * Type equivalence classes — groups of ColumnTypes that map to the same
 * PostgreSQL data type and should not trigger alter_column_type.
 *
 * - timestamp/datetime → both are TIMESTAMPTZ
 *
 * Note: number/integer are NOT equivalent because `number` can represent
 * NUMERIC(precision,scale) via originalDbType, which differs from INTEGER.
 */
const TYPE_EQUIVALENCE: ReadonlyMap<string, string> = new Map([
	['timestamp', 'timestamptz'],
	['datetime', 'timestamptz'],
]);

function areTypesEquivalent(a: string, b: string): boolean {
	if (a === b) return true;
	const canonA = TYPE_EQUIVALENCE.get(a);
	const canonB = TYPE_EQUIVALENCE.get(b);
	return canonA !== undefined && canonA === canonB;
}

// ============================================================================
// Default Normalization
// ============================================================================

/**
 * Normalize default values for comparison.
 *
 * PostgreSQL introspection returns defaults with type casts and quoting:
 *   'deploy'::character varying  →  deploy
 *   ''::text                     →  (empty string)
 *   42::integer                  →  42
 *   gen_random_uuid()            →  gen_random_uuid()
 *   now()                        →  now()
 */
function normalizeDefault(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;

	let str: string;
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		const rawSql = (value as Record<string, unknown>).sql;
		if (typeof rawSql !== 'string') {
			throw new Error(
				`normalizeDefault({ sql }): expected string, got ${typeof rawSql}`,
			);
		}
		str = rawSql;
	} else {
		str = String(value);
	}

	// Strip PostgreSQL type casts: 'value'::type → value
	// Handles: 'deploy'::character varying, ''::text, '{}'::text[]
	str = str.replace(/^'(.*)'::[\w\s[\]]+$/, '$1');

	// Also strip unquoted casts: 42::integer → 42
	// But NOT function calls like gen_random_uuid()
	if (!str.includes('(')) {
		str = str.replace(/^(.+?)::[\w\s[\]]+$/, '$1');
	}

	return str;
}

// ============================================================================
// Primary Key Comparison
// ============================================================================

function comparePrimaryKeys(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const schemaPK = normalizePK(schema.primaryKey);
	const dbPK = normalizePK(db.primaryKey);

	const sameKeys =
		schemaPK.length === dbPK.length &&
		schemaPK.every((col, i) => col === dbPK[i]);

	if (sameKeys) return;

	// PK in schema but not in DB → add
	if (schemaPK.length > 0 && dbPK.length === 0) {
		changes.push({
			kind: 'add_primary_key',
			table: schema.name,
			destructive: false,
			details: `Add primary key (${schemaPK.join(', ')})`,
			meta: { columns: schemaPK },
		});
		return;
	}

	// PK in DB but not in schema → drop
	if (schemaPK.length === 0 && dbPK.length > 0) {
		changes.push({
			kind: 'drop_primary_key',
			table: schema.name,
			destructive: true,
			details: `Drop primary key (${dbPK.join(', ')})`,
			meta: { columns: dbPK },
		});
		return;
	}

	// PK differs → drop + add
	changes.push({
		kind: 'drop_primary_key',
		table: schema.name,
		destructive: true,
		details: `Drop primary key (${dbPK.join(', ')})`,
		meta: { columns: dbPK },
	});
	changes.push({
		kind: 'add_primary_key',
		table: schema.name,
		destructive: false,
		details: `Add primary key (${schemaPK.join(', ')})`,
		meta: { columns: schemaPK },
	});
}

function normalizePK(pk: string | readonly string[] | undefined): string[] {
	if (!pk) return [];
	if (typeof pk === 'string') return [pk];
	return Array.from(pk);
}

// ============================================================================
// Foreign Key Comparison
// ============================================================================

function compareForeignKeys(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const schemaFKs = schema.foreignKeys;
	const dbFKs = db.foreignKeys;

	// Build a key for each FK: "localCols→targetTable(targetCols)"
	const schemaFKMap = new Map(schemaFKs.map((fk) => [fkKey(fk), fk]));
	const dbFKMap = new Map(dbFKs.map((fk) => [fkKey(fk), fk]));

	// FKs in schema but not in DB → add
	for (const [key, fk] of schemaFKMap) {
		if (!dbFKMap.has(key)) {
			changes.push({
				kind: 'add_foreign_key',
				table: schema.name,
				destructive: false,
				details: `Add FK (${fk.columns.join(', ')}) → ${fk.references.table}(${fk.references.columns.join(', ')})`,
				meta: { fk },
			});
		} else {
			// FK exists in both — check onDelete, onUpdate, deferred, and notValid
			const dbFK = dbFKMap.get(key)!;
			const schemaOnDelete = fk.onDelete ?? 'NO ACTION';
			const dbOnDelete = dbFK.onDelete ?? 'NO ACTION';
			const schemaOnUpdate = fk.onUpdate ?? 'NO ACTION';
			const dbOnUpdate = dbFK.onUpdate ?? 'NO ACTION';
			const schemaDeferred = fk.deferred ?? false;
			const dbDeferred = dbFK.deferred ?? false;
			if (
				schemaOnDelete !== dbOnDelete ||
				schemaOnUpdate !== dbOnUpdate ||
				schemaDeferred !== dbDeferred
			) {
				changes.push({
					kind: 'alter_foreign_key',
					table: schema.name,
					destructive: false,
					details: `Alter FK (${fk.columns.join(', ')}) — onDelete/onUpdate/deferred changed`,
					meta: { fk, previousOnDelete: dbOnDelete, oldFk: dbFK },
				});
			}
			// notValid: true in DB but false/undefined in schema → emit validate_constraint
			const dbNotValid = dbFK.notValid ?? false;
			const schemaNotValid = fk.notValid ?? false;
			if (dbNotValid && !schemaNotValid) {
				changes.push({
					kind: 'validate_constraint',
					table: schema.name,
					destructive: false,
					details: `Validate FK constraint on (${fk.columns.join(', ')})`,
					meta: { fk },
				});
			}
		}
	}

	// FKs in DB but not in schema → drop
	for (const [key, fk] of dbFKMap) {
		if (!schemaFKMap.has(key)) {
			changes.push({
				kind: 'drop_foreign_key',
				table: schema.name,
				destructive: true,
				details: `Drop FK (${fk.columns.join(', ')}) → ${fk.references.table}(${fk.references.columns.join(', ')})`,
				meta: { fk },
			});
		}
	}
}

function fkKey(fk: ForeignKeyIR): string {
	return `${fk.columns.join(',')}→${fk.references.schema ?? ''}.${fk.references.table}(${fk.references.columns.join(',')})`;
}

// ============================================================================
// Index Comparison
// ============================================================================

function compareIndexes(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	// Build the set of FK auto-index keys.
	// generateDDL (fkAutoIndex=true default) creates an index for every single-column FK that
	// does not already have an explicit index.  These indexes are managed automatically — they
	// should never trigger create_index or drop_index diffs.
	const explicitIndexCols = new Set(
		schema.indexes.flatMap((idx) =>
			idx.columns.length === 1 ? idx.columns : [],
		),
	);
	const autoFkIndexKeys = new Set(
		schema.foreignKeys
			.filter(
				(fk) =>
					fk.columns.length === 1 &&
					fk.columns[0] !== undefined &&
					!explicitIndexCols.has(fk.columns[0]),
			)
			.map((fk) =>
				indexKey({
					columns: fk.columns,
					unique: false,
				}),
			),
	);

	// Index identity: structural definition (name is cosmetic)
	const schemaIdxMap = new Map(
		schema.indexes.map((idx) => [indexKey(idx), idx]),
	);
	const dbIdxMap = new Map(db.indexes.map((idx) => [indexKey(idx), idx]));

	// Explicit indexes in schema but not in DB → create
	for (const [key, idx] of schemaIdxMap) {
		if (!dbIdxMap.has(key)) {
			changes.push({
				kind: 'create_index',
				table: schema.name,
				destructive: false,
				details: `Create ${idx.unique ? 'unique ' : ''}index on (${idx.columns.join(', ')})`,
				meta: { index: idx },
			});
		}
	}

	// Auto-unique index keys: col.unique=true generates an implicit UNIQUE index in the DB,
	// but this does not appear in ModelIR's indexes[] array.  These are auto-managed and must
	// never trigger a drop_index diff. Include either side when the column exists on both
	// sides, because compareColumnDetails owns the col.unique toggle.
	const dbColMap = new Map(db.columns.map((col) => [col.name, col]));
	const autoUniqueIndexColumns = new Set(
		schema.columns
			.filter((schemaCol) => {
				const dbCol = dbColMap.get(schemaCol.name);
				return (
					dbCol !== undefined &&
					(schemaCol.unique === true || dbCol.unique === true)
				);
			})
			.map((col) => col.name),
	);

	// Indexes in DB but not in schema → drop (skip auto-FK and auto-unique indexes — they are auto-managed)
	for (const [key, idx] of dbIdxMap) {
		if (
			!schemaIdxMap.has(key) &&
			!autoFkIndexKeys.has(key) &&
			!isAutoUniqueIndex(schema.name, idx, autoUniqueIndexColumns)
		) {
			changes.push({
				kind: 'drop_index',
				table: schema.name,
				destructive: false,
				details: `Drop index ${idx.name ?? `on (${idx.columns.join(', ')})`}`,
				meta: { index: idx },
			});
		}
	}
}

function isAutoUniqueIndex(
	tableName: string,
	idx: IndexIR,
	autoUniqueIndexColumns: ReadonlySet<string>,
): boolean {
	if (idx.columns.length !== 1) return false;
	const column = idx.columns[0];
	if (column === undefined || !autoUniqueIndexColumns.has(column)) return false;
	if (idx.unique !== true) return false;
	if (idx.name !== undefined && idx.name !== `${tableName}_${column}_key`) {
		return false;
	}
	return (
		idx.nullsNotDistinct !== true &&
		(idx.method === undefined || idx.method === 'btree') &&
		idx.where === undefined &&
		(idx.expressions === undefined || idx.expressions.length === 0) &&
		(idx.include === undefined || idx.include.length === 0) &&
		(idx.opclass === undefined || Object.keys(idx.opclass).length === 0) &&
		(idx.with === undefined || Object.keys(idx.with).length === 0)
	);
}

function indexKey(idx: IndexIR): string {
	const parts = [
		idx.columns.join(','),
		idx.unique ? 'unique' : 'nonunique',
		idx.unique && idx.nullsNotDistinct ? 'nulls-not-distinct' : '',
		idx.method ?? 'btree',
		idx.where ?? '',
		(idx.expressions ?? []).join(','),
		idx.opclass
			? Object.entries(idx.opclass)
					.sort()
					.map(([k, v]) => `${k}=${v}`)
					.join(',')
			: '',
		idx.with
			? Object.entries(idx.with)
					.sort()
					.map(([k, v]) => `${k}=${v}`)
					.join(',')
			: '',
	];
	return parts.join(':');
}

// ============================================================================
// Summary Builder
// ============================================================================

// ============================================================================
// compareCheckConstraints
// ============================================================================
// ============================================================================
// Comments
// ============================================================================

function compareComments(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	// Table-level comment
	if ((schema.comment ?? null) !== (db.comment ?? null)) {
		if (schema.comment) {
			changes.push({
				kind: 'add_comment',
				table: schema.name,
				destructive: false,
				details: `Set comment on table "${schema.name}"`,
				meta: { comment: schema.comment, target: 'table' },
			});
		} else {
			changes.push({
				kind: 'drop_comment',
				table: schema.name,
				destructive: false,
				details: `Remove comment from table "${schema.name}"`,
				meta: { target: 'table' },
			});
		}
	}

	// Column-level comments
	for (const schemaCol of schema.columns) {
		const dbCol = db.columns.find((c) => c.name === schemaCol.name);
		if (!dbCol) continue;
		if ((schemaCol.comment ?? null) !== (dbCol.comment ?? null)) {
			if (schemaCol.comment) {
				changes.push({
					kind: 'add_comment',
					table: schema.name,
					column: schemaCol.name,
					destructive: false,
					details: `Set comment on "${schema.name}"."${schemaCol.name}"`,
					meta: { comment: schemaCol.comment, target: 'column' },
				});
			} else {
				changes.push({
					kind: 'drop_comment',
					table: schema.name,
					column: schemaCol.name,
					destructive: false,
					details: `Remove comment from "${schema.name}"."${schemaCol.name}"`,
					meta: { target: 'column' },
				});
			}
		}
	}
}

// ============================================================================
// Partition Diff
// ============================================================================

/**
 * Compare partition configs between schema and DB.
 * PostgreSQL does not support ALTER TABLE ... SET PARTITION STRATEGY.
 * Any mismatch (add, remove, or change) requires DROP + CREATE.
 * We emit a destructive drop_table change with isPartitionChange=true as a marker.
 */
function comparePartitions(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const sp = schema.partition as PartitionIR | undefined;
	const dp = db.partition as PartitionIR | undefined;

	if (!sp && !dp) return; // Neither has partition — nothing to do

	if (sp && dp) {
		// Both have partition — check if config matches
		const sameStrategy = sp.strategy === dp.strategy;
		const sameCols = sp.columns.join(',') === dp.columns.join(',');
		if (!sameStrategy || !sameCols) {
			changes.push({
				kind: 'drop_table',
				table: schema.name,
				destructive: true,
				details: `Cannot alter partition strategy of "${schema.name}" (${dp.strategy} → ${sp.strategy}). Requires DROP + CREATE (data migration needed).`,
				meta: { isPartitionChange: true },
			});
		}
		// Same config → no change needed
	} else if (sp && !dp) {
		// Adding partition to non-partitioned table
		changes.push({
			kind: 'drop_table',
			table: schema.name,
			destructive: true,
			details: `Cannot add partition to existing table "${schema.name}". Requires DROP + CREATE (data migration needed).`,
			meta: { isPartitionChange: true },
		});
	} else {
		// Removing partition from partitioned table
		changes.push({
			kind: 'drop_table',
			table: schema.name,
			destructive: true,
			details: `Cannot remove partition from existing table "${schema.name}". Requires DROP + CREATE (data migration needed).`,
			meta: { isPartitionChange: true },
		});
	}
}

function compareCheckConstraints(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const schemaChecks = schema.checkConstraints ?? [];
	const dbChecks = db.checkConstraints ?? [];

	// Build map by constraint name
	const schemaMap = new Map(schemaChecks.map((c) => [c.name, c]));
	const dbMap = new Map(dbChecks.map((c) => [c.name, c]));

	// In schema but not in DB → add
	for (const [name, check] of schemaMap) {
		if (!dbMap.has(name)) {
			changes.push({
				kind: 'add_check_constraint',
				table: schema.name,
				destructive: false,
				details: `Add CHECK constraint "${name}" ${check.expression}`,
				meta: { check },
			});
		} else {
			// Both have it — compare expression and notValid
			const dbCheck = dbMap.get(name)!;
			if (check.expression !== dbCheck.expression) {
				// Expression changed → drop + re-add
				changes.push({
					kind: 'drop_check_constraint',
					table: schema.name,
					destructive: true,
					details: `Drop CHECK constraint "${name}" (expression changed)`,
					meta: { check: dbCheck },
				});
				changes.push({
					kind: 'add_check_constraint',
					table: schema.name,
					destructive: false,
					details: `Add CHECK constraint "${name}" ${check.expression}`,
					meta: { check },
				});
			} else {
				// notValid: true in DB but false/undefined in schema → emit validate_constraint
				const dbNotValid = dbCheck.notValid ?? false;
				const schemaNotValid = check.notValid ?? false;
				if (dbNotValid && !schemaNotValid) {
					changes.push({
						kind: 'validate_constraint',
						table: schema.name,
						destructive: false,
						details: `Validate CHECK constraint "${name}"`,
						meta: { check },
					});
				}
			}
		}
	}

	// In DB but not in schema → drop
	for (const [name, check] of dbMap) {
		if (!schemaMap.has(name)) {
			changes.push({
				kind: 'drop_check_constraint',
				table: schema.name,
				destructive: true,
				details: `Drop CHECK constraint "${name}"`,
				meta: { check },
			});
		}
	}
}

// ============================================================================
// ENUM comparison (schema-level, not table-level)
// ============================================================================

function compareEnums(
	schema: ModelIR,
	db: ModelIR,
	changes: SchemaChange[],
): void {
	const schemaEnums = schema.enums ?? new Map<string, EnumIR>();
	const dbEnums = db.enums ?? new Map<string, EnumIR>();

	// Enums in schema but not in DB → create
	for (const [name, enumDef] of schemaEnums) {
		if (!dbEnums.has(name)) {
			changes.push({
				kind: 'create_enum',
				table: '',
				destructive: false,
				details: `Create enum "${name}" with values (${enumDef.values.join(', ')})`,
				meta: { enum: enumDef },
			});
		} else {
			// Exists in both → check for new values
			const dbEnum = dbEnums.get(name)!;
			// Find values in schema that are not in DB → add
			for (let i = 0; i < enumDef.values.length; i++) {
				const val = enumDef.values[i]!;
				if (!dbEnum.values.includes(val)) {
					const prevVal = i > 0 ? enumDef.values[i - 1] : undefined;
					changes.push({
						kind: 'alter_enum_add_value',
						table: '',
						destructive: false,
						details: `Add value '${val}' to enum "${name}"${prevVal ? ` after '${prevVal}'` : ''}`,
						meta: { enum: enumDef, value: val, after: prevVal },
					});
				}
			}
			// Values in DB but not in schema → PG limitation, flag as error
			for (const val of dbEnum.values) {
				if (!enumDef.values.includes(val)) {
					changes.push({
						kind: 'drop_enum',
						table: '',
						destructive: true,
						details: `Cannot remove value '${val}' from enum "${name}" — PostgreSQL limitation. Requires DROP TYPE + CREATE TYPE (data migration needed).`,
						meta: { enum: dbEnum, removedValue: val, isValueRemoval: true },
					});
				}
			}
		}
	}

	// Enums in DB but not in schema → drop
	for (const [name, enumDef] of dbEnums) {
		if (!schemaEnums.has(name)) {
			// Scan DB tables for columns still referencing this enum type.
			// These must be cast to text before the DROP TYPE can succeed.
			const referencingColumns: Array<{ table: string; column: string }> = [];
			for (const [tableName, tableIR] of db.tables) {
				for (const col of tableIR.columns) {
					if (col.originalDbType === name) {
						referencingColumns.push({ table: tableName, column: col.name });
					}
				}
			}
			changes.push({
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: `Drop enum "${name}"`,
				meta: { enum: enumDef, referencingColumns },
			});
		}
	}
}

// ============================================================================
// Extension Diff
// ============================================================================

function compareExtensions(
	schema: ModelIR,
	db: ModelIR,
	changes: SchemaChange[],
	opts: { ignoreUnmanaged: boolean } = { ignoreUnmanaged: false },
): void {
	const schemaExts = new Set(schema.extensions ?? []);
	const dbExts = new Set(db.extensions ?? []);

	for (const ext of schemaExts) {
		if (!dbExts.has(ext)) {
			changes.push({
				kind: 'create_extension',
				table: '',
				destructive: false,
				details: `Create extension "${ext}"`,
				meta: { extension: ext },
			});
		}
	}

	if (!opts.ignoreUnmanaged) {
		for (const ext of dbExts) {
			if (!schemaExts.has(ext)) {
				changes.push({
					kind: 'drop_extension',
					table: '',
					destructive: true,
					details: `Drop extension "${ext}"`,
					meta: { extension: ext },
				});
			}
		}
	}
}

// ============================================================================
// Sequence Diff
// ============================================================================

function compareSequences(
	schema: ModelIR,
	db: ModelIR,
	changes: SchemaChange[],
): void {
	const schemaSeqs = schema.sequences ?? new Map<string, SequenceIR>();
	const dbSeqs = db.sequences ?? new Map<string, SequenceIR>();

	// Sequences in schema but not in DB → create
	for (const [name, seq] of schemaSeqs) {
		if (!dbSeqs.has(name)) {
			changes.push({
				kind: 'create_sequence',
				table: '',
				destructive: false,
				details: `Create sequence "${name}"`,
				meta: { sequence: seq },
			});
		} else {
			const dbSeq = dbSeqs.get(name)!;
			// Compare relevant properties
			if (
				seq.startWith !== dbSeq.startWith ||
				seq.incrementBy !== dbSeq.incrementBy ||
				seq.minValue !== dbSeq.minValue ||
				seq.maxValue !== dbSeq.maxValue ||
				seq.cycle !== dbSeq.cycle
			) {
				changes.push({
					kind: 'alter_sequence',
					table: '',
					destructive: false,
					details: `Alter sequence "${name}"`,
					meta: { sequence: seq, previousSequence: dbSeq },
				});
			}
		}
	}

	// Sequences in DB but not in schema → drop
	for (const [name, seq] of dbSeqs) {
		if (!schemaSeqs.has(name)) {
			changes.push({
				kind: 'drop_sequence',
				table: '',
				destructive: true,
				details: `Drop sequence "${name}"`,
				meta: { sequence: seq },
			});
		}
	}
}

// ============================================================================
// RLS Policy Comparison
// ============================================================================

function comparePolicies(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	const schemaRlsEnabled = schema.rlsEnabled ?? false;
	const dbRlsEnabled = db.rlsEnabled ?? false;

	// RLS enabled state changed
	if (schemaRlsEnabled && !dbRlsEnabled) {
		changes.push({
			kind: 'enable_rls',
			table: schema.name,
			destructive: false,
			details: `Enable RLS on table "${schema.name}"`,
		});
	} else if (!schemaRlsEnabled && dbRlsEnabled) {
		changes.push({
			kind: 'disable_rls',
			table: schema.name,
			destructive: false,
			details: `Disable RLS on table "${schema.name}"`,
		});
	}

	const schemaPolicies = schema.policies ?? [];
	const dbPolicies = db.policies ?? [];

	const schemaMap = new Map<string, PolicyIR>(
		schemaPolicies.map((p) => [p.name, p]),
	);
	const dbMap = new Map<string, PolicyIR>(dbPolicies.map((p) => [p.name, p]));

	// In schema but not in DB → create
	for (const [name, policy] of schemaMap) {
		if (!dbMap.has(name)) {
			changes.push({
				kind: 'create_policy',
				table: schema.name,
				destructive: false,
				details: `Create policy "${name}" on "${schema.name}"`,
				meta: { policy },
			});
		} else {
			// Policy exists in both — compare all fields; if changed → drop + recreate
			const dbPolicy = dbMap.get(name)!;
			const changed =
				policy.command !== dbPolicy.command ||
				policy.using !== dbPolicy.using ||
				policy.withCheck !== dbPolicy.withCheck ||
				policy.permissive !== dbPolicy.permissive ||
				JSON.stringify(policy.roles ?? []) !==
					JSON.stringify(dbPolicy.roles ?? []);
			if (changed) {
				changes.push({
					kind: 'drop_policy',
					table: schema.name,
					destructive: false,
					details: `Drop policy "${name}" on "${schema.name}" (changed)`,
					meta: { policy: dbPolicy },
				});
				changes.push({
					kind: 'create_policy',
					table: schema.name,
					destructive: false,
					details: `Create policy "${name}" on "${schema.name}"`,
					meta: { policy },
				});
			}
		}
	}

	// In DB but not in schema → drop
	for (const [name, policy] of dbMap) {
		if (!schemaMap.has(name)) {
			changes.push({
				kind: 'drop_policy',
				table: schema.name,
				destructive: false,
				details: `Drop policy "${name}" on "${schema.name}"`,
				meta: { policy },
			});
		}
	}
}

function buildSummary(changes: readonly SchemaChange[]): DiffSummary {
	const tables = { added: 0, dropped: 0 };
	const columns = { added: 0, dropped: 0, altered: 0 };
	const indexes = { added: 0, dropped: 0 };
	const constraints = { added: 0, dropped: 0, altered: 0 };

	for (const c of changes) {
		switch (c.kind) {
			case 'create_table':
				tables.added++;
				break;
			case 'drop_table':
				tables.dropped++;
				break;
			case 'add_column':
				columns.added++;
				break;
			case 'drop_column':
				columns.dropped++;
				break;
			case 'alter_column_type':
			case 'alter_column_nullable':
			case 'alter_column_default':
			case 'alter_column_unique':
				columns.altered++;
				break;
			case 'add_primary_key':
			case 'add_foreign_key':
			case 'add_check_constraint':
				constraints.added++;
				break;
			case 'drop_primary_key':
			case 'drop_foreign_key':
			case 'drop_check_constraint':
				constraints.dropped++;
				break;
			case 'alter_foreign_key':
				constraints.altered++;
				break;
			case 'create_index':
				indexes.added++;
				break;
			case 'drop_index':
				indexes.dropped++;
				break;
			case 'create_enum':
			case 'alter_enum_add_value':
			case 'drop_enum':
				// ENUM changes are schema-level; not counted in table/column/index summaries
				break;
			case 'alter_column_collation':
			case 'alter_column_identity':
				columns.altered++;
				break;
			case 'add_comment':
			case 'drop_comment':
			case 'create_extension':
			case 'drop_extension':
			case 'create_sequence':
			case 'alter_sequence':
			case 'drop_sequence':
			case 'enable_rls':
			case 'disable_rls':
			case 'create_policy':
			case 'drop_policy':
				// Schema-level or metadata changes; not counted in table/column/index/constraint summaries
				break;
		}
	}

	return { tables, columns, indexes, constraints };
}
