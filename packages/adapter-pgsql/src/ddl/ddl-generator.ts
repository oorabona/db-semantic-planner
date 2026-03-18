/**
 * DDL Generator - Generates PostgreSQL DDL statements from ModelIR
 *
 * Generates SQL strings directly for better compatibility and control.
 * Two-pass strategy handles circular FK dependencies.
 *
 * @module ddl/ddl-generator
 */

import type {
	ColumnIR,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	TableIR,
} from '@dbsp/types';
import { identityNaming, type NamingPlugin } from '../naming-plugin.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ============================================================================
// Options
// ============================================================================

export interface GenerateDDLOptions {
	/** Include DROP TABLE IF EXISTS statements before CREATE TABLE */
	readonly includeDropStatements?: boolean;
	/** Database schema name (e.g., 'public', 'tenant_123') */
	readonly schemaName?: string;
	/**
	 * Automatically create indexes on foreign key columns.
	 * FK columns are frequently used in JOINs, so indexing is a best practice.
	 * @default true
	 */
	readonly fkAutoIndex?: boolean;
	/** Naming plugin for identifier transformation */
	readonly naming?: NamingPlugin;
}

// ============================================================================
// Main DDL Generation
// ============================================================================

/**
 * Generate DDL statements from a ModelIR schema.
 *
 * Uses a two-pass approach to handle circular FK dependencies:
 * 1. CREATE TABLE (without FK constraints)
 * 2. ALTER TABLE ADD CONSTRAINT for foreign keys
 * 3. CREATE INDEX (explicit + auto-generated for FKs)
 *
 * @param schema - The ModelIR schema to generate DDL from
 * @param options - Optional configuration
 * @returns Array of DDL statements in dependency order
 */
export function generateDDL(
	schema: ModelIR,
	options: GenerateDDLOptions = {},
): string[] {
	const statements: string[] = [];
	const {
		includeDropStatements = false,
		schemaName,
		fkAutoIndex = true,
		naming = identityNaming,
	} = options;

	// Get all tables
	const tables = Array.from(schema.tables.values());

	// ========================================================================
	// PASS 0: DROP statements (if requested)
	// ========================================================================
	if (includeDropStatements) {
		// Reverse order + CASCADE to handle FK dependencies
		for (const table of [...tables].reverse()) {
			statements.push(generateDropTable(table.name, schemaName, naming));
		}
		statements.push(''); // Empty line separator
	}

	// ========================================================================
	// PASS 1: CREATE TABLE statements (without FK constraints)
	// ========================================================================
	for (const table of tables) {
		statements.push(generateCreateTable(table, schemaName, naming));
	}

	// ========================================================================
	// PASS 2: ALTER TABLE ADD CONSTRAINT for foreign keys
	// ========================================================================
	for (const table of tables) {
		for (const fk of table.foreignKeys) {
			statements.push(
				generateAlterTableAddFK(table.name, fk, schemaName, naming),
			);
		}
	}

	// ========================================================================
	// PASS 2.5: ALTER TABLE ADD CHECK CONSTRAINT
	// ========================================================================
	for (const table of tables) {
		for (const check of table.checkConstraints ?? []) {
			const qualifiedTable = qualifyTable(table.name, schemaName, naming);
			const constraintName = quoteIdentifier(check.name);
			statements.push(
				`ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} ${check.expression};`,
			);
		}
	}

	// ========================================================================
	// PASS 3: CREATE INDEX statements
	// ========================================================================
	for (const table of tables) {
		// Collect explicit index column names to avoid duplicates
		const explicitIndexColumns = new Set(
			table.indexes.flatMap((idx) =>
				idx.columns.length === 1 ? idx.columns : [],
			),
		);

		// Generate explicit indexes
		for (const idx of table.indexes) {
			statements.push(generateCreateIndex(table.name, idx, schemaName, naming));
		}

		// Auto-generate indexes for FK columns if fkAutoIndex is enabled
		if (fkAutoIndex) {
			for (const fk of table.foreignKeys) {
				// Only auto-index single-column FKs that don't have explicit indexes
				const fkCol = fk.columns[0];
				if (
					fk.columns.length === 1 &&
					fkCol &&
					!explicitIndexColumns.has(fkCol)
				) {
					const autoIdx: IndexIR = {
						name: `idx_${table.name}_${fkCol}`,
						columns: [fkCol],
						unique: false,
					};
					statements.push(
						generateCreateIndex(table.name, autoIdx, schemaName, naming),
					);
				}
			}
		}
	}

	return statements;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quote an identifier (table name, column name, etc.)
 */
function quoteIdentifier(name: string): string {
	return `"${name}"`;
}

/**
 * Qualify a table name with optional schema.
 */
function qualifyTable(
	tableName: string,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const table = quoteIdentifier(naming.toDatabase(tableName));
	if (schemaName) {
		return `${quoteIdentifier(naming.toDatabase(schemaName))}.${table}`;
	}
	return table;
}

// ============================================================================
// DROP TABLE
// ============================================================================

function generateDropTable(
	tableName: string,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName, naming);
	return `DROP TABLE IF EXISTS ${qualifiedTable} CASCADE;`;
}

// ============================================================================
// CREATE TABLE
// ============================================================================

function generateCreateTable(
	table: TableIR,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const qualifiedTable = qualifyTable(table.name, schemaName, naming);
	const elements: string[] = [];

	// Add columns
	for (const col of table.columns) {
		elements.push(generateColumnDef(col, naming));
	}

	// Add primary key constraint (omit if no PK defined)
	if (table.primaryKey !== undefined) {
		const pkColumns = Array.isArray(table.primaryKey)
			? table.primaryKey
			: [table.primaryKey];
		const pkCols = pkColumns
			.map((col) => quoteIdentifier(naming.toDatabase(col)))
			.join(', ');
		const pkName = quoteIdentifier(`pk_${table.name}`);
		elements.push(`CONSTRAINT ${pkName} PRIMARY KEY (${pkCols})`);
	}

	const elementsStr = elements.map((el) => `  ${el}`).join(',\n');
	return `CREATE TABLE ${qualifiedTable} (\n${elementsStr}\n);`;
}

/**
 * Generate a column definition string.
 */
function generateColumnDef(col: ColumnIR, naming: NamingPlugin): string {
	const parts: string[] = [];

	// Column name and type
	parts.push(quoteIdentifier(naming.toDatabase(col.name)));
	parts.push(mapColumnType(col));

	// NOT NULL constraint (SERIAL/BIGSERIAL imply NOT NULL)
	if (!col.nullable && !col.autoIncrement) {
		parts.push('NOT NULL');
	}

	// DEFAULT constraint
	if (col.default !== undefined) {
		parts.push(`DEFAULT ${formatDefaultValue(col.default)}`);
	}

	// UNIQUE constraint
	if (col.unique) {
		parts.push('UNIQUE');
	}

	return parts.join(' ');
}

/**
 * Format a default value for SQL.
 */
function formatDefaultValue(value: unknown): string {
	// Handle SqlDefault object: { sql: 'now()' }
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		return (value as Record<string, unknown>).sql as string;
	}

	// Handle function-like expressions (e.g., 'now()')
	if (typeof value === 'string') {
		if (value.endsWith('()')) {
			return value;
		}
		// String literal - escape single quotes
		return `'${value.replace(/'/g, "''")}'`;
	}

	// Number literals
	if (typeof value === 'number') {
		return String(value);
	}

	// Boolean literals
	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}

	// NULL
	if (value === null) {
		return 'NULL';
	}

	// Fallback: string representation
	return `'${String(value)}'`;
}

// ============================================================================
// ALTER TABLE (Foreign Keys)
// ============================================================================

function generateAlterTableAddFK(
	tableName: string,
	fk: ForeignKeyIR,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName, naming);
	const constraintName = quoteIdentifier(
		`fk_${tableName}_${fk.columns.join('_')}`,
	);

	// Local columns
	const fkCols = fk.columns
		.map((col) => quoteIdentifier(naming.toDatabase(col)))
		.join(', ');

	// Referenced table and columns
	const refTable = quoteIdentifier(naming.toDatabase(fk.references.table));
	const refCols = fk.references.columns
		.map((col) => quoteIdentifier(naming.toDatabase(col)))
		.join(', ');

	// ON DELETE action
	const onDelete = fk.onDelete
		? ` ON DELETE ${mapOnDeleteAction(fk.onDelete)}`
		: '';

	return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete};`;
}

// ============================================================================
// CREATE INDEX
// ============================================================================

function generateCreateIndex(
	tableName: string,
	idx: IndexIR,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const indexName = quoteIdentifier(
		idx.name ?? `idx_${tableName}_${idx.columns.join('_')}`,
	);
	const qualifiedTable = qualifyTable(tableName, schemaName, naming);

	// Index columns
	const cols = idx.columns
		.map((col) => quoteIdentifier(naming.toDatabase(col)))
		.join(', ');

	// UNIQUE keyword
	const unique = idx.unique ? 'UNIQUE ' : '';

	return `CREATE ${unique}INDEX ${indexName} ON ${qualifiedTable} (${cols});`;
}
