/**
 * @module intent/include-intent
 * Include intent types for relation loading and ordering.
 */

import type { SortDirection } from '../shared/utils.js';
import type { ExpressionIntent, ParamIntent } from './expression-intent.js';
import type { NullsPosition, SelectIntent } from './select-intent.js';
import type { WhereIntent } from './where-intent.js';

// ============================================================================
// Include Intent - Relation Loading
// ============================================================================

/**
 * CLI-012c: Options for recursive include (self-referential relations only).
 *
 * Enables WITH RECURSIVE CTE generation for hierarchical data traversal
 * (org charts, category trees, bill of materials).
 *
 * For complex recursive queries (bidirectional, custom traversal expressions),
 * use `RecursiveIntent` directly.
 *
 * Note: Named `IncludeRecursiveOptions` to avoid conflict with DX-layer
 * `RecursiveIncludeOptions` in dx/types.ts.
 */
export interface IncludeRecursiveOptions {
	/**
	 * Maximum recursion depth (default: 100).
	 * Safety limit to prevent infinite recursion.
	 * @example maxDepth: 10 - fetch up to 10 levels deep
	 */
	readonly maxDepth?: number;

	/**
	 * Track additional metadata during recursion.
	 */
	readonly track?: {
		/**
		 * Include depth counter (starts at 0 for root nodes).
		 * Set to true for default column name 'depth', or object for custom alias.
		 */
		readonly depth?: boolean | { readonly as?: string };
		/**
		 * Include path array for cycle detection/debugging.
		 * Set to true for default column name 'path', or object for custom alias.
		 */
		readonly path?: boolean | { readonly as?: string };
	};

	/**
	 * Foreign key column for recursion.
	 * If not specified, will be inferred from relation definition.
	 * @example 'parentId' for self-referential category tree
	 */
	readonly foreignKey?: string;
}

export interface IncludeIntent {
	/** Relation name to include */
	readonly relation: string;

	/** What columns to select from related records */
	readonly select?: SelectIntent | undefined;

	/** Filter conditions on related records */
	readonly where?: WhereIntent | undefined;

	/** Nested includes for deep loading */
	readonly include?: readonly IncludeIntent[] | undefined;

	/**
	 * Explicit relation path for disambiguation.
	 * Use when multiple relations exist between same tables.
	 * @example 'author' or 'editor' when User has both relations to Post
	 */
	readonly via?: string | undefined;

	/**
	 * Maximum number of related records to include per parent.
	 * Only effective with LATERAL JOIN strategy (PostgreSQL/DuckDB/MSSQL).
	 * @example limit: 5 - fetch at most 5 related records per parent
	 */
	readonly limit?: number | undefined;

	/**
	 * Order by for related records (used with limit).
	 * @example orderBy: [{ field: 'createdAt', direction: 'desc' }]
	 */
	readonly orderBy?: readonly OrderByIntent[] | undefined;

	/**
	 * CLI-012c: Enable recursive CTE for self-referential relations.
	 * Only valid when relation.source === relation.target (e.g., categories → parent).
	 *
	 * @example
	 * include: [{
	 *   relation: 'children',
	 *   recursive: { maxDepth: 10, track: { depth: true } }
	 * }]
	 */
	readonly recursive?: IncludeRecursiveOptions | undefined;

	/**
	 * NQL v2.1: Override include output strategy for this relation.
	 *
	 * This is an **output strategy** (flat vs nested), not an implementation strategy.
	 * The planner decides the best implementation (join, subquery, lateral, cte)
	 * based on relation type and dialect capabilities.
	 *
	 * - 'auto': Let planner decide freely, including json_agg (default)
	 * - 'flat': Exclude json_agg from candidates; planner picks best flat strategy
	 *
	 * @example
	 * // NQL: orders | select *, customer.* | flat
	 * // Results in: include: [{ relation: 'customer', strategy: 'flat' }]
	 * // Planner then picks lateral, join, subquery, or cte (never json_agg)
	 */
	readonly strategy?: 'auto' | 'flat' | undefined;

	/**
	 * Join type for the include when using the 'join' strategy.
	 * - 'left' (default): LEFT JOIN — all root rows returned, NULL for unmatched relations
	 * - 'inner': INNER JOIN — only root rows WITH a matching related record are returned
	 *
	 * Forces the 'join' include strategy (overrides auto-selection).
	 *
	 * @example
	 * // Only return symbols that have a matching file
	 * include('file', { join: 'inner' })
	 * // → INNER JOIN files ON files.id = symbols.file_id
	 * // → Only symbols WITH a matching file are returned
	 */
	readonly join?: 'inner' | 'left' | undefined;
}

// ============================================================================
// OrderBy Intent - Sorting
// ============================================================================

/**
 * OrderBy intent - sort results
 */
/**
 * OrderBy intent (field branch): sort by a named column.
 */
export interface OrderByFieldIntent {
	/** Field name to sort by */
	readonly field: string;
	readonly expression?: never;
	/** Sort direction */
	readonly direction: SortDirection;
	/**
	 * Where to place NULL values
	 * @default 'last' for 'asc', 'first' for 'desc' (database default)
	 */
	readonly nulls?: NullsPosition;
}

/**
 * OrderBy intent (expression branch): sort by an arbitrary expression.
 */
export interface OrderByExpressionIntent {
	readonly field?: never;
	/** Expression to sort by */
	readonly expression: ExpressionIntent | ParamIntent;
	/** Sort direction */
	readonly direction: SortDirection;
	/**
	 * Where to place NULL values
	 * @default 'last' for 'asc', 'first' for 'desc' (database default)
	 */
	readonly nulls?: NullsPosition;
}

/**
 * OrderBy intent - sort results.
 * XOR: exactly one of `field` or `expression` must be present.
 */
export type OrderByIntent = OrderByFieldIntent | OrderByExpressionIntent;
