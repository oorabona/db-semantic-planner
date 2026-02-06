/**
 * @module intent/recursive-intent
 * Recursive CTE intent types for hierarchical data traversal (RFC-001).
 */

import type { WhereIntent } from './where-intent.js';
import type { OrderByIntent } from './include-intent.js';

// ============================================================================
// Recursive CTE Intent - Hierarchical Data Traversal (RFC-001)
// ============================================================================

/**
 * Node ID expression for recursive CTE anchor.
 * Used to define the join key for recursive traversal.
 */
export type RecursiveNodeIdExpr =
	| { readonly kind: 'column'; readonly name: string; readonly as?: string }
	| {
			readonly kind: 'literal';
			readonly value: unknown;
			readonly as?: string;
	  }
	| {
			readonly kind: 'binary';
			readonly left: RecursiveNodeIdExpr;
			readonly op: string;
			readonly right: RecursiveNodeIdExpr;
			readonly as?: string;
	  };

/**
 * Get the alias for a node ID expression.
 * Used by both planner and compiler for consistent CTE column naming.
 *
 * @param expr - The node ID expression
 * @returns The alias to use (explicit alias, column name, or 'node_id' fallback)
 */
export function getNodeIdAlias(expr: RecursiveNodeIdExpr): string {
	if (expr.as) return expr.as;
	if (expr.kind === 'column') return expr.name;
	if (expr.kind === 'literal') return 'node_id';
	// Binary expression needs explicit alias
	return 'node_id';
}

/**
 * Adjacency-list traversal (self-referential table).
 * Example: roles.parent_id → roles.id
 */
export interface AdjacencyTraversal {
	readonly kind: 'adjacency';

	/** Table containing hierarchical data */
	readonly nodeTable: string;

	/** Primary key column (e.g., "id") */
	readonly nodeId: string;

	/** Foreign key pointing to parent (e.g., "parent_id") */
	readonly parentId: string;

	/** Traversal direction */
	readonly direction: 'descendants' | 'ancestors';

	/** Filter applied to each step (e.g., active = true) */
	readonly stepWhere?: WhereIntent;
}

/**
 * Edge-table traversal (separate join table).
 * Example: role_inheritance(from_role_id, to_role_id)
 */
export interface EdgeTableTraversal {
	readonly kind: 'edge-table';

	/** Node table containing hierarchical data */
	readonly nodeTable: string;

	/** Edge table containing relationships */
	readonly edgeTable: string;

	/** Primary key column in node table (e.g., "id") */
	readonly nodeId: string;

	/** Source column in edge table (e.g., "from_role_id") */
	readonly edgeFrom: string;

	/** Target column in edge table (e.g., "to_role_id") */
	readonly edgeTo: string;

	/** Traversal direction */
	readonly direction: 'out' | 'in' | 'both';

	/** Filter on edges (e.g., relationship_type = 'inheritance') */
	readonly edgeWhere?: WhereIntent;

	/** Filter on nodes (e.g., active = true) */
	readonly nodeWhere?: WhereIntent;

	/** Edge attributes to include in result */
	readonly edgeSelect?: readonly string[];

	/**
	 * Hint for edge storage semantics (only affects `direction: 'both'`).
	 *
	 * - 'unknown' (default): Edges may exist in both directions (A→B and B→A).
	 *   Uses UNION (distinct) to avoid duplicates. Safe but slower.
	 * - 'directed-only': Caller guarantees edges are stored once only.
	 *   Uses UNION ALL for performance. INCORRECT if duplicates exist.
	 */
	readonly edgeStorageHint?: 'unknown' | 'directed-only';
}

/**
 * Custom traversal for complex cases (P2 escape hatch).
 */
export interface CustomTraversal {
	readonly kind: 'custom';
	/** Explicit step query builder - reserved for P2 */
	readonly stepBuilder?: unknown;
}

/**
 * Recursive traversal type union.
 */
export type RecursiveTraversal =
	| AdjacencyTraversal
	| EdgeTableTraversal
	| CustomTraversal;

/**
 * Tracking options for recursive traversal.
 */
export interface RecursiveTrackOptions {
	/** Depth counter (starts at 0) */
	readonly depth?: {
		readonly as?: string; // Default: "depth"
	};

	/** Path tracking for cycle detection + debugging */
	readonly path?: {
		/** Columns to trace in path (default: nodeId only) */
		readonly by?: 'nodeId' | readonly string[];
		/** Result column name (default: "path") */
		readonly as?: string;
		/** Storage strategy (default: 'array' for PostgreSQL, 'string' for others) */
		readonly strategy?: 'array' | 'string';
		/** Separator for string strategy (default: '/') */
		readonly separator?: string;
	};

	/** Cycle detection marker */
	readonly isCycle?: {
		readonly as?: string; // Default: "is_cycle"
	};
}

/**
 * Join clause for CTE emit composition.
 * Allows joining the CTE result with additional tables for final projection.
 */
export interface EmitJoinClause {
	/** Table to join with */
	readonly table: string;

	/** Join type (default: 'inner') */
	readonly type?: 'inner' | 'left';

	/** Alias for this table (auto-generated if not provided) */
	readonly as?: string;

	/** Join condition */
	readonly on: {
		/** Column from CTE or previous joined table */
		readonly left: string;
		/** Column from this table */
		readonly right: string;
	};

	/** Columns to select from this table */
	readonly select?: readonly (
		| string
		| { readonly column: string; readonly as: string }
	)[];
}

/**
 * Emit options for recursive CTE final projection.
 */
export interface RecursiveEmitOptions {
	/** Fields to select from CTE */
	readonly select?: readonly string[];
	/** Filter on generated rows */
	readonly where?: WhereIntent;
	/** Ordering */
	readonly orderBy?: readonly OrderByIntent[];
	/** Join CTE result with additional tables for composition */
	readonly joinWith?: readonly EmitJoinClause[];
	/** Apply DISTINCT to final result */
	readonly distinct?: boolean;
}

/**
 * PostgreSQL-specific options for recursive CTE (capability-gated).
 */
export interface RecursiveAdvancedOptions {
	/**
	 * Cycle detection strategy (adapter-specific implementation).
	 * - 'error': Throw on cycle detection
	 * - 'stop': Stop traversal at cycle (prune branch)
	 * - 'mark': Add is_cycle column to results
	 *
	 * PostgreSQL 14+ uses native CYCLE clause.
	 * Other adapters may use application-level detection.
	 */
	readonly cycle?: 'error' | 'stop' | 'mark';

	/**
	 * Traversal search order (adapter-specific implementation).
	 * - 'depth': Depth-first search order
	 * - 'breadth': Breadth-first search order
	 *
	 * PostgreSQL 14+ uses native SEARCH clause.
	 * Other adapters may use ORDER BY on depth column.
	 */
	readonly search?: 'depth' | 'breadth';
}

/**
 * Deduplication strategy for recursive CTE.
 *
 * - 'none': No dedup. May return same node multiple times via different paths.
 *   Fastest. Use when you need all paths or when graph is known to be a tree.
 *
 * - 'final': One row per nodeId in final output.
 *   Implemented via `DISTINCT ON (nodeId)` (PostgreSQL) or
 *   `ROW_NUMBER() OVER (PARTITION BY nodeId)` fallback.
 *   ⚠️ NOT the same as `query.distinct()` which dedupes on entire row!
 *
 * Note: 'global' (UNION instead of UNION ALL) was considered but not implemented.
 * 'final' provides the same end result with better performance characteristics.
 */
export type RecursiveDedupe = 'none' | 'final';

/**
 * Recursive CTE intent for hierarchical data traversal.
 *
 * Key invariant: anchor and step MUST produce identical column shape.
 * The planner validates this and auto-injects nodeIdExpr.
 *
 * @see RFC-001 for detailed specification
 */
export interface RecursiveIntent {
	readonly type: 'recursive';

	/** CTE name for the recursive query */
	readonly cteName: string;

	// ─────────────────────────────────────────────────────────────────────────
	// START (anchor/seed)
	// ─────────────────────────────────────────────────────────────────────────

	readonly start: {
		/** Source table for anchor query */
		readonly from: string;

		/** Filter for seed rows (e.g., where id = $userId) */
		readonly where?: WhereIntent;

		/**
		 * REQUIRED: Expression for node ID. Auto-injected into select.
		 * This ensures the recursive join always has the key column.
		 */
		readonly nodeIdExpr: RecursiveNodeIdExpr;

		/** Additional fields to select (beyond nodeId) */
		readonly select?: readonly string[];
	};

	// ─────────────────────────────────────────────────────────────────────────
	// TRAVERSAL
	// ─────────────────────────────────────────────────────────────────────────

	/** Traversal configuration (adjacency-list or edge-table) */
	readonly traversal: RecursiveTraversal;

	// ─────────────────────────────────────────────────────────────────────────
	// TRACKING (system columns)
	// ─────────────────────────────────────────────────────────────────────────

	/** Tracking options for depth, path, and cycle detection */
	readonly track?: RecursiveTrackOptions;

	// ─────────────────────────────────────────────────────────────────────────
	// SAFETY
	// ─────────────────────────────────────────────────────────────────────────

	/** Maximum recursion depth (REQUIRED) */
	readonly maxDepth: number;

	/** Maximum rows (optional safety limit) */
	readonly maxRows?: number;

	/** Deduplication strategy */
	readonly dedupe?: RecursiveDedupe;

	// ─────────────────────────────────────────────────────────────────────────
	// EMIT (final projection)
	// ─────────────────────────────────────────────────────────────────────────

	/** Final projection options */
	readonly emit?: RecursiveEmitOptions;

	// ─────────────────────────────────────────────────────────────────────────
	// ADVANCED OPTIONS (capability-gated, adapter-specific implementation)
	// ─────────────────────────────────────────────────────────────────────────

	/** Advanced recursive options (cycle detection, search order) */
	readonly advancedOptions?: RecursiveAdvancedOptions;
}
