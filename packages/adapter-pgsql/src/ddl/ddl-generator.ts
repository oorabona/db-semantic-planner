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
import type { NamingPlugin } from '../naming-plugin.js';
import {
	createPgPhysicalModel,
	pgForeignKeyName,
	pgPrimaryKeyName,
} from '../physical-model/index.js';
import { getPostgresqlCapabilitiesTargetVersion } from '../postgresql-capabilities.js';
import { validateIdentifier, validateSqlExpression } from '../validate.js';
import { shouldEmitAutoFkIndex } from './fk-index-coverage.js';
import { normalizeOptionalBoolean } from './generated-source-normalizers.js';
import {
	assertCreateIndexesSupported,
	type IndexCapabilityContext,
	type IndexRenderSpec,
	renderCreateIndex,
} from './index-render.js';
import { generateCommentsPhase } from './phases/comments.js';
import { generateConstraintsPhase } from './phases/constraints.js';
import { generateDropStatementsPhase } from './phases/drop-statements.js';
import { generateEnumTypesPhase } from './phases/enum-types.js';
import { generateExtensionsPhase } from './phases/extensions.js';
import { generateIndexesPhase } from './phases/indexes.js';
import { generateRlsPhase } from './phases/rls.js';
import { generateSequencesPhase } from './phases/sequences.js';
import { generateTablesPhase } from './phases/tables.js';
import { type PhaseContext, sup } from './phases/types.js';
import {
	formatSqlDefault,
	quoteCollation,
	quoteRoleName,
} from './phases/utils.js';
import { renderPolicyClauses } from './policy-clauses.js';
import {
	assertSchemaName,
	collectModelScopeEvidence,
	MODEL_SCHEMA_SCOPE_SUBJECT,
} from './schema-scope.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ============================================================================
// Options
// ============================================================================

export interface GenerateDDLOptions {
	/** Include DROP TABLE IF EXISTS statements before CREATE TABLE */
	readonly includeDropStatements?: boolean;
	/**
	 * Database schema name (e.g., 'public', 'tenant_123').
	 * Required when emitted DDL would otherwise mix non-default target-scoped
	 * custom types/enums with unqualified table SQL.
	 */
	readonly schemaName?: string;
	/**
	 * Automatically create indexes on foreign key columns.
	 * FK columns are frequently used in JOINs, so indexing is a best practice.
	 * @default true
	 */
	readonly fkAutoIndex?: boolean;
	/** Naming plugin for logical-model callers. Physical models omit this option. */
	readonly naming?: NamingPlugin;
	/** Dialect capabilities — unsupported index features throw during DDL generation */
	readonly dialectCapabilities?: DialectCapabilities;
}

// ============================================================================
// Shared Validation Helpers
// ============================================================================

/**
 * Valid PostgreSQL table partitioning strategies.
 * Used in PARTITION BY <strategy> clauses.
 */
const ALLOWED_PARTITION_STRATEGIES = ['RANGE', 'LIST', 'HASH'] as const;
type PartitionStrategy = (typeof ALLOWED_PARTITION_STRATEGIES)[number];

/**
 * Assert that a partition strategy string is one of the allowed values.
 * Normalises to uppercase. Throws on invalid input.
 *
 * Exported so that migration-sql.ts can reuse the same guard without
 * duplicating the allowlist.
 *
 * @security Defense-in-depth: prevents raw strategy strings from being
 *   interpolated into SQL without allowlist validation.
 */
export function assertPartitionStrategy(value: string): PartitionStrategy {
	const upper = value.toUpperCase() as PartitionStrategy;
	if (!ALLOWED_PARTITION_STRATEGIES.includes(upper)) {
		throw new Error(
			`Invalid partition strategy "${value}". ` +
				`Must be one of: ${ALLOWED_PARTITION_STRATEGIES.join(', ')}.`,
		);
	}
	return upper;
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
	const { naming, ...renderOptions } = options;
	for (const table of schema.tables.values()) {
		validateIdentifier(table.name, 'alias');
		for (const column of table.columns)
			validateIdentifier(column.name, 'alias');
	}
	const needsPhysicalNames = [...schema.tables.values()].some((table) =>
		table.primaryKey !== undefined && table.primaryKeyName === undefined
			? true
			: table.columns.some(
					(column) =>
						column.unique === true && column.uniqueConstraintName === undefined,
				) ||
				table.foreignKeys.some(
					(fk) =>
						fk.name === undefined ||
						(fk.columns.length === 1 &&
							shouldEmitAutoFkIndex(table, fk.columns[0]!) &&
							renderOptions.fkAutoIndex !== false &&
							fk.autoIndexName === undefined),
				) ||
				table.indexes.some((index) => index.name === undefined),
	);
	if (naming !== undefined || needsPhysicalNames) {
		const physical = createPgPhysicalModel({
			mode: 'logical',
			model: schema,
			schema: renderOptions.schemaName ?? 'public',
			...(naming === undefined ? {} : { naming }),
			...(renderOptions.fkAutoIndex === undefined
				? {}
				: { fkAutoIndex: renderOptions.fkAutoIndex }),
		});
		return generateDDL(physical.model, {
			...renderOptions,
			...(renderOptions.schemaName === undefined
				? {}
				: { schemaName: renderOptions.schemaName }),
			fkAutoIndex: physical.fkAutoIndex,
		});
	}
	const {
		includeDropStatements = false,
		schemaName,
		fkAutoIndex: resolvedFkAutoIndex = true,
		dialectCapabilities: caps,
	} = renderOptions;

	const tables = Array.from(schema.tables.values());
	const scope = collectModelScopeEvidence(schema, {
		includeEnums: sup(caps, caps?.supportsDDLEnumTypes),
	});
	assertSchemaName(scope, schemaName, MODEL_SCHEMA_SCOPE_SUBJECT);

	const ctx: PhaseContext = {
		schema,
		tables,
		schemaName,
		caps,
		fkAutoIndex: resolvedFkAutoIndex,
		includeDropStatements,
	};
	assertCreateIndexesSupported(
		collectGeneratedCreateIndexSpecs(tables, schemaName, resolvedFkAutoIndex),
		indexContextFromCaps(caps),
	);

	const statements = [
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

	return statements;
}

function buildIndexRenderSpec(
	tableName: string,
	idx: IndexIR,
	schemaName: string | undefined,
): IndexRenderSpec {
	return {
		name: requiredPhysicalIndexName(idx, tableName),
		table: tableName,
		schema: schemaName,
		unique: idx.unique === true,
		method: idx.method,
		keys: [
			...(idx.expressions ?? []).map((expression) => ({ expression })),
			...idx.columns.map((col) => ({
				column: col,
				opclass: idx.opclass?.[col],
			})),
		],
		include: idx.include,
		nullsNotDistinct: idx.nullsNotDistinct,
		with: idx.with,
		where: idx.where,
		whereSource: idx,
	};
}

/** All renderer-visible index names must already come from PgPhysicalModel. */
function requiredPhysicalIndexName(idx: IndexIR, tableName: string): string {
	if (idx.name !== undefined) return idx.name;
	const tables = new Map([
		[
			tableName,
			{
				name: tableName,
				columns: idx.columns.map((name) => ({
					name,
					type: 'string' as const,
					nullable: true,
				})),
				foreignKeys: [],
				indexes: [idx],
			},
		],
	]);
	const physical = createPgPhysicalModel({
		mode: 'logical',
		schema: 'public',
		model: {
			tables,
			relations: new Map(),
			getTable: (name) => tables.get(name),
			getRelation: () => undefined,
			getRelationsFrom: () => [],
			getRelationsTo: () => [],
			isAmbiguous: () => ({ ambiguous: false, options: [] }),
		},
	});
	const name = physical.model.getTable(tableName)?.indexes[0]?.name;
	if (name === undefined)
		throw new Error(
			`physical index name is missing from the model for table ${tableName}`,
		);
	return name;
}

function collectGeneratedCreateIndexSpecs(
	tables: readonly TableIR[],
	schemaName: string | undefined,
	fkAutoIndex: boolean,
): IndexRenderSpec[] {
	const specs: IndexRenderSpec[] = [];
	for (const table of tables) {
		for (const idx of table.indexes) {
			specs.push(buildIndexRenderSpec(table.name, idx, schemaName));
		}
		if (!fkAutoIndex) continue;
		for (const fk of table.foreignKeys) {
			const fkCol = fk.columns[0];
			if (
				fk.columns.length === 1 &&
				fkCol &&
				shouldEmitAutoFkIndex(table, fkCol)
			) {
				const autoIndexName = fk.autoIndexName;
				if (autoIndexName === undefined)
					throw new Error(
						'physical automatic foreign-key index name is missing from the model',
					);
				specs.push(
					buildIndexRenderSpec(
						table.name,
						{
							name: autoIndexName,
							columns: [fkCol],
							unique: false,
						},
						schemaName,
					),
				);
			}
		}
	}
	return specs;
}

function indexContextFromCaps(
	caps: DialectCapabilities | undefined,
): IndexCapabilityContext | undefined {
	return caps
		? { caps, targetVersion: getPostgresqlCapabilitiesTargetVersion(caps) }
		: undefined;
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
): string {
	const table = quoteIdentifier(tableName);
	if (schemaName) {
		return `${quoteIdentifier(schemaName)}.${table}`;
	}
	return table;
}

// ============================================================================
// DROP TABLE
// ============================================================================

export function generateDropTable(
	tableName: string,
	schemaName: string | undefined,
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName);
	return `DROP TABLE IF EXISTS ${qualifiedTable} CASCADE;`;
}

// ============================================================================
// CREATE TABLE
// ============================================================================

export function generateCreateTable(
	table: TableIR,
	schemaName: string | undefined,
): string {
	const qualifiedTable = qualifyTable(table.name, schemaName);
	const elements: string[] = [];

	// Add columns
	for (const col of table.columns) {
		elements.push(generateColumnDef(col, schemaName));
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
		const pkCols = pkColumns.map((col) => quoteIdentifier(col)).join(', ');
		const pkName = quoteIdentifier(
			table.primaryKeyName ?? pgPrimaryKeyName(table.name),
		);
		elements.push(`CONSTRAINT ${pkName} PRIMARY KEY (${pkCols})`);
	}

	const elementsStr = elements.map((el) => `  ${el}`).join(',\n');
	let sql = `CREATE TABLE ${qualifiedTable} (\n${elementsStr}\n)`;
	if (table.partition) {
		const strategy = assertPartitionStrategy(table.partition.strategy);
		const partCols = table.partition.columns
			.map((col) => quoteIdentifier(col))
			.join(', ');
		sql += ` PARTITION BY ${strategy} (${partCols})`;
	}
	sql += ';';
	return sql;
}

/**
 * Generate a column definition string.
 */
export function generateColumnDef(
	col: ColumnIR,
	targetSchema?: string,
): string {
	const parts: string[] = [];

	// Column name and type
	parts.push(quoteIdentifier(col.name));
	const type = mapColumnType(col, targetSchema);
	parts.push(type);

	// NOT NULL constraint (SERIAL/BIGSERIAL imply NOT NULL)
	if (!col.nullable && type !== 'SERIAL' && type !== 'BIGSERIAL') {
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
	// S-2: validate collation name before quoting — uses quoteCollation which
	// accepts locale strings like `en_US.utf8`, `en-US-x-icu`, `C.UTF-8`
	// that contain dots/hyphens rejected by the standard identifier validator.
	if (col.collation) {
		parts.push(`COLLATE ${quoteCollation(col.collation)}`);
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
// M-6: formatDefaultValue is now a thin alias for the shared formatSqlDefault from phases/utils.
// The duplicate implementations have been consolidated.
// The doc-comment security note is on formatSqlDefault in packages/adapter-pgsql/src/ddl/phases/utils.ts.
function formatDefaultValue(value: unknown): string {
	return formatSqlDefault(value, 'ddl-generator default');
}

// ============================================================================
// ALTER TABLE (Foreign Keys)
// ============================================================================

export function generateAlterTableAddFK(
	tableName: string,
	fk: ForeignKeyIR,
	schemaName: string | undefined,
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName);
	const constraintName = quoteIdentifier(
		fk.name ?? pgForeignKeyName(tableName, fk.columns),
	);

	// Local columns
	const fkCols = fk.columns.map((col) => quoteIdentifier(col)).join(', ');

	// Referenced table and columns resolve to a declared schema, or the DDL schema when absent.
	const refTable =
		fk.references.schema !== undefined
			? qualifyTable(fk.references.table, fk.references.schema)
			: qualifyTable(fk.references.table, schemaName);
	const refCols = fk.references.columns
		.map((col) => quoteIdentifier(col))
		.join(', ');

	// ON DELETE / ON UPDATE / DEFERRABLE actions
	const onDelete = fk.onDelete
		? ` ON DELETE ${mapOnDeleteAction(fk.onDelete)}`
		: '';
	const onUpdate = fk.onUpdate
		? ` ON UPDATE ${mapOnDeleteAction(fk.onUpdate)}`
		: '';
	const deferred =
		normalizeOptionalBoolean(fk.deferred, 'foreign key deferred') === true
			? ' DEFERRABLE INITIALLY DEFERRED'
			: '';
	const notValid =
		normalizeOptionalBoolean(fk.notValid, 'foreign key notValid') === true
			? ' NOT VALID'
			: '';

	return `ALTER TABLE ${qualifiedTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete}${onUpdate}${deferred}${notValid};`;
}

// ============================================================================
// CREATE INDEX
// ============================================================================

export function generateCreateIndex(
	tableName: string,
	idx: IndexIR,
	schemaName: string | undefined,
	context?: IndexCapabilityContext,
	ifNotExists?: boolean,
): string {
	const spec = buildIndexRenderSpec(tableName, idx, schemaName);
	return `${renderCreateIndex(
		ifNotExists === undefined ? spec : { ...spec, ifNotExists },
		context,
	)};`;
}

/**
 * Returns whether the PostgreSQL DDL generator can emit this IndexIR.
 *
 * Keep this as the single representability predicate for generated schema
 * omission and destructive-drop classification: both sides must agree on the
 * exact validation surface used by generateCreateIndex().
 */
export function canGenerateCreateIndex(
	tableName: string,
	idx: IndexIR,
	schemaName: string | undefined = undefined,
): boolean {
	try {
		generateCreateIndex(tableName, idx, schemaName);
		return true;
	} catch {
		return false;
	}
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
): string {
	const qualifiedTable = qualifyTable(tableName, schemaName);
	const policyName = quoteIdentifier(policy.name);
	const ALLOWED_RLS_COMMANDS = [
		'ALL',
		'SELECT',
		'INSERT',
		'UPDATE',
		'DELETE',
	] as const;
	// Snapshot-once: read command ONCE before typeof guard + toUpperCase so a
	// getter-backed forged value cannot switch between the guard and the render.
	const rawCommand = policy.command;
	if (
		rawCommand !== undefined &&
		rawCommand !== null &&
		typeof rawCommand !== 'string'
	) {
		throw new Error(
			`RLS policy command must be a string, got ${typeof rawCommand}.`,
		);
	}
	const rlsCommand = rawCommand ? rawCommand.toUpperCase() : 'ALL';
	if (
		!ALLOWED_RLS_COMMANDS.includes(
			rlsCommand as (typeof ALLOWED_RLS_COMMANDS)[number],
		)
	) {
		throw new Error(
			`Invalid RLS policy command "${rawCommand}". ` +
				`Must be one of: ${ALLOWED_RLS_COMMANDS.join(', ')}.`,
		);
	}
	const forClause = rlsCommand !== 'ALL' ? ` FOR ${rlsCommand}` : ' FOR ALL';
	const asClause =
		policy.permissive === false ? ' AS RESTRICTIVE' : ' AS PERMISSIVE';
	// M-4: role names use quoteRoleName() (allows spaces/hyphens, blocks injection vectors)
	// rather than quoteIdentifier() (which only allows \w$ characters).
	const toClause =
		policy.roles && policy.roles.length > 0
			? ` TO ${policy.roles.map((r) => quoteRoleName(r)).join(', ')}`
			: '';
	// Snapshot-once: read each field EXACTLY ONCE into a local const, validate and render
	// only that local. A getter-backed forged object could return a safe value on the
	// first read (validation) and a malicious value on the second read (render).
	const usingExpr = policy.using;
	if (usingExpr !== undefined && usingExpr !== null && usingExpr !== '') {
		if (typeof usingExpr !== 'string') {
			throw new Error(
				`RLS policy USING: expression must be a plain string, got ${typeof usingExpr}.`,
			);
		}
		validateSqlExpression(usingExpr, 'policy USING expression');
	}
	const withCheckExpr = policy.withCheck;
	if (
		withCheckExpr !== undefined &&
		withCheckExpr !== null &&
		withCheckExpr !== ''
	) {
		if (typeof withCheckExpr !== 'string') {
			throw new Error(
				`RLS policy WITH CHECK: expression must be a plain string, got ${typeof withCheckExpr}.`,
			);
		}
		validateSqlExpression(withCheckExpr, 'policy WITH CHECK expression');
	}
	const usingClause = usingExpr ? ` USING (${usingExpr})` : '';
	const withCheckClause = withCheckExpr ? ` WITH CHECK (${withCheckExpr})` : '';
	return `CREATE POLICY ${policyName} ON ${qualifiedTable}${renderPolicyClauses(asClause, forClause, toClause, usingClause, withCheckClause)};`;
}
