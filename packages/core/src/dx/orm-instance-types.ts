/**
 * @fileoverview ORM instance and configuration type definitions.
 *
 * Contains the OrmInstance interface (returned by createOrm) and all
 * OrmOptions variants for configuring the ORM.
 *
 * @module orm-instance-types
 * @since R01
 */

import type { ColumnJsReadType, PinnedConnectionOptions } from '@dbsp/types';
import type { Adapter, TransactionOptions } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type { BatchValuesOptions, BatchValuesRef } from './batch-values.js';
import type { CteBuilder } from './cte-builder.js';
import type {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import type { NqlTag } from './nql.js';
import type { QueryBuilder } from './query-builder-types.js';
import type {
	RawCteQueryBuilder,
	RecursiveOptions,
} from './raw-cte-builder.js';
import type { DropIndexOptions, TableDDL } from './table-ddl-types.js';
import type { ColumnRef, InferTableRow, TableRef } from './table-ref.js';
import type {
	ExpressionSpec,
	ListHierarchyOptions,
	RelationHints,
} from './types.js';

/**
 * Configuration options for creating an ORM instance.
 *
 * Either `model` or `adapter` must be provided:
 * - With `model`: Uses the provided schema (sync)
 * - With `adapter` only: Auto-discovers schema via introspection (async)
 *
 * @example Zero-config (auto-introspection)
 * ```typescript
 * const orm = await createOrm({ adapter });
 * const users = await orm.select('users').all();
 * ```
 *
 * @example Explicit model
 * ```typescript
 * const orm = createOrm({ model, adapter });
 * const users = await orm.select('users').all();
 * ```
 */
/**
 * Union type for all ORM options.
 * Prefer specific option types (OrmOptionsWithModel, OrmOptionsWithAdapter).
 */
export type OrmOptions<DB = unknown> =
	| OrmOptionsWithModel<DB>
	| OrmOptionsWithAdapter<DB>;

/**
 * Base options shared by all ORM option variants.
 */
interface OrmOptionsBase<DB = unknown> {
	readonly strictMode?: boolean;
	readonly relationHints?: RelationHints;
	readonly adapter?: Adapter<DB>;

	// ============================================================
	// Global Limits (NQL-ALIGN Block 3)
	// ============================================================

	/**
	 * Maximum depth for recursive CTE queries.
	 * Prevents infinite recursion in tree/graph traversals.
	 * @default 10
	 */
	readonly maxDepth?: number;

	/**
	 * Maximum number of relation hops in a single query.
	 * Limits paths like `user.posts.comments.author.profile`.
	 * @default 5
	 */
	readonly maxTableHops?: number;

	/**
	 * Maximum nesting depth for CASE expressions.
	 * Prevents overly complex conditional logic.
	 * @default 10
	 */
	readonly maxNestedCase?: number;
	/**
	 * Dialect capabilities for strategy selection.
	 * When provided, the planner uses these to select optimal strategies:
	 * - supportsJsonAgg: Enables json_agg for to-many relations
	 * - supportsLateralJoin: Enables LATERAL for per-row limits
	 * - supportsRecursiveCTE: Enables WITH RECURSIVE for tree traversal
	 */
	readonly dialectCapabilities?: DialectCapabilities;

	/**
	 * Plan options passed to the semantic planner.
	 * Per-query options via `.withPlanOptions()` take precedence over global options.
	 *
	 * @example
	 * ```typescript
	 * const orm = createOrm({
	 *   schema,
	 *   adapter,
	 *   planOptions: {
	 *     defaultIncludeStrategy: 'subquery',
	 *     enableCTEs: true,
	 *     maxIncludeDepth: 3,
	 *   },
	 * });
	 * ```
	 */
	readonly planOptions?: PlanOptions;
}

/**
 * OrmOptions with explicit model (sync creation).
 */
export interface OrmOptionsWithModel<DB = unknown> extends OrmOptionsBase<DB> {
	readonly model: ModelIR;
	readonly schema?: never;
}

/**
 * OrmOptions without model, requires adapter for auto-introspection (async creation).
 */
export interface OrmOptionsWithAdapter<DB = unknown>
	extends OrmOptionsBase<DB> {
	readonly model?: never;
	readonly schema?: never;
	readonly adapter: Adapter<DB>;
}

/**
 * ORM instance created by createOrm().
 *
 * @typeParam DB - Database row map type.
 *   Keys are table names, values are row types.
 *   When provided, query() method provides autocomplete for table names
 *   and infers result types automatically.
 *
 * @example
 * ```typescript
 * // Define your database schema
 * interface Database {
 *   users: { id: number; name: string; email: string };
 *   posts: { id: number; title: string; authorId: number };
 * }
 *
 * // Create typed ORM
 * const orm = createOrm<Database>({ model });
 *
 * // Table names are autocompleted, results are typed
 * const users = await orm.select('users').all();
 * // users is { id: number; name: string; email: string }[]
 * ```
 */
/**
 * PUBLIC ORM instance type — the interface consumers see from createOrm().
 *
 * SELECT queries can start from either first-class table entry point:
 *   - `orm.select(name)` - concise table-name form
 *   - `orm.from(table)` - TableRef form with column-level types
 *
 * Mutations use the typed TableRef-based methods:
 *   - `orm.into(table)` - INSERT
 *   - `orm.modify(table)` - UPDATE
 *   - `orm.removeFrom(table)` - DELETE
 *   - `orm.upsertInto(table)` - UPSERT (INSERT ... ON CONFLICT)
 *
 * @typeParam DB - Database row map type.
 *   Keys are table names, values are row types.
 *
 * @example
 * ```typescript
 * const { users } = orm.tables;
 * const activeUsers = await orm.from(users).where(eq(users.active, true)).all();
 * await orm.into(users).values({ name: 'Alice', email: 'a@b.com' }).execute();
 * ```
 *
 * @since DX-040-SURFACE
 */
/**
 * Convenience alias for explicit ORM type annotations.
 * Accepts BOTH raw SchemaDefinition AND Schema<T> wrapper (auto-unwraps).
 *
 * @example
 * ```typescript
 * // With Schema wrapper from schema()
 * const db = schema({ users: { id: 'integer', name: 'string' } });
 * type MyOrm = OrmOf<typeof db>;  // unwraps Schema<T> → InferDB<T>
 *
 * // With raw SchemaDefinition
 * type MyOrm = OrmOf<{ users: { id: 'integer' } }>;  // uses InferDB directly
 * ```
 */
export type OrmOf<S> = S extends import('./schema.js').Schema<
	infer T extends import('./schema.js').SchemaDefinition
>
	? OrmInstance<import('./schema.js').InferDB<T>>
	: S extends import('./schema.js').SchemaDefinition
		? OrmInstance<import('./schema.js').InferDB<S>>
		: never;

/**
 * Convert a row type `{ col: Type }` to column refs `{ col: ColumnRef<Table, 'col', Type> }`
 * so that `InferTableRow` can extract the types back from a `TableRef`.
 *
 * This is used exclusively to type `OrmInstance.tables` with full column type info.
 *
 * @typeParam TTable - The table name literal (e.g. `'users'`)
 * @typeParam TRow   - The row type from `DB[K]` (e.g. `{ id: number; name: string }`)
 */
type RowToColumnRefs<TTable extends string, TRow> = {
	[K in keyof TRow & string]: ColumnRef<TTable, K, TRow[K]>;
};

/**
 * Result of `orm.selectExpression()` — provides compiled SQL and execution.
 */
export interface SelectExpressionResult {
	/** Compiled SQL string (e.g. `SELECT nextval('my_seq')`) */
	readonly sql: string;
	/** Bound parameters (if any) */
	readonly parameters: readonly unknown[];
	/**
	 * Execute the expression against the database.
	 * Requires the ORM to have an adapter with a pool.
	 *
	 * @typeParam T - Expected result row type
	 * @returns Array of result rows (typically one row for scalar expressions)
	 */
	execute<T = Record<string, unknown>>(): Promise<T[]>;
}

export interface RawReadOptions {
	/**
	 * Map of output-key -> JS read type, applied to bigint columns read via raw SQL.
	 * The caller declares provenance explicitly; dbsp does not infer it for arbitrary SQL.
	 */
	readonly bigintReads?: Readonly<Record<string, ColumnJsReadType>>;
}

export interface OrmInstance<DB = Record<string, unknown>> {
	/**
	 * Type-safe table references for query building.
	 *
	 * Provides access to tables and their columns as typed objects.
	 * Use destructuring to get individual table references, then pass
	 * them to `from()` for type-safe queries.
	 *
	 * Each entry also carries the runtime DDL helpers (`.truncate()`,
	 * `.indexes.list()`, `.alterColumn()`, …) via the `TableDDL` mixin, mirroring
	 * what `wrapTablesProxyWithDDL` produces at runtime.
	 *
	 * @example
	 * ```typescript
	 * const { users, posts } = orm.tables;
	 * const activeUsers = await orm.from(users).where(eq(users.active, true)).all();
	 * const indexes = await orm.tables.users.indexes.list();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	readonly tables: {
		// TRelations is `any` because `DB` only encodes row types, not schema relations.
		// To compute proper RelationRef types, the full schema definition would be needed.
		// TODO(FIND-030): Thread a TSchema generic through OrmInstance to replace `any`
		// with `RowToRelationRefs<K, DB, TSchema>` once the schema-tables-types
		// infrastructure is wired through createOrm().
		// The `& TableDDL` intersection reflects the runtime augmentation done by
		// wrapTablesProxyWithDDL (Object.assign(tableRef, ddl)) — the query-building
		// TableRef and the DDL runtime helpers coexist on the same object.
		// biome-ignore lint/suspicious/noExplicitAny: TRelations generic is intentionally deferred — see TODO(FIND-030); full type requires schema-level information not available in OrmInstance<DB>
		[K in keyof DB & string]: TableRef<K, RowToColumnRefs<K, DB[K]>, any> &
			TableDDL;
	};

	/**
	 * Start building a SELECT query from a table name (string-based API).
	 *
	 * This is the ordinary table-name API used throughout guides and examples.
	 * Use `orm.from(orm.tables.<table>)` when you want the stricter TableRef-based
	 * form with column-level type information for filters, ordering, and result
	 * inference.
	 *
	 * @typeParam K - Table name (inferred from DB keys when typed)
	 * @typeParam TResult - Override result type (defaults to DB[K])
	 * @param from - The root table name to select from
	 * @returns A QueryBuilder for constructing the select
	 */
	select<K extends keyof DB & string, TResult = DB[K]>(
		from: K,
	): QueryBuilder<TResult>;

	/**
	 * Start building a SELECT query from a typed TableRef.
	 *
	 * This is the stricter table-reference API. Use it when you want column refs
	 * from `orm.tables.<table>` to carry column-level types into filters and other
	 * query clauses. Use `orm.select('<table>')` when the shorter table-name form is
	 * enough.
	 *
	 * @typeParam TTable - The TableRef type (inferred from the argument)
	 * @param table - A TableRef from `orm.tables`
	 * @returns A QueryBuilder typed to the table's row type
	 *
	 * @example
	 * ```typescript
	 * const { users } = orm.tables;
	 * const user = await orm.from(users).where(eq(users.id, 1)).first();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this overload signature
	from<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): QueryBuilder<InferTableRow<TTable>>;

	/**
	 * Start a SELECT query from a BatchValuesRef source (unnest-backed virtual table).
	 *
	 * @param batchRef - A BatchValuesRef created via `orm.batchValues(...)`
	 * @returns A QueryBuilder with the batch alias as the root table
	 *
	 * @example
	 * ```typescript
	 * const requested = orm.batchValues(
	 *   [paths, names],
	 *   ['path', 'name'],
	 *   ['text', 'text'],
	 *   { ordinality: true },
	 * );
	 * const rows = await orm.from(requested).orderBy('requested.ord').all();
	 * ```
	 */
	from(batchRef: BatchValuesRef): QueryBuilder<Record<string, unknown>>;

	/**
	 * Start a type-safe INSERT operation from a TableRef.
	 *
	 * @typeParam TTable - The TableRef type (inferred from the argument)
	 * @param table - A TableRef from `orm.tables`
	 * @returns An InsertBuilder typed to the table's row type
	 *
	 * @example
	 * ```typescript
	 * const { users } = orm.tables;
	 * await orm.into(users).values({ name: 'Alice', email: 'a@b.com' }).execute();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this overload signature
	into<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): InsertBuilder<InferTableRow<TTable>>;

	/**
	 * Start a type-safe UPDATE operation from a TableRef.
	 *
	 * @typeParam TTable - The TableRef type (inferred from the argument)
	 * @param table - A TableRef from `orm.tables`
	 * @returns An UpdateBuilder for constructing the update
	 *
	 * @example
	 * ```typescript
	 * const { users } = orm.tables;
	 * await orm.modify(users).set({ active: false }).where(eq(users.id, 1)).execute();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this overload signature
	modify<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): UpdateBuilder<InferTableRow<TTable>>;

	/**
	 * Start a type-safe DELETE operation from a TableRef.
	 *
	 * @typeParam TTable - The TableRef type (inferred from the argument)
	 * @param table - A TableRef from `orm.tables`
	 * @returns A DeleteBuilder for constructing the delete
	 *
	 * @example
	 * ```typescript
	 * const { users } = orm.tables;
	 * await orm.removeFrom(users).where(eq(users.id, 1)).execute();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this overload signature
	removeFrom<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): DeleteBuilder<InferTableRow<TTable>>;

	/**
	 * Start a type-safe UPSERT (INSERT ... ON CONFLICT) operation from a TableRef.
	 *
	 * @typeParam TTable - The TableRef type (inferred from the argument)
	 * @param table - A TableRef from `orm.tables`
	 * @returns An UpsertBuilder for constructing the upsert
	 *
	 * @example
	 * ```typescript
	 * const { users } = orm.tables;
	 * await orm.upsertInto(users)
	 *   .values({ id: 1, name: 'Alice', email: 'a@b.com' })
	 *   .onConflict(['email'])
	 *   .doUpdate({ name: 'Alice' })
	 *   .execute();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	// biome-ignore lint/suspicious/noExplicitAny: polymorphic constraint — TTable is inferred by callers; TableRef generics are statically erased in this overload signature
	upsertInto<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): UpsertBuilder<InferTableRow<TTable>>;

	/**
	 * The strict mode setting for this ORM instance.
	 */
	readonly strictMode: boolean;

	/**
	 * Whether the connection backing this ORM instance is inside a transaction.
	 *
	 * Reflects the backing adapter's real transaction state: `true` inside a
	 * {@link OrmInstance.transaction} callback, and also `true` for a top-level
	 * instance built on an adapter that is ALREADY inside a caller-owned
	 * transaction (e.g. a borrowed pg client mid-`BEGIN`); `false` otherwise.
	 *
	 * Callers use this to enforce a top-level precondition: an operation whose
	 * effects a caller's outer rollback must not silently undo — DDL that cannot
	 * be nested, or a process-level cache that would go stale if the surrounding
	 * transaction rolls back — can fail closed when the connection is already in a
	 * transaction instead of assuming it owns the top-level transaction.
	 *
	 * Optional for backward compatibility: instances produced by `createOrm`
	 * always populate it, but a pre-existing hand-built `OrmInstance` double may
	 * omit it (reads as `undefined`), so a fail-closed caller should treat a
	 * non-`true` value it cannot confirm accordingly.
	 */
	readonly inTransaction?: boolean;

	/**
	 * Create a schema-scoped ORM instance.
	 * All queries from the returned instance will include the schema prefix.
	 * Type information is preserved in the returned instance.
	 *
	 * @param schemaName - The database schema name (e.g., 'public', 'blog', 'tenant_123')
	 * @returns A new ORM instance scoped to the schema
	 *
	 * @example
	 * ```typescript
	 * const scopedOrm = orm.withSchema('blog');
	 * const { users } = scopedOrm.tables;
	 * const rows = await scopedOrm.from(users).all();
	 * // SQL: SELECT * FROM "blog"."users"
	 * ```
	 */
	withSchema(schemaName: string): OrmInstance<DB>;

	// =========================================================================
	// Hierarchy List Methods (DX-022)
	// =========================================================================

	/**
	 * List all ancestors of a node as a flat array.
	 * Uses the include({ recursive: true }) API internally.
	 *
	 * Unlike ancestors(), this method executes immediately and returns a flat array.
	 *
	 * @param table - The hierarchical table name
	 * @param nodeIdValue - The ID of the starting node
	 * @param options - Hierarchy list options
	 * @returns Promise resolving to array of ancestor records (excluding the starting node)
	 *
	 * @example
	 * ```typescript
	 * // Get all ancestor categories of category 42
	 * const ancestors = await orm.listAncestors('categories', 42, {
	 *   parentId: 'parentCategoryId',
	 *   maxDepth: 10
	 * });
	 * // Returns: [{ id: 5, name: 'Parent' }, { id: 1, name: 'Root' }]
	 * ```
	 */
	listAncestors<TResult = unknown>(
		table: string,
		nodeIdValue: unknown,
		options: ListHierarchyOptions,
	): Promise<TResult[]>;

	/**
	 * List all descendants of a node as a flat array.
	 * Uses the include({ recursive: true }) API internally.
	 *
	 * Unlike descendants(), this method executes immediately and returns a flat array.
	 *
	 * @param table - The hierarchical table name
	 * @param nodeIdValue - The ID of the starting node
	 * @param options - Hierarchy list options
	 * @returns Promise resolving to array of descendant records (excluding the starting node)
	 *
	 * @example
	 * ```typescript
	 * // Get all descendant categories of category 1
	 * const descendants = await orm.listDescendants('categories', 1, {
	 *   parentId: 'parentCategoryId',
	 *   maxDepth: 5
	 * });
	 * // Returns: [{ id: 2, name: 'Child1' }, { id: 3, name: 'Grandchild' }]
	 * ```
	 */
	listDescendants<TResult = unknown>(
		table: string,
		nodeIdValue: unknown,
		options: ListHierarchyOptions,
	): Promise<TResult[]>;

	// =========================================================================
	// Bulk delete/update (no typed TableRef variant — no WHERE guard needed)
	// =========================================================================

	/**
	 * Start building an UPDATE operation that affects all rows.
	 * Use with caution - this explicitly allows updates without WHERE.
	 *
	 * @param table - The table to update
	 * @returns An UpdateBuilder pre-configured for full-table update
	 *
	 * @example
	 * ```typescript
	 * await orm.updateAll('users')
	 *   .set({ lastLoginCheck: new Date() })
	 *   .execute();
	 * ```
	 */
	updateAll(table: string): UpdateBuilder;

	/**
	 * Start building a DELETE operation that affects all rows.
	 * Use with caution - this explicitly allows deletes without WHERE.
	 *
	 * @param table - The table to delete from
	 * @returns A DeleteBuilder pre-configured for full-table delete
	 *
	 * @example
	 * ```typescript
	 * await orm.deleteAll('tempData').execute();
	 * ```
	 */
	deleteAll(table: string): DeleteBuilder;

	// =========================================================================
	// Transaction Methods (DX-025)
	// =========================================================================

	/**
	 * Execute a callback within a database transaction.
	 * Auto-commits on success, auto-rolls back on exception.
	 *
	 * @typeParam T - The return type of the callback
	 * @param fn - Async callback that receives a transaction-scoped ORM instance
	 * @returns Promise resolving to the callback's return value
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.transaction(async (tx) => {
	 *   const { users, orders } = tx.tables;
	 *   await tx.into(orders).values({ userId: 1, total: 100 }).execute();
	 *   await tx.modify(users).set({ balance: 0 }).where(eq(users.id, 1)).execute();
	 *   return { success: true };
	 * });
	 * ```
	 */
	transaction<T>(
		fn: (tx: OrmInstance<DB>) => Promise<T>,
		options?: TransactionOptions,
	): Promise<T>;

	/**
	 * Execute a callback with all ORM work pinned to one physical database
	 * connection for the callback lifetime, without opening a transaction.
	 *
	 * @typeParam T - The return type of the callback
	 * @param fn - Async callback that receives a connection-pinned ORM instance
	 * @param options - Optional pinned connection controls
	 * @returns Promise resolving to the callback's return value
	 */
	withPinnedConnection<T>(
		fn: (pinned: OrmInstance<DB>) => Promise<T>,
		options?: PinnedConnectionOptions,
	): Promise<T>;

	// =========================================================================
	// NQL Template Literal API (DX-040 Block 8)
	// =========================================================================

	/**
	 * NQL template tag for writing queries in Natural Query Language.
	 *
	 * @typeParam T - The expected result row type
	 * @returns An NqlBuilder with .all(), .first(), .toIntentIR(), .plan(), .dump()
	 *
	 * @example
	 * ```typescript
	 * type UserRow = { id: string; name: string };
	 * const users = await orm.nql<UserRow>`users | select id, name`.all();
	 * ```
	 */
	readonly nql: NqlTag;

	// =========================================================================
	// Raw SQL Escape Hatch
	// =========================================================================

	/**
	 * Execute raw SQL directly.
	 * This is the ultimate escape hatch for queries that cannot be
	 * expressed via the intent system.
	 *
	 * ⚠️  WARNING: This bypasses the planner and all type safety.
	 *
	 * @typeParam T - Expected result type (defaults to unknown)
	 * @param sql - Raw SQL string with parameter placeholders
	 * @param parameters - Parameter values for placeholders
	 * @param options - Explicit raw read coercion options
	 * @returns Promise resolving to array of results
	 */
	raw<T = unknown>(
		sql: string,
		parameters?: readonly unknown[],
		options?: RawReadOptions,
	): Promise<T[]>;

	/**
	 * Create a CTE (Common Table Expression) backed by unnest() arrays.
	 *
	 * @param name - The CTE name
	 * @returns A CteBuilder for constructing the CTE
	 */
	withCte(name: string): CteBuilder;

	/**
	 * Build a WITH RECURSIVE CTE from explicit base and step query builders (FR-8).
	 *
	 * The base query provides the anchor (starting rows).
	 * The step query references the CTE name as its FROM table and is joined
	 * recursively until no new rows are produced or maxDepth is reached.
	 *
	 * Returns a RawCteQueryBuilder that can be further configured with
	 * `.columns()`, `.where()`, `.orderBy()`, `.limit()` before execution.
	 *
	 * @param name - CTE name (used as the table in the recursive step and outer query)
	 * @param options - { base, step, maxDepth?, depthColumn?, unionAll? }
	 * @returns A RawCteQueryBuilder for the outer query configuration and execution
	 *
	 * @example
	 * ```typescript
	 * const chain = orm.recursive('parent_chain', {
	 *   base: orm.select('symbols').where(eq('id', rootId)),
	 *   step: orm.select('parent_chain'),
	 *   maxDepth: 10,
	 * });
	 * const results = await chain.columns(['id', 'name', 'depth']).orderBy('depth').all();
	 * ```
	 */
	recursive<TResult = unknown>(
		name: string,
		options: RecursiveOptions,
	): RawCteQueryBuilder<TResult>;

	/**
	 * Create a virtual batch data source backed by `unnest($1::type[], $2::type[], ...)`.
	 *
	 * Returns a BatchValuesRef that can be passed to:
	 * - `.from(batchRef)` — use as the primary FROM source
	 * - `.join(batchRef, { on: ... })` — join to an existing table
	 * - `orm.modify(table).join(batchRef, { on: ... })` — batch UPDATE FROM
	 *
	 * @param data    Column-major arrays: `[idsArray, namesArray, ...]`
	 * @param columns Column names: `['id', 'name', ...]`
	 * @param types   PG type names for CAST: `['integer', 'text', ...]`
	 * @param opts    Optional: alias (default 'batch') and ordinality flag
	 *
	 * @example
	 * ```typescript
	 * const batch = orm.batchValues(
	 *   [[1, 2, 3], [10, 20, 30]],
	 *   ['id', 'callee_id'],
	 *   ['integer', 'integer'],
	 * );
	 * await orm.modify('calls')
	 *   .join(batch, { on: eq('calls.id', ref('batch.id')) })
	 *   .set({ callee_id: ref('batch.callee_id') })
	 *   .execute();
	 * ```
	 */
	batchValues(
		data: readonly unknown[][],
		columns: readonly string[],
		types: readonly string[],
		opts?: BatchValuesOptions,
	): BatchValuesRef;

	// =========================================================================
	// FROM-less SELECT expression (Gap 6)
	// =========================================================================

	/**
	 * Compile and optionally execute a FROM-less SELECT expression.
	 *
	 * Used for expressions that do not query a specific table,
	 * such as sequence functions, date functions, or scalar computations.
	 *
	 * @param expr - An ExpressionSpec produced by fn(), op(), literal(), etc.
	 * @returns An object with `sql`, `parameters`, and `execute()` method.
	 *
	 * @example
	 * ```typescript
	 * // Compile only (no DB connection needed)
	 * const { sql } = orm.selectExpression(fn('nextval', literal('my_seq')));
	 * // SQL: SELECT nextval('my_seq')
	 *
	 * // Execute (requires adapter with pool)
	 * const [{ nextval }] = await orm.selectExpression(fn('nextval', literal('my_seq'))).execute();
	 * ```
	 */
	selectExpression(expr: ExpressionSpec): SelectExpressionResult;

	// =========================================================================
	// Global DDL Shortcuts (F-005)
	// =========================================================================

	/**
	 * Global DDL operations not scoped to a specific table.
	 *
	 * @since DDL-TABLE-001 / F-005
	 */
	readonly ddl: {
		/**
		 * Drop an index by name (schema-aware, not table-scoped).
		 *
		 * @param name - Index name to drop
		 * @param options - Optional DROP INDEX options (concurrently, ifExists, cascade, schema)
		 */
		dropIndex(name: string, options?: DropIndexOptions): Promise<void>;
	};
}

/**
 * INTERNAL ORM instance type — extends public OrmInstance with string-based
 * table entry points used by NQL, the planner, and internal tests.
 *
 * External consumers should NOT use this type. Cast to it only when internal
 * string-based access is explicitly required:
 * ```typescript
 * const internal = orm as OrmInstanceInternal<DB>;
 * internal.select('users');
 * ```
 *
 * @internal
 */
export interface OrmInstanceInternal<DB = Record<string, unknown>>
	extends OrmInstance<DB> {
	/**
	 * Start building a SELECT query from a table name (string-based API).
	 *
	 * @internal Use `orm.from(orm.tables.tableName)` for type-safe queries.
	 *
	 * @typeParam K - Table name (inferred from DB keys when typed)
	 * @typeParam TResult - Override result type (defaults to DB[K])
	 * @param from - The root table name to select from
	 * @returns A QueryBuilder for constructing the select
	 */
	select<K extends keyof DB & string, TResult = DB[K]>(
		from: K,
	): QueryBuilder<TResult>;

	/**
	 * Start building an INSERT operation (string-based API).
	 *
	 * @internal Use `orm.into(orm.tables.tableName)` for type-safe inserts.
	 */
	insert(table: string): InsertBuilder;

	/**
	 * Start building an UPDATE operation (string-based API).
	 *
	 * @internal Use `orm.modify(orm.tables.tableName)` for type-safe updates.
	 */
	update(table: string): UpdateBuilder;

	/**
	 * Start building a DELETE operation (string-based API).
	 *
	 * @internal Use `orm.removeFrom(orm.tables.tableName)` for type-safe deletes.
	 */
	delete(table: string): DeleteBuilder;

	/**
	 * Start building an UPSERT operation (string-based API).
	 *
	 * @internal Use `orm.upsertInto(orm.tables.tableName)` for type-safe upserts.
	 */
	upsert(table: string): UpsertBuilder;
}
