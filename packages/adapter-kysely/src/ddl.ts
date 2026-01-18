/**
 * DDL Generation - Generates CREATE TABLE statements from ModelIR.
 *
 * Uses Kysely's schema builder to ensure column naming transformations
 * (e.g., CamelCasePlugin) are applied consistently between DDL and queries.
 *
 * Two-pass generation strategy:
 * 1. CREATE TABLE statements (without FK constraints)
 * 2. ALTER TABLE ADD CONSTRAINT for foreign keys
 *
 * This handles circular FK dependencies (A → B → A).
 *
 * @module ddl
 */

import type {
	ColumnType,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	TableIR,
} from '@dbsp/core';
import type {
	ColumnDataType,
	CreateTableBuilder,
	Kysely,
	OnModifyForeignAction,
} from 'kysely';
import { sql } from 'kysely';

// ============================================================================
// Type Mapping
// ============================================================================

/**
 * Map ModelIR ColumnType to Kysely column data type.
 *
 * Uses originalDbType if available (from introspection), otherwise
 * falls back to reasonable PostgreSQL defaults.
 */
function mapColumnType(
	type: ColumnType,
	originalDbType?: string,
): ColumnDataType {
	// Prefer original DB type if available (preserves precision/scale)
	if (originalDbType) {
		return originalDbType as ColumnDataType;
	}

	// Default mappings for manually-defined schemas
	switch (type) {
		case 'string':
			return 'varchar(255)';
		case 'number':
			return 'integer';
		case 'boolean':
			return 'boolean';
		case 'date':
			return 'date';
		case 'datetime':
			return 'timestamptz';
		case 'json':
			return 'jsonb';
		case 'uuid':
			return 'uuid';
		case 'bigint':
			return 'bigint';
		default: {
			// TypeScript exhaustive check
			const _exhaustive: never = type;
			throw new Error(`Unknown column type: ${_exhaustive}`);
		}
	}
}

/**
 * Map OnDeleteAction to Kysely's OnModifyForeignAction.
 */
function mapOnDelete(action?: string): OnModifyForeignAction {
	switch (action) {
		case 'CASCADE':
			return 'cascade';
		case 'SET NULL':
			return 'set null';
		case 'SET DEFAULT':
			return 'set default';
		case 'RESTRICT':
			return 'restrict';
		default:
			return 'no action';
	}
}

// ============================================================================
// DDL Generation
// ============================================================================

/**
 * Generate DDL statements from a ModelIR schema using Kysely's schema builder.
 *
 * The generated DDL respects any plugins configured on the Kysely instance,
 * such as CamelCasePlugin for automatic column name transformation.
 *
 * @param db - Kysely instance (plugins like CamelCasePlugin will be applied)
 * @param schema - The ModelIR schema to generate DDL from
 * @param options - Optional configuration
 * @returns Array of DDL statements in dependency order
 */
export function generateDDL(
	db: Kysely<unknown>,
	schema: ModelIR,
	options: GenerateDDLOptions = {},
): string[] {
	const statements: string[] = [];
	const { includeDropStatements = false, schemaName } = options;

	// Get all tables (order doesn't matter for two-pass approach)
	const tables = Array.from(schema.tables.values());

	// Generate DROP statements (if requested)
	if (includeDropStatements) {
		// Drop in reverse alphabetical order (or any order with CASCADE)
		const sortedTables = [...tables].sort((a, b) =>
			b.name.localeCompare(a.name),
		);
		for (const table of sortedTables) {
			const tableName = schemaName ? `${schemaName}.${table.name}` : table.name;
			statements.push(`DROP TABLE IF EXISTS "${tableName}" CASCADE;`);
		}
		statements.push(''); // Empty line separator
	}

	// ========================================================================
	// PASS 1: CREATE TABLE statements (without FK constraints)
	// ========================================================================
	for (const table of tables) {
		const ddl = generateTableDDL(db, table, schemaName);
		statements.push(ddl);
	}

	// ========================================================================
	// PASS 2: ALTER TABLE ADD CONSTRAINT for foreign keys
	// ========================================================================
	for (const table of tables) {
		for (const fk of table.foreignKeys) {
			const alterDDL = generateForeignKeyDDL(db, table.name, fk, schemaName);
			statements.push(alterDDL);
		}
	}

	// ========================================================================
	// PASS 3: CREATE INDEX statements
	// ========================================================================
	for (const table of tables) {
		for (const idx of table.indexes) {
			const indexDDL = generateIndexDDL(db, table.name, idx, schemaName);
			statements.push(indexDDL);
		}
	}

	return statements;
}

/**
 * Options for DDL generation.
 */
export interface GenerateDDLOptions {
	/** Include DROP TABLE IF EXISTS statements before CREATE TABLE */
	readonly includeDropStatements?: boolean | undefined;
	/** Database schema name (e.g., 'public', 'tenant_123') */
	readonly schemaName?: string | undefined;
}

/**
 * Generate DDL for a single table (without FK constraints - those come in pass 2).
 */
function generateTableDDL(
	db: Kysely<unknown>,
	table: TableIR,
	schemaName?: string,
): string {
	// Start building the table
	// biome-ignore lint/suspicious/noExplicitAny: Kysely type requires unknown schema
	let builder: CreateTableBuilder<any, any> = schemaName
		? db.schema.withSchema(schemaName).createTable(table.name)
		: db.schema.createTable(table.name);

	// Get primary key columns for reference
	const pkColumns = Array.isArray(table.primaryKey)
		? table.primaryKey
		: [table.primaryKey];

	// Add columns
	for (const col of table.columns) {
		const dataType = mapColumnType(col.type, col.originalDbType);
		const isPrimaryKey = pkColumns.length === 1 && pkColumns[0] === col.name;

		builder = builder.addColumn(col.name, dataType, (cb) => {
			let colBuilder = cb;

			// Primary key (single column only - composite handled separately)
			if (isPrimaryKey) {
				colBuilder = colBuilder.primaryKey();
			}

			// Nullable
			if (!col.nullable) {
				colBuilder = colBuilder.notNull();
			}

			// Default value handling
			if (col.default !== undefined) {
				colBuilder = applyDefaultValue(colBuilder, col.default, db);
			}

			return colBuilder;
		});
	}

	// Add composite primary key (if multi-column)
	if (pkColumns.length > 1) {
		builder = builder.addPrimaryKeyConstraint(
			`pk_${table.name}`,
			pkColumns as [string, ...string[]],
		);
	}

	// Note: Foreign key constraints are added in pass 2 via ALTER TABLE

	// Compile to SQL
	const compiled = builder.compile();
	return `${compiled.sql};`;
}

/**
 * Apply default value to column builder.
 * Handles both literal values and SQL expressions.
 */
function applyDefaultValue(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely column builder type
	colBuilder: any,
	defaultValue: unknown,
	db: Kysely<unknown>,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely column builder type
): any {
	// Handle SqlDefault object: { sql: 'now()' }
	if (
		typeof defaultValue === 'object' &&
		defaultValue !== null &&
		'sql' in defaultValue
	) {
		const sqlExpr = (defaultValue as { sql: string }).sql;
		// Handle function-like expressions (e.g., 'now()')
		if (sqlExpr.endsWith(')')) {
			return colBuilder.defaultTo(db.fn(sqlExpr.replace(/\(\)$/, '')));
		}
		// Raw SQL expression (use with caution)
		return colBuilder.defaultTo(sql.raw(sqlExpr));
	}

	// Handle legacy string function syntax (e.g., 'now()')
	if (typeof defaultValue === 'string' && defaultValue.endsWith(')')) {
		return colBuilder.defaultTo(db.fn(defaultValue.replace(/\(\)$/, '')));
	}

	// Literal values
	return colBuilder.defaultTo(defaultValue);
}

/**
 * Generate ALTER TABLE ADD CONSTRAINT for a foreign key.
 */
function generateForeignKeyDDL(
	db: Kysely<unknown>,
	tableName: string,
	fk: ForeignKeyIR,
	schemaName?: string,
): string {
	const constraintName = `fk_${tableName}_${fk.columns.join('_')}`;

	// Use Kysely's alterTable to generate the DDL
	const schemaBuilder = schemaName
		? db.schema.withSchema(schemaName)
		: db.schema;

	const builder = schemaBuilder
		.alterTable(tableName)
		.addForeignKeyConstraint(
			constraintName,
			fk.columns as [string, ...string[]],
			fk.references.table,
			fk.references.columns as [string, ...string[]],
			(cb) => (fk.onDelete ? cb.onDelete(mapOnDelete(fk.onDelete)) : cb),
		);

	const compiled = builder.compile();
	return `${compiled.sql};`;
}

/**
 * Generate CREATE INDEX statement.
 */
function generateIndexDDL(
	db: Kysely<unknown>,
	tableName: string,
	idx: IndexIR,
	schemaName?: string,
): string {
	const indexName = idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`;

	const schemaBuilder = schemaName
		? db.schema.withSchema(schemaName)
		: db.schema;

	let builder = schemaBuilder.createIndex(indexName).on(tableName);

	// Add columns
	for (const col of idx.columns) {
		builder = builder.column(col);
	}

	// Unique index
	if (idx.unique) {
		builder = builder.unique();
	}

	const compiled = builder.compile();
	return `${compiled.sql};`;
}
