/**
 * Migration SQL Generator (DDL-PROV Block 1)
 *
 * Generates ordered SQL statements from a SchemaDiff.
 * Statements are topologically sorted: DROP constraints → DROP objects → CREATE objects → ADD constraints.
 *
 * @module migration-sql
 */

import type { ColumnIR, ForeignKeyIR, IndexIR, TableIR } from '@dbsp/types';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ============================================================================
// Types
// ============================================================================

export interface MigrationSQLOptions {
	/** Schema namespace (default: none — unqualified) */
	readonly schemaName?: string;
	/** Whether to include destructive changes (drops) */
	readonly includeDestructive?: boolean;
}

// ============================================================================
// SQL Generation
// ============================================================================

/**
 * Generate ordered SQL statements from a SchemaDiff.
 *
 * Topological order:
 * 1. DROP FK constraints (must drop before referenced tables)
 * 2. DROP indexes
 * 3. DROP columns
 * 4. DROP primary keys
 * 5. DROP tables
 * 6. CREATE tables
 * 7. ADD columns
 * 8. ALTER columns (type, nullable, default)
 * 9. ADD primary keys
 * 10. ADD FK constraints (must add after referenced tables exist)
 * 11. CREATE indexes
 */
export function generateMigrationSQL(
	diff: SchemaDiff,
	options?: MigrationSQLOptions,
): readonly string[] {
	const schemaName = options?.schemaName;
	const includeDestructive = options?.includeDestructive ?? true;

	// Filter out destructive changes if not included
	const changes = includeDestructive
		? diff.changes
		: diff.changes.filter((c) => !c.destructive);

	// Group changes by phase for topological ordering
	const phases: SchemaChange[][] = [
		[], // 0: drop FK
		[], // 1: drop index
		[], // 2: drop column
		[], // 3: drop PK
		[], // 4: drop table
		[], // 5: create table
		[], // 6: add column
		[], // 7: alter column
		[], // 8: add PK
		[], // 9: add FK
		[], // 10: alter FK (drop + re-add)
		[], // 11: create index
	];

	for (const change of changes) {
		const phase = getPhase(change.kind);
		phases[phase]!.push(change);
	}

	// Generate SQL in phase order
	const statements: string[] = [];
	for (const phase of phases) {
		for (const change of phase) {
			const sql = changeToSQL(change, schemaName);
			if (sql) statements.push(sql);
		}
	}

	return statements;
}

// ============================================================================
// Phase Mapping (Topological Order)
// ============================================================================

function getPhase(kind: SchemaChange['kind']): number {
	switch (kind) {
		case 'drop_foreign_key':
			return 0;
		case 'drop_index':
			return 1;
		case 'drop_column':
			return 2;
		case 'drop_primary_key':
			return 3;
		case 'drop_table':
			return 4;
		case 'create_table':
			return 5;
		case 'add_column':
			return 6;
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
			return 7;
		case 'add_primary_key':
			return 8;
		case 'add_foreign_key':
			return 9;
		case 'alter_foreign_key':
			return 10;
		case 'create_index':
			return 11;
	}
}

// ============================================================================
// SQL Generators per ChangeKind
// ============================================================================

function changeToSQL(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const q = (name: string) => `"${name}"`;
	const qualTable = (table: string) =>
		schemaName ? `${q(schemaName)}.${q(table)}` : q(table);

	switch (change.kind) {
		case 'create_table': {
			const table = change.meta?.table as TableIR | undefined;
			if (!table) return undefined;
			return generateCreateTableSQL(table, schemaName);
		}

		case 'drop_table':
			return `DROP TABLE IF EXISTS ${qualTable(change.table)} CASCADE;`;

		case 'add_column': {
			const col = change.meta?.column as ColumnIR | undefined;
			if (!col) return undefined;
			const typeName = mapColumnType(col);
			const notNull = !col.nullable && !col.autoIncrement ? ' NOT NULL' : '';
			const def =
				col.default !== undefined
					? ` DEFAULT ${formatDefault(col.default)}`
					: '';
			const unique = col.unique ? ' UNIQUE' : '';
			return `ALTER TABLE ${qualTable(change.table)} ADD COLUMN ${q(col.name)} ${typeName}${notNull}${def}${unique};`;
		}

		case 'drop_column':
			return `ALTER TABLE ${qualTable(change.table)} DROP COLUMN ${q(change.column!)} CASCADE;`;

		case 'alter_column_type': {
			const col = change.meta?.column as ColumnIR | undefined;
			const toType = col ? mapColumnType(col) : String(change.meta?.toType);
			return `ALTER TABLE ${qualTable(change.table)} ALTER COLUMN ${q(change.column!)} TYPE ${toType};`;
		}

		case 'alter_column_nullable': {
			const nullable = change.meta?.nullable as boolean;
			const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
			return `ALTER TABLE ${qualTable(change.table)} ALTER COLUMN ${q(change.column!)} ${action};`;
		}

		case 'alter_column_default': {
			const def = change.meta?.default;
			if (def === undefined || def === null) {
				return `ALTER TABLE ${qualTable(change.table)} ALTER COLUMN ${q(change.column!)} DROP DEFAULT;`;
			}
			return `ALTER TABLE ${qualTable(change.table)} ALTER COLUMN ${q(change.column!)} SET DEFAULT ${formatDefault(def)};`;
		}

		case 'add_primary_key': {
			const columns = change.meta?.columns as string[];
			const pkCols = columns.map(q).join(', ');
			const pkName = q(`pk_${change.table}`);
			return `ALTER TABLE ${qualTable(change.table)} ADD CONSTRAINT ${pkName} PRIMARY KEY (${pkCols});`;
		}

		case 'drop_primary_key': {
			const pkName = q(`pk_${change.table}`);
			return `ALTER TABLE ${qualTable(change.table)} DROP CONSTRAINT IF EXISTS ${pkName} CASCADE;`;
		}

		case 'add_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			return generateAddFKSQL(change.table, fk, schemaName);
		}

		case 'drop_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			const constraintName = q(`fk_${change.table}_${fk.columns.join('_')}`);
			return `ALTER TABLE ${qualTable(change.table)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
		}

		case 'alter_foreign_key': {
			// Drop + re-add with new onDelete
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			const constraintName = q(`fk_${change.table}_${fk.columns.join('_')}`);
			const drop = `ALTER TABLE ${qualTable(change.table)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
			const add = generateAddFKSQL(change.table, fk, schemaName);
			return `${drop}\n${add}`;
		}

		case 'create_index': {
			const idx = change.meta?.index as IndexIR;
			if (!idx) return undefined;
			const indexName = q(
				idx.name ?? `idx_${change.table}_${idx.columns.join('_')}`,
			);
			const unique = idx.unique ? 'UNIQUE ' : '';
			const cols = idx.columns.map(q).join(', ');
			return `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${qualTable(change.table)} (${cols});`;
		}

		case 'drop_index': {
			const idx = change.meta?.index as IndexIR;
			if (!idx) return undefined;
			const indexName = q(
				idx.name ?? `idx_${change.table}_${idx.columns.join('_')}`,
			);
			const schemaPrefix = schemaName ? `${q(schemaName)}.` : '';
			return `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`;
		}
	}
}

// ============================================================================
// Helpers
// ============================================================================

function generateCreateTableSQL(table: TableIR, schemaName?: string): string {
	const q = (name: string) => `"${name}"`;
	const qualTable = schemaName
		? `${q(schemaName)}.${q(table.name)}`
		: q(table.name);

	const elements: string[] = [];

	// Columns
	for (const col of table.columns) {
		const parts: string[] = [q(col.name), mapColumnType(col)];
		if (!col.nullable && !col.autoIncrement) parts.push('NOT NULL');
		if (col.default !== undefined)
			parts.push(`DEFAULT ${formatDefault(col.default)}`);
		if (col.unique) parts.push('UNIQUE');
		elements.push(parts.join(' '));
	}

	// Primary key
	if (table.primaryKey !== undefined) {
		const pkCols = (
			Array.isArray(table.primaryKey) ? table.primaryKey : [table.primaryKey]
		)
			.map(q)
			.join(', ');
		elements.push(
			`CONSTRAINT ${q(`pk_${table.name}`)} PRIMARY KEY (${pkCols})`,
		);
	}

	const body = elements.map((el) => `  ${el}`).join(',\n');
	return `CREATE TABLE ${qualTable} (\n${body}\n);`;
}

function generateAddFKSQL(
	tableName: string,
	fk: ForeignKeyIR,
	schemaName?: string,
): string {
	const q = (name: string) => `"${name}"`;
	const qualTable = schemaName
		? `${q(schemaName)}.${q(tableName)}`
		: q(tableName);
	const constraintName = q(`fk_${tableName}_${fk.columns.join('_')}`);
	const fkCols = fk.columns.map(q).join(', ');
	const refTable = q(fk.references.table);
	const refCols = fk.references.columns.map(q).join(', ');
	const onDelete = fk.onDelete
		? ` ON DELETE ${mapOnDeleteAction(fk.onDelete)}`
		: '';
	return `ALTER TABLE ${qualTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete};`;
}

function formatDefault(value: unknown): string {
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		return (value as Record<string, unknown>).sql as string;
	}
	if (typeof value === 'string') {
		if (value.endsWith('()')) return value;
		return `'${value.replace(/'/g, "''")}'`;
	}
	if (typeof value === 'number') return String(value);
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (value === null) return 'NULL';
	return `'${String(value)}'`;
}
