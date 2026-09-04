/**
 * Recursive CTE Module
 *
 * Provides utilities for building WITH RECURSIVE CTEs for hierarchical
 * data traversal in PostgreSQL.
 *
 * Features:
 * - CTE compilation with anchor and recursive parts
 * - Path tracking for materialized paths
 * - Cycle detection (array-based or PG14+ CYCLE clause)
 */

export {
	buildRecursiveCte,
	type RecursiveCteConfig,
} from './cte-compiler.js';
export {
	buildCycleCheck,
	buildCycleDetection,
	buildCycleFilter,
	buildPg14CycleClause,
	isPg14CycleSupported,
} from './cycle-detection.js';
export {
	appendPathColumn,
	buildJsonPathColumn,
	buildPathColumn,
	buildPathString,
} from './path-tracking.js';
