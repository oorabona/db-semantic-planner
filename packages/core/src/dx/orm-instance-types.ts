/**
 * @fileoverview ORM instance and configuration type definitions.
 *
 * Contains the OrmInstance interface (returned by createOrm) and all
 * OrmOptions variants for configuring the ORM.
 *
 * @module orm-instance-types
 * @since R01
 */

import type { ColumnRef, InferTableRow, TableRef } from './table-ref.js';
import type { Adapter } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import type { CteBuilder } from './cte-builder.js';
import type { NqlTag } from './nql.js';
import type { QueryBuilder } from './query-builder-types.js';
import type { GeneratedSchema, InferDBFromSchema } from './schema-bridge.js';
import type { ListHierarchyOptions, RelationHints } from './types.js';

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
 * Prefer specific option types (OrmOptionsWithModel, OrmOptionsWithSchema, OrmOptionsWithAdapter).
 */
export type OrmOptions<DB = unknown> =
	| OrmOptionsWithModel<DB>
	| OrmOptionsWithSchema<GeneratedSchema, DB>
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
 * Prefer OrmOptionsWithSchema for codegen-first approach.
 */
export interface OrmOptionsWithModel<DB = unknown> extends OrmOptionsBase<DB> {
	readonly model: ModelIR;
	readonly schema?: never;
}

/**
 * OrmOptions with generated schema (sync creation, codegen-first).
 * Preferred approach for ARCH-002 codegen-first architecture.
 *
 * @typeParam TSchema - The schema type (inferred from schema value)
 * @typeParam DB - The database type (inferred from TSchema when possible)
 *
 * @example
 * ```typescript
 * const schema = { tables: { users: { id: { type: 'uuid' } } } } as const satisfies GeneratedSchema;
 * const orm = createOrm({ schema, adapter });
 * // DB is inferred as { users: { id: string } }
 * ```
 */
export interface OrmOptionsWithSchema<
	TSchema extends GeneratedSchema = GeneratedSchema,
	DB = InferDBFromSchema<TSchema>,
> extends OrmOptionsBase<DB> {
	readonly schema: TSchema;
	readonly model?: never;
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
 * @typeParam DB - Database schema type (Kysely-like).
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
 * String-based table entry points (select, insert, update, delete, upsert) are
 * intentionally absent. Use the typed TableRef-based methods instead:
 *   - `orm.from(table)` — SELECT
 *   - `orm.into(table)` — INSERT
 *   - `orm.modify(table)` — UPDATE
 *   - `orm.removeFrom(table)` — DELETE
 *   - `orm.upsertInto(table)` — UPSERT (INSERT ... ON CONFLICT)
 *
 * Internal code (NQL, planner, tests) that needs string-based access should
 * cast to `OrmInstanceInternal<DB>`.
 *
 * @typeParam DB - Database schema type (Kysely-like).
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
 * // With Schema wrapper (from schema() / defineSchema())
 * const db = schema({ users: { id: 'integer', name: 'string' } });
 * type MyOrm = OrmOf<typeof db>;  // unwraps Schema<T> → InferDB<T>
 *
 * // With raw SchemaDefinition
 * type MyOrm = OrmOf<{ users: { id: 'integer' } }>;  // uses InferDB directly
 * ```
 */
export type OrmOf<S> =
	S extends import('./schema.js').Schema<infer T extends import('./schema.js').SchemaDefinition>
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

export interface OrmInstance<DB = Record<string, unknown>> {
	/**
	 * Type-safe table references for query building.
	 *
	 * Provides access to tables and their columns as typed objects.
	 * Use destructuring to get individual table references, then pass
	 * them to `from()` for type-safe queries.
	 *
	 * @example
	 * ```typescript
	 * const { users, posts } = orm.tables;
	 * const activeUsers = await orm.from(users).where(eq(users.active, true)).all();
	 * ```
	 *
	 * @since DX-040-SURFACE
	 */
	readonly tables: { [K in keyof DB & string]: TableRef<K, RowToColumnRefs<K, DB[K]>, any> };

	/**
	 * Start a type-safe SELECT query from a TableRef.
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
	from<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): QueryBuilder<InferTableRow<TTable>>;

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
	into<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): InsertBuilder;

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
	modify<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): UpdateBuilder;

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
	removeFrom<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): DeleteBuilder;

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
	upsertInto<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): UpsertBuilder;

	/**
	 * The strict mode setting for this ORM instance.
	 */
	readonly strictMode: boolean;

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
	transaction<T>(fn: (tx: OrmInstance<DB>) => Promise<T>): Promise<T>;

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
	 * @returns Promise resolving to array of results
	 */
	raw<T = unknown>(sql: string, parameters?: readonly unknown[]): Promise<T[]>;

	/**
	 * Create a CTE (Common Table Expression) backed by unnest() arrays.
	 *
	 * @param name - The CTE name
	 * @returns A CteBuilder for constructing the CTE
	 */
	withCte(name: string): CteBuilder;
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

