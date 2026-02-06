/**
 * @module intent/recursive-types
 * Recursive relation types for hierarchical queries.
 */

/**
 * Direction of recursion for ancestors/descendants traversal.
 * - 'up': Traverse to ancestors (parent → grandparent → ...)
 * - 'down': Traverse to descendants (children → grandchildren → ...)
 */
export type RecursiveDirection = 'up' | 'down';

/**
 * Options for recursive EXISTS checks.
 * Used when checking existence through a recursive path (ancestors/descendants).
 *
 * @example
 * // Check if any ancestor has name = 'Electronics'
 * { direction: 'up', through: 'parent', maxDepth: 10 }
 */
export interface RecursiveExistsOptions {
	/** Direction of recursion: up (ancestors) or down (descendants) */
	readonly direction: RecursiveDirection;
	/** The relation name to follow for recursion (e.g., 'parent' for ancestors) */
	readonly through: string;
	/** Maximum recursion depth (default: 10) */
	readonly maxDepth?: number;
}
