/**
 * Migration SQL Generator (DDL-PROV Block 1)
 *
 * Generates ordered SQL statements from a SchemaDiff.
 * Statements are topologically sorted: DROP constraints → DROP objects → CREATE objects → ADD constraints.
 *
 * @module migration-sql
 */

import type {
	CheckConstraintIR,
	ColumnIR,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	TableIR,
} from '@dbsp/types';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ── Helpers ─────────────────────────────────────────────────────

/** Double-quote a SQL identifier. */
function q(name: string): string {
	return `"${name}"`;
}

/** Schema-qualify a table name: "schema"."table" or just "table". */
function qualifyTable(table: string, schemaName?: string): string {
	return schemaName ? `${q(schemaName)}.${q(table)}` : q(table);
}

/** PK constraint name convention. */
function pkName(table: string): string {
	return `pk_${table}`;
}

/** FK constraint name convention. */
function fkName(table: string, columns: readonly string[]): string {
	return `fk_${table}_${columns.join('_')}`;
}

/** Index name convention (custom name takes priority). */
function idxName(
	table: string,
	columns: readonly string[],
	customName?: string,
): string {
	return customName ?? `idx_${table}_${columns.join('_')}`;
}

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
 * 0.  DROP FK/CHECK constraints (must drop before referenced tables)
 * 1.  DROP indexes
 * 2.  DROP columns
 * 3.  DROP primary keys
 * 4.  DROP tables, DROP ENUMs
 * 5.  CREATE ENUMs (must exist before tables that use them)
 * 6.  CREATE tables
 * 7.  ADD columns
 * 8.  ALTER columns (type, nullable, default)
 * 9.  ADD primary keys
 * 10. ADD FK constraints (must add after referenced tables exist)
 * 11. ALTER FK (drop + re-add)
 * 12. CREATE indexes
 * 13. ADD CHECK constraints
 * 14. ALTER ENUM ADD VALUE (must be last — has transaction visibility caveats in PG)
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
		[], // 0: drop FK, drop CHECK
		[], // 1: drop index
		[], // 2: drop column
		[], // 3: drop PK
		[], // 4: drop table, drop ENUM
		[], // 5: create ENUM
		[], // 6: create table
		[], // 7: add column
		[], // 8: alter column
		[], // 9: add PK
		[], // 10: add FK
		[], // 11: alter FK (drop + re-add)
		[], // 12: create index
		[], // 13: add CHECK constraint
		[], // 14: alter ENUM add value (must be after CREATE TABLE, outside transaction)
	];

	for (const change of changes) {
		const phase = getPhase(change.kind);
		phases[phase]!.push(change);
	}

	// Generate SQL in phase order
	const statements: string[] = [];
	for (const phase of phases) {
		for (const change of phase) {
			const sql = changeToUpSQL(change, schemaName);
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
		case 'drop_check_constraint':
			return 0;
		case 'drop_index':
			return 1;
		case 'drop_column':
			return 2;
		case 'drop_primary_key':
			return 3;
		case 'drop_table':
		case 'drop_enum':
			return 4;
		case 'create_enum':
			return 5;
		case 'create_table':
			return 6;
		case 'add_column':
			return 7;
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
			return 8;
		case 'add_primary_key':
			return 9;
		case 'add_foreign_key':
			return 10;
		case 'alter_foreign_key':
			return 11;
		case 'create_index':
			return 12;
		case 'add_check_constraint':
			return 13;
		case 'alter_enum_add_value':
			return 14;
	}
}

// ============================================================================
// SQL Generators per ChangeKind
// ============================================================================

function changeToUpSQL(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	switch (change.kind) {
		case 'create_table': {
			const table = change.meta?.table as TableIR | undefined;
			if (!table) return undefined;
			return generateCreateTableSQL(table, schemaName);
		}

		case 'drop_table':
			return `DROP TABLE IF EXISTS ${qualifyTable(change.table, schemaName)} CASCADE;`;

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
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD COLUMN ${q(col.name)} ${typeName}${notNull}${def}${unique};`;
		}

		case 'drop_column':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP COLUMN ${q(change.column!)} CASCADE;`;

		case 'alter_column_type': {
			const col = change.meta?.column as ColumnIR | undefined;
			const toType = col ? mapColumnType(col) : String(change.meta?.toType);
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} TYPE ${toType};`;
		}

		case 'alter_column_nullable': {
			const nullable = change.meta?.nullable as boolean;
			const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} ${action};`;
		}

		case 'alter_column_default': {
			const def = change.meta?.default;
			if (def === undefined || def === null) {
				return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} DROP DEFAULT;`;
			}
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} SET DEFAULT ${formatDefault(def)};`;
		}

		case 'add_primary_key': {
			const columns = change.meta?.columns as string[];
			const pkCols = columns.map(q).join(', ');
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD CONSTRAINT ${q(pkName(change.table))} PRIMARY KEY (${pkCols});`;
		}

		case 'drop_primary_key': {
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(pkName(change.table))} CASCADE;`;
		}

		case 'add_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			return generateAddFKSQL(change.table, fk, schemaName);
		}

		case 'drop_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			const constraintName = q(fkName(change.table, fk.columns));
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
		}

		case 'alter_foreign_key': {
			// Drop + re-add with new onDelete
			const fk = change.meta?.fk as ForeignKeyIR;
			if (!fk) return undefined;
			const constraintName = q(fkName(change.table, fk.columns));
			const drop = `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
			const add = generateAddFKSQL(change.table, fk, schemaName);
			return `${drop}\n${add}`;
		}

		case 'create_index': {
			const idx = change.meta?.index as IndexIR;
			if (!idx) return undefined;
			const indexName = q(idxName(change.table, idx.columns, idx.name));
			const unique = idx.unique ? 'UNIQUE ' : '';
			const cols = idx.columns.map(q).join(', ');
			return `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${qualifyTable(change.table, schemaName)} (${cols});`;
		}

		case 'drop_index': {
			const idx = change.meta?.index as IndexIR;
			if (!idx) return undefined;
			const indexName = q(idxName(change.table, idx.columns, idx.name));
			const schemaPrefix = schemaName ? `${q(schemaName)}.` : '';
			return `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`;
		}

		case 'add_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR;
			if (!check) return undefined;
			const constraintName = q(check.name);
			return (
				'DO $$ BEGIN ALTER TABLE ' +
				qualifyTable(change.table, schemaName) +
				' ADD CONSTRAINT ' +
				constraintName +
				' ' +
				check.expression +
				'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;'
			);
		}

		case 'drop_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR;
			if (!check) return undefined;
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(check.name)};`;
		}

		case 'create_enum': {
			const enumDef = change.meta?.enum as EnumIR;
			if (!enumDef) return undefined;
			const enumName = schemaName ? `${q(schemaName)}.${q(enumDef.name)}` : q(enumDef.name);
			const values = enumDef.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
			return `CREATE TYPE ${enumName} AS ENUM (${values});`;
		}

		case 'alter_enum_add_value': {
			const enumDef = change.meta?.enum as EnumIR;
			const value = change.meta?.value as string;
			const after = change.meta?.after as string | undefined;
			if (!enumDef || !value) return undefined;
			const enumName = schemaName ? `${q(schemaName)}.${q(enumDef.name)}` : q(enumDef.name);
			const escaped = value.replace(/'/g, "''");
			const position = after ? ` AFTER '${after.replace(/'/g, "''")}'` : '';
			return `ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS '${escaped}'${position};`;
		}

		case 'drop_enum': {
			const enumDef = change.meta?.enum as EnumIR;
			if (!enumDef) return undefined;
			const enumName = schemaName ? `${q(schemaName)}.${q(enumDef.name)}` : q(enumDef.name);
			return `DROP TYPE IF EXISTS ${enumName} CASCADE;`;
		}
	}
}

// ============================================================================
// DOWN SQL Generators per ChangeKind
// ============================================================================

function changeToDownSQL(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	switch (change.kind) {
		case 'create_table':
			return `DROP TABLE IF EXISTS ${qualifyTable(change.table, schemaName)} CASCADE;`;

		case 'drop_table':
			return `-- WARNING: Cannot reverse drop_table "${change.table}" -- table data was lost`;

		case 'add_column':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP COLUMN ${q(change.column!)} CASCADE;`;

		case 'drop_column':
			return `-- WARNING: Cannot reverse drop_column "${change.table}"."${change.column}" -- column data was lost`;

		case 'alter_column_type': {
			const fromType = change.meta?.fromType as string | undefined;
			if (!fromType) {
				return `-- WARNING: Cannot reverse alter_column_type "${change.table}"."${change.column}" -- missing migration metadata`;
			}
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} TYPE ${fromType};`;
		}

		case 'alter_column_nullable': {
			const oldNullable = change.meta?.oldNullable as boolean | undefined;
			if (oldNullable === undefined) {
				return `-- WARNING: Cannot reverse alter_column_nullable "${change.table}"."${change.column}" -- missing migration metadata`;
			}
			// Reverse: restore old nullable state
			const action = oldNullable ? 'DROP NOT NULL' : 'SET NOT NULL';
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} ${action};`;
		}

		case 'alter_column_default': {
			const oldDefault = change.meta?.oldDefault;
			if (oldDefault === undefined) {
				return `-- WARNING: Cannot reverse alter_column_default "${change.table}"."${change.column}" -- missing migration metadata`;
			}
			if (oldDefault === null) {
				return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} DROP DEFAULT;`;
			}
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} SET DEFAULT ${formatDefault(oldDefault)};`;
		}

		case 'add_primary_key': {
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(pkName(change.table))} CASCADE;`;
		}

		case 'drop_primary_key':
			return `-- WARNING: Cannot reverse drop_primary_key "${change.table}" -- columns unknown`;

		case 'add_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR | undefined;
			if (!fk) return undefined;
			const constraintName = q(fkName(change.table, fk.columns));
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName} CASCADE;`;
		}

		case 'drop_foreign_key':
			return `-- WARNING: Cannot reverse drop_foreign_key "${change.table}" -- FK definition was lost`;

		case 'alter_foreign_key': {
			const oldFk = change.meta?.oldFk as ForeignKeyIR | undefined;
			if (!oldFk) {
				return `-- WARNING: Cannot reverse alter_foreign_key "${change.table}" -- missing migration metadata`;
			}
			const fk = change.meta?.fk as ForeignKeyIR;
			const constraintName = q(fkName(change.table, fk.columns));
			const drop = `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
			const add = generateAddFKSQL(change.table, oldFk, schemaName);
			return `${drop}\n${add}`;
		}

		case 'create_index': {
			const idx = change.meta?.index as IndexIR | undefined;
			if (!idx) return undefined;
			const indexName = q(idxName(change.table, idx.columns, idx.name));
			const schemaPrefix = schemaName ? `${q(schemaName)}.` : '';
			return `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`;
		}

		case 'drop_index':
			return `-- WARNING: Cannot reverse drop_index "${change.table}" -- index definition was lost`;

		case 'add_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR | undefined;
			if (!check) return undefined;
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(check.name)};`;
		}

		case 'drop_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR | undefined;
			if (!check) return undefined;
			return (
				'DO $ BEGIN ALTER TABLE ' +
				qualifyTable(change.table, schemaName) +
				' ADD CONSTRAINT ' +
				q(check.name) +
				' ' +
				check.expression +
				'; EXCEPTION WHEN duplicate_object THEN NULL; END $;'
			);
		}

		case 'create_enum': {
			// DOWN: drop the type that was created
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return undefined;
			const enumName = schemaName ? `${q(schemaName)}.${q(enumDef.name)}` : q(enumDef.name);
			return `DROP TYPE IF EXISTS ${enumName} CASCADE;`;
		}

		case 'drop_enum': {
			// DOWN: recreate the type that was dropped
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return undefined;
			const enumName = schemaName ? `${q(schemaName)}.${q(enumDef.name)}` : q(enumDef.name);
			const values = enumDef.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
			return `CREATE TYPE ${enumName} AS ENUM (${values});`;
		}

		case 'alter_enum_add_value':
			// DOWN: ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL
			return `-- ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL`;
	}
}

// ============================================================================
// Down Migration SQL Generation
// ============================================================================

/**
 * Generate ordered DOWN SQL statements from a SchemaDiff.
 *
 * Reverses the topological order used in UP migrations:
 * phases run in descending order (11, 10, 9, ..., 0).
 *
 * Irreversible changes (drops that lose data) produce SQL WARNING comments.
 */
export function generateDownSQL(
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
		[], // 0: drop FK, drop CHECK
		[], // 1: drop index
		[], // 2: drop column
		[], // 3: drop PK
		[], // 4: drop table, drop ENUM
		[], // 5: create ENUM
		[], // 6: create table
		[], // 7: add column
		[], // 8: alter column
		[], // 9: add PK
		[], // 10: add FK
		[], // 11: alter FK (drop + re-add)
		[], // 12: create index
		[], // 13: add CHECK constraint
		[], // 14: alter ENUM add value
	];

	for (const change of changes) {
		const phase = getPhase(change.kind);
		phases[phase]!.push(change);
	}

	// Generate SQL in REVERSE phase order (index → FK → PK → alter → column → table)
	const statements: string[] = [];
	for (let i = phases.length - 1; i >= 0; i--) {
		for (const change of phases[i]!) {
			const sql = changeToDownSQL(change, schemaName);
			if (sql) statements.push(sql);
		}
	}

	return statements;
}

// ============================================================================
// Helpers
// ============================================================================

function generateCreateTableSQL(table: TableIR, schemaName?: string): string {
	const qualTable = qualifyTable(table.name, schemaName);

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
			`CONSTRAINT ${q(pkName(table.name))} PRIMARY KEY (${pkCols})`,
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
	const qualTable = qualifyTable(tableName, schemaName);
	const constraintName = q(fkName(tableName, fk.columns));
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
