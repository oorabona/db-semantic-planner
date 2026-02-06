/**
 * @module intent/select-intent
 * Select intent types for column selection and aggregation.
 */

import type { ExpressionIntent } from './expression-intent.js';

export type { SortDirection } from '../shared/utils.js';

/** Null handling in sort */
export type NullsPosition = 'first' | 'last';

/**
 * Select all columns
 */
export interface SelectAllIntent {
	readonly type: 'all';
}

/**
 * Select specific fields
 */
export interface SelectFieldsIntent {
	readonly type: 'fields';
	/** Field names to select */
	readonly fields: readonly string[];
}

// ============================================================================
// Aggregate Functions
// ============================================================================

/** Aggregate function types */
export type AggregateFunction =
	| 'count'
	| 'sum'
	| 'avg'
	| 'min'
	| 'max'
	| 'array_agg'
	| 'string_agg';

/**
 * Aggregate operation intent
 * @example { function: 'count' } → COUNT(*)
 * @example { function: 'sum', field: 'price' } → SUM(price)
 */
export interface AggregateIntent {
	/** Aggregate function */
	readonly function: AggregateFunction;
	/** Field to aggregate (optional for count without field) */
	readonly field?: string;
	/** Alias for result column */
	readonly as?: string;
	/** Whether to apply DISTINCT to the aggregate (e.g., COUNT(DISTINCT field)) */
	readonly distinct?: boolean;
}

/**
 * Select with aggregate functions
 */
export interface SelectAggregateIntent {
	readonly type: 'aggregate';
	/** Aggregate operations */
	readonly aggregates: readonly AggregateIntent[];
	/** Non-aggregate fields (for GROUP BY) */
	readonly fields?: readonly string[];
}

/**
 * Select with expressions (computed columns).
 * Columns are ExpressionIntent directly - matches NQL compiler output.
 */
export interface SelectWithExpressionsIntent {
	readonly type: 'expressions';
	/** Columns as ExpressionIntent (NQL format) */
	readonly columns: readonly ExpressionIntent[];
}

/**
 * Select intent - what columns to retrieve
 */
export type SelectIntent =
	| SelectAllIntent
	| SelectFieldsIntent
	| SelectAggregateIntent
	| SelectWithExpressionsIntent;
