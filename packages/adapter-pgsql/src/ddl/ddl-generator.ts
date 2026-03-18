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
	// PASS -1: CREATE EXTENSION (before everything)
	// ========================================================================
	if (schema.extensions) {
		for (const ext of schema.extensions) {
			statements.push(`CREATE EXTENSION IF NOT EXISTS "${ext}";`);
		}
	}

	// ========================================================================
	// PASS -0.5: CREATE SEQUENCE (before tables)
	// ========================================================================
	if (schema.sequences) {
		for (const [, seq] of schema.sequences) {
			const seqName = schemaName
				? `${quoteIdentifier(naming.toDatabase(schemaName))}.${quoteIdentifier(seq.name)}`
				: quoteIdentifier(seq.name);
			const parts: string[] = [`CREATE SEQUENCE ${seqName}`];
			if (seq.startWith !== undefined)
				parts.push(`START WITH ${seq.startWith}`);
			if (seq.incrementBy !== undefined)
				parts.push(`INCREMENT BY ${seq.incrementBy}`);
			if (seq.minValue !== undefined) parts.push(`MINVALUE ${seq.minValue}`);
			if (seq.maxValue !== undefined) parts.push(`MAXVALUE ${seq.maxValue}`);
			if (seq.cycle) parts.push('CYCLE');
			statements.push(`${parts.join(' ')};`);
		}
	}

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
	// PASS 0.5: CREATE TYPE for ENUM types (must be before CREATE TABLE)
	// ========================================================================
	if (schema.enums) {
		for (const [, enumDef] of schema.enums) {
			const enumName = schemaName
				? `${quoteIdentifier(naming.toDatabase(schemaName))}.${quoteIdentifier(enumDef.name)}`
				: quoteIdentifier(enumDef.name);
			const values = enumDef.values
				.map((v) => `'${v.replace(/'/g, "''")}'`)
				.join(', ');
			statements.push(`CREATE TYPE ${enumName} AS ENUM (${values});`);
		}
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

	// ========================================================================
	// PASS 4: COMMENT ON TABLE / COLUMN
	// ========================================================================
	for (const table of tables) {
		if (table.comment) {
			const qualifiedTable = qualifyTable(table.name, schemaName, naming);
			statements.push(
				`COMMENT ON TABLE ${qualifiedTable} IS '${table.comment.replace(/'/g, "''")}';`,
			);
		}
		for (const col of table.columns) {
			if (col.comment) {
				const qualifiedTable = qualifyTable(table.name, schemaName, naming);
				statements.push(
					`COMMENT ON COLUMN ${qualifiedTable}.${quoteIdentifier(naming.toDatabase(col.name))} IS '${col.comment.replace(/'/g, "''")}';`,
				);
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

	// COLLATE (must come after type)
	if (col.collation) {
		parts.push(`COLLATE "${col.collation}"`);
	}

	// GENERATED AS IDENTITY
	if (col.identity) {
		const gen = col.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
		parts.push(`GENERATED ${gen} AS IDENTITY`);
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

	// ON DELETE / ON UPDATE / DEFERRABLE actions
	const onDelete = fk.onDelete
		? ` ON DELETE ${mapOnDeleteAction(fk.onDelete)}`
		: '';
	const onUpdate = fk.onUpdate
		? ` ON UPDATE ${mapOnDeleteAction(fk.onUpdate)}`
		: '';
	const deferred = fk.deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '';

	return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete}${onUpdate}${deferred};`;
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
	const unique = idx.unique ? 'UNIQUE ' : '';
	const method = idx.method ? ` USING ${idx.method}` : '';

	// Build column list: expressions first (unquoted), then named columns with optional opclass
	const colParts: string[] = [];
	if (idx.expressions && idx.expressions.length > 0) {
		for (const expr of idx.expressions) {
			colParts.push(expr);
		}
	}
	for (const col of idx.columns) {
		const opclass = idx.opclass?.[col] ?? '';
		colParts.push(
			`${quoteIdentifier(naming.toDatabase(col))}${opclass ? ` ${opclass}` : ''}`,
		);
	}
	const cols = colParts.join(', ');

	const include =
		idx.include && idx.include.length > 0
			? ` INCLUDE (${idx.include.map((c) => quoteIdentifier(naming.toDatabase(c))).join(', ')})`
			: '';
	const withParams =
		idx.with && Object.keys(idx.with).length > 0
			? ` WITH (${Object.entries(idx.with)
					.map(([k, v]) => `${k} = ${v}`)
					.join(', ')})`
			: '';
	const where = idx.where ? ` WHERE ${idx.where}` : '';

	return `CREATE ${unique}INDEX ${indexName} ON ${qualifiedTable}${method} (${cols})${include}${withParams}${where};`;
}
