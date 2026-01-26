import type { Adapter, Dump } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type {
	ExpressionIntent,
	SelectIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { IncludeStrategy, ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import type { DistinctField } from './filters.js';
import type {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import type { WhereFilter } from './object-filter.js';
import type { GeneratedSchema, InferDBFromSchema } from './schema-bridge.js';

/**
 * A wrapper around an ExpressionIntent that marks it for use in columns().
 * The __expr marker allows runtime detection of expression vs string columns.
 *
 * Create these using helper functions like coalesce() or raw().
 */
export interface ExpressionSpec {
	readonly __expr: true;
	readonly intent: ExpressionIntent;
}

/**
 * A column specification - either a field name or an expression.
 *
 * @example
 * ```typescript
 * // Simple field
 * 'id'
 *
 * // Expression (via coalesce helper)
 * coalesce(['name_fr', 'name_en'], 'name')
 * ```
 */
export type ColumnSpec = string | ExpressionSpec;

/**
 * Type guard to check if a ColumnSpec is an ExpressionSpec.
 */
export function isExpressionSpec(spec: ColumnSpec): spec is ExpressionSpec {
	return (
		typeof spec === 'object' &&
		spec !== null &&
		'__expr' in spec &&
		spec.__expr === true
	);
}

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
 * Options for offset-based pagination.
 */
export interface PaginateOptions {
	/**
	 * Page number (1-indexed).
	 * @default 1
	 */
	readonly page?: number;

	/**
	 * Number of items per page.
	 * @default 20
	 */
	readonly perPage?: number;

	/**
	 * Whether to include total count (requires additional COUNT query).
	 * Set to false for better performance when total is not needed.
	 * @default true
	 */
	readonly withCount?: boolean;
}

/**
 * Result of offset-based pagination.
 */
export interface PaginatedResult<T> {
	/** The data for the current page */
	readonly data: T[];

	/** Pagination metadata */
	readonly pagination: {
		/** Current page number (1-indexed) */
		readonly page: number;

		/** Items per page */
		readonly perPage: number;

		/** Total number of items (only if withCount: true) */
		readonly total?: number;

		/** Total number of pages (only if withCount: true) */
		readonly totalPages?: number;

		/** Whether there is a next page */
		readonly hasNextPage: boolean;

		/** Whether there is a previous page */
		readonly hasPrevPage: boolean;
	};
}

/**
 * Options for cursor-based pagination.
 */
export interface CursorPaginateOptions {
	/**
	 * Cursor pointing to the last item of the previous page.
	 * Pass undefined/null for the first page.
	 */
	readonly cursor?: string | null;

	/**
	 * Number of items to fetch.
	 * @default 20
	 */
	readonly limit?: number;

	/**
	 * Direction of pagination.
	 * - 'forward': fetch items after cursor (default)
	 * - 'backward': fetch items before cursor
	 * @default 'forward'
	 */
	readonly direction?: 'forward' | 'backward';
}

/**
 * Result of cursor-based pagination.
 */
export interface CursorPaginatedResult<T> {
	/** The data for the current page */
	readonly data: T[];

	/** Cursor for the next page (null if no more items) */
	readonly nextCursor: string | null;

	/** Cursor for the previous page (null if at the beginning) */
	readonly prevCursor: string | null;

	/** Whether there are more items after this page */
	readonly hasNextPage: boolean;

	/** Whether there are items before this page */
	readonly hasPrevPage: boolean;
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

// ============================================================================
// OrderBy Shorthand Types (DX-024)
// ============================================================================

/**
 * Sort direction for orderBy (re-exported from @dbsp/types).
 */
import type { SortDirection } from '@dbsp/types';

export type { SortDirection } from '@dbsp/types';

/**
 * Where to place NULL values in sort order.
 */
export type NullsPosition = 'first' | 'last';

/**
 * Object form for orderBy - map of field to direction.
 *
 * @example
 * ```typescript
 * { created_at: 'desc', name: 'asc' }
 * ```
 */
export type OrderByRecord = Readonly<Record<string, SortDirection>>;

/**
 * Advanced orderBy specification with nulls handling.
 *
 * @example
 * ```typescript
 * { column: 'created_at', direction: 'desc', nulls: 'last' }
 * ```
 */
export interface OrderBySpec {
	readonly column: string;
	readonly direction?: SortDirection;
	readonly nulls?: NullsPosition;
}

/**
 * All valid orderBy input types.
 */
export type OrderByInput =
	| string // Simple: 'field'
	| OrderByRecord // Object: { field: 'desc' }
	| readonly OrderBySpec[]; // Array: [{ column, direction, nulls }]

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
	/**
	 * Default include strategy for relations when set to 'auto'.
	 * - 'join': Use JOIN (single query, database optimizes) - DEFAULT
	 * - 'separate': Use separate queries (N+1 style with batching)
	 * - 'cte': Use CTE (Common Table Expression)
	 * - 'lateral': Use LATERAL JOIN (PostgreSQL)
	 * - 'json_agg': Use JSON aggregation (PostgreSQL)
	 * - 'auto': Let planner decide based on relation type
	 */
	readonly defaultIncludeStrategy?: IncludeStrategy;
	/**
	 * Dialect capabilities for strategy selection.
	 * When provided, the planner uses these to select optimal strategies:
	 * - supportsJsonAgg: Enables json_agg for to-many relations
	 * - supportsLateralJoin: Enables LATERAL for per-row limits
	 * - supportsRecursiveCTE: Enables WITH RECURSIVE for tree traversal
	 */
	readonly dialectCapabilities?: DialectCapabilities;
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
 * Options for recursive include traversal on self-referential relations.
 *
 * @example
 * ```typescript
 * // Traverse ancestors (nested format)
 * query('categories').where(eq('id', 5)).include('parent', {
 *   recursive: true,
 *   direction: 'ancestors'
 * })
 *
 * // Traverse descendants (flat format with depth)
 * query('categories').where(eq('id', 1)).include('children', {
 *   recursive: true,
 *   direction: 'descendants',
 *   flat: true,
 *   maxDepth: 10
 * })
 * ```
 */
export interface RecursiveIncludeOptions extends IncludeOptions {
	/**
	 * Enable recursive CTE traversal.
	 * MUST be `true` when using recursive options.
	 */
	readonly recursive: true;

	/**
	 * Direction of traversal.
	 * - 'ancestors': Traverse up the hierarchy (parent → grandparent → ...)
	 * - 'descendants': Traverse down the hierarchy (children → grandchildren → ...)
	 *
	 * REQUIRED when `recursive: true`.
	 */
	readonly direction: 'ancestors' | 'descendants';

	/**
	 * Output format.
	 * - false (default): Nested object structure (parent: { parent: { ... } })
	 * - true: Flat array with depth field ([{ id: 2, depth: 1 }, { id: 1, depth: 2 }])
	 *
	 * When flat=true, property is renamed: parent → ancestors, children → descendants
	 */
	readonly flat?: boolean;

	/**
	 * Exclude the source node from results.
	 * @default false
	 */
	readonly omitSelf?: boolean;

	/**
	 * Maximum traversal depth.
	 * @default 100 (safety limit)
	 */
	readonly maxDepth?: number;

	/**
	 * Include depth column in results.
	 * Automatically true when flat=true.
	 */
	readonly includeDepth?: boolean;
}

/**
 * Union type for include options: regular or recursive.
 */
export type IncludeOptionsWithRecursive =
	| IncludeOptions
	| RecursiveIncludeOptions;

/**
 * Type guard to check if include options are recursive.
 */
export function isRecursiveIncludeOptions(
	options: IncludeOptionsWithRecursive | undefined,
): options is RecursiveIncludeOptions {
	return (
		options !== undefined &&
		'recursive' in options &&
		options.recursive === true
	);
}

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
	orderBy(field: string, direction?: SortDirection): QueryBuilder<TResult>;
	orderBy(fields: OrderByRecord): QueryBuilder<TResult>;
	orderBy(specs: readonly OrderBySpec[]): QueryBuilder<TResult>;

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
 * Options for listAncestors/listDescendants methods (DX-022).
 * These methods execute immediately and return flat arrays.
 */
export interface ListHierarchyOptions {
	/**
	 * The column that references the parent node (for adjacency list pattern).
	 * This is used to auto-detect the self-referential relation.
	 * @example 'parentCategoryId', 'parentId', 'managerId'
	 */
	readonly parentId: string;

	/**
	 * The column that identifies a node (default: 'id').
	 */
	readonly nodeId?: string;

	/**
	 * Maximum depth to traverse (default: 100).
	 */
	readonly maxDepth?: number;
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
	 * Start building a SELECT query from a table.
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
