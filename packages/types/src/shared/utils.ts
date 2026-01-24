/**
 * Shared utility types used across all @dbsp packages
 * @module @dbsp/types/shared/utils
 */

/**
 * Sort direction for ORDER BY clauses
 * @public
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Range value representation for PostgreSQL range types.
 * Supports: daterange, tsrange, tstzrange, int4range, int8range, numrange
 * @public
 */
export interface RangeValue {
	readonly lower: unknown;
	readonly upper: unknown;
	/** Bounds specification: '[)' (default), '[]', '()', '(]' */
	readonly bounds?: '[)' | '[]' | '()' | '(]';
}
