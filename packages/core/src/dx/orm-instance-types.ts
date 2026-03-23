/**
 * @fileoverview ORM instance and configuration type definitions.
 *
 * Contains the OrmInstance interface (returned by createOrm) and all
 * OrmOptions variants for configuring the ORM.
 *
 * @module orm-instance-types
 * @since R01
 */

import type { InferTableRow, TableRef } from './table-ref.js';
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
	readonly tables: Record<string, TableRef<any, any, any>>;

	/**
	 * Start a type-safe query from a TableRef.
	 *
	 * Extracts the table name from the TableRef's metadata and delegates
	 * to the internal select implementation. All QueryBuilder features
	 * (include, union, groupBy, having, etc.) are available.
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
	 * Start building a SELECT query from a table (string-based API).
	 *
	 * @deprecated Prefer `orm.from(orm.tables.tableName)` for type-safe queries.
	 * This method remains for internal use and backward compatibility.
	 * @internal
	 *
	 * When DB generic is provided:
	 * - Table name is constrained to `keyof DB`
	 * - Result type defaults to `DB[TableName]`
	 *
	 * @typeParam K - Table name (inferred from DB keys when typed)
	 * @typeParam TResult - Override result type (defaults to DB[K])
	 * @param from - The root table name to select from
	 * @returns A QueryBuilder for constructing the select
	 *
	 * @example
	 * ```typescript
	 * // Typed select (with DB generic)
	 * const orm = createOrm<Database>({ model });
	 * const users = await orm.select('users').all();
	 * // users is Database['users'][]
	 *
	 * // Override type if needed
	 * type CustomUser = { id: number; extra: string };
	 * const custom = await orm.select<CustomUser>('users').all();
	 * ```
	 */
	select<K extends keyof DB & string, TResult = DB[K]>(
		from: K,
	): QueryBuilder<TResult>;

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
	 * const users = await scopedOrm.select('users').all();
	 * // SQL: SELECT * FROM blog.users
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
	// Mutation Methods (DX-010)
	// =========================================================================

	/**
	 * Start building an INSERT operation.
	 *
	 * @param table - The table to insert into
	 * @returns An InsertBuilder for constructing the insert
	 *
	 * @example
	 * ```typescript
	 * await orm.insert('users')
	 *   .values({ name: 'John', email: 'john@example.com' })
	 *   .execute();
	 * ```
	 */
	insert(table: string): InsertBuilder;

	/**
	 * Start building an UPDATE operation.
	 * Requires a WHERE clause unless using updateAll().
	 *
	 * @param table - The table to update
	 * @returns An UpdateBuilder for constructing the update
	 *
	 * @example
	 * ```typescript
	 * await orm.update('users')
	 *   .set({ active: false })
	 *   .where(eq('id', 123))
	 *   .execute();
	 * ```
	 */
	update(table: string): UpdateBuilder;

	/**
	 * Start building a DELETE operation.
	 * Requires a WHERE clause unless using deleteAll().
	 *
	 * @param table - The table to delete from
	 * @returns A DeleteBuilder for constructing the delete
	 *
	 * @example
	 * ```typescript
	 * await orm.delete('users')
	 *   .where(eq('id', 123))
	 *   .execute();
	 * ```
	 */
	delete(table: string): DeleteBuilder;

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

	/**
	 * Start building an UPSERT operation (INSERT ... ON CONFLICT).
	 * Combines insert with conflict handling for idempotent operations.
	 *
	 * @param table - The table to upsert into
	 * @returns An UpsertBuilder for constructing the upsert
	 *
	 * @example
	 * ```typescript
	 * // Upsert with doUpdate
	 * await orm.upsert('users')
	 *   .values({ id: 1, name: 'Alice', email: 'alice@example.com' })
	 *   .onConflict(['id'])
	 *   .doUpdate({ name: 'Alice Updated' })
	 *   .execute();
	 *
	 * // Upsert with doNothing
	 * await orm.upsert('users')
	 *   .values({ id: 1, name: 'Alice' })
	 *   .onConflict(['id'])
	 *   .doNothing()
	 *   .execute();
	 *
	 * // With returning (requires PostgreSQL)
	 * const upserted = await orm.upsert('users')
	 *   .values({ id: 1, name: 'Alice' })
	 *   .onConflict(['id'])
	 *   .doUpdate()
	 *   .returning(['id', 'updated_at'])
	 *   .execute();
	 * ```
	 */
	upsert(table: string): UpsertBuilder;

	// =========================================================================
	// Transaction Methods (DX-025)
	// =========================================================================

	/**
	 * Execute a callback within a database transaction.
	 * Auto-commits on success, auto-rolls back on exception.
	 *
	 * This is a passthrough to Kysely's transaction API.
	 * The callback receives a transaction-scoped ORM instance.
	 *
	 * @typeParam T - The return type of the callback
	 * @param fn - Async callback that receives a transaction-scoped ORM instance
	 * @returns Promise resolving to the callback's return value
	 *
	 * @example
	 * ```typescript
	 * // Basic transaction
	 * const result = await orm.transaction(async (tx) => {
	 *   await tx.insert('orders').values({ userId: 1, total: 100 }).execute();
	 *   await tx.update('users').set({ balance: 0 }).where(eq('id', 1)).execute();
	 *   return { success: true };
	 * });
	 *
	 * // Multi-tenant transaction
	 * await orm.withSchema('schema_name').transaction(async (tx) => {
	 *   await tx.insert('events').values({ type: 'order_created' }).execute();
	 * });
	 *
	 * // Auto-rollback on exception
	 * try {
	 *   await orm.transaction(async (tx) => {
	 *     await tx.insert('orders').values({ userId: 1 }).execute();
	 *     throw new Error('Validation failed');
	 *     // Transaction is automatically rolled back
	 *   });
	 * } catch (err) {
	 *   // Handle error
	 * }
	 * ```
	 */
	transaction<T>(fn: (tx: OrmInstance<DB>) => Promise<T>): Promise<T>;

	// =========================================================================
	// Raw SQL Execution (DX-027)
	// =========================================================================

	// =========================================================================
	// NQL Template Literal API (DX-040 Block 8)
	// =========================================================================

	/**
	 * NQL template tag for writing queries in Natural Query Language.
	 *
	 * NQL provides a pipe-based syntax that compiles to the same IntentIR
	 * as the native query builder, ensuring both APIs produce identical
	 * execution plans and SQL.
	 *
	 * ⚠️  Type parameter `T` is required - NQL uses explicit type annotation
	 * since the query string cannot provide TypeScript inference.
	 *
	 * @typeParam T - The expected result row type
	 * @returns An NqlBuilder with .all(), .first(), .toIntentIR(), .plan(), .dump()
	 *
	 * @example
	 * ```typescript
	 * // Basic select with explicit type
	 * type UserRow = { id: string; name: string };
	 * const users = await orm.nql<UserRow>`users | select id, name`.all();
	 *
	 * // Filtering and ordering
	 * const activeUsers = await orm.nql<UserRow>`
	 *   users
	 *   | filter active = true
	 *   | sort name asc
	 *   | take 10
	 * `.all();
	 *
	 * // Debug: inspect the IntentIR
	 * const intent = orm.nql<UserRow>`users | select name`.toIntentIR();
	 * console.log(JSON.stringify(intent, null, 2));
	 *
	 * // Debug: get full dump (plan + SQL + params)
	 * const { plan, sql, params } = orm.nql<UserRow>`users | select name`.dump();
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
	 * The SQL string is NOT validated - ensure it's safe!
	 * Use parameter placeholders for any dynamic values.
	 * Note: Placeholder syntax varies by dialect ($1, $2 for PostgreSQL; ? for SQLite/MySQL).
	 *
	 * @typeParam T - Expected result type (defaults to unknown)
	 * @param sql - Raw SQL string with parameter placeholders
	 * @param parameters - Parameter values for placeholders
	 * @returns Promise resolving to array of results
	 *
	 * @example
	 * ```typescript
	 * // Simple query with parameters
	 * const users = await orm.raw<User>(
	 *   'SELECT * FROM users WHERE age > $1 AND status = $2',
	 *   [18, 'active']
	 * );
	 *
	 * // Complex analytics query not expressible via intents
	 * const stats = await orm.raw<{ month: Date; count: number }>(
	 *   `SELECT date_trunc('month', created_at) as month,
	 *           COUNT(*) as count
	 *    FROM orders
	 *    GROUP BY 1
	 *    ORDER BY 1 DESC`,
	 *   []
	 * );
	 *
	 * // Multi-tenant: raw() does NOT auto-prefix tables with schema.
	 * // You must include the schema name in your SQL manually:
	 * const products = await orm.withSchema('acme').raw<Product>(
	 *   'SELECT * FROM "acme"."products" WHERE inventory > $1',
	 *   [0]
	 * );
	 * ```
	 */
	raw<T = unknown>(sql: string, parameters?: readonly unknown[]): Promise<T[]>;
	/**
	 * Create a CTE (Common Table Expression) backed by unnest() arrays.
	 * Use .fromUnnest() to provide column data, .withIndex() to add an ordinality index,
	 * then .query() to attach an outer SELECT.
	 *
	 * @param name - The CTE name
	 * @returns A CteBuilder for constructing the CTE
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.withCte('lookups')
	 *   .fromUnnest({ id: [1, 2, 3], name: ['a', 'b', 'c'] })
	 *   .withIndex('idx')
	 *   .query(orm.select('symbols'))
	 *   .all();
	 * ```
	 */
	withCte(name: string): CteBuilder;
}

