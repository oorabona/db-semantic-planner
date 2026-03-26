/**
 * @fileoverview Core DX layer type definitions.
 *
 * Contains shared types used across the query builder, ORM instance,
 * and other DX components: column specs, ordering, includes, hierarchy, etc.
 *
 * Split files are re-exported for backward compatibility:
 * - pagination-types.ts: Pagination and streaming types
 * - query-builder-types.ts: QueryBuilder interface
 * - orm-instance-types.ts: OrmInstance and OrmOptions
 *
 * @module types
 * @since DX-001
 */

import type {
	ExpressionIntent,
	SelectIntent,
	WhereIntent,
} from '../intent-ast.js';

// ============================================================================
// Re-exports from split files (backward compatibility)
// ============================================================================

export type {
	OrmInstance,
	OrmInstanceInternal,
	OrmOptions,
	OrmOptionsWithAdapter,
	OrmOptionsWithModel,
	OrmOptionsWithSchema,
	SelectExpressionResult,
} from './orm-instance-types.js';
export type {
	CursorPaginatedResult,
	CursorPaginateOptions,
	PaginatedResult,
	PaginateOptions,
	StreamOptions,
} from './pagination-types.js';
export type { QueryBuilder } from './query-builder-types.js';

// ============================================================================
// Expression & Column Types
// ============================================================================

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
 * An ExpressionSpec that carries its alias as a phantom type parameter.
 * This allows .columns() to extend the result type with the aliased property.
 *
 * Created by relationColumn(relation, column, alias) when the alias is a
 * string literal — TypeScript captures the exact string type, enabling
 * .columns() to extend TResult with { [alias]: TValue }.
 *
 * @typeParam TAlias - The string literal type of the alias
 * @typeParam TValue - The value type (defaults to unknown)
 */
export interface AliasedExprColumn<TAlias extends string, TValue = unknown>
	extends ExpressionSpec {
	/** @internal phantom brand — never set at runtime */
	readonly __alias: TAlias;
	/** @internal phantom brand — never set at runtime */
	readonly __value: TValue;
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

// ============================================================================
// Aggregate Types
// ============================================================================

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

// ============================================================================
// Relation Hints
// ============================================================================

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

// ============================================================================
// Include Types
// ============================================================================

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

	/**
	 * Join type for the include when using the 'join' strategy.
	 * - 'left' (default): LEFT JOIN — all root rows returned, NULL for unmatched relations
	 * - 'inner': INNER JOIN — only root rows WITH a matching related record are returned
	 *
	 * Forces the 'join' include strategy (overrides auto-selection).
	 *
	 * @example
	 * include('file', { join: 'inner' })
	 * // → INNER JOIN files ON files.id = symbols.file_id
	 */
	readonly join?: 'inner' | 'left';
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
 * Include with relation name for nested includes.
 * Used when building nested include hierarchies.
 */
export interface NestedInclude extends IncludeOptions {
	/**
	 * The relation name or target table for this nested include.
	 */
	readonly relation: string;
}

// ============================================================================
// Hierarchy Types (DX-022)
// ============================================================================

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
