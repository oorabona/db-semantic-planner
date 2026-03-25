/**
 * @fileoverview QueryBuilder interface and directly-related types.
 *
 * The QueryBuilder is the core chainable API for constructing SELECT queries.
 * It supports column selection, filtering, ordering, pagination, aggregation,
 * includes (relations), streaming, and execution.
 *
 * @module query-builder-types
 * @since R01
 */

import type { Dump } from '../adapter.js';
import type {
	JoinIntent,
	LockStrength,
	LockWaitPolicy,
	WhereIntent,
} from '../intent-ast.js';
import type { PlanOptions, PlanReport } from '../planner.js';
import type { ExpressionRef } from './expressions.js';
import type { DistinctField } from './filters.js';
import type { WhereFilter } from './object-filter.js';
import type {
	CursorPaginatedResult,
	CursorPaginateOptions,
	PaginatedResult,
	PaginateOptions,
	StreamOptions,
} from './pagination-types.js';
import type { SetOperationBuilder } from './set-operation-builder.js';
import type {
	AggregateOptions,
	AliasedExprColumn,
	ColumnSpec,
	ExpressionSpec,
	IncludeOptionsWithRecursive,
	OrderByRecord,
	OrderBySpec,
	SortDirection,
} from './types.js';

/**
 * Utility type for picking fields from an object type.
 * Used for type inference in select().
 */
export type SelectFields<TTable, K extends keyof TTable> = Pick<TTable, K>;

/**
 * Chainable query builder for constructing queries.
 *
 * @typeParam TResult - The inferred result type for execution methods.
 *   Defaults to `unknown` for backward compatibility.
 *   Can be narrowed by:
 *   - Providing explicit type: `orm.query<User>('users')`
 *   - Using typed select: `orm.select('users').select<User, 'id' | 'name'>(['id', 'name'])`
 *
 * @example
 * ```typescript
 * // Explicit table type
 * type User = { id: number; name: string; email: string };
 * const users = await orm.query<User>('users').all();
 * // users is User[]
 *
 * // With select narrowing
 * const partialUsers = await orm.query<User>('users')
 *   .select<User, 'id' | 'name'>(['id', 'name'])
 *   .all();
 * // partialUsers is Pick<User, 'id' | 'name'>[]
 * ```
 */
export interface QueryBuilder<TResult = unknown> {
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
	include(
		relation: string,
		options?: IncludeOptionsWithRecursive,
	): QueryBuilder<TResult>;

	/**
	 * Select specific columns from the root entity.
	 * Accepts both simple field names and expression specs (from coalesce(), raw(), etc.)
	 *
	 * The result type is preserved from the QueryBuilder generic parameter.
	 * Use explicit typing on select() for typed results:
	 * ```typescript
	 * type User = { id: number; name: string; email: string };
	 * const users = await orm.select<User>('users')
	 *   .columns(['id', 'name'])
	 *   .all();
	 * // users is User[]
	 * ```
	 *
	 * @param columns - Array of field names or expression specs
	 * @returns A new QueryBuilder with the column selection applied
	 *
	 * @example
	 * ```typescript
	 * import { coalesce, raw } from '@dbsp/core';
	 *
	 * // Simple fields
	 * orm.select('users').columns(['id', 'name']).all();
	 *
	 * // Mix of fields and expressions
	 * orm.select('products')
	 *   .columns([
	 *     'id',
	 *     'sku',
	 *     coalesce(['title_fr', 'title_en'], 'title')
	 *   ])
	 *   .all();
	 * // → SELECT id, sku, COALESCE(title_fr, title_en) AS title FROM products
	 * ```
	 */
	columns<K extends keyof TResult & string>(
		columns: readonly K[],
	): QueryBuilder<Pick<TResult, K>>;
	columns<
		const T extends readonly (
			| (keyof TResult & string)
			| AliasedExprColumn<string>
		)[],
	>(
		columns: T,
	): QueryBuilder<
		Pick<TResult, Extract<T[number], keyof TResult & string>> & {
			[E in Extract<
				T[number],
				AliasedExprColumn<string>
			> as E['__alias']]: E['__value'];
		}
	>;
	columns(columns: readonly ColumnSpec[]): QueryBuilder<TResult>;

	/**
	 * Add a COALESCE expression to the select, with full type inference.
	 *
	 * Returns the first non-null value from the specified fields.
	 * The result type is inferred as `NonNullable<TResult[K]>` where K is the union
	 * of the field types being coalesced.
	 *
	 * @typeParam K - Field names from TResult to coalesce
	 * @typeParam Alias - The alias for the result column (must be a string literal)
	 * @param fields - Array of field names to check (first non-null wins)
	 * @param as - Alias for the resulting column
	 * @returns A new QueryBuilder with the coalesced column added to TResult
	 *
	 * @example
	 * ```typescript
	 * // Basic coalesce - fallback from bio to name
	 * const users = await orm.select('users')
	 *   .columns(['id', 'email'])
	 *   .coalesce(['bio', 'name'], 'displayText')
	 *   .all();
	 * // Type: { id: number; email: string; displayText: string }[]
	 *
	 * // Chain multiple coalesces
	 * const products = await orm.select('products')
	 *   .columns(['id'])
	 *   .coalesce(['title_fr', 'title_en'], 'title')
	 *   .coalesce(['desc_fr', 'desc_en'], 'description')
	 *   .all();
	 * // Type: { id: number; title: string; description: string }[]
	 * ```
	 */
	coalesce<K extends keyof TResult & string, Alias extends string>(
		fields: readonly K[],
		as: Alias,
	): QueryBuilder<TResult & { [P in Alias]: NonNullable<TResult[K]> }>;

	/**
	 * Count rows, optionally counting a specific field.
	 * Supports DISTINCT counting via the distinct() helper.
	 *
	 * @param fieldOrOptions - Optional field, DistinctField, or options object
	 * @param as - Optional alias (when using field or DistinctField as first arg)
	 * @returns A new QueryBuilder configured for COUNT
	 *
	 * @example
	 * ```typescript
	 * import { distinct } from '@dbsp/core';
	 *
	 * // COUNT(*)
	 * orm.select('users').count().execute();
	 *
	 * // COUNT(email)
	 * orm.select('users').count('email').execute();
	 *
	 * // COUNT(email) AS email_count
	 * orm.select('users').count('email', 'email_count').execute();
	 *
	 * // COUNT(DISTINCT customerId)
	 * orm.select('orders').count(distinct('customerId')).execute();
	 *
	 * // COUNT(DISTINCT customerId) AS unique_customers
	 * orm.select('orders').count(distinct('customerId'), 'unique_customers').execute();
	 * ```
	 */
	count(options?: AggregateOptions): QueryBuilder<TResult>;
	count(field: string, as?: string): QueryBuilder<TResult>;
	count(field: DistinctField, as?: string): QueryBuilder<TResult>;

	/**
	 * Calculate sum of a field.
	 * Supports DISTINCT summing via the distinct() helper (rare but valid SQL).
	 *
	 * @param field - Field or DistinctField to sum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for SUM
	 *
	 * @example
	 * ```typescript
	 * orm.select('orders').sum('total', 'order_total').execute();
	 * orm.select('orders').sum(distinct('amount'), 'unique_total').execute();
	 * ```
	 */
	sum(field: string | DistinctField, as?: string): QueryBuilder<TResult>;

	/**
	 * Calculate average of a field.
	 * Supports DISTINCT averaging via the distinct() helper.
	 *
	 * @param field - Field or DistinctField to average
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for AVG
	 */
	avg(field: string | DistinctField, as?: string): QueryBuilder<TResult>;

	/**
	 * Find minimum value of a field.
	 *
	 * @param field - Field to find minimum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for MIN
	 */
	min(field: string, as?: string): QueryBuilder<TResult>;

	/**
	 * Find maximum value of a field.
	 *
	 * @param field - Field to find maximum
	 * @param as - Optional alias for result column
	 * @returns A new QueryBuilder configured for MAX
	 */
	max(field: string, as?: string): QueryBuilder<TResult>;

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
	 * orm.select('posts')
	 *   .count({ as: 'post_count' })
	 *   .groupBy(['authorId'])
	 *   .execute();
	 * ```
	 */
	groupBy(fields: readonly string[]): QueryBuilder<TResult>;

	/**
	 * Filter grouped results based on aggregate values.
	 * Applied after GROUP BY, similar to WHERE but for aggregates.
	 *
	 * @param condition - Filter condition (typically using aggregate comparisons)
	 * @returns A new QueryBuilder with HAVING applied
	 *
	 * @example
	 * ```typescript
	 * // Authors with more than 5 posts
	 * orm.select('posts')
	 *   .columns(['authorId'])
	 *   .count({ as: 'postCount' })
	 *   .groupBy(['authorId'])
	 *   .having(gt('postCount', 5))
	 *   .execute();
	 *
	 * // Categories with average price > 100
	 * orm.select('products')
	 *   .columns(['categoryId'])
	 *   .avg('price', 'avgPrice')
	 *   .groupBy(['categoryId'])
	 *   .having(gt('avgPrice', 100))
	 *   .execute();
	 * ```
	 */
	having(condition: WhereIntent): QueryBuilder<TResult>;

	/**
	 * Apply SELECT DISTINCT to deduplicate result rows.
	 *
	 * @returns A new QueryBuilder with DISTINCT applied
	 *
	 * @example
	 * ```typescript
	 * // Get unique author IDs
	 * orm.select('posts')
	 *   .distinct()
	 *   .columns(['authorId'])
	 *   .execute();
	 *
	 * // Unique combinations
	 * orm.select('orders')
	 *   .distinct()
	 *   .columns(['customerId', 'status'])
	 *   .execute();
	 * ```
	 */
	distinct(): QueryBuilder<TResult>;

	/**
	 * Apply PostgreSQL DISTINCT ON (...) to the query.
	 *
	 * @param columns - One or more column names to deduplicate on
	 * @returns A new QueryBuilder with DISTINCT ON applied
	 *
	 * @example
	 * ```typescript
	 * orm.select('users').distinctOn('department').all();
	 * // SQL: SELECT DISTINCT ON ("department") * FROM "users"
	 *
	 * orm.select('logs').distinctOn('user_id', 'action').all();
	 * // SQL: SELECT DISTINCT ON ("user_id", "action") * FROM "logs"
	 * ```
	 */
	distinctOn(...columns: string[]): QueryBuilder<TResult>;

	/**
	 * Acquire a FOR UPDATE lock on selected rows.
	 * Default wait policy is 'block' (wait for the lock).
	 *
	 * @example
	 * ```typescript
	 * // Job queue pattern: claim next pending job
	 * const job = await orm.select('jobs')
	 *   .where(eq('status', 'pending'))
	 *   .limit(1)
	 *   .forUpdate()
	 *   .skipLocked()
	 *   .first();
	 * ```
	 */
	forUpdate(): QueryBuilder<TResult>;

	/** Acquire a FOR SHARE lock on selected rows. */
	forShare(): QueryBuilder<TResult>;

	/** Acquire a FOR NO KEY UPDATE lock on selected rows. */
	forNoKeyUpdate(): QueryBuilder<TResult>;

	/** Acquire a FOR KEY SHARE lock on selected rows. */
	forKeyShare(): QueryBuilder<TResult>;

	/**
	 * Acquire a row-level lock with explicit strength and optional wait policy.
	 *
	 * @param strength - The lock strength
	 * @param waitPolicy - The wait policy (default: 'block')
	 */
	lock(
		strength: LockStrength,
		waitPolicy?: LockWaitPolicy,
	): QueryBuilder<TResult>;

	/**
	 * Set the wait policy to SKIP LOCKED.
	 * Must be called after a lock method (forUpdate, forShare, etc.).
	 *
	 * Rows that are already locked by other transactions are skipped
	 * instead of waiting. Essential for job queue patterns.
	 */
	skipLocked(): QueryBuilder<TResult>;

	/**
	 * Set the wait policy to NOWAIT.
	 * Must be called after a lock method (forUpdate, forShare, etc.).
	 *
	 * Throws an error immediately if any selected row is already locked
	 * by another transaction.
	 */
	noWait(): QueryBuilder<TResult>;

	/**
	 * Sort results by one or more fields.
	 *
	 * Supports multiple signatures for convenience:
	 * - Single field with optional direction: `.orderBy('name')` or `.orderBy('name', 'desc')`
	 * - Object form for multiple fields: `.orderBy({ created_at: 'desc', name: 'asc' })`
	 * - Array form for advanced options: `.orderBy([{ column: 'name', direction: 'desc', nulls: 'last' }])`
	 *
	 * @example
	 * ```typescript
	 * // Simple ascending sort (default)
	 * orm.select('users').orderBy('name').all();
	 *
	 * // Descending sort
	 * orm.select('users').orderBy('createdAt', 'desc').all();
	 *
	 * // Multiple fields (chained)
	 * orm.select('users')
	 *   .orderBy('lastName', 'asc')
	 *   .orderBy('firstName', 'asc')
	 *   .all();
	 *
	 * // Object form - multiple fields at once
	 * orm.select('users')
	 *   .orderBy({ created_at: 'desc', name: 'asc' })
	 *   .all();
	 *
	 * // Array form - advanced with nulls handling
	 * orm.select('users')
	 *   .orderBy([{ column: 'created_at', direction: 'desc', nulls: 'last' }])
	 *   .all();
	 * ```
	 */
	orderBy(
		field: string,
		direction?: SortDirection,
		options?: { nulls?: import('./types.js').NullsPosition },
	): QueryBuilder<TResult>;
	orderBy(fields: OrderByRecord): QueryBuilder<TResult>;
	orderBy(specs: readonly OrderBySpec[]): QueryBuilder<TResult>;
	orderBy(
		expr: ExpressionRef,
		direction?: SortDirection,
		options?: { nulls?: import('./types.js').NullsPosition },
	): QueryBuilder<TResult>;
	orderBy(
		expr: ExpressionSpec,
		direction?: SortDirection,
		options?: { nulls?: import('./types.js').NullsPosition },
	): QueryBuilder<TResult>;

	/**
	 * Limit the number of results returned.
	 *
	 * @param count - Maximum number of rows to return
	 * @returns A new QueryBuilder with the limit applied
	 *
	 * @example
	 * ```typescript
	 * // Get first 10 users
	 * orm.select('users').limit(10).all();
	 *
	 * // Pagination with limit and offset
	 * orm.select('users')
	 *   .orderBy('id')
	 *   .limit(20)
	 *   .offset(40)
	 *   .all();
	 * ```
	 */
	limit(count: number): QueryBuilder<TResult>;

	/**
	 * Skip a number of results (for pagination).
	 *
	 * @param count - Number of rows to skip
	 * @returns A new QueryBuilder with the offset applied
	 *
	 * @example
	 * ```typescript
	 * // Skip first 20 results
	 * orm.select('users').offset(20).all();
	 *
	 * // Pagination: page 3 with 10 items per page
	 * orm.select('users')
	 *   .orderBy('id')
	 *   .limit(10)
	 *   .offset(20)
	 *   .all();
	 * ```
	 */
	offset(count: number): QueryBuilder<TResult>;

	/**
	 * Filter the root entity records.
	 *
	 * Supports two syntax forms:
	 * 1. WhereIntent (from filter helpers): `where(eq('status', 'active'))`
	 * 2. Object filter (Prisma-like): `where({ status: 'active' })`
	 *
	 * Object filter syntax:
	 * - Simple equality: `{ status: 'active' }` → `eq('status', 'active')`
	 * - Operators: `{ age: { $gt: 18 } }` → `gt('age', 18)`
	 * - Multiple fields: `{ a: 1, b: 2 }` → `and(eq('a', 1), eq('b', 2))`
	 * - Null check: `{ deletedAt: null }` → `isNull('deletedAt')`
	 *
	 * @param condition - Where condition (WhereIntent or object filter)
	 * @returns A new QueryBuilder with the filter applied
	 *
	 * @example
	 * ```typescript
	 * // Using filter helpers (legacy)
	 * orm.select('users').where(eq('status', 'active'))
	 *
	 * // Using object syntax (new)
	 * orm.select('users').where({ status: 'active' })
	 *
	 * // With operators
	 * orm.select('users').where({ age: { $gte: 18, $lt: 65 } })
	 *
	 * // Multiple conditions (implicit AND)
	 * orm.select('users').where({ active: true, role: 'admin' })
	 * ```
	 */
	where(condition: WhereIntent | WhereFilter<TResult>): QueryBuilder<TResult>;

	/**
	 * Add an explicit SQL JOIN clause to the query (non-hydrating, flat result).
	 *
	 * Two modes based on whether `opts.on` is provided:
	 * - **Relation mode** (no `on`): FK auto-resolved from the model, like `include` but flat.
	 * - **Table mode** (`on` required): Explicit table + ON condition. Use `as` for self-joins.
	 *
	 * @param relationOrTable - Relation name (FK mode) or table name (explicit mode)
	 * @param opts - Optional join configuration
	 * @param opts.type - Join type: `'inner'` (default) or `'left'`
	 * @param opts.on - ON condition (required for table mode, absent for relation mode)
	 * @param opts.as - Alias for the joined table (required for self-joins)
	 * @returns A new QueryBuilder with the join appended
	 *
	 * @example
	 * ```typescript
	 * // Relation mode — FK auto-resolved
	 * orm.from(calls).join('caller')
	 * orm.from(calls).join('callerFile', { type: 'left' })
	 *
	 * // Table mode — explicit ON condition
	 * orm.from(embeddings).join('embeddings', {
	 *   on: lt(ref('embeddings.id'), ref('e2.id')),
	 *   as: 'e2',
	 *   type: 'inner',
	 * })
	 * ```
	 */
	join(
		relationOrTable: string,
		opts?: { type?: 'inner' | 'left'; on?: WhereIntent; as?: string },
	): QueryBuilder<TResult>;

	/**
	 * Override the ORM-level strict mode for this query.
	 *
	 * @param strict - true for strict mode, false for lenient mode
	 * @returns A new QueryBuilder with the strict mode override
	 *
	 * @example
	 * ```typescript
	 * // ORM is lenient by default, but this query is strict
	 * orm.select('users')
	 *   .withStrictMode(true)
	 *   .include('posts')
	 *   .plan();  // Throws if 'posts' is ambiguous
	 * ```
	 */
	withStrictMode(strict: boolean): QueryBuilder<TResult>;

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
	 * orm.select('users')
	 *   .withRelationHint('posts', 'authoredPosts')
	 *   .include('posts')  // Uses 'authoredPosts' relation
	 *   .plan();
	 * ```
	 */
	withRelationHint(target: string, relation: string): QueryBuilder<TResult>;

	/**
	 * Override plan options for this specific query.
	 * Merges with global planOptions from createOrm(), with per-query values taking precedence.
	 *
	 * @param options - Plan options to apply to this query
	 * @returns A new QueryBuilder with the plan options applied
	 *
	 * @example
	 * ```typescript
	 * orm.select('users')
	 *   .withPlanOptions({ defaultIncludeStrategy: 'subquery', maxIncludeDepth: 3 })
	 *   .include('posts')
	 *   .all();
	 * ```
	 */
	withPlanOptions(options: PlanOptions): QueryBuilder<TResult>;

	/**
	 * Disable default filters (e.g., soft delete) for this query.
	 * Use when you need to query deleted/inactive records.
	 *
	 * Default filters are defined at schema level using the `defaultFilters` option
	 * in `schema()`. They are applied automatically to all queries unless disabled.
	 *
	 * @returns A new QueryBuilder with default filters disabled
	 *
	 * @example
	 * ```typescript
	 * // Query all products including soft-deleted ones
	 * const allProducts = await orm
	 *   .select('products')
	 *   .withoutDefaultFilters()
	 *   .all();
	 * ```
	 */
	withoutDefaultFilters(): QueryBuilder<TResult>;

	/**
	 * Combine with another query using UNION (deduplicates rows).
	 *
	 * Both queries must select compatible columns.
	 *
	 * @param other - The query to union with
	 * @returns A SetOperationBuilder for further chaining or execution
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.select('employees')
	 *   .union(orm.select('contractors'))
	 *   .all();
	 * // SQL: (SELECT ...) UNION (SELECT ...)
	 * ```
	 */
	union(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/**
	 * Combine with another query using UNION ALL (keeps duplicate rows).
	 *
	 * @param other - The query to union with
	 * @returns A SetOperationBuilder for further chaining or execution
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.select('employees')
	 *   .unionAll(orm.select('contractors'))
	 *   .all();
	 * // SQL: (SELECT ...) UNION ALL (SELECT ...)
	 * ```
	 */
	unionAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/**
	 * Combine with another query using INTERSECT (rows present in both).
	 *
	 * @param other - The query to intersect with
	 * @returns A SetOperationBuilder for further chaining or execution
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.select('active_users')
	 *   .intersect(orm.select('verified_users'))
	 *   .all();
	 * // SQL: (SELECT ...) INTERSECT (SELECT ...)
	 * ```
	 */
	intersect(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/**
	 * Combine with another query using INTERSECT ALL (rows present in both, with duplicates).
	 *
	 * @param other - The query to intersect with
	 * @returns A SetOperationBuilder for further chaining or execution
	 */
	intersectAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/**
	 * Combine with another query using EXCEPT (rows in this query but not in other).
	 *
	 * @param other - The query to subtract
	 * @returns A SetOperationBuilder for further chaining or execution
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.select('all_users')
	 *   .except(orm.select('banned_users'))
	 *   .all();
	 * // SQL: (SELECT ...) EXCEPT (SELECT ...)
	 * ```
	 */
	except(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

	/**
	 * Combine with another query using EXCEPT ALL (rows in this query but not in other, with duplicates).
	 *
	 * @param other - The query to subtract
	 * @returns A SetOperationBuilder for further chaining or execution
	 */
	exceptAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult>;

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
	 * const dump = orm.select('products')
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
	 * Check whether any matching rows exist.
	 *
	 * Compiles to `SELECT EXISTS(SELECT 1 FROM ... WHERE ...)`.
	 * Strips `orderBy` and `include` (irrelevant for existence checks).
	 * Preserves `groupBy`, `having`, and `offset` (they affect the result set).
	 *
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to `true` if at least one row matches, `false` otherwise
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const hasActive = await orm.select('users')
	 *   .where(eq('active', true))
	 *   .exists();
	 * // → true | false
	 * ```
	 */
	exists(): Promise<boolean>;

	/**
	 * Get the SQL dump for an existence check without executing.
	 *
	 * Same as exists() but returns the Dump instead of executing the query.
	 *
	 * @returns The complete dump with plan, sql, params, and meta
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const dump = orm.select('users')
	 *   .where(eq('active', true))
	 *   .existsDump();
	 * // dump.sql → 'SELECT EXISTS(SELECT 1 FROM "users" AS "t0" WHERE ...)'
	 * ```
	 */
	existsDump(): Dump;

	/**
	 * Execute the query and return all matching rows.
	 *
	 * Semantic alias for all() - use for clearer intent in code.
	 * Requires `db` to be configured in createOrm() options.
	 *
	 * @returns Promise resolving to array of rows (may be empty)
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const products = await orm.select('products')
	 *   .where(eq('active', true))
	 *   .execute();
	 * ```
	 */
	execute(): Promise<TResult[]>;

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
	 * const users = await orm.select('users')
	 *   .where(eq('status', 'active'))
	 *   .all();
	 * ```
	 */
	all(): Promise<TResult[]>;

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
	 * const user = await orm.select('users')
	 *   .where(eq('id', 1))
	 *   .first();
	 * ```
	 */
	first(): Promise<TResult | undefined>;

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
	 * const user = await orm.select('users')
	 *   .where(eq('id', 1))
	 *   .firstOrThrow();
	 * ```
	 */
	firstOrThrow(): Promise<TResult>;

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
	 * for await (const user of orm.select('users').stream()) {
	 *   console.log(user.name);
	 *   if (shouldStop) break; // Connection released automatically
	 * }
	 * ```
	 */
	stream(options?: StreamOptions): AsyncIterableIterator<TResult>;

	/**
	 * Execute the query with offset-based pagination.
	 *
	 * Returns the data for the requested page along with pagination metadata.
	 * By default, includes a COUNT query to determine total pages.
	 *
	 * @param options - Pagination options (page, perPage, withCount)
	 * @returns Promise resolving to paginated result with data and metadata
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const result = await orm.select('users')
	 *   .where(eq('active', true))
	 *   .orderBy('created_at', 'desc')
	 *   .paginate({ page: 2, perPage: 20 });
	 *
	 * // result = {
	 * //   data: User[],
	 * //   pagination: { page: 2, perPage: 20, total: 100, totalPages: 5, hasNextPage: true, hasPrevPage: true }
	 * // }
	 * ```
	 */
	paginate(options?: PaginateOptions): Promise<PaginatedResult<TResult>>;

	/**
	 * Execute the query with cursor-based pagination.
	 *
	 * Returns the data along with cursors for navigating to next/previous pages.
	 * Requires an orderBy clause to ensure stable ordering.
	 *
	 * @param options - Cursor pagination options (cursor, limit, direction)
	 * @returns Promise resolving to cursor-paginated result
	 * @throws {ExecutionError} If db is not configured
	 * @throws {PlannerError} If no orderBy clause is specified
	 *
	 * @example
	 * ```typescript
	 * // First page
	 * const page1 = await orm.select('users')
	 *   .orderBy('id')
	 *   .cursorPaginate({ limit: 20 });
	 *
	 * // Next page
	 * const page2 = await orm.select('users')
	 *   .orderBy('id')
	 *   .cursorPaginate({ cursor: page1.nextCursor, limit: 20 });
	 * ```
	 */
	cursorPaginate(
		options?: CursorPaginateOptions,
	): Promise<CursorPaginatedResult<TResult>>;

	/**
	 * Find a single record by its primary key.
	 *
	 * Shortcut for `.where(eq('id', value)).first()` for simple PKs,
	 * or `.where(and(eq('a', 1), eq('b', 2))).first()` for composite PKs.
	 *
	 * @param value - Simple PK value (string | number) or composite PK object
	 * @returns Promise resolving to the record or undefined if not found
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * // Simple primary key
	 * const user = await orm.select('users').byId(42);
	 *
	 * // Composite primary key
	 * const orderLine = await orm.select('order_lines').byId({
	 *   orderId: 1,
	 *   productId: 42
	 * });
	 * ```
	 */
	byId(
		value: string | number | Record<string, unknown>,
	): Promise<TResult | undefined>;

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
	 * const user = await orm.select('users').byIdOrThrow(42);
	 * ```
	 */
	byIdOrThrow(
		value: string | number | Record<string, unknown>,
	): Promise<TResult>;

	/**
	 * Find multiple records by their primary keys.
	 *
	 * Shortcut for `.where(inArray('id', values)).all()`.
	 * Only supports simple (non-composite) primary keys.
	 *
	 * @param values - Array of primary key values
	 * @returns Promise resolving to array of records (may be empty)
	 * @throws {ExecutionError} If db is not configured
	 *
	 * @example
	 * ```typescript
	 * const users = await orm.select('users').byIds([1, 2, 3]);
	 * ```
	 */
	byIds(values: readonly (string | number)[]): Promise<TResult[]>;
}
