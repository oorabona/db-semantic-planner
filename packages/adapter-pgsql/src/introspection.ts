/**
 * PostgreSQL Schema Introspection (ADAPTER-006)
 *
 * Queries information_schema/pg_catalog to build ModelIR
 * from an existing database. Supports:
 * - Table/column/PK discovery
 * - FK → bidirectional relation inference
 * - Hierarchy detection (adjacency + edge-table)
 * - Include/exclude filtering
 *
 * @module introspection
 */

import { ModelIRImpl } from '@dbsp/core';
import type {
	CheckConstraintIR,
	ColumnIR,
	ColumnType,
	EnumIR,
	ForeignKeyIR,
	HierarchyIR,
	IndexIR,
	LogicalIdentity,
	ModelIR,
	OnDeleteAction,
	PartitionIR,
	PolicyIR,
	RelationIR,
	RelationType,
	SequenceIR,
	TableIR,
} from '@dbsp/types';
import { buildRelationKeyFields } from '@dbsp/types';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { DEFAULT_PK_COLUMN } from './assert-field.js';
import { stripNotValidSuffix } from './check-expression.js';
import { quoteTypeIdentifier, stripDbTypeSchema } from './db-type.js';
import { DBSP_LOGICAL_IDENTITY_TABLE } from './transition/constants.js';

// ============================================================================
// Types
// ============================================================================

/** The minimum every schema-level operation needs: which schema. */
export interface SchemaScopeOptions {
	/** Schema name to operate on (default: 'public') */
	readonly schema?: string;
}

/**
 * Introspection additionally chooses WHICH TABLES to read. It is a read-only
 * path, so narrowing it is safe — that is why the table filters live here and
 * nowhere else.
 */
export interface IntrospectionOptions extends SchemaScopeOptions {
	/** Tables to exclude (glob patterns: * matches any chars) */
	readonly exclude?: readonly string[];
	/** Tables to include (default: all). Applied before exclude. */
	readonly include?: readonly string[];
}

/** Hierarchy pattern detected during introspection */
/**
 * Hierarchy pattern detected during introspection.
 * Alias of {@link HierarchyIR} from \@dbsp/types — kept here for
 * public-API backwards compatibility (re-exported from \@dbsp/adapter-pgsql).
 */
export type DetectedHierarchy = HierarchyIR;

/** Extended ModelIR with hierarchy metadata */
export interface IntrospectedModelIR extends ModelIR {
	readonly hierarchies: readonly DetectedHierarchy[];
	readonly introspectedAt: Date;
	readonly warnings: readonly string[];
}

// ============================================================================
// Raw query result types
// ============================================================================

interface RawColumn {
	table_name: string;
	column_name: string;
	data_type: string;
	udt_name: string;
	is_nullable: string;
	column_default: string | null;
	collation_name: string | null;
	is_identity: string;
	identity_generation: string | null;
}

interface RawFormattedColumnType {
	table_name: string;
	column_name: string;
	db_type: string;
	/** nspname of the column type's own namespace (pg_type.typnamespace). */
	type_schema: string;
}

interface RawLogicalIdentity {
	logical_id: string;
	schema_name: string;
	table_name: string;
	column_name: string | null;
	carrier_kind: string;
}

interface FormattedColumnType {
	dbType: string;
	typeSchema: string;
}

interface RawPrimaryKey {
	table_name: string;
	column_name: string;
}

interface RawForeignKey {
	constraint_name: string;
	source_table: string;
	source_column: string;
	target_schema: string;
	target_table: string;
	target_column: string;
	delete_rule: string;
	update_rule: string;
	is_deferrable: string;
	initially_deferred: string;
}

interface RawIndex {
	index_name: string;
	table_name: string;
	columns: string[];
	include_columns: string[] | null;
	expressions_text: string | null;
	opclass_names: string[] | null;
	opclass_cols: string[] | null;
	is_unique: boolean;
	is_valid?: boolean;
	is_ready?: boolean;
	nulls_not_distinct?: boolean | null;
	method: string;
	predicate: string | null;
	reloptions: string[] | null;
}

interface RawUniqueColumn {
	table_name: string;
	column_name: string;
	constraint_name: string;
}

interface RawPartition {
	table_name: string;
	strategy: string;
	columns: string[];
}

/**
 * The adapter's own executor for catalog reads, already carrying whatever
 * savepoint protection the connection's ownership calls for.
 *
 * The brand is load-bearing. Structurally, a `pg.PoolClient` has a `query()` and
 * would satisfy this interface — so without it, a checked-out client could be
 * passed straight into the catalog reads, unprotected, and nothing but a comment
 * would say otherwise. Only the adapter sets the brand.
 */
export interface CatalogQueryExecutor {
	readonly dbspProtectedCatalogExecutor: true;
	query<T extends QueryResultRow = QueryResultRow>(
		sql: string,
		parameters?: readonly unknown[],
	): Promise<QueryResult<T>>;
	readonly sequentialCatalogReads?: boolean;
}

/**
 * A `pg.PoolClient` is a `pg.Pool` plus `release()` — that is the whole of the
 * difference, and it is the one that matters: a client is checked out, so it may
 * be sitting inside somebody's transaction.
 *
 * This is used ONLY to refuse, never to decide how a connection is treated. The
 * declaration decides that. Reading the shape to guess what the caller meant is
 * the defect this adapter was rewritten to remove.
 */
function isCheckedOutClient(connection: unknown): boolean {
	return (
		typeof connection === 'object' &&
		connection !== null &&
		'release' in connection &&
		typeof (connection as { release?: unknown }).release === 'function'
	);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse the comma-separated expression list returned by pg_get_expr(indexprs, ...).
 *
 * PostgreSQL serialises multiple expression index entries as a comma-separated
 * string, e.g. `"lower(email), (score * 2)"`.  A naive split on "," would break
 * on expressions that contain commas inside parentheses (e.g. function calls with
 * multiple arguments), so we track parenthesis depth.
 */
function parseExpressionsList(raw: string): readonly string[] {
	const results: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			const expr = raw.slice(start, i).trim();
			if (expr) results.push(expr);
			start = i + 1;
		}
	}
	const last = raw.slice(start).trim();
	if (last) results.push(last);
	return results;
}

// ============================================================================
// Block 1: Core Introspection (tables, columns, PKs)
// ============================================================================

/**
 * Introspect a PostgreSQL database and return a ModelIR.
 *
 * @param pool - pg.Pool connection
 * @param options - Introspection options (schema, include/exclude)
 * @returns IntrospectedModelIR with tables, relations, and hierarchy metadata
 *
 * @example
 * ```typescript
 * const model = await introspect(pool);
 * const orm = createOrm({ model, adapter: createPgsqlAdapter(pool) });
 * ```
 */

// ============================================================================
// Catalog query helpers
// ============================================================================

/** All raw results returned by a single parallel catalog fetch */
interface CatalogResults {
	columns: RawColumn[];
	pks: RawPrimaryKey[];
	fks: RawForeignKey[];
	indexes: RawIndex[];
	uniqueColumns: RawUniqueColumn[];
	enums: Array<{ name: string; schema: string; values: string[] }>;
	comments: Array<{
		table_name: string;
		column_name: string | null;
		comment: string;
	}>;
	checks: Array<{
		name: string;
		expression: string;
		not_valid: boolean;
		raw_table: string;
	}>;
	partitions: RawPartition[];
	extensions: Array<{ name: string }>;
	sequences: Array<{
		name: string;
		start_value: string;
		increment_by: string;
		min_value: string;
		max_value: string;
		cycle: boolean;
	}>;
	rls: Array<{ table_name: string; rls_enabled: boolean }>;
	policies: Array<{
		table_name: string;
		policy_name: string;
		cmd: string;
		roles: string[];
		permissive: boolean;
		using_expr: string | null;
		with_check_expr: string | null;
	}>;
	formattedColumnTypes: RawFormattedColumnType[];
}

/**
 * Run all 14 catalog queries in parallel.
 * Order matches the coverage test mock sequence: columns, pks, fks, indexes,
 * unique columns, enums, comments, checks, partitions, extensions (no schema
 * param), sequences, rls state, policies, formatted column types.
 */
async function queryAllCatalogs(
	pool: CatalogQueryExecutor,
	schema: string,
): Promise<CatalogResults> {
	const catalogQueries = [
		() =>
			// 1. Columns (including identity and collation)
			pool.query<RawColumn>(
				`SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
			        collation_name, is_identity, identity_generation
			 FROM information_schema.columns
			 WHERE table_schema = $1
			 ORDER BY table_name, ordinal_position`,
				[schema],
			),
		() =>
			// 2. Primary keys
			pool.query<RawPrimaryKey>(
				`SELECT tc.table_name, kcu.column_name
			 FROM information_schema.table_constraints tc
			 JOIN information_schema.key_column_usage kcu
			   ON tc.constraint_name = kcu.constraint_name
			   AND tc.table_schema = kcu.table_schema
			 WHERE tc.constraint_type = 'PRIMARY KEY'
			   AND tc.table_schema = $1
			 ORDER BY tc.table_name, kcu.ordinal_position`,
				[schema],
			),
		() =>
			// 3. Foreign keys
			pool.query<RawForeignKey>(
				`SELECT
			   c.conname AS constraint_name,
			   source_rel.relname AS source_table,
			   source_attr.attname AS source_column,
			   target_ns.nspname AS target_schema,
			   target_rel.relname AS target_table,
			   target_attr.attname AS target_column,
			   CASE c.confdeltype
			     WHEN 'c' THEN 'CASCADE'
			     WHEN 'n' THEN 'SET NULL'
			     WHEN 'd' THEN 'SET DEFAULT'
			     WHEN 'r' THEN 'RESTRICT'
			     ELSE 'NO ACTION'
			   END AS delete_rule,
			   CASE c.confupdtype
			     WHEN 'c' THEN 'CASCADE'
			     WHEN 'n' THEN 'SET NULL'
			     WHEN 'd' THEN 'SET DEFAULT'
			     WHEN 'r' THEN 'RESTRICT'
			     ELSE 'NO ACTION'
			   END AS update_rule,
			   CASE WHEN c.condeferrable THEN 'YES' ELSE 'NO' END AS is_deferrable,
			   CASE WHEN c.condeferred THEN 'YES' ELSE 'NO' END AS initially_deferred
			 FROM pg_constraint c
			 JOIN pg_class source_rel ON source_rel.oid = c.conrelid
			 JOIN pg_namespace source_ns ON source_ns.oid = source_rel.relnamespace
			 JOIN pg_class target_rel ON target_rel.oid = c.confrelid
			 JOIN pg_namespace target_ns ON target_ns.oid = target_rel.relnamespace
			 JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS cols(source_attnum, target_attnum, ord) ON true
			 JOIN pg_attribute source_attr
			   ON source_attr.attrelid = c.conrelid
			   AND source_attr.attnum = cols.source_attnum
			 JOIN pg_attribute target_attr
			   ON target_attr.attrelid = c.confrelid
			   AND target_attr.attnum = cols.target_attnum
			 WHERE c.contype = 'f'
			   AND c.conparentid = 0
			   AND source_ns.nspname = $1
			 ORDER BY c.conname, cols.ord`,
				[schema],
			),
		() =>
			// 4. Indexes (excluding PK-backing indexes and unique-constraint-backing indexes).
			// Unique constraints created via col.unique / UNIQUE keyword in DDL produce an implicit
			// backing index that is NOT a user-defined index — it is tracked via col.unique on the
			// ColumnIR instead. Including it here would cause spurious drop_index diffs on roundtrip.
			// Enhanced to capture:
			//   - INCLUDE columns (PG11+): indkey positions > indnkeyatts
			//   - Expression index entries: attnum = 0 in indkey → pg_get_expr(indexprs)
			//   - Per-column operator classes: pg_opclass join on indclass, non-default only
			pool.query<RawIndex>(
				`SELECT
			   i.relname AS index_name,
			   t.relname AS table_name,
			   -- Key columns (attnum != 0 means real column, within key positions)
			   array_agg(a.attname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0) AS columns,
			   -- INCLUDE columns (positions after indnkeyatts)
			   array_agg(a_inc.attname ORDER BY k.n)
			     FILTER (WHERE k.n > ix.indnkeyatts) AS include_columns,
			   -- Full expression string for expression indexes (NULL if none)
			   pg_get_expr(ix.indexprs, ix.indrelid, false) AS expressions_text,
			   -- Non-default opclass names (parallel arrays with opclass_cols)
			   array_agg(oc.opcname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
			             AND NOT oc.opcdefault) AS opclass_names,
			   array_agg(a.attname ORDER BY k.n)
			     FILTER (WHERE k.n <= ix.indnkeyatts AND k.attnum != 0
			             AND NOT oc.opcdefault) AS opclass_cols,
			   ix.indisunique AS is_unique,
			   ix.indisvalid AS is_valid,
			   ix.indisready AS is_ready,
			   bool_or(COALESCE((to_jsonb(ix) ->> 'indnullsnotdistinct')::boolean, false)) AS nulls_not_distinct,
			   am.amname AS method,
			   pg_get_expr(ix.indpred, ix.indrelid, false) AS predicate,
			   i.reloptions AS reloptions
			 FROM pg_index ix
			 JOIN pg_class i ON i.oid = ix.indexrelid
			 JOIN pg_class t ON t.oid = ix.indrelid
			 JOIN pg_namespace n ON n.oid = t.relnamespace
			 JOIN pg_am am ON am.oid = i.relam
			 -- Unnest all indkey entries (key + INCLUDE positions)
			 CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, n)
			 -- Real column (key positions, attnum != 0)
			 LEFT JOIN pg_attribute a
			   ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum != 0
			 -- INCLUDE column (positions past indnkeyatts)
			 LEFT JOIN pg_attribute a_inc
			   ON a_inc.attrelid = t.oid AND a_inc.attnum = k.attnum AND k.n > ix.indnkeyatts
			 -- Operator class for key columns (indclass is oidvector, cast to oid[])
			 LEFT JOIN pg_opclass oc
			   ON oc.oid = (ix.indclass::oid[])[k.n - 1]
			   AND k.n <= ix.indnkeyatts AND k.attnum != 0
			 WHERE n.nspname = $1
			   AND NOT ix.indisprimary
			   AND NOT EXISTS (
			     SELECT 1 FROM pg_constraint c
			     WHERE c.conindid = i.oid
			       AND c.contype = 'u'
			   )
			 GROUP BY i.relname, t.relname, ix.indisunique, ix.indisvalid,
			          ix.indisready, am.amname,
			          ix.indpred, ix.indrelid, ix.indexprs, i.reloptions
			 ORDER BY t.relname, i.relname`,
				[schema],
			),
		() =>
			// 5. Single-column UNIQUE constraints tracked as ColumnIR.unique
			pool.query<RawUniqueColumn>(
				`SELECT rel.relname AS table_name, att.attname AS column_name, c.conname AS constraint_name
				 FROM pg_constraint c
				 JOIN pg_class rel ON rel.oid = c.conrelid
				 JOIN pg_namespace ns ON ns.oid = rel.relnamespace
				 JOIN pg_attribute att ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
				 WHERE c.contype = 'u'
				   AND array_length(c.conkey, 1) = 1
				   AND ns.nspname = $1`,
				[schema],
			),
		() =>
			// 6. ENUM types
			pool.query<{ name: string; schema: string; values: string[] }>(
				`SELECT
			   t.typname AS name,
			   n.nspname AS schema,
			   array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
			 FROM pg_type t
			 JOIN pg_enum e ON e.enumtypid = t.oid
			 JOIN pg_namespace n ON n.oid = t.typnamespace
			 WHERE t.typtype = 'e'
			   AND n.nspname = $1
			 GROUP BY t.typname, n.nspname`,
				[schema],
			),
		() =>
			// 7. Comments (table and column level) from pg_description
			pool.query<{
				table_name: string;
				column_name: string | null;
				comment: string;
			}>(
				`SELECT
			   c.relname AS table_name,
			   a.attname AS column_name,
			   d.description AS comment
			 FROM pg_description d
			 JOIN pg_class c ON c.oid = d.objoid
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 LEFT JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
			 WHERE n.nspname = $1
			   AND d.objsubid >= 0`,
				[schema],
			),
		() =>
			// 8. CHECK constraints
			pool.query<{
				name: string;
				expression: string;
				not_valid: boolean;
				raw_table: string;
			}>(
				`SELECT
			   c.conname AS name,
			   pg_get_constraintdef(c.oid, false) AS expression,
			   NOT c.convalidated AS not_valid,
			   r.relname AS raw_table
			 FROM pg_constraint c
			 JOIN pg_class r ON r.oid = c.conrelid
			 JOIN pg_namespace n ON n.oid = r.relnamespace
			 WHERE c.contype = 'c'
			   AND n.nspname = $1`,
				[schema],
			),
		() =>
			// 9. Partition configurations
			pool.query<RawPartition>(
				`SELECT
			   c.relname AS table_name,
			   p.partstrat AS strategy,
			   array_agg(a.attname ORDER BY pk.n) AS columns
			 FROM pg_partitioned_table p
			 JOIN pg_class c ON c.oid = p.partrelid
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 JOIN LATERAL unnest(p.partattrs) WITH ORDINALITY AS pk(attnum, n) ON true
			 JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = pk.attnum
			 WHERE n.nspname = $1
			 GROUP BY c.relname, p.partstrat`,
				[schema],
			),
		() =>
			// 10. Installed extensions (no schema param — queries globally; skip plpgsql)
			pool.query<{ name: string }>(
				`SELECT extname AS name
			 FROM pg_extension
			 WHERE extname != 'plpgsql'`,
			),
		() =>
			// 11. Sequences not backed by SERIAL
			pool.query<{
				name: string;
				start_value: string;
				increment_by: string;
				min_value: string;
				max_value: string;
				cycle: boolean;
			}>(
				`SELECT s.sequencename AS name, s.start_value, s.increment_by, s.min_value, s.max_value, s.cycle
			 FROM pg_sequences s
			 LEFT JOIN pg_class c ON c.relname = s.sequencename AND c.relkind = 'S'
			   AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = s.schemaname)
			 LEFT JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
			 WHERE s.schemaname = $1
			   AND d.objid IS NULL`,
				[schema],
			),
		() =>
			// 12. RLS enabled state per table
			pool.query<{ table_name: string; rls_enabled: boolean }>(
				`SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
			 FROM pg_class c
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1
			   AND c.relkind = 'r'`,
				[schema],
			),
		() =>
			// 13. Row-Level Security policies
			pool.query<{
				table_name: string;
				policy_name: string;
				cmd: string;
				roles: string[];
				permissive: boolean;
				using_expr: string | null;
				with_check_expr: string | null;
			}>(
				`SELECT
			   c.relname AS table_name,
			   p.polname AS policy_name,
			   p.polcmd AS cmd,
			   ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)) AS roles,
			   p.polpermissive AS permissive,
			   pg_get_expr(p.polqual, p.polrelid) AS using_expr,
			   pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
			 FROM pg_policy p
			 JOIN pg_class c ON c.oid = p.polrelid
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 WHERE n.nspname = $1`,
				[schema],
			),
		() =>
			// 14. Faithful SQL-facing column types via format_type, for three cases:
			// (a) typmod-bearing columns (atttypmod <> -1) — varchar(120), numeric(10,2),
			//     timestamptz(3), bit(8), vector(768) — to preserve modifier fidelity (#261);
			// (b) array columns (typcategory 'A') — so integer[] is stored as `integer[]`
			//     rather than the internal `_int4` udt_name;
			// (c) non-pg_catalog scalar types — enums/composites/domains in user schemas.
			// `type_schema` is the type's OWN namespace (pg_type.typnamespace). The IR stores
			// it structurally and keeps `originalDbType` bare, so DDL/cast emission can decide
			// whether the type follows the target schema or remains absolute.
			pool.query<RawFormattedColumnType>(
				`SELECT c.relname AS table_name,
			        a.attname AS column_name,
			        format_type(a.atttypid, a.atttypmod) AS db_type,
			        tn.nspname AS type_schema
			 FROM pg_catalog.pg_attribute a
			 JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
			 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			 JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
			 JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
			 WHERE n.nspname = $1
			   AND c.relkind IN ('r','p','v','m','f')
			   AND a.attnum > 0
			   AND NOT a.attisdropped
			   AND (
			     a.atttypmod <> -1
			     OR t.typcategory = 'A'
			     OR t.typnamespace <> 'pg_catalog'::regnamespace
			   )`,
				[schema],
			),
	] as const;

	const results = pool.sequentialCatalogReads
		? []
		: await Promise.all(catalogQueries.map((query) => query()));
	if (pool.sequentialCatalogReads) {
		for (const query of catalogQueries) {
			results.push(await query());
		}
	}

	const [
		columnsResult,
		pksResult,
		fksResult,
		indexesResult,
		uniqueColumnsResult,
		enumsResult,
		commentsResult,
		checksResult,
		partitionsResult,
		extensionsResult,
		sequencesResult,
		rlsResult,
		policiesResult,
		formattedColumnTypesResult,
	] = results as [
		QueryResult<RawColumn>,
		QueryResult<RawPrimaryKey>,
		QueryResult<RawForeignKey>,
		QueryResult<RawIndex>,
		QueryResult<RawUniqueColumn>,
		QueryResult<{ name: string; schema: string; values: string[] }>,
		QueryResult<{
			table_name: string;
			column_name: string | null;
			comment: string;
		}>,
		QueryResult<{
			name: string;
			expression: string;
			not_valid: boolean;
			raw_table: string;
		}>,
		QueryResult<RawPartition>,
		QueryResult<{ name: string }>,
		QueryResult<{
			name: string;
			start_value: string;
			increment_by: string;
			min_value: string;
			max_value: string;
			cycle: boolean;
		}>,
		QueryResult<{ table_name: string; rls_enabled: boolean }>,
		QueryResult<{
			table_name: string;
			policy_name: string;
			cmd: string;
			roles: string[];
			permissive: boolean;
			using_expr: string | null;
			with_check_expr: string | null;
		}>,
		QueryResult<RawFormattedColumnType>,
	];

	return {
		columns: columnsResult.rows,
		pks: pksResult.rows,
		fks: fksResult.rows,
		indexes: indexesResult.rows,
		uniqueColumns: uniqueColumnsResult.rows,
		enums: enumsResult.rows,
		comments: commentsResult.rows,
		checks: checksResult.rows,
		partitions: partitionsResult.rows,
		extensions: extensionsResult.rows,
		sequences: sequencesResult.rows,
		rls: rlsResult.rows,
		policies: policiesResult.rows,
		formattedColumnTypes: formattedColumnTypesResult.rows,
	};
}

/** Build a Map<tableName, PartitionIR> from raw partition rows. */
function buildPartitionMap(rows: RawPartition[]): Map<string, PartitionIR> {
	const strategyMap: Record<string, 'RANGE' | 'LIST' | 'HASH'> = {
		r: 'RANGE',
		l: 'LIST',
		h: 'HASH',
	};
	const result = new Map<string, PartitionIR>();
	for (const row of rows) {
		const strategy = strategyMap[row.strategy];
		if (!strategy) continue; // Unknown strategy — skip
		const columns: string[] = Array.isArray(row.columns)
			? row.columns
			: String(row.columns)
					.replace(/^\{|}$/g, '')
					.split(',')
					.filter(Boolean);
		result.set(row.table_name, { strategy, columns });
	}
	return result;
}

/** Build a Map<tableName, CheckConstraintIR[]> from raw check rows. */
function buildCheckMap(
	rows: Array<{
		name: string;
		expression: string;
		not_valid: boolean;
		raw_table: string;
	}>,
): Map<string, CheckConstraintIR[]> {
	const result = new Map<string, CheckConstraintIR[]>();
	for (const ck of rows) {
		const tableName = ck.raw_table;
		// `pg_get_constraintdef` appends `NOT VALID` to the expression itself, so the
		// suffix has to come off the text and go onto the IR — otherwise it would be
		// compared as if it were part of the predicate, and re-emitted into the DDL.
		const checkIR: CheckConstraintIR = {
			name: ck.name,
			expression: stripNotValidSuffix(ck.expression),
			...(ck.not_valid ? { notValid: true } : {}),
		};
		const existing = result.get(tableName);
		if (existing) {
			existing.push(checkIR);
		} else {
			result.set(tableName, [checkIR]);
		}
	}
	return result;
}

/** Build a Map<tableName, IndexIR[]> from raw index rows. */
function buildIndexMap(rows: RawIndex[]): Map<string, IndexIR[]> {
	const result = new Map<string, IndexIR[]>();
	for (const idx of rows) {
		const columns: string[] = Array.isArray(idx.columns)
			? idx.columns
			: String(idx.columns)
					.replace(/^\{|}$/g, '')
					.split(',')
					.filter(Boolean);

		// Parse reloptions array (e.g. ['m=16', 'ef_construction=200']) into a Record
		let withParams: Record<string, string> | undefined;
		if (Array.isArray(idx.reloptions) && idx.reloptions.length > 0) {
			withParams = {};
			for (const opt of idx.reloptions) {
				const eqIdx = opt.indexOf('=');
				if (eqIdx !== -1) {
					withParams[opt.slice(0, eqIdx)] = opt.slice(eqIdx + 1);
				}
			}
		}

		const indexIR: IndexIR = {
			name: idx.index_name,
			columns,
			...(idx.is_unique ? { unique: true } : {}),
			...(idx.is_valid === false ? { valid: false } : {}),
			...(idx.is_ready === false ? { ready: false } : {}),
			...(idx.is_unique && idx.nulls_not_distinct
				? { nullsNotDistinct: true }
				: {}),
			// Only store method when it's not the default 'btree'
			...(idx.method && idx.method !== 'btree' ? { method: idx.method } : {}),
			...(idx.predicate ? { where: idx.predicate } : {}),
			...(withParams && Object.keys(withParams).length > 0
				? { with: withParams }
				: {}),
			// INCLUDE columns (PG11+)
			...(Array.isArray(idx.include_columns) && idx.include_columns.length > 0
				? { include: idx.include_columns as readonly string[] }
				: {}),
			// Expression index entries — parse comma-separated pg_get_expr output
			...(idx.expressions_text
				? { expressions: parseExpressionsList(idx.expressions_text) }
				: {}),
			// Per-column operator class overrides (non-default only)
			...(Array.isArray(idx.opclass_cols) &&
			idx.opclass_cols.length > 0 &&
			Array.isArray(idx.opclass_names) &&
			idx.opclass_names.length > 0
				? {
						opclass: Object.fromEntries(
							idx.opclass_cols.map((col, i) => [col, idx.opclass_names![i]!]),
						) as Record<string, string>,
					}
				: {}),
		};
		const existing = result.get(idx.table_name);
		if (existing) {
			existing.push(indexIR);
		} else {
			result.set(idx.table_name, [indexIR]);
		}
	}
	return result;
}

/** Build a Map<tableName, Map<columnName, constraintName>> from raw unique constraint rows. */
function buildUniqueColumnMap(
	rows: RawUniqueColumn[],
): Map<string, Map<string, string>> {
	const result = new Map<string, Map<string, string>>();
	for (const row of rows) {
		const existing = result.get(row.table_name);
		if (existing) {
			existing.set(row.column_name, row.constraint_name);
		} else {
			result.set(
				row.table_name,
				new Map([[row.column_name, row.constraint_name]]),
			);
		}
	}
	return result;
}

/** Build a Map<tableName, RawColumn[]> from raw column rows. */
function buildColumnMap(rows: RawColumn[]): Map<string, RawColumn[]> {
	const result = new Map<string, RawColumn[]>();
	for (const col of rows) {
		const existing = result.get(col.table_name);
		if (existing) {
			existing.push(col);
		} else {
			result.set(col.table_name, [col]);
		}
	}
	return result;
}

/** Build a Map<tableName, pkColumns[]> from raw PK rows. */
function buildPKMap(rows: RawPrimaryKey[]): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const pk of rows) {
		const existing = result.get(pk.table_name);
		if (existing) {
			existing.push(pk.column_name);
		} else {
			result.set(pk.table_name, [pk.column_name]);
		}
	}
	return result;
}

/** FK entry used internally for relation/hierarchy inference. */
interface FKEntry {
	source: string;
	target: string;
	targetSchema?: string;
	cols: string[];
	refs: string[];
	deleteRule: string;
	updateRule: string;
	deferred: boolean;
}

/** Build a Map<sourceTable + constraintName, FKEntry> from raw FK rows. */
function buildFKMap(rows: RawForeignKey[]): Map<string, FKEntry> {
	const result = new Map<string, FKEntry>();
	for (const fk of rows) {
		const key = JSON.stringify([fk.source_table, fk.constraint_name]);
		const existing = result.get(key);
		if (existing) {
			existing.cols.push(fk.source_column);
			existing.refs.push(fk.target_column);
		} else {
			result.set(key, {
				source: fk.source_table,
				target: fk.target_table,
				targetSchema: fk.target_schema,
				cols: [fk.source_column],
				refs: [fk.target_column],
				deleteRule: fk.delete_rule,
				updateRule: fk.update_rule,
				deferred: fk.is_deferrable === 'YES' && fk.initially_deferred === 'YES',
			});
		}
	}
	return result;
}

/** Build a Map<enumName, EnumIR> from raw enum rows. */
function buildEnumMap(
	rows: Array<{ name: string; schema?: string; values: string[] }>,
): Map<string, EnumIR> {
	const result = new Map<string, EnumIR>();
	for (const row of rows) {
		const values: string[] = Array.isArray(row.values)
			? row.values
			: String(row.values)
					.replace(/^\{|}$/g, '')
					.split(',')
					.filter(Boolean);
		result.set(row.name, {
			name: row.name,
			values,
			...(row.schema !== undefined ? { schema: row.schema } : {}),
		});
	}
	return result;
}

/** Build table-level and column-level comment maps from raw pg_description rows. */
function buildCommentMaps(
	rows: Array<{
		table_name: string;
		column_name: string | null;
		comment: string;
	}>,
): {
	tableComments: Map<string, string>;
	columnComments: Map<string, string>;
} {
	const tableComments = new Map<string, string>();
	const columnComments = new Map<string, string>(); // key: "table.column"
	for (const row of rows) {
		if (row.column_name === null) {
			// objsubid = 0 → table comment
			tableComments.set(row.table_name, row.comment);
		} else {
			columnComments.set(`${row.table_name}.${row.column_name}`, row.comment);
		}
	}
	return { tableComments, columnComments };
}

/** Build RLS enabled map and policies map from raw RLS rows. */
function buildRLSMaps(
	rlsRows: Array<{ table_name: string; rls_enabled: boolean }>,
	policiesRows: Array<{
		table_name: string;
		policy_name: string;
		cmd: string;
		roles: string[];
		permissive: boolean;
		using_expr: string | null;
		with_check_expr: string | null;
	}>,
): {
	tableRlsEnabled: Map<string, boolean>;
	tablePolicies: Map<string, PolicyIR[]>;
} {
	const tableRlsEnabled = new Map<string, boolean>();
	for (const row of rlsRows) {
		tableRlsEnabled.set(row.table_name, row.rls_enabled);
	}

	const tablePolicies = new Map<string, PolicyIR[]>();
	const cmdMap: Record<string, PolicyIR['command']> = {
		r: 'SELECT',
		a: 'INSERT',
		w: 'UPDATE',
		d: 'DELETE',
		'*': 'ALL',
	};
	for (const row of policiesRows) {
		const command = cmdMap[row.cmd] ?? 'ALL';
		const policyIR: PolicyIR = {
			name: row.policy_name,
			command,
			...(Array.isArray(row.roles) && row.roles.length > 0
				? { roles: row.roles as readonly string[] }
				: {}),
			...(!row.permissive ? { permissive: false } : {}),
			...(row.using_expr ? { using: row.using_expr } : {}),
			...(row.with_check_expr ? { withCheck: row.with_check_expr } : {}),
		};
		const existing = tablePolicies.get(row.table_name);
		if (existing) {
			existing.push(policyIR);
		} else {
			tablePolicies.set(row.table_name, [policyIR]);
		}
	}
	return { tableRlsEnabled, tablePolicies };
}

function columnTypeMapKey(tableName: string, columnName: string): string {
	return `${tableName}\0${columnName}`;
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function logicalIdentityCarrier(): NonNullable<LogicalIdentity['carrier']> {
	return {
		kind: 'postgresql-side-table',
		authenticated: false,
	};
}

function logicalIdentityFor(id: string): LogicalIdentity {
	return {
		id,
		carrier: logicalIdentityCarrier(),
	};
}

async function queryLogicalIdentityCatalog(
	pool: CatalogQueryExecutor,
	schema: string,
): Promise<readonly RawLogicalIdentity[]> {
	const qualifiedSideTable = `${quoteIdentifier(schema)}.${quoteIdentifier(
		DBSP_LOGICAL_IDENTITY_TABLE,
	)}`;
	const exists = await pool.query<{ exists: boolean }>(
		'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists',
		[qualifiedSideTable],
	);
	if (exists.rows[0]?.exists !== true) {
		return [];
	}
	const result = await pool.query<RawLogicalIdentity>(
		`SELECT logical_id, schema_name, table_name, column_name, carrier_kind ` +
			`FROM ${qualifiedSideTable} ` +
			`WHERE schema_name = $1 ` +
			`ORDER BY table_name, column_name NULLS FIRST, logical_id`,
		[schema],
	);
	return result.rows;
}

/** Build a Map<tableName+columnName, bare format_type result + type schema>. */
function buildFormattedColumnTypeMap(
	rows: RawFormattedColumnType[],
): Map<string, FormattedColumnType> {
	const result = new Map<string, FormattedColumnType>();
	for (const row of rows) {
		result.set(columnTypeMapKey(row.table_name, row.column_name), {
			dbType: stripDbTypeSchema(row.db_type),
			typeSchema: row.type_schema,
		});
	}
	return result;
}

function buildLogicalIdentityMaps(rows: readonly RawLogicalIdentity[]): {
	tableLogicalIdentities: Map<string, LogicalIdentity>;
	columnLogicalIdentities: Map<string, Map<string, LogicalIdentity>>;
} {
	const tableLogicalIdentities = new Map<string, LogicalIdentity>();
	const columnLogicalIdentities = new Map<
		string,
		Map<string, LogicalIdentity>
	>();
	const ids = new Map<string, string>();
	const objects = new Set<string>();

	for (const row of rows) {
		if (row.carrier_kind !== 'postgresql-side-table') {
			continue;
		}
		const objectKey = JSON.stringify([
			row.schema_name,
			row.table_name,
			row.column_name,
		]);
		const owner =
			row.column_name == null
				? `table "${row.schema_name}.${row.table_name}"`
				: `column "${row.schema_name}.${row.table_name}.${row.column_name}"`;
		const priorOwner = ids.get(row.logical_id);
		if (priorOwner && priorOwner !== owner) {
			throw new Error(
				`Logical identity carrier has duplicate logical id "${row.logical_id}" on ${priorOwner} and ${owner}`,
			);
		}
		if (objects.has(objectKey)) {
			throw new Error(
				`Logical identity carrier has multiple rows for ${owner}`,
			);
		}
		ids.set(row.logical_id, owner);
		objects.add(objectKey);
		const identity = logicalIdentityFor(row.logical_id);
		if (row.column_name == null) {
			tableLogicalIdentities.set(row.table_name, identity);
			continue;
		}
		const columns =
			columnLogicalIdentities.get(row.table_name) ??
			new Map<string, LogicalIdentity>();
		columns.set(row.column_name, identity);
		columnLogicalIdentities.set(row.table_name, columns);
	}

	return { tableLogicalIdentities, columnLogicalIdentities };
}

/** Context bag passed to buildTableIR. */
interface TableIRContext {
	tableColumns: Map<string, RawColumn[]>;
	formattedColumnTypes: Map<string, FormattedColumnType>;
	tablePKs: Map<string, string[]>;
	fksByConstraint: Map<string, FKEntry>;
	tableIndexes: Map<string, IndexIR[]>;
	uniqueColumns: Map<string, Map<string, string>>;
	tableChecks: Map<string, CheckConstraintIR[]>;
	tableComments: Map<string, string>;
	columnComments: Map<string, string>;
	tablePartitions: Map<string, PartitionIR>;
	tableRlsEnabled: Map<string, boolean>;
	tablePolicies: Map<string, PolicyIR[]>;
	tableLogicalIdentities: Map<string, LogicalIdentity>;
	columnLogicalIdentities: Map<string, Map<string, LogicalIdentity>>;
	tableNames: string[];
	schema: string;
	warnings: string[];
}

/** Build a single TableIR from all pre-grouped maps. */
function buildTableIR(tableName: string, ctx: TableIRContext): TableIR {
	const rawCols = ctx.tableColumns.get(tableName) ?? [];
	const pkCols = ctx.tablePKs.get(tableName);
	const uniqueColumns = ctx.uniqueColumns.get(tableName);

	const columns: ColumnIR[] = rawCols.map((col) => {
		// Map identity_generation: 'ALWAYS' → 'always', 'BY DEFAULT' → 'byDefault'
		const identity =
			col.is_identity === 'YES' && col.identity_generation
				? col.identity_generation === 'ALWAYS'
					? ('always' as const)
					: ('byDefault' as const)
				: undefined;

		// Collation: skip null and the PostgreSQL default collation name
		const collation =
			col.collation_name && col.collation_name !== 'default'
				? col.collation_name
				: undefined;

		const colComment =
			ctx.columnComments.get(`${tableName}.${col.column_name}`) ?? undefined;
		const logicalIdentity = ctx.columnLogicalIdentities
			.get(tableName)
			?.get(col.column_name);
		const uniqueConstraintName = uniqueColumns?.get(col.column_name);
		const formattedType = ctx.formattedColumnTypes.get(
			columnTypeMapKey(tableName, col.column_name),
		);
		const originalDbType =
			formattedType?.dbType ?? quoteTypeIdentifier(col.udt_name);
		const originalDbTypeSchema =
			formattedType?.typeSchema !== undefined &&
			formattedType.typeSchema !== 'pg_catalog'
				? formattedType.typeSchema
				: undefined;

		return {
			name: col.column_name,
			type: mapPgType(col.data_type, col.udt_name),
			nullable: col.is_nullable === 'YES',
			// Wrap raw column_default string in { sql } so formatDefaultValue emits
			// it verbatim (e.g. CURRENT_TIMESTAMP, nextval('seq'::regclass)) instead
			// of quoting it as a string literal.
			...(col.column_default != null
				? { default: { sql: col.column_default } }
				: {}),
			// format_type preserves typmod/array fidelity; any schema qualification it
			// adds is search_path-relative, so originalDbType is stored bare and the
			// catalog schema/scope are stored structurally.
			originalDbType,
			...(originalDbTypeSchema !== undefined
				? {
						originalDbTypeSchema,
						originalDbTypeSchemaScope:
							originalDbTypeSchema === ctx.schema ? 'target' : 'absolute',
					}
				: {}),
			...(uniqueConstraintName !== undefined
				? { unique: true, uniqueConstraintName }
				: {}),
			...(collation ? { collation } : {}),
			...(identity ? { identity } : {}),
			...(logicalIdentity ? { logicalIdentity } : {}),
			...(colComment ? { comment: colComment } : {}),
		};
	});

	// Build FK list for this table
	const foreignKeys: ForeignKeyIR[] = [];
	for (const [, fk] of ctx.fksByConstraint) {
		if (fk.source !== tableName) continue;
		const isCrossSchema =
			fk.targetSchema !== undefined && fk.targetSchema !== ctx.schema;
		// Same-schema FKs must target a table in our filtered set. Cross-schema
		// targets are outside the single-schema table list by design.
		if (!isCrossSchema && !ctx.tableNames.includes(fk.target)) continue;
		const onDelete = mapDeleteRule(fk.deleteRule);
		const onUpdate = mapDeleteRule(fk.updateRule);
		foreignKeys.push({
			columns: fk.cols,
			references: {
				table: fk.target,
				columns: fk.refs,
				...(isCrossSchema ? { schema: fk.targetSchema } : {}),
			},
			...(onDelete !== 'NO ACTION' ? { onDelete } : {}),
			...(onUpdate !== 'NO ACTION' ? { onUpdate } : {}),
			...(fk.deferred ? { deferred: true } : {}),
		});
	}

	if (!pkCols) {
		ctx.warnings.push(`Table "${tableName}" has no primary key`);
	}

	const checks = ctx.tableChecks.get(tableName);
	const tableComment = ctx.tableComments.get(tableName);
	const partitionConfig = ctx.tablePartitions.get(tableName);
	const rlsEnabled = ctx.tableRlsEnabled.get(tableName) ?? false;
	const policies = ctx.tablePolicies.get(tableName);
	const tableLogicalIdentity = ctx.tableLogicalIdentities.get(tableName);

	return {
		name: tableName,
		...(tableLogicalIdentity ? { logicalIdentity: tableLogicalIdentity } : {}),
		columns,
		...(pkCols
			? { primaryKey: pkCols.length === 1 ? pkCols[0]! : pkCols }
			: {}),
		foreignKeys,
		indexes: ctx.tableIndexes.get(tableName) ?? [],
		...(checks && checks.length > 0 ? { checkConstraints: checks } : {}),
		...(tableComment ? { comment: tableComment } : {}),
		...(partitionConfig ? { partition: partitionConfig } : {}),
		...(rlsEnabled ? { rlsEnabled: true } : {}),
		...(policies && policies.length > 0 ? { policies } : {}),
	};
}

/** Build a Map<seqName, SequenceIR> from raw sequence rows. */
function buildSequenceMap(
	rows: Array<{
		name: string;
		start_value: string;
		increment_by: string;
		min_value: string;
		max_value: string;
		cycle: boolean;
	}>,
): Map<string, SequenceIR> {
	const result = new Map<string, SequenceIR>();
	for (const row of rows) {
		result.set(row.name, {
			name: row.name,
			startWith: Number(row.start_value),
			incrementBy: Number(row.increment_by),
			minValue: Number(row.min_value),
			maxValue: Number(row.max_value),
			cycle: row.cycle,
		});
	}
	return result;
}

/**
 * Introspect a database through a pool.
 *
 * This does NOT accept a checked-out `PoolClient`, and that is deliberate. A
 * client may be sitting inside a transaction that belongs to its owner, and a
 * catalog query that fails there aborts *their* transaction. Protecting that
 * needs a savepoint, and knowing whether to take one needs the caller to say
 * whose transaction it is — which is what `PgsqlAdapter`'s `borrowedClient`
 * declaration is for. Guessing it from the object's shape is the exact defect
 * this adapter was rewritten to remove.
 *
 * Saying so in a comment is not enough: `CatalogQueryExecutor` is structural, so
 * a `PoolClient` — which has a `query()` — satisfies it, and the prose would have
 * been the only thing standing in the way. It is branded instead, and only the
 * adapter's own protected executor carries the brand. A client cannot be passed
 * here at all.
 *
 * So: hold a client, use `new PgsqlAdapter(client, { borrowedClient: true })`
 * and call `.introspect()` on it.
 */
export async function introspect(
	pool: Pool,
	options?: IntrospectionOptions,
): Promise<IntrospectedModelIR> {
	// The type is a compile-time boundary and this is a public entry point: a
	// JavaScript caller, or anyone with a cast, reaches it regardless. A checked-out
	// client that got in here would have its catalog reads run unprotected inside
	// whatever transaction its owner had open — the exact class this adapter was
	// rewritten to close. So refuse it at runtime too, and say what to do instead.
	if (isCheckedOutClient(pool)) {
		throw new Error(
			'introspect() takes a pg.Pool, and was given a checked-out pg.PoolClient. ' +
				'That client may be sitting inside a transaction that belongs to you, and a ' +
				'catalog query that fails there would abort it. dbsp will not guess whose ' +
				'transaction it is: declare it — ' +
				'new PgsqlAdapter(client, { borrowedClient: true }).introspect() — and the ' +
				'declaration is what buys the savepoint protection.',
		);
	}

	// A pool checks out its own connection per query, so there is no caller
	// transaction to damage and nothing to protect. That is precisely why this
	// entry point can take a pool and not a client.
	return introspectWithExecutor(
		{
			dbspProtectedCatalogExecutor: true as const,
			query: <T extends QueryResultRow = QueryResultRow>(
				sql: string,
				parameters?: readonly unknown[],
			) =>
				parameters === undefined
					? pool.query<T>(sql)
					: pool.query<T>(sql, [...parameters]),
		},
		options,
	);
}

/**
 * The path `PgsqlAdapter.introspect()` takes, with an executor that already
 * carries the savepoint protection appropriate to whoever owns the connection.
 * Not exported from the package: reaching the catalog reads unprotected is the
 * thing the public entry point exists to prevent.
 */
export async function introspectWithExecutor(
	pool: CatalogQueryExecutor,
	options?: IntrospectionOptions,
): Promise<IntrospectedModelIR> {
	const schema = options?.schema ?? 'public';
	const warnings: string[] = [];

	const raw = await queryAllCatalogs(pool, schema);
	const logicalIdentities = await queryLogicalIdentityCatalog(pool, schema);

	const tablePartitions = buildPartitionMap(raw.partitions);
	const tableChecks = buildCheckMap(raw.checks);
	const tableIndexes = buildIndexMap(raw.indexes);
	const uniqueColumns = buildUniqueColumnMap(raw.uniqueColumns);
	const tableColumns = buildColumnMap(raw.columns);
	const formattedColumnTypes = buildFormattedColumnTypeMap(
		raw.formattedColumnTypes,
	);
	const tablePKs = buildPKMap(raw.pks);
	const fksByConstraint = buildFKMap(raw.fks);
	const enumMap = buildEnumMap(raw.enums);
	const { tableComments, columnComments } = buildCommentMaps(raw.comments);
	const { tableRlsEnabled, tablePolicies } = buildRLSMaps(
		raw.rls,
		raw.policies,
	);
	const { tableLogicalIdentities, columnLogicalIdentities } =
		buildLogicalIdentityMaps(logicalIdentities);

	// Apply include/exclude filters
	let tableNames = Array.from(tableColumns.keys()).filter(
		(tableName) => tableName !== DBSP_LOGICAL_IDENTITY_TABLE,
	);
	tableNames = filterTables(tableNames, options);

	// Build TableIR map
	const tables = new Map<string, TableIR>();
	for (const tableName of tableNames) {
		const table = buildTableIR(tableName, {
			tableColumns,
			formattedColumnTypes,
			tablePKs,
			fksByConstraint,
			tableIndexes,
			uniqueColumns,
			tableChecks,
			tableComments,
			columnComments,
			tablePartitions,
			tableRlsEnabled,
			tablePolicies,
			tableLogicalIdentities,
			columnLogicalIdentities,
			tableNames,
			schema,
			warnings,
		});
		tables.set(tableName, table);
	}

	const extensions: string[] = raw.extensions.map((r) => r.name);
	const sequenceMap = buildSequenceMap(raw.sequences);
	const relations = inferRelations(fksByConstraint, tableNames, schema);
	const hierarchies = detectHierarchies(
		tables,
		fksByConstraint,
		tableNames,
		schema,
	);
	const externalTables = new Set<string>();
	for (const fk of fksByConstraint.values()) {
		if (
			fk.targetSchema !== undefined &&
			fk.targetSchema !== schema &&
			!tables.has(fk.target)
		) {
			externalTables.add(fk.target);
		}
	}

	const modelIR = new ModelIRImpl(
		tables,
		relations,
		enumMap,
		extensions,
		sequenceMap,
		externalTables,
	);

	return Object.assign(modelIR, {
		hierarchies,
		introspectedAt: new Date(),
		warnings,
	}) as IntrospectedModelIR;
}

// ============================================================================
// Block 2: Relation Inference
// ============================================================================

/**
 * Infer bidirectional relations from FK constraints.
 * Each FK produces: belongsTo (source → target) + hasMany (target → source).
 */
function inferRelations(
	fksByConstraint: Map<string, FKEntry>,
	filteredTables: string[],
	schema: string,
): Map<string, RelationIR> {
	const relations = new Map<string, RelationIR>();
	const filteredSet = new Set(filteredTables);

	for (const [, fk] of fksByConstraint) {
		if (fk.targetSchema !== undefined && fk.targetSchema !== schema) continue;
		if (!filteredSet.has(fk.source) || !filteredSet.has(fk.target)) continue;

		// Derive relation name from FK column
		// author_id → author (belongsTo)
		// category_id → category (belongsTo)
		const belongsToName = deriveRelationName(fk.cols[0]!, fk.target);
		const relationFk = {
			columns: fk.cols,
			references: { table: fk.target, columns: fk.refs },
		};

		// belongsTo: source (FK owner) → target
		const belongsToKey = `${fk.source}.${belongsToName}`;
		if (!relations.has(belongsToKey)) {
			relations.set(belongsToKey, {
				name: belongsToName,
				type: 'belongsTo' as RelationType,
				source: fk.source,
				target: fk.target,
				...buildRelationKeyFields(relationFk, 'belongsTo'),
				cardinality: 'one',
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});
		}

		// hasMany: target → source (FK owner)
		// users.posts (users hasMany posts)
		const hasManyName = fk.source; // Use source table name for hasMany
		const hasManyKey = `${fk.target}.${hasManyName}`;
		if (!relations.has(hasManyKey)) {
			relations.set(hasManyKey, {
				name: hasManyName,
				type: 'hasMany' as RelationType,
				source: fk.target,
				target: fk.source,
				...buildRelationKeyFields(relationFk, 'inverse'),
				cardinality: 'many',
				optionality: 'optional',
				includeStrategy: 'auto',
				filterStrategy: 'auto',
				joinDefault: 'auto',
			});
		}
	}

	return relations;
}

/**
 * Derive a relation name from a FK column name.
 * - author_id → author
 * - category_id → category
 * - parent_id → parent
 * - If no _id suffix, use target table (singular)
 */
function deriveRelationName(fkColumn: string, _targetTable: string): string {
	if (fkColumn.endsWith('_id')) {
		return fkColumn.slice(0, -3);
	}
	if (fkColumn.endsWith('Id')) {
		return fkColumn.slice(0, -2);
	}
	return fkColumn;
}

// ============================================================================
// Block 3: Hierarchy Detection
// ============================================================================

/**
 * Detect hierarchy patterns:
 * - Adjacency: self-referential FK (table.parent_id → table.id)
 * - Edge-table: table with 2+ FKs to same target
 */
function detectHierarchies(
	tables: Map<string, TableIR>,
	fksByConstraint: Map<string, FKEntry>,
	filteredTables: string[],
	schema: string,
): DetectedHierarchy[] {
	const hierarchies: DetectedHierarchy[] = [];
	const filteredSet = new Set(filteredTables);

	// Track FKs by (source, target) for edge-table detection
	const fksBySourceTarget = new Map<
		string,
		Array<{ cols: string[]; refs: string[] }>
	>();

	for (const [, fk] of fksByConstraint) {
		if (fk.targetSchema !== undefined && fk.targetSchema !== schema) continue;
		if (!filteredSet.has(fk.source) || !filteredSet.has(fk.target)) continue;

		// Adjacency: self-referential FK
		if (
			fk.source === fk.target &&
			fk.cols.length === 1 &&
			(fk.targetSchema === undefined || fk.targetSchema === schema)
		) {
			const table = tables.get(fk.source);
			const pk = table?.primaryKey;
			const nodeIdColumn =
				typeof pk === 'string' ? pk : (pk?.[0] ?? DEFAULT_PK_COLUMN);

			hierarchies.push({
				type: 'adjacency',
				nodeTable: fk.source,
				parentColumn: fk.cols[0]!,
				nodeIdColumn,
			});
		}

		// Track for edge-table detection
		const key = `${fk.source}→${fk.target}`;
		const existing = fksBySourceTarget.get(key);
		if (existing) {
			existing.push({ cols: fk.cols, refs: fk.refs });
		} else {
			fksBySourceTarget.set(key, [{ cols: fk.cols, refs: fk.refs }]);
		}
	}

	// Edge-table: table with 2+ FKs to same target (non-self-referential)
	for (const [key, fks] of fksBySourceTarget) {
		if (fks.length < 2) continue;
		const [source, target] = key.split('→');
		if (!source || !target) continue;
		if (source === target) continue; // Exclude self-referential (already handled as adjacency)

		const nodeTable = tables.get(target);
		const nodeIdColumn =
			typeof nodeTable?.primaryKey === 'string'
				? nodeTable.primaryKey
				: (nodeTable?.primaryKey?.[0] ?? DEFAULT_PK_COLUMN);

		hierarchies.push({
			type: 'edge-table',
			nodeTable: target,
			edgeTable: source,
			parentColumn: fks[0]!.cols[0]!,
			childColumn: fks[1]!.cols[0]!,
			nodeIdColumn,
		});
	}

	return hierarchies;
}

// ============================================================================
// Block 4: Helpers
// ============================================================================

/** Map PostgreSQL data type to ColumnType */
function mapPgType(dataType: string, udtName: string): ColumnType {
	// Check UDT name first (more specific)
	switch (udtName) {
		case 'uuid':
			return 'uuid';
		case 'jsonb':
			return 'jsonb';
		case 'json':
			return 'json';
		case 'int4range':
			return 'int4range';
		case 'int8range':
			return 'int8range';
		case 'numrange':
			return 'numrange';
		case 'daterange':
			return 'daterange';
		case 'tsrange':
			return 'tsrange';
		case 'tstzrange':
			return 'tstzrange';
	}

	// Fallback to data_type
	switch (dataType) {
		case 'integer':
		case 'smallint':
			return 'integer';
		case 'bigint':
			return 'bigint';
		case 'numeric':
		case 'decimal':
		case 'real':
		case 'double precision':
			return 'decimal';
		case 'boolean':
			return 'boolean';
		case 'character varying':
		case 'character':
		case 'varchar':
		case 'char':
			return 'string';
		case 'text':
			return 'text';
		case 'date':
			return 'date';
		case 'time without time zone':
		case 'time with time zone':
			return 'time';
		case 'timestamp without time zone':
			return 'timestamp';
		case 'timestamp with time zone':
			return 'datetime';
		case 'json':
			return 'json';
		case 'jsonb':
			return 'jsonb';
		case 'uuid':
			return 'uuid';
		default:
			return 'string'; // Safe fallback
	}
}

/** Map PostgreSQL delete rule to OnDeleteAction */
function mapDeleteRule(rule: string): OnDeleteAction {
	switch (rule) {
		case 'CASCADE':
			return 'CASCADE';
		case 'SET NULL':
			return 'SET NULL';
		case 'SET DEFAULT':
			return 'SET DEFAULT';
		case 'RESTRICT':
			return 'RESTRICT';
		default:
			return 'NO ACTION';
	}
}

/**
 * Filter table names by include/exclude options.
 * Include is applied first, then exclude.
 * Patterns support * for wildcard matching.
 */
function filterTables(
	tableNames: string[],
	options?: IntrospectionOptions,
): string[] {
	return tableNames.filter((name) =>
		isTableInIntrospectionScope(name, options),
	);
}

function isTableInIntrospectionScope(
	tableName: string,
	options?: IntrospectionOptions,
): boolean {
	if (
		options?.include?.length &&
		!options.include.some((pattern) => matchGlob(pattern, tableName))
	) {
		return false;
	}

	if (
		options?.exclude?.length &&
		options.exclude.some((pattern) => matchGlob(pattern, tableName))
	) {
		return false;
	}

	return true;
}

/** Simple glob matching (supports * wildcard) */
function matchGlob(pattern: string, value: string): boolean {
	if (!pattern.includes('*')) return pattern === value;
	const regex = new RegExp(
		`^${pattern.replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
	);
	return regex.test(value);
}
