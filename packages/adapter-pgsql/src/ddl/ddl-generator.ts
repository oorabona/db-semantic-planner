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
	DialectCapabilities,
	ForeignKeyIR,
	IndexIR,
	ModelIR,
	PolicyIR,
	TableIR,
} from '@dbsp/types';
import { identityNaming, type NamingPlugin } from '../naming-plugin.js';
import { validateIdentifier, validateSqlExpression } from '../validate.js';
import { generateCommentsPhase } from './phases/comments.js';
import { generateConstraintsPhase } from './phases/constraints.js';
import { generateDropStatementsPhase } from './phases/drop-statements.js';
import { generateEnumTypesPhase } from './phases/enum-types.js';
import { generateExtensionsPhase } from './phases/extensions.js';
import { generateIndexesPhase } from './phases/indexes.js';
import { generateRlsPhase } from './phases/rls.js';
import { generateSequencesPhase } from './phases/sequences.js';
import { generateTablesPhase } from './phases/tables.js';
import type { PhaseContext } from './phases/types.js';
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
	/** Dialect capabilities — DDL passes for unsupported features will be skipped */
	readonly dialectCapabilities?: DialectCapabilities;
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
	const {
		includeDropStatements = false,
		schemaName,
		fkAutoIndex = true,
		naming = identityNaming,
		dialectCapabilities: caps,
	} = options;

	const tables = Array.from(schema.tables.values());

	const ctx: PhaseContext = {
		schema,
		tables,
		schemaName,
		naming,
		caps,
		fkAutoIndex,
		includeDropStatements,
	};

	return [
		...generateExtensionsPhase(ctx), // PASS -1: CREATE EXTENSION
		...generateSequencesPhase(ctx), // PASS -0.5: CREATE SEQUENCE
		...generateDropStatementsPhase(ctx), // PASS 0: DROP TABLE (optional)
		...generateEnumTypesPhase(ctx), // PASS 0.5: CREATE TYPE ... AS ENUM
		...generateTablesPhase(ctx), // PASS 1: CREATE TABLE
		...generateConstraintsPhase(ctx), // PASS 2 + 2.5: FK + CHECK constraints
		...generateIndexesPhase(ctx), // PASS 3: CREATE INDEX
		...generateRlsPhase(ctx), // PASS 3.5: RLS + policies
		...generateCommentsPhase(ctx), // PASS 4: COMMENT ON
	];
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quote an identifier (table name, column name, etc.)
 */
/**
 * Quote an identifier (table name, column name, etc.) for use in DDL.
 *
 * @security Validates the identifier via validateIdentifier() before quoting.
 * Escapes embedded double-quotes by doubling them as defense-in-depth.
 * Only call this with identifiers that have been validated upstream (table names,
 * column names, policy names). Do NOT call with raw user input without validation.
 */
function quoteIdentifier(name: string): string {
	validateIdentifier(name, 'alias');
	// Defense-in-depth: escape any embedded double-quotes by doubling them.
	return `"${name.replace(/"/g, '""')}"`;
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

export function generateDropTable(
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

export function generateCreateTable(
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
		// Normalize primaryKey: typed as string | readonly string[], but
		// introspected models may pass { columns: string[] } — extract columns defensively.
		const rawPk = table.primaryKey as unknown;
		let pkColumns: readonly string[];
		if (
			rawPk !== null &&
			typeof rawPk === 'object' &&
			'columns' in rawPk &&
			Array.isArray((rawPk as { columns: unknown }).columns)
		) {
			pkColumns = (rawPk as { columns: string[] }).columns;
		} else if (Array.isArray(rawPk)) {
			pkColumns = rawPk as readonly string[];
		} else {
			pkColumns = [rawPk as string];
		}
		const pkCols = pkColumns
			.map((col) => quoteIdentifier(naming.toDatabase(col)))
			.join(', ');
		const pkName = quoteIdentifier(`pk_${table.name}`);
		elements.push(`CONSTRAINT ${pkName} PRIMARY KEY (${pkCols})`);
	}

	const elementsStr = elements.map((el) => `  ${el}`).join(',\n');
	let sql = `CREATE TABLE ${qualifiedTable} (\n${elementsStr}\n)`;
	if (table.partition) {
		const partCols = table.partition.columns
			.map((col) => quoteIdentifier(naming.toDatabase(col)))
			.join(', ');
		sql += ` PARTITION BY ${table.partition.strategy} (${partCols})`;
	}
	sql += ';';
	return sql;
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
/**
 * Format a default value for SQL.
 *
 * @security The `{ sql: string }` escape hatch is validated via validateSqlExpression()
 * before interpolation to prevent injection of multi-statement or comment-bearing strings.
 */
function formatDefaultValue(value: unknown): string {
	// Handle SqlDefault object: { sql: 'now()' }
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		const rawSql = (value as Record<string, unknown>).sql;
		if (typeof rawSql !== 'string') {
			throw new Error(
				`formatDefaultValue({ sql }): expected string, got ${typeof rawSql}`,
			);
		}
		validateSqlExpression(rawSql, 'column default');
		return rawSql;
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

export function generateAlterTableAddFK(
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

	// Referenced table and columns (must also be schema-qualified to match the target table's schema)
	const refTable = qualifyTable(fk.references.table, schemaName, naming);
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
	const notValid = fk.notValid ? ' NOT VALID' : '';

	return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete}${onUpdate}${deferred}${notValid};`;
}

// ============================================================================
// CREATE INDEX
// ============================================================================

export function generateCreateIndex(
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

// ============================================================================
// generateCreatePolicy
// ============================================================================

/**
 * Generate a CREATE POLICY statement.
 */
export function generateCreatePolicy(
	tableName: string,
	policy: PolicyIR,
	schemaName: string | undefined,
	naming: NamingPlugin,
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName, naming);
	const policyName = quoteIdentifier(policy.name);
	const forClause =
		policy.command && policy.command !== 'ALL'
			? ` FOR ${policy.command}`
			: ' FOR ALL';
	const asClause =
		policy.permissive === false ? ' AS RESTRICTIVE' : ' AS PERMISSIVE';
	const toClause =
		policy.roles && policy.roles.length > 0
			? ` TO ${policy.roles.map((r) => quoteIdentifier(r)).join(', ')}`
			: '';
	if (policy.using) {
		validateSqlExpression(policy.using, 'policy USING expression');
	}
	if (policy.withCheck) {
		validateSqlExpression(policy.withCheck, 'policy WITH CHECK expression');
	}
	const usingClause = policy.using ? ` USING (${policy.using})` : '';
	const withCheckClause = policy.withCheck
		? ` WITH CHECK (${policy.withCheck})`
		: '';
	return `CREATE POLICY ${policyName} ON ${qualifiedTable}${forClause}${asClause}${toClause}${usingClause}${withCheckClause};`;
}
