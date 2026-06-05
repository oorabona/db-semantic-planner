/**
 * @module planner
 * Planner type definitions - PlanReport, PlanDecision, PlanWarning, etc.
 *
 * Runtime functions (plan(), planRecursive(), etc.) remain in @dbsp/core.
 */

import type { DialectCapabilities } from './dialects.js';
import type { QueryIntent, RecursiveIntent } from './intent-ast.js';
import type { IncludeStrategy, RelationType } from './model-ir.js';

// ============================================================================
// Decision Types
// ============================================================================

/**
 * Decision types made by the planner
 */
export type DecisionType =
	| 'filter-strategy'
	| 'join-type'
	| 'include-strategy'
	| 'cte-extraction'
	| 'ambiguity'
	| 'recursive-cte'
	| 'bidirectional-edges';

// ============================================================================
// Plan Decision
// ============================================================================

export interface PlanDecision {
	/** Unique identifier for the decision */
	readonly id: string;

	/** Type of decision */
	readonly type: DecisionType;

	/** Context: what triggered this decision */
	readonly context: {
		/** Source table in the decision */
		readonly sourceTable: string;
		/** Target table or relation name */
		readonly target?: string;
		/** Relation name if applicable */
		readonly relation?: string;
		/** Relation type (belongsTo, hasMany, hasOne, belongsToMany) */
		readonly relationType?: RelationType;
		/** Intent path (e.g., "where.exists.posts") */
		readonly intentPath?: string;
		/** Full relation path for multi-hop (SPEC-002), e.g., "author.company" */
		readonly relationPath?: string;
		/** User-provided include alias (e.g., 'author' from .include('author')) */
		readonly includeAlias?: string;
		/** Foreign key column(s) for include-strategy (Phase 3) */
		readonly foreignKey?: string | readonly string[];
		/** Whether the relation is self-referential (source === target) */
		readonly isSelfRef?: boolean;
	};

	/** The choice made */
	readonly choice: string;

	/**
	 * Join type for include-strategy decisions using the 'join' strategy.
	 * Set when the user explicitly requests 'inner' or 'left' via IncludeIntent.join.
	 * When absent, the join handler defaults to LEFT JOIN.
	 */
	readonly joinType?: 'inner' | 'left';

	/** Human-readable reasoning */
	readonly reasoning: string;

	/** Other options that were available */
	readonly alternatives: readonly string[];
}

// ============================================================================
// Plan Warning
// ============================================================================

export type PlanWarningCode =
	| 'AMBIGUOUS_RELATION'
	| 'POTENTIAL_ROW_EXPLOSION'
	| 'CIRCULAR_INCLUDE'
	| 'MISSING_INDEX_HINT'
	| 'DEEP_NESTING'
	| 'INVALID_RECURSIVE_INCLUDE'
	| 'RAW_SQL_USAGE';

export interface PlanWarning {
	/** Warning code for programmatic handling */
	readonly code: PlanWarningCode;

	/** Human-readable message */
	readonly message: string;

	/** Suggested action to resolve */
	readonly suggestion?: string;

	/** Related decision ID if applicable */
	readonly relatedDecision?: string;
}

// ============================================================================
// CTE Definition
// ============================================================================

export interface CTEDefinition {
	/** CTE name (used in WITH clause) */
	readonly name: string;

	/** Purpose of this CTE */
	readonly purpose: string;

	/** Which query parts reference this CTE */
	readonly referencedBy: readonly string[];

	/** The intent fragment this CTE represents */
	readonly sourceIntent: string;

	/**
	 * CLI-012c: Whether this CTE should use WITH RECURSIVE.
	 * Set when include.recursive is specified and relation is self-referential.
	 */
	readonly recursive?: boolean;
}

// ============================================================================
// Plan Report
// ============================================================================

export interface PlanReport {
	/** Root table for the query */
	readonly rootTable: string;

	/** All decisions made during planning */
	readonly decisions: readonly PlanDecision[];

	/** Warnings about the plan */
	readonly warnings: readonly PlanWarning[];

	/** CTEs to be extracted */
	readonly ctes: readonly CTEDefinition[];

	/** Original intent (for reference) */
	readonly intent: QueryIntent;

	/**
	 * The intent the adapter should compile (post-optimization, e.g. IN→EXISTS rewrite).
	 * When the planner rewrites the WHERE clause (e.g. IN-subquery → EXISTS), this field
	 * carries the optimized form so the adapter compiles the correct SQL.
	 * Falls back to `intent` when absent (no optimization applied).
	 * `intent` always stays the original submitted intent — never mutated by the planner.
	 */
	readonly executableIntent?: QueryIntent;

	/** Planning metadata */
	readonly metadata: {
		/** Planning duration in ms */
		readonly planningTimeMs: number;
		/** Number of relations traversed */
		readonly relationsAnalyzed: number;
		/** Whether the plan is ambiguous */
		readonly isAmbiguous: boolean;
		/** Ambiguous relation options (if isAmbiguous) */
		readonly ambiguousOptions?: readonly string[];
	};
}

// ============================================================================
// Plan Options
// ============================================================================

export interface PlanOptions {
	/**
	 * Force a specific filter strategy (overrides auto-detection)
	 */
	forceFilterStrategy?: 'exists' | 'join';

	/**
	 * Force a specific join type (overrides auto-detection)
	 */
	forceJoinType?: 'left' | 'inner';

	/**
	 * Enable CTE extraction for repeated subqueries
	 * @default true
	 */
	enableCTEs?: boolean;

	/**
	 * Threshold for CTE extraction (min references)
	 * @default 2
	 */
	cteThreshold?: number;

	/**
	 * Maximum include depth before warning
	 * @default 5
	 */
	maxIncludeDepth?: number;

	/**
	 * Disambiguation hints for ambiguous relations
	 * Map of "sourceTable.targetTable" -> relation name
	 */
	disambiguate?: Record<string, string>;

	/**
	 * Default include strategy for relations when set to 'auto'.
	 * - 'join': Use JOIN (single query, database optimizes) - RECOMMENDED for to-one
	 * - 'subquery': Use subquery queries (N+1 style with batching) - safe for to-many
	 * - 'cte': Use CTE-based include (good for recursive/hierarchical)
	 * - 'lateral': Use LATERAL JOIN (PostgreSQL) / CROSS APPLY (MSSQL)
	 * - 'json_agg': Use JSON aggregation (PostgreSQL/MySQL/DuckDB)
	 * - 'auto': Smart selection based on relation type + dialect capabilities
	 * @default 'auto'
	 */
	defaultIncludeStrategy?: IncludeStrategy;

	/**
	 * Dialect capabilities for smart strategy selection.
	 * When provided, 'auto' strategy uses dialect-aware selection.
	 * When absent, 'auto' falls back to 'join'.
	 */
	dialectCapabilities?: DialectCapabilities;
}

// ============================================================================
// Recursive Plan Types
// ============================================================================

export interface RecursivePlanReport
	extends Omit<PlanReport, 'intent' | 'metadata'> {
	readonly intent: RecursiveIntent;
	readonly metadata: PlanReport['metadata'] & {
		readonly isRecursive: true;
		readonly traversalKind: 'adjacency' | 'edge-table' | 'custom';
		readonly usesBidirectional: boolean;
		readonly dedupeStrategy: 'none' | 'final';
	};
}

export interface RecursivePlanOptions {
	/** Force bidirectional edge handling strategy */
	readonly forceBidirectionalStrategy?: 'union' | 'union-all';
}

// ============================================================================
// Resolved Strategy
// ============================================================================

/** Include strategy after 'auto' has been resolved to a concrete strategy */
export type ResolvedIncludeStrategy = Exclude<IncludeStrategy, 'auto'>;
