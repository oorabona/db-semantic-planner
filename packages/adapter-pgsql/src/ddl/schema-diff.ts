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
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	TableIR,
} from '@dbsp/types';

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
	| 'drop_index';

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
// Comparison Engine
// ============================================================================

/**
 * Compare two ModelIRs and produce a structured diff.
 *
 * @param schema - The desired schema (from definition)
 * @param db - The current database state (from introspection)
 * @returns SchemaDiff with all changes needed to bring DB in sync with schema
 */
export function compareSchemata(schema: ModelIR, db: ModelIR): SchemaDiff {
	const changes: SchemaChange[] = [];

	const schemaTables = new Map(schema.tables);
	const dbTables = new Map(db.tables);

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
			continue;
		}

		// Table exists in both → compare columns, constraints, indexes
		const dbTable = dbTables.get(name)!;
		compareColumns(schemaTable, dbTable, changes);
		comparePrimaryKeys(schemaTable, dbTable, changes);
		compareForeignKeys(schemaTable, dbTable, changes);
		compareIndexes(schemaTable, dbTable, changes);
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
	// Type change
	if (schema.type !== db.type) {
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

/**
 * Normalize default values for comparison.
 * PostgreSQL introspection returns defaults with type casts, parentheses, etc.
 */
function normalizeDefault(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		return String((value as Record<string, unknown>).sql);
	}
	return String(value);
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
				constraints.added++;
				break;
			case 'drop_primary_key':
			case 'drop_foreign_key':
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
		}
	}

	return { tables, columns, indexes, constraints };
}
