import type { Dump } from '@db-semantic-planner/adapter-kysely';
import type {
	ExpressionIntent,
	ModelIR,
	PlanReport,
	SelectIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import type { Kysely } from 'kysely';
import type {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
} from './mutation-builders.js';
import type { RecursiveQueryBuilder } from './recursive-query-builder.js';

/**
 * Options for streaming query execution.
 * Re-exports from adapter-kysely for convenience.
 */
export interface StreamOptions {
	/**
	 * Number of rows to fetch per batch from the database.
	 * Only affects PostgreSQL with pg-cursor configured.
	 * @default 100
	 */
	readonly chunkSize?: number;

	/**
	 * Callback invoked before streaming starts.
	 * Receives the query dump for observability/logging.
	 */
	readonly onStart?: (dump: Dump) => void;
}

/**
 * Options for aggregate functions.
 */
export interface AggregateOptions {
	/**
	 * Field to aggregate (required for SUM, AVG, MIN, MAX; optional for COUNT).
	 */
	readonly field?: string;
	/**
	 * Alias for the result column.
	 */
	readonly as?: string;
}

/**
 * Mapping of target table to preferred relation name.
 * Used to resolve ambiguous relations automatically.
 *
 * @example
 * ```typescript
 * const hints: RelationHints = {
 *   posts: 'authoredPosts',  // When including 'posts', use 'authoredPosts' relation
 * };
 * ```
 */
export type RelationHints = Readonly<Record<string, string>>;

/**
 * Configuration options for creating an ORM instance.
 *
 * Either `model` or `db` must be provided:
 * - With `model`: Uses the provided schema (sync)
 * - With `db` only: Auto-discovers schema via introspection (async)
 *
 * @example Zero-config (auto-introspection)
 * ```typescript
 * const orm = await createOrm({ db });
 * const users = await orm.query('users').findMany();
 * ```
 *
 * @example Explicit model
 * ```typescript
 * const orm = createOrm({ model, db });
 * const users = await orm.query('users').findMany();
 * ```
 */
export interface OrmOptions {
	/**
	 * The schema model to use for query planning.
	 * If not provided and `db` is set, the schema will be auto-discovered
	 * via database introspection.
	 */
	readonly model?: ModelIR;

	/**
	 * Controls behavior when ambiguous relations are detected.
	 *
	 * - `true` (strict mode): Throws `AmbiguousRelationError` on ambiguous relations
	 * - `false` (lenient mode): Uses first relation and records warning in plan
	 *
	 * @default false
	 */
	readonly strictMode?: boolean;

	/**
	 * Global relation hints for disambiguating relations.
	 * Maps target table names to preferred relation names.
	 *
	 * @example
	 * ```typescript
	 * const orm = createOrm({
	 *   model: schema,
	 *   relationHints: {
	 *     posts: 'authoredPosts',  // Always use 'authoredPosts' for 'posts' target
	 *   },
	 * });
	 * ```
	 */
	readonly relationHints?: RelationHints;

	/**
	 * Kysely database instance for query execution.
	 * Required for findMany(), findFirst(), findFirstOrThrow() methods.
	 * Also required for auto-introspection when `model` is not provided.
	 *
	 * @example
	 * ```typescript
	 * const db = new Kysely<Database>({ dialect: ... });
	 * const orm = createOrm({
	 *   model: schema,
	 *   db,  // Enable query execution
	 * });
	 * await orm.query('users').findMany();
	 * ```
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	readonly db?: Kysely<any>;
}

/**
 * OrmOptions with explicit model (sync creation).
 */
export interface OrmOptionsWithModel extends OrmOptions {
	readonly model: ModelIR;
}

/**
 * OrmOptions without model, requires db for auto-introspection (async creation).
 */
export interface OrmOptionsWithDb extends Omit<OrmOptions, 'model'> {
	readonly model?: undefined;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	readonly db: Kysely<any>;
}

/**
 * Options for the include() method on QueryBuilder.
 * Maps to IncludeIntent fields with developer-friendly naming.
 */
export interface IncludeOptions {
	/**
	 * Explicit relation name for disambiguation.
	 * Use when multiple relations exist between same tables.
	 *
	 * @example
	 * ```typescript
	 * // User has authoredPosts and reviewedPosts relations to Post
	 * query('users').include('posts', { via: 'authoredPosts' })
	 * ```
	 */
	readonly via?: string;

	/**
	 * Filter conditions on related records.
	 */
	readonly where?: WhereIntent;

	/**
	 * What columns to select from related records.
	 */
	readonly select?: SelectIntent;

	/**
	 * Nested includes for deep loading.
	 */
	readonly include?: readonly NestedInclude[];
}

/**
 * Chainable query builder for constructing queries.
 */
export interface QueryBuilder {
	/**
	 * Include a related entity in the query results.
	 *
	 * Supports dot notation for nested includes:
	 * - `'posts'` - include posts
	 * - `'posts.comments'` - include posts and their comments
	 * - `'posts.comments.author'` - include posts, their comments, and comment authors
	 *
	 * @param relation - The relation name (dot notation for nested)
	 * @param options - Optional configuration for the include
	 * @returns A new QueryBuilder with the include added
	 *
	 * @example
	 * ```typescript
	 * query('users')
	 *   .include('posts')  // Simple include
	 *   .include('posts.comments.author')  // Dot notation for nested
	 *   .include('profile', { select: { fields: ['bio'] } })  // With options
	 *   .include('posts', { via: 'authoredPosts' })  // Disambiguated
	 * ```
	 */
	include(relation: string, options?: IncludeOptions): QueryBuilder;

	/**
	 * Select specific fields from the root entity.
	 *
	 * @param fields - Array of field names to select
	 * @returns A new QueryBuilder with the selection applied
	 */
	select(fields: readonly string[]): QueryBuilder;

	/**
	 * Select fields with computed expressions (COALESCE, raw SQL, etc.)
	 *
	 * @param fields - Array of regular field names to select
	 * @param expressions - Array of expression intents (from coalesce(), raw(), etc.)
	 * @returns A new QueryBuilder with the selection applied
	 *
	 * @example
	 * ```typescript
	 * import { coalesce, raw } from '@db-semantic-planner/dx';
	 *
	 * // Locale fallback pattern
	 * orm.query('products')
	 *   .selectWithExpressions(
	 *     ['id', 'sku'],
	 *     [coalesce(['title_fr', 'title_en'], 'title')]
	 *   )
	 *   .findMany();
	 * // → SELECT id, sku, COALESCE(title_fr, title_en) AS title FROM products
	 *
	 * // Computed expression
	 * orm.query('orders')
	 *   .selectWithExpressions(
	 *     ['id'],
	 *     [raw('price_cents / 100.0', 'price_dollars')]
	 *   )
	 *   .findMany();
	 * ```
	 */
	selectWithExpressions(
		fields: readonly string[],
		expressions: readonly ExpressionIntent[],
	): QueryBuilder;

	/**
	 * Count rows, optionally counting a specific field.
	 *
	 * @param options - Optional field to count and alias
	 * @returns A new QueryBuilder configured for COUNT
	 *
	 * @example
	 * ```typescript
	 * // COUNT(*)
	 * orm.query('users').count().execute();
	 *
	 * // COUNT(email) AS email_count
	 * orm.query('users').count({ field: 'email', as: 'email_count' }).execute();
	 * ```
	 */
	count(options?: AggregateOptions): QueryBuilder;

	/**
	 * Calculate sum of a field.
	 *
	 * @param field - Field to sum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for SUM
	 *
	 * @example
	 * ```typescript
	 * orm.query('orders').sum('total', 'order_total').execute();
	 * ```
	 */
	sum(field: string, as?: string): QueryBuilder;

	/**
	 * Calculate average of a field.
	 *
	 * @param field - Field to average
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for AVG
	 */
	avg(field: string, as?: string): QueryBuilder;

	/**
	 * Find minimum value of a field.
	 *
	 * @param field - Field to find minimum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for MIN
	 */
	min(field: string, as?: string): QueryBuilder;

	/**
	 * Find maximum value of a field.
	 *
	 * @param field - Field to find maximum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for MAX
	 */
	max(field: string, as?: string): QueryBuilder;

	/**
	 * Group results by specified fields.
	 * Used with aggregate functions like count(), sum(), etc.
	 *
	 * @param fields - Fields to group by
	 * @returns A new QueryBuilder with GROUP BY applied
	 *
	 * @example
	 * ```typescript
	 * // Count posts per author
	 * orm.query('posts')
	 *   .count({ as: 'post_count' })
	 *   .groupBy(['authorId'])
	 *   .execute();
	 * ```
	 */
	groupBy(fields: readonly string[]): QueryBuilder;

	/**
	 * Sort results by one or more fields.
	 *
	 * @param field - Field name to sort by
	 * @param direction - Sort direction ('asc' or 'desc'), defaults to 'asc'
	 * @returns A new QueryBuilder with the sort applied
	 *
	 * @example
	 * ```typescript
	 * // Simple ascending sort
	 * orm.query('users').orderBy('name').findMany();
	 *
	 * // Descending sort
	 * orm.query('users').orderBy('createdAt', 'desc').findMany();
	 *
	 * // Multiple sorts (chained)
	 * orm.query('users')
	 *   .orderBy('lastName', 'asc')
	 *   .orderBy('firstName', 'asc')
	 *   .findMany();
	 * ```
	 */
	orderBy(field: string, direction?: 'asc' | 'desc'): QueryBuilder;

	/**
	 * Limit the number of results returned.
	 *
	 * @param count - Maximum number of rows to return
	 * @returns A new QueryBuilder with the limit applied
	 *
	 * @example
	 * ```typescript
	 * // Get first 10 users
	 * orm.query('users').limit(10).findMany();
	 *
	 * // Pagination with limit and offset
	 * orm.query('users')
	 *   .orderBy('id')
	 *   .limit(20)
	 *   .offset(40)
	 *   .findMany();
	 * ```
	 */
	limit(count: number): QueryBuilder;

	/**
	 * Skip a number of results (for pagination).
	 *
	 * @param count - Number of rows to skip
	 * @returns A new QueryBuilder with the offset applied
	 *
	 * @example
	 * ```typescript
	 * // Skip first 20 results
	 * orm.query('users').offset(20).findMany();
	 *
	 * // Pagination: page 3 with 10 items per page
	 * orm.query('users')
	 *   .orderBy('id')
	 *   .limit(10)
	 *   .offset(20)
	 *   .findMany();
	 * ```
	 */
	offset(count: number): QueryBuilder;

	/**
	 * Filter the root entity records.
	 *
	 * @param condition - Where condition to apply
	 * @returns A new QueryBuilder with the filter applied
	 */
	where(condition: WhereIntent): QueryBuilder;

	/**
	 * Override the ORM-level strict mode for this query.
	 *
	 * @param strict - true for strict mode, false for lenient mode
	 * @returns A new QueryBuilder with the strict mode override
	 *
	 * @example
	 * ```typescript
	 * // ORM is lenient by default, but this query is strict
	 * orm.query('users')
	 *   .withStrictMode(true)
	 *   .include('posts')
	 *   .plan();  // Throws if 'posts' is ambiguous
	 * ```
	 */
	withStrictMode(strict: boolean): QueryBuilder;

	/**
	 * Set a relation hint for this query.
	 * When including the target table, use the specified relation.
	 *
	 * @param target - The target table name
	 * @param relation - The relation name to use
	 * @returns A new QueryBuilder with the hint added
	 *
	 * @example
	 * ```typescript
	 * orm.query('users')
	 *   .withRelationHint('posts', 'authoredPosts')
	 *   .include('posts')  // Uses 'authoredPosts' relation
	 *   .plan();
	 * ```
	 */
	withRelationHint(target: string, relation: string): QueryBuilder;

	/**
	 * Generate the execution plan for this query.
	 *
	 * In strict mode, throws `AmbiguousRelationError` if ambiguous relations are detected.
	 * In lenient mode, resolves ambiguity using first relation and adds warning to plan.
	 *
	 * @returns The plan report with decisions, warnings, and query intent
	 * @throws {AmbiguousRelationError} In strict mode when relation is ambiguous
	 */
	plan(): PlanReport;

	/**
	 * Get the complete dump for this query including plan, SQL, and parameters.
	 *
	 * Provides full observability without executing the query.
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns The complete dump with plan, sql, params, and meta
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const dump = orm.query('products')
	 *   .where(eq('active', true))
	 *   .dump();
	 *
	 * console.log(dump.sql);       // SELECT * FROM products WHERE active = $1
	 * console.log(dump.params);    // [true]
	 * console.log(dump.plan);      // { rootTable: 'products', decisions: [...] }
	 * console.log(dump.meta);      // { tenant: 'acme', compiledAt: Date }
	 * ```
	 */
	dump(): Dump;

	/**
	 * Execute the query and return all matching rows.
	 *
	 * Semantic alias for findMany() - use for clearer intent in code.
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to array of rows (may be empty)
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const products = await orm.query('products')
	 *   .where(eq('active', true))
	 *   .execute();
	 * ```
	 */
	execute(): Promise<unknown[]>;

	/**
	 * Execute the query and return all matching rows.
	 *
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to array of rows (may be empty)
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const users = await orm.query('users')
	 *   .where(eq('status', 'active'))
	 *   .findMany();
	 * ```
	 */
	findMany(): Promise<unknown[]>;

	/**
	 * Execute the query and return the first matching row.
	 *
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to first row or undefined if none
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const user = await orm.query('users')
	 *   .where(eq('id', 1))
	 *   .findFirst();
	 * ```
	 */
	findFirst(): Promise<unknown | undefined>;

	/**
	 * Execute the query and return the first matching row, or throw if none.
	 *
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to first row
	 * @throws {NotFoundError} If no rows match
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const user = await orm.query('users')
	 *   .where(eq('id', 1))
	 *   .findFirstOrThrow();
	 * ```
	 */
	findFirstOrThrow(): Promise<unknown>;

	/**
	 * Execute the query and stream results row by row.
	 *
	 * Requires PostgreSQL with pg-cursor installed.
	 * Breaking out of the loop early releases the connection.
	 *
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @param options - Stream options (chunkSize, onStart callback)
	 * @returns AsyncIterableIterator for row-by-row iteration
	 * @throws {ExecutionError} If db is not configured
	 * @throws {MissingDependencyError} If pg-cursor not installed
	 * @throws {UnsupportedOperationError} If streaming not supported by dialect
	 *
	 * @example
	 * ```typescript
	 * for await (const user of orm.query('users').stream()) {
	 *   console.log(user.name);
	 *   if (shouldStop) break; // Connection released automatically
	 * }
	 * ```
	 */
	stream(options?: StreamOptions): AsyncIterableIterator<unknown>;

	/**
	 * Find a single record by its primary key.
	 *
	 * Shortcut for `.where(eq('id', value)).findFirst()` for simple PKs,
	 * or `.where(and(eq('a', 1), eq('b', 2))).findFirst()` for composite PKs.
	 *
	 * @param value - Simple PK value (string | number) or composite PK object
	 * @returns Promise resolving to the record or undefined if not found
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * // Simple primary key
	 * const user = await orm.query('users').byId(42);
	 *
	 * // Composite primary key
	 * const orderLine = await orm.query('order_lines').byId({
	 *   orderId: 1,
	 *   productId: 42
	 * });
	 * ```
	 */
	byId(
		value: string | number | Record<string, unknown>,
	): Promise<unknown | undefined>;

	/**
	 * Find a single record by its primary key, or throw if not found.
	 *
	 * @param value - Simple PK value (string | number) or composite PK object
	 * @returns Promise resolving to the record
	 * @throws {NotFoundError} If no record found
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const user = await orm.query('users').byIdOrThrow(42);
	 * ```
	 */
	byIdOrThrow(
		value: string | number | Record<string, unknown>,
	): Promise<unknown>;

	/**
	 * Find multiple records by their primary keys.
	 *
	 * Shortcut for `.where(inArray('id', values)).findMany()`.
	 * Only supports simple (non-composite) primary keys.
	 *
	 * @param values - Array of primary key values
	 * @returns Promise resolving to array of records (may be empty)
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const users = await orm.query('users').byIds([1, 2, 3]);
	 * ```
	 */
	byIds(values: readonly (string | number)[]): Promise<unknown[]>;
}

/**
 * Options for hierarchy traversal shortcuts (ancestors, descendants, subtree).
 */
export interface HierarchyOptions {
	/**
	 * The column that references the parent node (for adjacency list pattern).
	 * @example 'parentCategoryId', 'parentId', 'managerId'
	 */
	readonly parentId: string;

	/**
	 * The column that identifies a node (default: 'id').
	 */
	readonly nodeId?: string;

	/**
	 * Optional CTE name (default: auto-generated based on table name).
	 */
	readonly cteName?: string;
}

/**
 * ORM instance created by createOrm().
 */
export interface OrmInstance {
	/**
	 * Start building a query from a table.
	 *
	 * @param from - The root table name to query
	 * @returns A QueryBuilder for constructing the query
	 *
	 * @example
	 * ```typescript
	 * const users = orm.query('users')
	 *   .include('posts')
	 *   .where({ field: 'active', op: '=', value: true })
	 *   .plan();
	 * ```
	 */
	query(from: string): QueryBuilder;

	/**
	 * The strict mode setting for this ORM instance.
	 */
	readonly strictMode: boolean;

	/**
	 * Create a tenant-scoped ORM instance.
	 * All queries from the returned instance will include the schema prefix.
	 *
	 * @param schemaName - The tenant schema name
	 * @returns A new ORM instance scoped to the tenant
	 *
	 * @example
	 * ```typescript
	 * const tenantOrm = orm.forTenant('tenant_123');
	 * const users = await tenantOrm.query('users').findMany();
	 * // SQL: SELECT * FROM tenant_123.users
	 * ```
	 */
	forTenant(schemaName: string): OrmInstance;

	/**
	 * Start building a recursive CTE query.
	 *
	 * @param cteName - Name for the recursive CTE
	 * @returns A RecursiveQueryBuilder for constructing the recursive query
	 *
	 * @example
	 * ```typescript
	 * const permissions = await orm
	 *   .recursive('role_tree')
	 *   .from('roles')
	 *   .where(eq('id', 1))
	 *   .nodeId('id')
	 *   .traverseVia('roleEdges', { from: 'parentRoleId', to: 'childRoleId' })
	 *   .maxDepth(10)
	 *   .join('rolePermissions', 'id', 'roleId')
	 *   .distinct()
	 *   .execute();
	 * ```
	 */
	recursive<TResult = unknown>(cteName: string): RecursiveQueryBuilder<TResult>;

	/**
	 * Get ancestors of a node in a hierarchy (traverses UP the tree).
	 * Shortcut for recursive query with adjacency traversal in 'ancestors' direction.
	 *
	 * @param table - The hierarchical table name
	 * @param nodeIdValue - The ID of the starting node
	 * @param options - Hierarchy traversal options
	 * @returns A RecursiveQueryBuilder configured for ancestor traversal
	 *
	 * @example
	 * ```typescript
	 * // Get all ancestor categories of category 42
	 * const ancestors = await orm
	 *   .ancestors('categories', 42, { parentId: 'parentCategoryId' })
	 *   .upToDepth(10)
	 *   .execute();
	 * ```
	 */
	ancestors<TResult = unknown>(
		table: string,
		nodeIdValue: unknown,
		options: HierarchyOptions,
	): RecursiveQueryBuilder<TResult>;

	/**
	 * Get descendants of a node in a hierarchy (traverses DOWN the tree).
	 * Shortcut for recursive query with adjacency traversal in 'descendants' direction.
	 *
	 * @param table - The hierarchical table name
	 * @param nodeIdValue - The ID of the starting node
	 * @param options - Hierarchy traversal options
	 * @returns A RecursiveQueryBuilder configured for descendant traversal
	 *
	 * @example
	 * ```typescript
	 * // Get all descendant categories of category 1 (root)
	 * const descendants = await orm
	 *   .descendants('categories', 1, { parentId: 'parentCategoryId' })
	 *   .upToDepth(5)
	 *   .execute();
	 * ```
	 */
	descendants<TResult = unknown>(
		table: string,
		nodeIdValue: unknown,
		options: HierarchyOptions,
	): RecursiveQueryBuilder<TResult>;

	/**
	 * Get the entire subtree rooted at a node (the node + all descendants).
	 * Shortcut for recursive query that includes the starting node and all descendants.
	 *
	 * @param table - The hierarchical table name
	 * @param nodeIdValue - The ID of the root node
	 * @param options - Hierarchy traversal options
	 * @returns A RecursiveQueryBuilder configured for subtree traversal
	 *
	 * @example
	 * ```typescript
	 * // Get entire category subtree starting from category 5
	 * const subtree = await orm
	 *   .subtree('categories', 5, { parentId: 'parentCategoryId' })
	 *   .upToDepth(10)
	 *   .execute();
	 * ```
	 */
	subtree<TResult = unknown>(
		table: string,
		nodeIdValue: unknown,
		options: HierarchyOptions,
	): RecursiveQueryBuilder<TResult>;

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
}

/**
 * Include with relation name for nested includes.
 * Used when building nested include hierarchies.
 */
export interface NestedInclude extends IncludeOptions {
	/**
	 * The relation name or target table for this nested include.
	 */
	readonly relation: string;
}
