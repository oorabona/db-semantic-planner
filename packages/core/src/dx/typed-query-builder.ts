/**
 * DX-110: Type-Safe Query Builder
 *
 * This module provides a type-safe query builder that integrates with
 * TypedSchema and provides Prisma-like conditional type inference.
 *
 * Key features:
 * - Table name autocomplete from schema
 * - Relation name autocomplete in include()
 * - Result type automatically includes relations based on include() calls
 */

import type { WhereIntent } from '../intent-ast.js';
import type { DistinctField } from './filters.js';
import type {
	IncludeSpec,
	InferQueryResult,
	InferRelationNames,
	TableNames,
	TypedSchema,
} from './prisma-types.js';
import type {
	AggregateOptions,
	ColumnSpec,
	CursorPaginatedResult,
	CursorPaginateOptions,
	IncludeOptionsWithRecursive,
	NullsPosition,
	OrderByInput,
	PaginatedResult,
	PaginateOptions,
	SortDirection,
	StreamOptions,
} from './types.js';

// ============================================================================
// Type-Safe Include State Tracking
// ============================================================================

/**
 * Represents the current state of includes in a query builder.
 * This tracks which relations have been included and their nested includes.
 */
export type IncludeState<
	S extends TypedSchema,
	T extends TableNames<S>,
> = IncludeSpec<S, T>;

/**
 * Merge a new include into the existing include state.
 * Used when chaining .include() calls.
 */
export type MergeInclude<
	S extends TypedSchema,
	T extends TableNames<S>,
	Current,
	NewRel extends InferRelationNames<S['tables'][T]>,
	NewOpts = true,
> = Current extends Record<string, unknown>
	? Current & { [K in NewRel]: NewOpts }
	: { [K in NewRel]: NewOpts };

// ============================================================================
// Type-Safe Query Builder Interface
// ============================================================================

/**
 * Type-safe query builder with Prisma-like inference.
 *
 * @typeParam S - The TypedSchema definition
 * @typeParam T - The table name being queried
 * @typeParam I - The current include state (tracks which relations are included)
 *
 * @example
 * ```typescript
 * const schema = {
 *   tables: {
 *     users: {
 *       columns: { id: { type: 'uuid' }, name: { type: 'string' } },
 *       relations: { posts: hasMany('posts', { foreignKey: 'authorId' }) }
 *     },
 *     posts: {
 *       columns: { id: { type: 'uuid' }, title: { type: 'string' }, authorId: { type: 'uuid' } },
 *       relations: { author: belongsTo('users', { foreignKey: 'authorId' }) }
 *     }
 *   }
 * } as const satisfies TypedSchema;
 *
 * const orm = createTypedOrm({ schema, adapter });
 *
 * // Result type is automatically inferred:
 * const users = await orm.select('users').include('posts').all();
 * // users: { id: string; name: string; posts: { id: string; title: string; authorId: string }[] }[]
 * ```
 */
export interface TypedQueryBuilder<
	S extends TypedSchema,
	T extends TableNames<S>,
	// I tracks include state for type inference. Relaxed constraint allows nested include merging.
	I = undefined,
> {
	// ========================================================================
	// Include Methods (Type-Safe)
	// ========================================================================

	/**
	 * Include a related entity in the query results.
	 * The relation name is constrained to valid relations for this table.
	 *
	 * @typeParam R - The relation name (autocompleted from schema)
	 * @param relation - The relation to include
	 * @returns A new TypedQueryBuilder with the include tracked in the type
	 *
	 * @example
	 * ```typescript
	 * // Basic include
	 * orm.select('users').include('posts').all();
	 * // → { ...user, posts: Post[] }[]
	 *
	 * // Multiple includes
	 * orm.select('users').include('posts').include('profile').all();
	 * // → { ...user, posts: Post[], profile: Profile | null }[]
	 * ```
	 */
	include<R extends InferRelationNames<S['tables'][T]>>(
		relation: R,
		options?: IncludeOptionsWithRecursive,
	): TypedQueryBuilder<S, T, MergeInclude<S, T, I, R, true>>;

	/**
	 * Include with nested relations using an object specification.
	 *
	 * @typeParam R - The relation name
	 * @typeParam Opts - The nested include options
	 * @param relation - The relation to include
	 * @param options - Object with nested include specification
	 * @returns A new TypedQueryBuilder with nested includes tracked
	 *
	 * @example
	 * ```typescript
	 * orm.select('users')
	 *   .include('posts', { include: { comments: true } })
	 *   .all();
	 * // → { ...user, posts: (Post & { comments: Comment[] })[] }[]
	 * ```
	 */
	includeNested<
		R extends InferRelationNames<S['tables'][T]>,
		// biome-ignore lint/suspicious/noExplicitAny: Required for conditional type check on relations Record
		Target extends S['tables'][T]['relations'] extends Record<string, any>
			? S['tables'][T]['relations'][R] extends { target: infer Tgt }
				? Tgt extends TableNames<S>
					? Tgt
					: never
				: never
			: never,
		Nested extends IncludeSpec<S, Target>,
	>(
		relation: R,
		options: { include: Nested } & IncludeOptionsWithRecursive,
	): TypedQueryBuilder<S, T, MergeInclude<S, T, I, R, { include: Nested }>>;

	// ========================================================================
	// Column Selection
	// ========================================================================

	/**
	 * Select specific columns from the root entity.
	 *
	 * @param columns - Array of column names or expressions
	 * @returns A new TypedQueryBuilder
	 */
	columns(columns: readonly ColumnSpec[]): TypedQueryBuilder<S, T, I>;

	// ========================================================================
	// Filtering
	// ========================================================================

	/**
	 * Apply WHERE conditions to the query.
	 *
	 * @param conditions - Where conditions (WhereIntent or raw conditions)
	 * @returns A new TypedQueryBuilder
	 */
	where(
		...conditions: Array<WhereIntent | Record<string, unknown>>
	): TypedQueryBuilder<S, T, I>;

	// ========================================================================
	// Aggregations
	// ========================================================================

	/**
	 * Count rows.
	 */
	count(options?: AggregateOptions): TypedQueryBuilder<S, T, I>;
	count(field: string, as?: string): TypedQueryBuilder<S, T, I>;
	count(field: DistinctField, as?: string): TypedQueryBuilder<S, T, I>;

	/**
	 * Sum a field.
	 */
	sum(field: string | DistinctField, as?: string): TypedQueryBuilder<S, T, I>;

	/**
	 * Average a field.
	 */
	avg(field: string | DistinctField, as?: string): TypedQueryBuilder<S, T, I>;

	/**
	 * Minimum value.
	 */
	min(field: string, as?: string): TypedQueryBuilder<S, T, I>;

	/**
	 * Maximum value.
	 */
	max(field: string, as?: string): TypedQueryBuilder<S, T, I>;

	// ========================================================================
	// Grouping & Ordering
	// ========================================================================

	/**
	 * Group by fields.
	 */
	groupBy(...fields: string[]): TypedQueryBuilder<S, T, I>;

	/**
	 * HAVING clause for group filtering.
	 */
	having(
		...conditions: Array<WhereIntent | Record<string, unknown>>
	): TypedQueryBuilder<S, T, I>;

	/**
	 * SELECT DISTINCT.
	 */
	distinct(): TypedQueryBuilder<S, T, I>;

	/**
	 * Order by columns.
	 */
	orderBy(input: OrderByInput): TypedQueryBuilder<S, T, I>;
	orderBy(field: string, direction?: SortDirection): TypedQueryBuilder<S, T, I>;
	orderBy(
		field: string,
		direction?: SortDirection,
		nulls?: NullsPosition,
	): TypedQueryBuilder<S, T, I>;

	// ========================================================================
	// Pagination & Limiting
	// ========================================================================

	/**
	 * Limit results.
	 */
	limit(count: number): TypedQueryBuilder<S, T, I>;

	/**
	 * Offset results.
	 */
	offset(count: number): TypedQueryBuilder<S, T, I>;

	/**
	 * Paginate with page/perPage.
	 */
	paginate(
		options: PaginateOptions,
	): Promise<PaginatedResult<InferQueryResult<S, T, I>>>;

	/**
	 * Cursor-based pagination.
	 */
	cursorPaginate(
		options: CursorPaginateOptions,
	): Promise<CursorPaginatedResult<InferQueryResult<S, T, I>>>;

	// ========================================================================
	// Execution Methods (Type-Safe Results)
	// ========================================================================

	/**
	 * Execute query and return all results.
	 * The return type is automatically inferred based on schema and includes.
	 *
	 * @returns Array of results with proper typing including relations
	 */
	all(): Promise<InferQueryResult<S, T, I>[]>;

	/**
	 * Execute query and return first result.
	 *
	 * @returns First result or null
	 */
	first(): Promise<InferQueryResult<S, T, I> | null>;

	/**
	 * Execute query and return first result, throw if not found.
	 *
	 * @returns First result (throws NotFoundError if none)
	 */
	firstOrThrow(): Promise<InferQueryResult<S, T, I>>;

	/**
	 * Find by primary key.
	 *
	 * @param id - The primary key value
	 * @returns Result or null
	 */
	byId(id: string | number): Promise<InferQueryResult<S, T, I> | null>;

	/**
	 * Find by primary key, throw if not found.
	 *
	 * @param id - The primary key value
	 * @returns Result (throws NotFoundError if none)
	 */
	byIdOrThrow(id: string | number): Promise<InferQueryResult<S, T, I>>;

	/**
	 * Find by multiple primary keys.
	 *
	 * @param ids - Array of primary key values
	 * @returns Array of results
	 */
	byIds(
		ids: readonly (string | number)[],
	): Promise<InferQueryResult<S, T, I>[]>;

	/**
	 * Stream results.
	 *
	 * @param options - Stream options
	 * @returns AsyncIterable of results
	 */
	stream(options?: StreamOptions): AsyncIterable<InferQueryResult<S, T, I>>;

	/**
	 * Execute raw query (for aggregations).
	 *
	 * @returns Query result
	 */
	execute(): Promise<unknown>;

	// ========================================================================
	// Planning & Debugging
	// ========================================================================

	/**
	 * Get the query plan without executing.
	 */
	plan(): unknown;

	/**
	 * Get full dump (plan + SQL + params).
	 */
	dump(): unknown;

	// ========================================================================
	// Configuration
	// ========================================================================

	/**
	 * Enable/disable strict mode for this query.
	 */
	withStrictMode(enabled: boolean): TypedQueryBuilder<S, T, I>;

	/**
	 * Provide relation hints for disambiguation.
	 */
	withRelationHint(hints: Record<string, string>): TypedQueryBuilder<S, T, I>;
}

// ============================================================================
// Type-Safe ORM Instance
// ============================================================================

/**
 * Type-safe ORM instance that provides schema-aware query building.
 *
 * @typeParam S - The TypedSchema definition
 */
export interface TypedOrmInstance<S extends TypedSchema> {
	/**
	 * Start a SELECT query on a table.
	 * Table name is constrained to valid table names in the schema.
	 *
	 * @typeParam T - The table name (autocompleted from schema)
	 * @param tableName - The table to query
	 * @returns A TypedQueryBuilder for the table
	 *
	 * @example
	 * ```typescript
	 * // Table name is autocompleted
	 * const users = await orm.select('users').all();
	 * // users: { id: string; name: string; ... }[]
	 * ```
	 */
	select<T extends TableNames<S>>(
		tableName: T,
	): TypedQueryBuilder<S, T, undefined>;

	/**
	 * Whether strict mode is enabled by default.
	 */
	readonly strictMode: boolean;
}
