/**
 * Schema Comparison Engine (DDL-PROV Block 1)
 *
 * Compares two ModelIRs (schema definition vs database state)
 * and produces a structured diff of changes needed.
 *
 * @module schema-diff
 */

import type {
	CheckConstraintIR,
	ColumnIR,
	DbCasing,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
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
	// Constraints
	| 'add_primary_key'
	| 'drop_primary_key'
	| 'add_foreign_key'
	| 'drop_foreign_key'
	| 'alter_foreign_key'
	// Indexes
	| 'create_index'
	| 'drop_index'
	// CHECK constraints
	| 'add_check_constraint'
	| 'drop_check_constraint'
	// ENUM types
	| 'create_enum'
	| 'alter_enum_add_value'
	| 'drop_enum';

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

	// 0. Compare ENUM types (schema-level, before tables)
	compareEnums(schema, db, changes);

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
			for (const check of schemaTable.checkConstraints ?? []) {
				changes.push({
					kind: 'add_check_constraint',
					table: name,
					destructive: false,
					details: `Add CHECK constraint "${check.name}" ${check.expression}`,
					meta: { check },
				});
			}
			continue;
		}

		// Table exists in both → compare columns, constraints, indexes
		const dbTable = dbTables.get(name)!;
		compareColumns(schemaTable, dbTable, changes);
		comparePrimaryKeys(schemaTable, dbTable, changes);
		compareForeignKeys(schemaTable, dbTable, changes);
		compareIndexes(schemaTable, dbTable, changes);
		compareCheckConstraints(schemaTable, dbTable, changes);
	}

	// 2. Tables that exist in DB but not in schema → drop_table
	for (const [name] of dbTables) {
		if (!schemaTables.has(name)) {
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
		str = String((value as Record<string, unknown>).sql);
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
		});
		return;
	}

	// PK differs → drop + add
	changes.push({
		kind: 'drop_primary_key',
		table: schema.name,
		destructive: true,
		details: `Drop primary key (${dbPK.join(', ')})`,
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
			// FK exists in both — check onDelete action
			const dbFK = dbFKMap.get(key)!;
			const schemaOnDelete = fk.onDelete ?? 'NO ACTION';
			const dbOnDelete = dbFK.onDelete ?? 'NO ACTION';
			if (schemaOnDelete !== dbOnDelete) {
				changes.push({
					kind: 'alter_foreign_key',
					table: schema.name,
					destructive: false,
					details: `Change onDelete of FK (${fk.columns.join(', ')}) from ${dbOnDelete} to ${schemaOnDelete}`,
					meta: { fk, previousOnDelete: dbOnDelete, oldFk: dbFK },
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
	return `${fk.columns.join(',')}→${fk.references.table}(${fk.references.columns.join(',')})`;
}

// ============================================================================
// Index Comparison
// ============================================================================

function compareIndexes(
	schema: TableIR,
	db: TableIR,
	changes: SchemaChange[],
): void {
	// Index identity: columns + unique flag (name is cosmetic)
	const schemaIdxMap = new Map(
		schema.indexes.map((idx) => [indexKey(idx), idx]),
	);
	const dbIdxMap = new Map(db.indexes.map((idx) => [indexKey(idx), idx]));

	// Indexes in schema but not in DB → create
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

	// Indexes in DB but not in schema → drop
	for (const [key, idx] of dbIdxMap) {
		if (!schemaIdxMap.has(key)) {
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

function indexKey(idx: IndexIR): string {
	return `${idx.columns.join(',')}:${idx.unique ? 'unique' : 'nonunique'}`;
}

// ============================================================================
// Summary Builder
// ============================================================================

// ============================================================================
// compareCheckConstraints
// ============================================================================
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
			// Both have it — compare expression
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
			changes.push({
				kind: 'drop_enum',
				table: '',
				destructive: true,
				details: `Drop enum "${name}"`,
				meta: { enum: enumDef },
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
		}
	}

	return { tables, columns, indexes, constraints };
}
