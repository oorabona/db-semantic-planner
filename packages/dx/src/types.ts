import type {
	ModelIR,
	PlanReport,
	SelectIntent,
	WhereIntent,
} from '@db-semantic-planner/core';

/**
 * Configuration options for creating an ORM instance.
 */
export interface OrmOptions {
	/**
	 * The schema model to use for query planning.
	 */
	readonly model: ModelIR;

	/**
	 * Controls behavior when ambiguous relations are detected.
	 *
	 * - `true` (strict mode): Throws `AmbiguousRelationError` on ambiguous relations
	 * - `false` (lenient mode): Uses first relation and records warning in plan
	 *
	 * @default false
	 */
	readonly strictMode?: boolean;
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
	 * @param relation - The relation name or target table to include
	 * @param options - Optional configuration for the include
	 * @returns A new QueryBuilder with the include added
	 *
	 * @example
	 * ```typescript
	 * query('users')
	 *   .include('posts')  // Simple include
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
	 * Filter the root entity records.
	 *
	 * @param condition - Where condition to apply
	 * @returns A new QueryBuilder with the filter applied
	 */
	where(condition: WhereIntent): QueryBuilder;

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
