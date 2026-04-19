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
import { validateSqlExpression } from '../validate.js';
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

/** Build a CREATE POLICY SQL statement from a PolicyIR. */
function buildPolicySQL(
	tableName: string,
	policy: PolicyIR,
	schemaName?: string,
): string {
	const policyName = q(policy.name);
	const qt = qualifyTable(tableName, schemaName);
	const forClause =
		policy.command && policy.command !== 'ALL'
			? ` FOR ${policy.command}`
			: ' FOR ALL';
	const asClause =
		policy.permissive === false ? ' AS RESTRICTIVE' : ' AS PERMISSIVE';
	const toClause =
		policy.roles && policy.roles.length > 0
			? ` TO ${policy.roles.map((r) => q(r)).join(', ')}`
			: '';
	if (policy.using) validateSqlExpression(policy.using, 'USING expression');
	if (policy.withCheck)
		validateSqlExpression(policy.withCheck, 'WITH CHECK expression');
	const usingClause = policy.using ? ` USING (${policy.using})` : '';
	const withCheckClause = policy.withCheck
		? ` WITH CHECK (${policy.withCheck})`
		: '';
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
 * 9.  ADD primary keys
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
		[], // 9: add PK
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
						const indexName = q(idxName(table.name, [fkCol]));
						statements.push(
							`CREATE INDEX IF NOT EXISTS ${indexName} ON ${qualifyTable(table.name, schemaName)} (${q(fkCol)});`,
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
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD COLUMN ${q(col.name)} ${typeName}${notNull}${def}${unique};`;
}

function upAlterColumnType(change: SchemaChange, schemaName?: string): string {
	const col = change.meta?.column as ColumnIR | undefined;
	const toType = col ? mapColumnType(col) : String(change.meta?.toType);
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} TYPE ${toType};`;
}

function upAlterColumnNullable(
	change: SchemaChange,
	schemaName?: string,
): string {
	const nullable = change.meta?.nullable as boolean;
	const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL';
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} ${action};`;
}

function upAlterColumnDefault(
	change: SchemaChange,
	schemaName?: string,
): string {
	const def = change.meta?.default;
	if (def === undefined || def === null) {
		return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} DROP DEFAULT;`;
	}
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} SET DEFAULT ${formatDefault(def)};`;
}

function upAddPrimaryKey(change: SchemaChange, schemaName?: string): string {
	const columns = change.meta?.columns as string[];
	const pkCols = columns.map(q).join(', ');
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ADD CONSTRAINT ${q(pkName(change.table))} PRIMARY KEY (${pkCols});`;
}

function upDropForeignKey(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const fk = change.meta?.fk as ForeignKeyIR;
	if (!fk) return undefined;
	const constraintName = q(fkName(change.table, fk.columns));
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${constraintName};`;
}

function upAlterForeignKey(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	// Drop + re-add with new onDelete
	const fk = change.meta?.fk as ForeignKeyIR;
	if (!fk) return undefined;
	const constraintName = q(fkName(change.table, fk.columns));
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
	const indexName = q(idxName(change.table, idx.columns, idx.name));
	const unique = idx.unique ? 'UNIQUE ' : '';
	const method = idx.method ? ` USING ${idx.method}` : '';

	// Build column list: expressions first (unquoted), then named columns with optional opclass
	const colParts: string[] = [
		...(idx.expressions ?? []),
		...idx.columns.map((col) => {
			const opclass = idx.opclass?.[col] ?? '';
			return `${q(col)}${opclass ? ` ${opclass}` : ''}`;
		}),
	];
	const cols = colParts.join(', ');

	const include =
		idx.include && idx.include.length > 0
			? ` INCLUDE (${idx.include.map(q).join(', ')})`
			: '';
	const withParams =
		idx.with && Object.keys(idx.with).length > 0
			? ` WITH (${Object.entries(idx.with)
					.map(([k, v]) => `${k} = ${v}`)
					.join(', ')})`
			: '';
	const where = idx.where ? ` WHERE ${idx.where}` : '';

	return `CREATE ${unique}INDEX IF NOT EXISTS ${indexName} ON ${qualifyTable(change.table, schemaName)}${method} (${cols})${include}${withParams}${where};`;
}

function upDropIndex(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const idx = change.meta?.index as IndexIR;
	if (!idx) return undefined;
	const indexName = q(idxName(change.table, idx.columns, idx.name));
	const schemaPrefix = schemaName ? `${q(schemaName)}.` : '';
	return `DROP INDEX IF EXISTS ${schemaPrefix}${indexName};`;
}

function upAddCheckConstraint(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const check = change.meta?.check as CheckConstraintIR;
	if (!check) return undefined;
	const notValid = check.notValid ? ' NOT VALID' : '';
	return (
		'DO $$ BEGIN ALTER TABLE ' +
		qualifyTable(change.table, schemaName) +
		' ADD CONSTRAINT ' +
		q(check.name) +
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
		? q(fkName(change.table, fk.columns))
		: check
			? q(check.name)
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
		? `${q(schemaName)}.${q(enumDef.name)}`
		: q(enumDef.name);
	const values = enumDef.values
		.map((v) => `'${v.replace(/'/g, "''")}'`)
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
	const enumName = schemaName
		? `${q(schemaName)}.${q(enumDef.name)}`
		: q(enumDef.name);
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
		? `${q(schemaName)}.${q(enumDef.name)}`
		: q(enumDef.name);
	// Before dropping the type, cast any referencing columns to text
	// to prevent "cannot drop type: still referenced" errors.
	const refs = change.meta?.referencingColumns as
		| Array<{ table: string; column: string }>
		| undefined;
	const alterStatements =
		refs && refs.length > 0
			? refs.map(
					(ref) =>
						`ALTER TABLE ${qualifyTable(ref.table, schemaName)} ALTER COLUMN ${q(ref.column)} TYPE text;`,
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
	const collation = col.collation ? ` COLLATE "${col.collation}"` : '';
	const typeName = mapColumnType(col);
	return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ALTER COLUMN ${q(change.column!)} TYPE ${typeName}${collation};`;
}

function upAlterColumnIdentity(
	change: SchemaChange,
	schemaName?: string,
): string | undefined {
	const col = change.meta?.column as ColumnIR;
	const prevIdentity = change.meta?.previousIdentity as string | undefined;
	if (!col) return undefined;
	const table = qualifyTable(change.table, schemaName);
	const column = q(change.column!);
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
	return `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${q(change.column!)} IS '${escaped}';`;
}

function upSequenceName(
	schemaName: string | undefined,
	seq: SequenceIR,
): string {
	return schemaName ? `${q(schemaName)}.${q(seq.name)}` : q(seq.name);
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
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP COLUMN ${q(change.column!)} CASCADE;`;
		case 'alter_column_type':
			return upAlterColumnType(change, schemaName);
		case 'alter_column_nullable':
			return upAlterColumnNullable(change, schemaName);
		case 'alter_column_default':
			return upAlterColumnDefault(change, schemaName);
		case 'add_primary_key':
			return upAddPrimaryKey(change, schemaName);
		case 'drop_primary_key':
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(pkName(change.table))} CASCADE;`;
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
				? `ALTER TABLE ${qualifyTable(change.table, schemaName)} DROP CONSTRAINT IF EXISTS ${q(check.name)};`
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
			return `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${q(change.column!)} IS NULL;`;
		}
		case 'create_extension': {
			const ext = change.meta?.extension as string;
			return ext ? `CREATE EXTENSION IF NOT EXISTS "${ext}";` : undefined;
		}
		case 'drop_extension': {
			const ext = change.meta?.extension as string;
			return ext ? `DROP EXTENSION IF EXISTS "${ext}" CASCADE;` : undefined;
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
				? `DROP POLICY IF EXISTS ${q(policy.name)} ON ${qualifyTable(change.table, schemaName)};`
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
				'DO $$ BEGIN ALTER TABLE ' +
				qualifyTable(change.table, schemaName) +
				' ADD CONSTRAINT ' +
				q(check.name) +
				' ' +
				check.expression +
				'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;'
			);
		}

		case 'create_enum': {
			// DOWN: drop the type that was created
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return undefined;
			const enumName = schemaName
				? `${q(schemaName)}.${q(enumDef.name)}`
				: q(enumDef.name);
			return `DROP TYPE IF EXISTS ${enumName} CASCADE;`;
		}

		case 'drop_enum': {
			// DOWN: recreate the type that was dropped
			const enumDef = change.meta?.enum as EnumIR | undefined;
			if (!enumDef) return undefined;
			const enumName = schemaName
				? `${q(schemaName)}.${q(enumDef.name)}`
				: q(enumDef.name);
			const values = enumDef.values
				.map((v) => `'${v.replace(/'/g, "''")}'`)
				.join(', ');
			return `CREATE TYPE ${enumName} AS ENUM (${values});`;
		}

		case 'alter_enum_add_value':
			// DOWN: ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL
			return `-- ALTER TYPE ADD VALUE cannot be reversed in PostgreSQL`;

		case 'alter_column_collation': {
			// DOWN: restore previous collation — stored in db state, not in meta; emit warning
			return `-- WARNING: Cannot reverse alter_column_collation "${change.table}"."${change.column}" -- previous collation unknown`;
		}

		case 'alter_column_identity': {
			const col = change.meta?.column as ColumnIR | undefined;
			const prevIdentity = change.meta?.previousIdentity as string | undefined;
			if (!col) return undefined;
			const table = qualifyTable(change.table, schemaName);
			const column = q(change.column!);
			// Reverse: restore previous identity state
			if (prevIdentity && !col.identity) {
				// Was identity, now not → re-add identity
				const gen = prevIdentity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
				return `ALTER TABLE ${table} ALTER COLUMN ${column} ADD GENERATED ${gen} AS IDENTITY;`;
			}
			if (!prevIdentity && col.identity) {
				// Was not identity, now is → drop identity
				return `ALTER TABLE ${table} ALTER COLUMN ${column} DROP IDENTITY IF EXISTS;`;
			}
			// Change between types → restore previous
			const gen = prevIdentity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
			return `ALTER TABLE ${table} ALTER COLUMN ${column} SET GENERATED ${gen};`;
		}

		case 'add_comment': {
			// DOWN: remove the comment that was added
			const target = change.meta?.target as string;
			if (target === 'table') {
				return `COMMENT ON TABLE ${qualifyTable(change.table, schemaName)} IS NULL;`;
			}
			return `COMMENT ON COLUMN ${qualifyTable(change.table, schemaName)}.${q(change.column!)} IS NULL;`;
		}

		case 'drop_comment': {
			// DOWN: cannot restore comment — value was lost
			return `-- WARNING: Cannot reverse drop_comment "${change.table}"${change.column ? `."${change.column}"` : ''} -- comment text was lost`;
		}

		case 'create_extension': {
			// DOWN: drop the extension that was created
			const ext = change.meta?.extension as string;
			if (!ext) return undefined;
			return `DROP EXTENSION IF EXISTS "${ext}" CASCADE;`;
		}

		case 'drop_extension': {
			// DOWN: recreate the extension that was dropped
			const ext = change.meta?.extension as string;
			if (!ext) return undefined;
			return `CREATE EXTENSION IF NOT EXISTS "${ext}";`;
		}

		case 'create_sequence': {
			// DOWN: drop the sequence that was created
			const seq = change.meta?.sequence as SequenceIR;
			if (!seq) return undefined;
			const seqName = schemaName
				? `${q(schemaName)}.${q(seq.name)}`
				: q(seq.name);
			return `DROP SEQUENCE IF EXISTS ${seqName} CASCADE;`;
		}

		case 'alter_sequence': {
			// DOWN: restore previous sequence state
			const prevSeq = change.meta?.previousSequence as SequenceIR | undefined;
			if (!prevSeq) {
				return `-- WARNING: Cannot reverse alter_sequence "${change.table}" -- missing migration metadata`;
			}
			const seqName = schemaName
				? `${q(schemaName)}.${q(prevSeq.name)}`
				: q(prevSeq.name);
			return buildSequenceClause('ALTER SEQUENCE', seqName, prevSeq, true);
		}

		case 'drop_sequence': {
			// DOWN: recreate the sequence that was dropped
			const seq = change.meta?.sequence as SequenceIR;
			if (!seq) return undefined;
			const seqName = schemaName
				? `${q(schemaName)}.${q(seq.name)}`
				: q(seq.name);
			return buildSequenceClause('CREATE SEQUENCE', seqName, seq);
		}

		case 'validate_constraint':
			// DOWN: VALIDATE CONSTRAINT cannot be reversed in PostgreSQL
			return `-- VALIDATE CONSTRAINT cannot be reversed in PostgreSQL (table: "${change.table}")`;

		case 'enable_rls':
			// DOWN: reverse enable → disable
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} DISABLE ROW LEVEL SECURITY;`;

		case 'disable_rls':
			// DOWN: reverse disable → enable
			return `ALTER TABLE ${qualifyTable(change.table, schemaName)} ENABLE ROW LEVEL SECURITY;`;

		case 'create_policy': {
			// DOWN: drop the policy that was created
			const policy = change.meta?.policy as PolicyIR;
			if (!policy) return undefined;
			return `DROP POLICY IF EXISTS ${q(policy.name)} ON ${qualifyTable(change.table, schemaName)};`;
		}

		case 'drop_policy': {
			// DOWN: recreate the policy that was dropped
			const policy = change.meta?.policy as PolicyIR;
			if (!policy) return undefined;
			return buildPolicySQL(change.table, policy, schemaName);
		}
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
		if (col.collation) parts.push(`COLLATE "${col.collation}"`);
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
			.map(q)
			.join(', ');
		elements.push(
			`CONSTRAINT ${q(pkName(table.name))} PRIMARY KEY (${pkCols})`,
		);
	}

	const body = elements.map((el) => `  ${el}`).join(',\n');
	let sql = `CREATE TABLE ${qualTable} (\n${body}\n)`;
	if (table.partition) {
		const partCols = table.partition.columns.map(q).join(', ');
		sql += ` PARTITION BY ${table.partition.strategy} (${partCols})`;
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
	const constraintName = q(fkName(tableName, fk.columns));
	const fkCols = fk.columns.map(q).join(', ');
	// Referenced table must also be schema-qualified to resolve within the same schema
	const refTable = qualifyTable(fk.references.table, schemaName);
	const refCols = fk.references.columns.map(q).join(', ');
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

function formatDefault(value: unknown): string {
	if (typeof value === 'object' && value !== null && 'sql' in value) {
		const rawSql = (value as Record<string, unknown>).sql as string;
		validateSqlExpression(rawSql, 'migration-sql formatDefault({ sql })');
		return rawSql;
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
