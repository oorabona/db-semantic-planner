import type { Dump } from '@db-semantic-planner/adapter-kysely';
import type {
	ModelIR,
	PlanReport,
	SelectIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import type { Kysely } from 'kysely';

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
