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
	DialectCapabilities,
	EnumIR,
	ForeignKeyIR,
	IndexIR,
	PolicyIR,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { validateIdentifier, validateSqlExpression } from '../validate.js';
import { assertPartitionStrategy } from './ddl-generator.js';
import {
	formatSqlDefault,
	quoteCollation,
	quoteExtensionName,
	quoteIdent,
	quoteRoleName,
	validateEnumLabel,
	validateIndexMethod,
} from './phases/utils.js';
import type { SchemaChange, SchemaDiff } from './schema-diff.js';
import { mapColumnType, mapOnDeleteAction } from './type-mapping.js';

// ── Helpers ─────────────────────────────────────────────────────

// NOTE: quoteIdent (imported from phases/utils) validates + double-quotes identifiers.
// The former local q() had no validation (bare `"${name}"`). All callers now use quoteIdent.

// =============================================================================
// retro-audit M-5 (SchemaChange.meta discriminated union) — DEFERRED
//
// The ~56 `change.meta?.x as ForeignKeyIR / as IndexIR / as ColumnIR` casts
// below remain untyped by design. A full discriminated union covering all ~25
// ChangeKind values is too large in scope for this PR and was explicitly listed
// as deferrable in the audit brief.
//
// Tracked in TODO.md: "[adapter-pgsql] M-5 SchemaChangeMeta discriminated union".
//
// Until that follow-up lands, every NEW SchemaChange producer MUST verify the
// meta shape at the call site rather than relying on downstream casts.
// =============================================================================

/** Schema-qualify a table name: "schema"."table" or just "table". */
function qualifyTable(table: string, schemaName?: string): string {
	return schemaName
		? `${quoteIdent(schemaName, 'schema')}.${quoteIdent(table, 'table')}`
		: quoteIdent(table, 'table');
}

// validateEnumLabel is imported from './phases/utils.js' (shared with enum-types.ts)

/** PK constraint name convention. */
function pkName(table: string): string {
	return `pk_${table}`;
}

/** FK constraint name convention. */
function fkName(table: string, columns: readonly string[]): string {
	return `fk_${table}_${columns.join('_')}`;
}

/** Column UNIQUE constraint name convention. */
function uniqueName(table: string, column: string): string {
	return `${table}_${column}_key`;
}

/** Index name convention (custom name takes priority). */
function idxName(
	table: string,
	columns: readonly string[],
	customName?: string,
): string {
	return customName ?? `idx_${table}_${columns.join('_')}`;
}

/** Build a CREATE POLICY SQL statement from a PolicyIR. */
function buildPolicySQL(
	tableName: string,
	policy: PolicyIR,
	schemaName?: string,
): string {
	const policyName = quoteIdent(policy.name, 'alias');
	const qt = qualifyTable(tableName, schemaName);
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
	// M-4: role names use quoteRoleName() (allows spaces, blocks injection vectors)
	// rather than quoteIdent() (which only allows \w$ characters).
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
		validateSqlExpression(usingExpr, 'USING expression');
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
		validateSqlExpression(withCheckExpr, 'WITH CHECK expression');
	}
	const usingClause = usingExpr ? ` USING (${usingExpr})` : '';
	const withCheckClause = withCheckExpr ? ` WITH CHECK (${withCheckExpr})` : '';
	return `CREATE POLICY ${policyName} ON ${qt}${forClause}${asClause}${toClause}${usingClause}${withCheckClause};`;
}

/**
 * Build a sequence options clause (shared by CREATE SEQUENCE, ALTER SEQUENCE, and their reverses).
 *
 * @param verb - SQL verb: `'CREATE SEQUENCE'` or `'ALTER SEQUENCE'`
 * @param seqName - Already-quoted and schema-qualified sequence name
 * @param seq - Sequence properties to emit
 * @param includeCycleNoCycle - When true, emits `NO CYCLE` for `seq.cycle === false`
 *   (needed by ALTER SEQUENCE; CREATE SEQUENCE omits the clause when cycle is false)
 * @returns Full SQL statement ending with `;`
 */
/**
 * Build a sequence options clause shared by CREATE SEQUENCE, ALTER SEQUENCE, and their reverses.
 *
 * @param verb - SQL verb: `'CREATE SEQUENCE'` or `'ALTER SEQUENCE'`
 * @param seqName - Already-quoted and schema-qualified sequence name
 * @param seq - Sequence properties to emit
 * @param includeCycleNoCycle - When true (ALTER SEQUENCE), emits `NO CYCLE` for `seq.cycle === false`.
 *   When false (CREATE SEQUENCE), only emits `CYCLE` when truthy; no `NO CYCLE` clause.
 * @returns Full SQL statement ending with `;`
 */
export function buildSequenceClause(
	verb: 'CREATE SEQUENCE' | 'ALTER SEQUENCE',
	seqName: string,
	seq: Pick<
		SequenceIR,
		'startWith' | 'incrementBy' | 'minValue' | 'maxValue' | 'cycle'
	>,
	includeCycleNoCycle = false,
): string {
	const parts: string[] = [`${verb} ${seqName}`];
	if (seq.startWith !== undefined) parts.push(`START WITH ${seq.startWith}`);
	if (seq.incrementBy !== undefined)
		parts.push(`INCREMENT BY ${seq.incrementBy}`);
	if (seq.minValue !== undefined) parts.push(`MINVALUE ${seq.minValue}`);
	if (seq.maxValue !== undefined) parts.push(`MAXVALUE ${seq.maxValue}`);
	if (includeCycleNoCycle) {
		// ALTER SEQUENCE: emit CYCLE or NO CYCLE when the flag is defined
		if (seq.cycle !== undefined) parts.push(seq.cycle ? 'CYCLE' : 'NO CYCLE');
	} else {
		// CREATE SEQUENCE: only emit CYCLE when truthy; silence NO CYCLE
		if (seq.cycle) parts.push('CYCLE');
	}
	return `${parts.join(' ')};`;
}

// ============================================================================
// Types
// ============================================================================

export interface MigrationSQLOptions {
	/** Schema namespace (default: none — unqualified) */
	readonly schemaName?: string;
	/** Whether to include destructive changes (drops) */
	readonly includeDestructive?: boolean;
	/** Automatically create indexes on FK columns for new tables (default: true) */
	readonly fkAutoIndex?: boolean;
	/** Dialect capabilities — migration SQL for unsupported features will be filtered */
	readonly dialectCapabilities?: DialectCapabilities;
}

export interface DownMigrationSQL {
	readonly statements: readonly string[];
	readonly destructive: boolean;
}

interface DownChangeSQL {
	readonly sql: string | undefined;
	readonly destructive: boolean;
}

function failSafeUnknownDownChange(kind: never): DownChangeSQL {
	return {
		sql: `-- WARNING: Cannot reverse unsupported SchemaChange kind "${kind}"`,
		destructive: true,
	};
}

// ============================================================================
// Capability Helpers
// ============================================================================

/** Check if a change kind is supported by the dialect capabilities */
function isChangeSupported(kind: string, caps: DialectCapabilities): boolean {
	switch (kind) {
		case 'create_enum':
		case 'drop_enum':
		case 'alter_enum_add_value':
			return caps.supportsDDLEnumTypes === true;
		case 'create_extension':
		case 'drop_extension':
			return caps.supportsDDLExtensions === true;
		case 'create_sequence':
		case 'drop_sequence':
		case 'alter_sequence':
			return caps.supportsDDLSequences === true;
		case 'add_check_constraint':
		case 'drop_check_constraint':
			return caps.supportsDDLCheckConstraints === true;
		case 'add_comment':
		case 'drop_comment':
			return caps.supportsDDLComments === true;
		case 'alter_column_collation':
			return caps.supportsDDLCollation === true;
		case 'alter_column_identity':
			return caps.supportsDDLIdentityColumns === true;
		case 'enable_rls':
		case 'disable_rls':
		case 'create_policy':
		case 'drop_policy':
			return caps.supportsDDLRowLevelSecurity === true;
		default:
			return true;
	}
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
 * 9.  ADD primary keys / column UNIQUE constraints
 * 10. ADD FK constraints (must add after referenced tables exist)
 * 11. ALTER FK (drop + re-add)
 * 12. CREATE indexes
 * 13. ADD CHECK constraints
 * 14. ALTER ENUM ADD VALUE (must be last — has transaction visibility caveats in PG)
 * 15. COMMENT ON TABLE / COLUMN (very last)
 */
export function generateMigrationSQL(
	diff: SchemaDiff,
	options?: MigrationSQLOptions,
): readonly string[] {
	const schemaName = options?.schemaName;
	const includeDestructive = options?.includeDestructive ?? true;

	// Filter out destructive changes if not included
	const filteredChanges = includeDestructive
		? diff.changes
		: diff.changes.filter((c) => !c.destructive);

	const caps = options?.dialectCapabilities;

	// Filter out changes for unsupported DDL features
	const changes = caps
		? filteredChanges.filter((c) => isChangeSupported(c.kind, caps))
		: filteredChanges;

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
		[], // 9: add PK / column UNIQUE constraint
		[], // 10: add FK
		[], // 11: alter FK (drop + re-add)
		[], // 12: create index
		[], // 13: add CHECK constraint
		[], // 14: alter ENUM add value (must be after CREATE TABLE, outside transaction)
		[], // 15: COMMENT ON TABLE / COLUMN
		[], // 16: VALIDATE CONSTRAINT (after FK/CHECK added with NOT VALID)
		[], // 17: ENABLE/DISABLE ROW LEVEL SECURITY
		[], // 18: CREATE/DROP POLICY
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

	// FK auto-indexes for new tables (single-column FKs without explicit index)
	if (options?.fkAutoIndex !== false) {
		for (const change of changes) {
			if (change.kind === 'create_table') {
				const table = change.meta?.table as TableIR | undefined;
				if (!table) continue;
				const explicitIndexColumns = new Set(
					table.indexes.flatMap((idx) =>
						idx.columns.length === 1 ? idx.columns : [],
					),
				);
				for (const fk of table.foreignKeys) {
					const fkCol = fk.columns[0];
					if (
						fk.columns.length === 1 &&
						fkCol &&
						!explicitIndexColumns.has(fkCol)
					) {
						const indexName = quoteIdent(idxName(table.name, [fkCol]), 'alias');
						statements.push(
							`CREATE INDEX IF NOT EXISTS ${indexName} ON ${qualifyTable(table.name, schemaName)} (${quoteIdent(fkCol, 'alias')});`,
						);
					}
				}
			}
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
		case 'drop_extension':
		case 'drop_sequence':
			return 4;
		case 'create_enum':
		case 'create_extension':
		case 'create_sequence':
			return 5;
		case 'alter_sequence':
			return 8;
		case 'create_table':
			return 6;
		case 'add_column':
			return 7;
		case 'alter_column_type':
		case 'alter_column_nullable':
		case 'alter_column_default':
		case 'alter_column_collation':
		case 'alter_column_identity':
			return 8;
		case 'alter_column_unique':
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
		case 'add_comment':
		case 'drop_comment':
			return 15;
		case 'validate_constraint':
			// Runs after add_foreign_key / add_check_constraint so the constraint exists
			return 16;
		case 'enable_rls':
		case 'disable_rls':
			// After table is created / indexes set up
			return 17;
		case 'create_policy':
		case 'drop_policy':
			// After RLS is enabled
			return 18;
	}
}

// ============================================================================
// SQL Generators per ChangeKind
// ============================================================================

// ============================================================================
// UP SQL Handlers (one function per change kind)
// ============================================================================

function upAddColumn(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const col = change.meta?.column as ColumnIR | undefined;
	if (!col) return undefined;
	const typeName = mapColumnType(col);
	const notNull = !col.nullable && !col.autoIncrement ? ' NOT NULL' : '';
	const def =
		col.default !== undefined ? ` DEFAULT ${formatDefault(col.default)}` : '';
	const unique = col.unique ? ' UNIQUE' : '';
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD COLUMN ${quoteIdent(col.name, 'alias')} ${typeName}${notNull}${def}${unique};`;
}

function upAlterColumnType(change: SchemaChange, schemaName?: string): string {
	const col = change.meta?.column as ColumnIR | undefined;
	const toType = col ? mapColumnType(col) : String(change.meta?.toType);
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} TYPE ${toType};`;
}

function upAlterColumnNullable(
	change: SchemaChange,
	schemaName?: string,
): string {
	const nullable = change.meta?.nullable as boolean;
	const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} ${action};`;
}

function upAlterColumnDefault(
	change: SchemaChange,
	schemaName?: string,
): string {
	const def = change.meta?.default;
	if (def === undefined || def === null) {
		return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} DROP DEFAULT;`;
	}
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} SET DEFAULT ${formatDefault(def)};`;
}

function addColumnUniqueSQL(
	table: string,
	column: string,
	schemaName?: string,
): string {
	const constraintName = quoteIdent(uniqueName(table, column), 'alias');
	return `ALTER TABLE ${qualifyTable(table, schemaName)} ADD CONSTRAINT ${constraintName} UNIQUE (${quoteIdent(column, 'alias')});`;
}

function dropColumnUniqueSQL(
	table: string,
	column: string,
	schemaName?: string,
): string {
	const constraintName = quoteIdent(uniqueName(table, column), 'alias');
	return `ALTER TABLE ${qualifyTable(table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
}

function upAlterColumnUnique(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const unique = change.meta?.unique as boolean | undefined;
	if (unique === undefined || !change.column) return undefined;
	return unique
		? addColumnUniqueSQL(change.table, change.column, schemaName)
		: dropColumnUniqueSQL(change.table, change.column, schemaName);
}

function upAddPrimaryKey(change: SchemaChange, schemaName?: string): string {
	const columns = change.meta?.columns as string[];
	const pkCols = columns.map((n) => quoteIdent(n, 'alias')).join(', ');
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD CONSTRAINT ${quoteIdent(pkName(change.table), 'alias')} PRIMARY KEY (${pkCols});`;
}

function upDropForeignKey(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const fk = change.meta?.fk as ForeignKeyIR;
	if (!fk) return undefined;
	const constraintName = quoteIdent(fkName(change.table, fk.columns), 'alias');
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
}

function upAlterForeignKey(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	// Drop + re-add with new onDelete
	const fk = change.meta?.fk as ForeignKeyIR;
	if (!fk) return undefined;
	const constraintName = quoteIdent(fkName(change.table, fk.columns), 'alias');
	const drop = `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
	const add = generateAddFKSQL(change.table, fk, schemaName);
	return `${drop}\n${add}`;
}

function upCreateIndex(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const idx = change.meta?.index as IndexIR;
	if (!idx) return undefined;
	const indexName = quoteIdent(
		idxName(change.table, idx.columns, idx.name),
		'alias',
	);
	const unique = idx.unique ? 'UNIQUE ' : '';
	// S-1: validate index method against allowlist before interpolation into unquoted USING clause
	if (idx.method) validateIndexMethod(idx.method, 'index method');
	const method = idx.method ? ` USING ${idx.method}` : '';

	// Build column list: expressions first (validated), then named columns with optional opclass
	// S-1: validate each expression and opclass before interpolation
	const colParts: string[] = [
		...(idx.expressions ?? []).map((expr) => {
			validateSqlExpression(expr, 'index expression');
			return expr;
		}),
		...idx.columns.map((col) => {
			const opclass = idx.opclass?.[col] ?? '';
			if (opclass) validateIdentifier(opclass, 'alias');
			return `${quoteIdent(col, 'alias')}${opclass ? ` ${opclass}` : ''}`;
		}),
	];
	const cols = colParts.join(', ');

	const include =
		idx.include && idx.include.length > 0
			? ` INCLUDE (${idx.include.map((n) => quoteIdent(n, 'alias')).join(', ')})`
			: '';

	// Emitted unconditionally, matching INCLUDE; full PG-version gating is tracked in #245.
	const nullsNotDistinct =
		idx.unique && idx.nullsNotDistinct ? ' NULLS NOT DISTINCT' : '';

	// S-1: validate WITH storage parameter keys (values are numeric literals from IR)
	const withParams =
		idx.with && Object.keys(idx.with).length > 0
			? ` WITH (${Object.entries(idx.with)
					.map(([k, v]) => {
						validateIdentifier(k, 'alias');
						return `${k} = ${v}`;
					})
					.join(', ')})`
			: '';

	// S-1: validate WHERE predicate expression before interpolation
	if (idx.where) validateSqlExpression(idx.where, 'index WHERE predicate');
	const where = idx.where ? ` WHERE ${idx.where}` : '';

	return `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${qualifyTable(change.table, schemaName)}${method} (${cols})${include}${nullsNotDistinct}${withParams}${where};`;
}

function upDropIndex(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const idx = change.meta?.index as IndexIR;
	if (!idx) return undefined;
	const indexName = quoteIdent(
		idxName(change.table, idx.columns, idx.name),
		'alias',
	);
	const schemaPrefix = schemaName ? `${quoteIdent(schemaName, 'alias')}.` : '';
	return `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`;
}

function upAddCheckConstraint(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const check = change.meta?.check as CheckConstraintIR;
	if (!check) return undefined;
	const notValid = check.notValid ? ' NOT VALID' : '';
	validateSqlExpression(
		check.expression,
		'migration check constraint expression',
	);
	return (
		'DO $$ BEGIN ALTER TABLE ' +
		qualifyTable(change.table, schemaName) +
		' ADD CONSTRAINT ' +
		quoteIdent(check.name, 'alias') +
		' ' +
		check.expression +
		notValid +
		'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;'
	);
}

function upValidateConstraint(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const fk = change.meta?.fk as ForeignKeyIR | undefined;
	const check = change.meta?.check as CheckConstraintIR | undefined;
	const constraintName = fk
		? quoteIdent(fkName(change.table, fk.columns), 'alias')
		: check
			? quoteIdent(check.name, 'alias')
			: undefined;
	if (!constraintName) return undefined;
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} VALIDATE CONSTRAINT ${constraintName};`;
}

function upCreateEnum(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const enumDef = change.meta?.enum as EnumIR;
	if (!enumDef) return undefined;
	const enumName = schemaName
		? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(enumDef.name, 'alias')}`
		: quoteIdent(enumDef.name, 'alias');
	// M-2: validate each enum value against NUL/control-char injection before emission
	const values = enumDef.values
		.map((v) => {
			validateEnumLabel(v, 'enum value');
			return `'${v.replace(/'/g, "''")}'`;
		})
		.join(', ');
	return `CREATE TYPE ${enumName} AS ENUM (${values});`;
}

function upAlterEnumAddValue(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const enumDef = change.meta?.enum as EnumIR;
	const value = change.meta?.value as string;
	const after = change.meta?.after as string | undefined;
	if (!enumDef || !value) return undefined;
	// M-2: enum name validated via quoteIdent; enum labels validated against control-char injection
	const enumName = schemaName
		? `${quoteIdent(schemaName, 'schema')}.${quoteIdent(enumDef.name, 'table')}`
		: quoteIdent(enumDef.name, 'table');
	validateEnumLabel(value, 'enum value');
	if (after !== undefined) validateEnumLabel(after, 'enum AFTER position');
	const escaped = value.replace(/'/g, "''");
	const position = after ? ` AFTER '${after.replace(/'/g, "''")}'` : '';
	return `ALTER TYPE ${enumName} ADD VALUE IF NOT EXISTS '${escaped}'${position};`;
}

function upDropEnum(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const enumDef = change.meta?.enum as EnumIR;
	if (!enumDef) return undefined;
	const enumName = schemaName
		? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(enumDef.name, 'alias')}`
		: quoteIdent(enumDef.name, 'alias');
	// Before dropping the type, cast any referencing columns to text
	// to prevent "cannot drop type: still referenced" errors.
	const refs = change.meta?.referencingColumns as
		| Array<{ table: string; column: string }>
		| undefined;
	const alterStatements =
		refs && refs.length > 0
			? refs.map(
					(ref) =>
						`ALTER TABLE ${qualifyTable(ref.table, schemaName)} ALTER COLUMN ${quoteIdent(ref.column, 'alias')} TYPE text;`,
				)
			: [];
	return [...alterStatements, `DROP TYPE IF EXISTS ${enumName} CASCADE;`].join(
		'\n',
	);
}

function upAlterColumnCollation(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const col = change.meta?.column as ColumnIR;
	if (!col) return undefined;
	// S-2: validate collation name before quoting — uses quoteCollation which
	// accepts locale strings like `en_US.utf8`, `en-US-x-icu`, `C.UTF-8`
	// that contain dots/hyphens rejected by the standard identifier validator.
	const collation = col.collation
		? ` COLLATE ${quoteCollation(col.collation)}`
		: '';
	const typeName = mapColumnType(col);
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} TYPE ${typeName}${collation};`;
}

function upAlterColumnIdentity(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const col = change.meta?.column as ColumnIR;
	const prevIdentity = change.meta?.previousIdentity as string | undefined;
	if (!col) return undefined;
	const table = qualifyTable(change.table, schemaName);
	const column = quoteIdent(change.column!, 'alias');
	if (!col.identity && prevIdentity) {
		return `ALTER TABLE ${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS;`;
	}
	if (col.identity && !prevIdentity) {
		const gen = col.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
		return `ALTER TABLE ${table} ALTER COLUMN ${column} ADD GENERATED ${gen} AS IDENTITY;`;
	}
	// Change from one identity type to another
	const gen = col.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
	return `ALTER TABLE ${table} ALTER COLUMN ${column} SET GENERATED ${gen};`;
}

function upAddComment(change: SchemaChange, schemaName?: string): string {
	const comment = change.meta?.comment as string;
	const target = change.meta?.target as string;
	const escaped = comment.replace(/'/g, "''");
	if (target === 'table') {
		return `COMMENT ON TABLE ${qualifyTable(change.table, schemaName)} IS '${escaped}';`;
	}
	return `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${quoteIdent(change.column!, 'alias')} IS '${escaped}';`;
}

function upSequenceName(
	schemaName: string | undefined,
	seq: SequenceIR,
): string {
	return schemaName
		? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(seq.name, 'alias')}`
		: quoteIdent(seq.name, 'alias');
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
			return table ? generateCreateTableSQL(table, schemaName) : undefined;
		}
		case 'drop_table':
			return `DROP TABLE IF EXISTS ${qualifyTable(change.table, schemaName)} CASCADE;`;
		case 'add_column':
			return upAddColumn(change, schemaName);
		case 'drop_column':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP COLUMN ${quoteIdent(change.column!, 'alias')} CASCADE;`;
		case 'alter_column_type':
			return upAlterColumnType(change, schemaName);
		case 'alter_column_nullable':
			return upAlterColumnNullable(change, schemaName);
		case 'alter_column_default':
			return upAlterColumnDefault(change, schemaName);
		case 'alter_column_unique':
			return upAlterColumnUnique(change, schemaName);
		case 'add_primary_key':
			return upAddPrimaryKey(change, schemaName);
		case 'drop_primary_key':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(pkName(change.table), 'alias')} CASCADE;`;
		case 'add_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR;
			return fk ? generateAddFKSQL(change.table, fk, schemaName) : undefined;
		}
		case 'drop_foreign_key':
			return upDropForeignKey(change, schemaName);
		case 'alter_foreign_key':
			return upAlterForeignKey(change, schemaName);
		case 'create_index':
			return upCreateIndex(change, schemaName);
		case 'drop_index':
			return upDropIndex(change, schemaName);
		case 'add_check_constraint':
			return upAddCheckConstraint(change, schemaName);
		case 'validate_constraint':
			return upValidateConstraint(change, schemaName);
		case 'drop_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR;
			return check
				? `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(check.name, 'alias')};`
				: undefined;
		}
		case 'create_enum':
			return upCreateEnum(change, schemaName);
		case 'alter_enum_add_value':
			return upAlterEnumAddValue(change, schemaName);
		case 'drop_enum':
			return upDropEnum(change, schemaName);
		case 'alter_column_collation':
			return upAlterColumnCollation(change, schemaName);
		case 'alter_column_identity':
			return upAlterColumnIdentity(change, schemaName);
		case 'add_comment':
			return upAddComment(change, schemaName);
		case 'drop_comment': {
			const target = change.meta?.target as string;
			if (target === 'table') {
				return `COMMENT ON TABLE ${qualifyTable(change.table, schemaName)} IS NULL;`;
			}
			return `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${quoteIdent(change.column!, 'alias')} IS NULL;`;
		}
		case 'create_extension': {
			const ext = change.meta?.extension as string;
			if (ext == null) return undefined;
			return `CREATE EXTENSION IF NOT EXISTS ${quoteExtensionName(ext)};`;
		}
		case 'drop_extension': {
			const ext = change.meta?.extension as string;
			if (ext == null) return undefined;
			return `DROP EXTENSION IF EXISTS ${quoteExtensionName(ext)} CASCADE;`;
		}
		case 'create_sequence': {
			const seq = change.meta?.sequence as SequenceIR;
			return seq
				? buildSequenceClause(
						'CREATE SEQUENCE',
						upSequenceName(schemaName, seq),
						seq,
					)
				: undefined;
		}
		case 'alter_sequence': {
			const seq = change.meta?.sequence as SequenceIR;
			return seq
				? buildSequenceClause(
						'ALTER SEQUENCE',
						upSequenceName(schemaName, seq),
						seq,
						true,
					)
				: undefined;
		}
		case 'drop_sequence': {
			const seq = change.meta?.sequence as SequenceIR;
			return seq
				? `DROP SEQUENCE IF EXISTS ${upSequenceName(schemaName, seq)} CASCADE;`
				: undefined;
		}
		case 'enable_rls':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ENABLE ROW LEVEL SECURITY;`;
		case 'disable_rls':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DISABLE ROW LEVEL SECURITY;`;
		case 'create_policy': {
			const policy = change.meta?.policy as PolicyIR;
			return policy
				? buildPolicySQL(change.table, policy, schemaName)
				: undefined;
		}
		case 'drop_policy': {
			const policy = change.meta?.policy as PolicyIR;
			return policy
				? `DROP POLICY IF EXISTS ${quoteIdent(policy.name, 'alias')} ON ${qualifyTable(change.table, schemaName)};`
				: undefined;
		}
	}
}

// ============================================================================
// DOWN SQL Generators per ChangeKind
// ============================================================================

function changeToDownSQL(
	change: SchemaChange,
	schemaName?: string,
): DownChangeSQL {
	// Fail-safe allowlist: DOWN is destructive unless this switch explicitly
	// proves it only re-adds/restores recorded prior state. Any DROP, DISABLE,
	// removal, warning, missing metadata, or uncertain reversal stays destructive.
	switch (change.kind) {
		case 'create_table':
			return {
				sql: `DROP TABLE IF EXISTS ${qualifyTable(change.table, schemaName)} CASCADE;`,
				destructive: true,
			};

		case 'drop_table':
			return {
				sql: `-- WARNING: Cannot reverse drop_table "${change.table}" -- table data was lost`,
				destructive: true,
			};

		case 'add_column':
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP COLUMN ${quoteIdent(change.column!, 'alias')} CASCADE;`,
				destructive: true,
			};

		case 'drop_column':
			return {
				sql: `-- WARNING: Cannot reverse drop_column "${change.table}"."${change.column}" -- column data was lost`,
				destructive: true,
			};

		case 'alter_column_type': {
			const fromType = change.meta?.fromType as string | undefined;
			if (!fromType) {
				return {
					sql: `-- WARNING: Cannot reverse alter_column_type "${change.table}"."${change.column}" -- missing migration metadata`,
					destructive: true,
				};
			}
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} TYPE ${fromType};`,
				destructive: true,
			};
		}

		case 'alter_column_nullable': {
			const oldNullable = change.meta?.oldNullable as boolean | undefined;
			if (oldNullable === undefined) {
				return {
					sql: `-- WARNING: Cannot reverse alter_column_nullable "${change.table}"."${change.column}" -- missing migration metadata`,
					destructive: true,
				};
			}
			// Reverse: restore old nullable state
			const action = oldNullable ? 'DROP NOT NULL' : 'SET NOT NULL';
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} ${action};`,
				// Allowlisted: restores the recorded prior nullability metadata.
				destructive: false,
			};
		}

		case 'alter_column_default': {
			const oldDefault = change.meta?.oldDefault;
			if (oldDefault === undefined) {
				return {
					sql: `-- WARNING: Cannot reverse alter_column_default "${change.table}"."${change.column}" -- missing migration metadata`,
					destructive: true,
				};
			}
			if (oldDefault === null) {
				return {
					sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} DROP DEFAULT;`,
					// Allowlisted: restores the recorded prior state of "no default".
					destructive: false,
				};
			}
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${quoteIdent(change.column!, 'alias')} SET DEFAULT ${formatDefault(oldDefault)};`,
				// Allowlisted: restores the recorded prior default value.
				destructive: false,
			};
		}

		case 'alter_column_unique': {
			const unique = change.meta?.unique as boolean | undefined;
			if (unique === undefined || !change.column) {
				return {
					sql: `-- WARNING: Cannot reverse alter_column_unique "${change.table}"."${change.column}" -- missing migration metadata`,
					destructive: true,
				};
			}
			return {
				sql: unique
					? dropColumnUniqueSQL(change.table, change.column, schemaName)
					: addColumnUniqueSQL(change.table, change.column, schemaName),
				destructive: false,
			};
		}

		case 'add_primary_key': {
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(pkName(change.table), 'alias')} CASCADE;`,
				destructive: true,
			};
		}

		case 'drop_primary_key': {
			const columns = change.meta?.columns as readonly string[] | undefined;
			if (Array.isArray(columns) && columns.length > 0) {
				const pkCols = columns.map((n) => quoteIdent(n, 'alias')).join(', ');
				return {
					sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD CONSTRAINT ${quoteIdent(pkName(change.table), 'alias')} PRIMARY KEY (${pkCols});`,
					// Allowlisted: re-adds the dropped primary-key constraint from metadata.
					destructive: false,
				};
			}
			return {
				sql: `-- WARNING: Cannot reverse drop_primary_key "${change.table}" -- columns unknown`,
				destructive: true,
			};
		}

		case 'add_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR | undefined;
			if (!fk) return { sql: undefined, destructive: true };
			const constraintName = quoteIdent(
				fkName(change.table, fk.columns),
				'alias',
			);
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName} CASCADE;`,
				destructive: true,
			};
		}

		case 'drop_foreign_key': {
			const fk = change.meta?.fk as ForeignKeyIR | undefined;
			if (!fk) {
				return {
					sql: `-- WARNING: Cannot reverse drop_foreign_key "${change.table}" -- FK definition was lost`,
					destructive: true,
				};
			}
			return {
				sql: generateAddFKSQL(change.table, fk, schemaName),
				// Allowlisted: re-adds the dropped foreign-key constraint from metadata.
				destructive: false,
			};
		}

		case 'alter_foreign_key': {
			const oldFk = change.meta?.oldFk as ForeignKeyIR | undefined;
			const fk = change.meta?.fk as ForeignKeyIR | undefined;
			if (!oldFk || !fk) {
				return {
					sql: `-- WARNING: Cannot reverse alter_foreign_key "${change.table}" -- missing migration metadata`,
					destructive: true,
				};
			}
			const constraintName = quoteIdent(
				fkName(change.table, fk.columns),
				'alias',
			);
			const drop = `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
			const add = generateAddFKSQL(change.table, oldFk, schemaName);
			// Allowlisted: swaps the current FK back to the recorded prior FK.
			return { sql: `${drop}\n${add}`, destructive: false };
		}

		case 'create_index': {
			const idx = change.meta?.index as IndexIR | undefined;
			if (!idx) return { sql: undefined, destructive: true };
			const indexName = quoteIdent(
				idxName(change.table, idx.columns, idx.name),
				'alias',
			);
			const schemaPrefix = schemaName
				? `${quoteIdent(schemaName, 'alias')}.`
				: '';
			return {
				sql: `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`,
				destructive: true,
			};
		}

		case 'drop_index': {
			const idx = change.meta?.index as IndexIR | undefined;
			if (!idx) {
				return {
					sql: `-- WARNING: Cannot reverse drop_index "${change.table}" -- index definition was lost`,
					destructive: true,
				};
			}
			return {
				sql: upCreateIndex(change, schemaName),
				// Allowlisted: re-creates the dropped index from metadata.
				destructive: false,
			};
		}

		case 'add_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR | undefined;
			if (!check) return { sql: undefined, destructive: true };
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${quoteIdent(check.name, 'alias')};`,
				destructive: true,
			};
		}

		case 'drop_check_constraint': {
			const check = change.meta?.check as CheckConstraintIR | undefined;
			if (!check) return { sql: undefined, destructive: true };
			validateSqlExpression(
				check.expression,
				'migration check constraint (down)',
			);
			return {
				sql:
					'DO $$ BEGIN ALTER TABLE ' +
					qualifyTable(change.table, schemaName) +
					' ADD CONSTRAINT ' +
					quoteIdent(check.name, 'alias') +
					' ' +
					check.expression +
					'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
				// Allowlisted: re-adds the dropped CHECK constraint from metadata.
				destructive: false,
			};
		}

		case 'create_enum': {
			// DOWN: drop the type that was created
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return { sql: undefined, destructive: true };
			const enumName = schemaName
				? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(enumDef.name, 'alias')}`
				: quoteIdent(enumDef.name, 'alias');
			return {
				sql: `DROP TYPE IF EXISTS ${enumName} CASCADE;`,
				destructive: true,
			};
		}

		case 'drop_enum': {
			// DOWN: recreate the type that was dropped
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return { sql: undefined, destructive: true };
			const enumName = schemaName
				? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(enumDef.name, 'alias')}`
				: quoteIdent(enumDef.name, 'alias');
			const values = enumDef.values
				.map((v) => `'${v.replace(/'/g, "''")}'`)
				.join(', ');
			return {
				sql: `CREATE TYPE ${enumName} AS ENUM (${values});`,
				// Allowlisted: re-creates the dropped enum type from metadata.
				destructive: false,
			};
		}

		case 'alter_enum_add_value':
			// DOWN: ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL
			return {
				sql: `-- ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL`,
				destructive: true,
			};

		case 'alter_column_collation': {
			// DOWN: restore previous collation — stored in db state, not in meta; emit warning
			return {
				sql: `-- WARNING: Cannot reverse alter_column_collation "${change.table}"."${change.column}" -- previous collation unknown`,
				destructive: true,
			};
		}

		case 'alter_column_identity': {
			const col = change.meta?.column as ColumnIR | undefined;
			const prevIdentity = change.meta?.previousIdentity as string | undefined;
			if (!col) return { sql: undefined, destructive: true };
			const table = qualifyTable(change.table, schemaName);
			const column = quoteIdent(change.column!, 'alias');
			// Reverse: restore previous identity state
			if (prevIdentity && !col.identity) {
				// Was identity, now not → re-add identity
				const gen = prevIdentity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
				return {
					sql: `ALTER TABLE ${table} ALTER COLUMN ${column} ADD GENERATED ${gen} AS IDENTITY;`,
					// Allowlisted: re-adds the previously recorded identity metadata.
					destructive: false,
				};
			}
			if (!prevIdentity && col.identity) {
				// Was not identity, now is → drop identity
				return {
					sql: `ALTER TABLE ${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS;`,
					destructive: true,
				};
			}
			if (!prevIdentity && !col.identity) {
				return {
					sql: `-- WARNING: Cannot reverse alter_column_identity "${change.table}"."${change.column}" -- missing previous identity metadata`,
					destructive: true,
				};
			}
			// Change between types → restore previous
			const gen = prevIdentity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
			return {
				sql: `ALTER TABLE ${table} ALTER COLUMN ${column} SET GENERATED ${gen};`,
				// Allowlisted: restores the recorded prior identity generation mode.
				destructive: false,
			};
		}

		case 'add_comment': {
			// DOWN: remove the comment that was added
			const target = change.meta?.target as string;
			if (target === 'table') {
				return {
					sql: `COMMENT ON TABLE ${qualifyTable(change.table, schemaName)} IS NULL;`,
					destructive: true,
				};
			}
			return {
				sql: `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${quoteIdent(change.column!, 'alias')} IS NULL;`,
				destructive: true,
			};
		}

		case 'drop_comment': {
			const target = change.meta?.target as string | undefined;
			const comment = change.meta?.comment as string | undefined;
			if (typeof comment === 'string') {
				const escaped = comment.replace(/'/g, "''");
				if (target === 'table') {
					return {
						sql: `COMMENT ON TABLE ${qualifyTable(change.table, schemaName)} IS '${escaped}';`,
						// Allowlisted: re-adds the dropped table comment from metadata.
						destructive: false,
					};
				}
				if (target === 'column') {
					return {
						sql: `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${quoteIdent(change.column!, 'alias')} IS '${escaped}';`,
						// Allowlisted: re-adds the dropped column comment from metadata.
						destructive: false,
					};
				}
			}
			return {
				sql: `-- WARNING: Cannot reverse drop_comment "${change.table}"${change.column ? `."${change.column}"` : ''} -- comment text was lost`,
				destructive: true,
			};
		}

		case 'create_extension': {
			// DOWN: drop the extension that was created
			const ext = change.meta?.extension as string;
			if (ext == null) return { sql: undefined, destructive: true };
			return {
				sql: `DROP EXTENSION IF EXISTS ${quoteExtensionName(ext)} CASCADE;`,
				destructive: true,
			};
		}

		case 'drop_extension': {
			// DOWN: recreate the extension that was dropped
			const ext = change.meta?.extension as string;
			if (ext == null) return { sql: undefined, destructive: true };
			return {
				sql: `CREATE EXTENSION IF NOT EXISTS ${quoteExtensionName(ext)};`,
				// Allowlisted: re-creates the dropped extension from metadata.
				destructive: false,
			};
		}

		case 'create_sequence': {
			// DOWN: drop the sequence that was created
			const seq = change.meta?.sequence as SequenceIR;
			if (!seq) return { sql: undefined, destructive: true };
			const seqName = schemaName
				? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(seq.name, 'alias')}`
				: quoteIdent(seq.name, 'alias');
			return {
				sql: `DROP SEQUENCE IF EXISTS ${seqName} CASCADE;`,
				destructive: true,
			};
		}

		case 'alter_sequence': {
			// DOWN: restore previous sequence state
			const prevSeq = change.meta?.previousSequence as SequenceIR | undefined;
			if (!prevSeq) {
				return {
					sql: `-- WARNING: Cannot reverse alter_sequence "${change.table}" -- missing migration metadata`,
					destructive: true,
				};
			}
			const seqName = schemaName
				? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(prevSeq.name, 'alias')}`
				: quoteIdent(prevSeq.name, 'alias');
			return {
				sql: buildSequenceClause('ALTER SEQUENCE', seqName, prevSeq, true),
				// Allowlisted: restores the recorded prior sequence metadata.
				destructive: false,
			};
		}

		case 'drop_sequence': {
			// DOWN: recreate the sequence that was dropped
			const seq = change.meta?.sequence as SequenceIR;
			if (!seq) return { sql: undefined, destructive: true };
			const seqName = schemaName
				? `${quoteIdent(schemaName, 'alias')}.${quoteIdent(seq.name, 'alias')}`
				: quoteIdent(seq.name, 'alias');
			return {
				sql: buildSequenceClause('CREATE SEQUENCE', seqName, seq),
				// Allowlisted: re-creates the dropped sequence from metadata.
				destructive: false,
			};
		}

		case 'validate_constraint':
			// DOWN: VALIDATE CONSTRAINT cannot be reversed in PostgreSQL
			return {
				sql: `-- VALIDATE CONSTRAINT cannot be reversed in PostgreSQL (table: "${change.table}")`,
				destructive: true,
			};

		case 'enable_rls':
			// DOWN: reverse enable → disable
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} DISABLE ROW LEVEL SECURITY;`,
				destructive: true,
			};

		case 'disable_rls':
			// DOWN: reverse disable → enable
			return {
				sql: `ALTER TABLE ${qualifyTable(change.table, schemaName)} ENABLE ROW LEVEL SECURITY;`,
				// Allowlisted: re-enables the previously present RLS security control.
				destructive: false,
			};

		case 'create_policy': {
			// DOWN: drop the policy that was created
			const policy = change.meta?.policy as PolicyIR;
			if (!policy) return { sql: undefined, destructive: true };
			return {
				sql: `DROP POLICY IF EXISTS ${quoteIdent(policy.name, 'alias')} ON ${qualifyTable(change.table, schemaName)};`,
				destructive: true,
			};
		}

		case 'drop_policy': {
			// DOWN: recreate the policy that was dropped
			const policy = change.meta?.policy as PolicyIR;
			if (!policy) return { sql: undefined, destructive: true };
			return {
				sql: buildPolicySQL(change.table, policy, schemaName),
				// Allowlisted: re-creates the dropped RLS policy from metadata.
				destructive: false,
			};
		}

		default:
			return failSafeUnknownDownChange(change.kind);
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
	return generateDownMigrationSQL(diff, options).statements;
}

/**
 * Generate ordered DOWN SQL statements with structural rollback destructiveness.
 *
 * The destructive flag is emitted by changeToDownSQL alongside each DOWN
 * statement, not by regex-scanning SQL text or by a second SchemaChange switch.
 */
export function generateDownMigrationSQL(
	diff: SchemaDiff,
	options?: MigrationSQLOptions,
): DownMigrationSQL {
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
		[], // 9: add PK / column UNIQUE constraint
		[], // 10: add FK
		[], // 11: alter FK (drop + re-add)
		[], // 12: create index
		[], // 13: add CHECK constraint
		[], // 14: alter ENUM add value
		[], // 15: comments
		[], // 16: VALIDATE CONSTRAINT
		[], // 17: ENABLE/DISABLE ROW LEVEL SECURITY
		[], // 18: CREATE/DROP POLICY
	];

	for (const change of changes) {
		const phase = getPhase(change.kind);
		phases[phase]!.push(change);
	}

	// Generate SQL in REVERSE phase order (index → FK → PK → alter → column → table)
	const statements: string[] = [];
	let destructive = false;
	for (let i = phases.length - 1; i >= 0; i--) {
		for (const change of phases[i]!) {
			const down = changeToDownSQL(change, schemaName);
			destructive = down.destructive || destructive;
			if (down.sql) statements.push(down.sql);
		}
	}

	return { statements, destructive };
}

function generateCreateTableSQL(table: TableIR, schemaName?: string): string {
	const qualTable = qualifyTable(table.name, schemaName);

	const elements: string[] = [];

	// Columns
	for (const col of table.columns) {
		const parts: string[] = [quoteIdent(col.name, 'alias'), mapColumnType(col)];
		if (!col.nullable && !col.autoIncrement) parts.push('NOT NULL');
		if (col.default !== undefined)
			parts.push(`DEFAULT ${formatDefault(col.default)}`);
		if (col.unique) parts.push('UNIQUE');
		// S-2: validate collation name before quoting — uses quoteCollation which
		// accepts locale strings like `en_US.utf8`, `en-US-x-icu`, `C.UTF-8`
		// that contain dots/hyphens rejected by the standard identifier validator.
		if (col.collation) parts.push(`COLLATE ${quoteCollation(col.collation)}`);
		if (col.identity) {
			const gen = col.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
			parts.push(`GENERATED ${gen} AS IDENTITY`);
		}
		elements.push(parts.join(' '));
	}

	// Primary key
	if (table.primaryKey !== undefined) {
		const pkCols = (
			Array.isArray(table.primaryKey) ? table.primaryKey : [table.primaryKey]
		)
			.map((n) => quoteIdent(n, 'alias'))
			.join(', ');
		elements.push(
			`CONSTRAINT ${quoteIdent(pkName(table.name), 'alias')} PRIMARY KEY (${pkCols})`,
		);
	}

	const body = elements.map((el) => `  ${el}`).join(',\n');
	let sql = `CREATE TABLE ${qualTable} (\n${body}\n)`;
	if (table.partition) {
		const strategy = assertPartitionStrategy(table.partition.strategy);
		const partCols = table.partition.columns
			.map((n) => quoteIdent(n, 'alias'))
			.join(', ');
		sql += ` PARTITION BY ${strategy} (${partCols})`;
	}
	sql += ';';
	return sql;
}

function generateAddFKSQL(
	tableName: string,
	fk: ForeignKeyIR,
	schemaName?: string,
): string {
	const qualTable = qualifyTable(tableName, schemaName);
	const constraintName = quoteIdent(fkName(tableName, fk.columns), 'alias');
	const fkCols = fk.columns.map((n) => quoteIdent(n, 'alias')).join(', ');
	// Referenced table must also be schema-qualified to resolve within the same schema
	const refTable = qualifyTable(fk.references.table, schemaName);
	const refCols = fk.references.columns
		.map((n) => quoteIdent(n, 'alias'))
		.join(', ');
	const onDelete = fk.onDelete
		? ` ON DELETE ${mapOnDeleteAction(fk.onDelete)}`
		: '';
	const onUpdate = fk.onUpdate
		? ` ON UPDATE ${mapOnDeleteAction(fk.onUpdate)}`
		: '';
	const deferred = fk.deferred ? ' DEFERRABLE INITIALLY DEFERRED' : '';
	const notValid = fk.notValid ? ' NOT VALID' : '';
	return `ALTER TABLE ${qualTable} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${fkCols}) REFERENCES ${refTable} (${refCols})${onDelete}${onUpdate}${deferred}${notValid};`;
}

// M-6: formatDefault is now a thin alias for the shared formatSqlDefault from phases/utils.
// The duplicate implementations in migration-sql.ts, table-operations.ts, and ddl-generator.ts
// have been consolidated. See formatSqlDefault in packages/adapter-pgsql/src/ddl/phases/utils.ts.
function formatDefault(value: unknown): string {
	return formatSqlDefault(value, 'migration-sql default');
}
