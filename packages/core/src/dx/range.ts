/**
 * @module range
 * PostgreSQL range operator helpers — expression-level (ExpressionRef) API.
 *
 * Provides three operators for PostgreSQL range types:
 * - `rangeOverlaps`    — `&&`  (any points in common)
 * - `rangeContains`    — `@>`  (range contains range or element)
 * - `rangeContainedBy` — `<@`  (range is contained by another range)
 *
 * Tuple form:   `rangeOverlaps('period', ['2024-01-01', '2024-01-31'])` → ExpressionRef
 *               Compiles to: `"period" && daterange($1, $2)`
 *
 * Object form:  `rangeOverlaps('period', { lower: '2024-01-01', upper: '2024-01-31' })` → WhereRangeIntent
 *               Handled by the planner's range pipeline (backward-compatible path).
 *
 * @example
 * ```typescript
 * import { rangeOverlaps, rangeContains, rangeContainedBy } from '@dbsp/core';
 *
 * orm.select('bookings').where(rangeOverlaps('period', ['2024-01-01', '2024-01-31']))
 * orm.select('events').where(rangeContains('dateRange', ['2024-06-15', '2024-06-15']))
 * orm.select('events').where(rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31']))
 * ```
 */

import type { RangeValue } from '@dbsp/types';
import type { WhereRangeIntent } from '../intent-ast.js';
import { type ExpressionRef, fn, op, param, ref } from './expressions.js';

export type { RangeValue } from '@dbsp/types';

// ============================================================================
// RangeType
// ============================================================================

/**
 * PostgreSQL range type names.
 *
 * Used as the third argument to range helpers to control the constructor
 * function emitted in SQL (e.g. `daterange($1, $2)`, `int4range($1, $2)`).
 *
 * Defaults to `'daterange'` when omitted.
 */
export type RangeType =
	| 'int4range'
	| 'int8range'
	| 'numrange'
	| 'tsrange'
	| 'tstzrange'
	| 'daterange';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build the range constructor call: `rangeType(param(lower), param(upper))`
 */
function makeRangeFn(
	range: readonly [unknown, unknown],
	rangeType: RangeType,
): ExpressionRef {
	return fn(rangeType, param(range[0]), param(range[1]));
}

/**
 * Assert that `arr` is a 2-element tuple.
 * Throws a clear error for 0-, 1-, or 3+-element arrays so callers get
 * actionable feedback instead of silently producing bad SQL.
 */
function assertTupleLength(arr: unknown[]): void {
	if (arr.length !== 2) {
		throw new Error(
			`range tuple must have exactly 2 elements (got ${arr.length}); use [lower, upper] or pass a RangeValue object`,
		);
	}
}

// ============================================================================
// rangeOverlaps — &&
// ============================================================================

/**
 * Range OVERLAPS — tuple API: `"column" && rangeType($1, $2)` (ExpressionRef)
 *
 * @example rangeOverlaps('period', ['2024-01-01', '2024-01-31'])
 *          → "period" && daterange($1, $2)
 * @example rangeOverlaps('span', [1, 100], 'int4range')
 *          → "span" && int4range($1, $2)
 */
export function rangeOverlaps(
	column: string,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): ExpressionRef;

/**
 * Range OVERLAPS — object API: delegates to WhereRangeIntent (planner path)
 *
 * @example rangeOverlaps('dates', { lower: '2025-01-15', upper: '2025-01-20' })
 */
export function rangeOverlaps(
	field: string,
	value: RangeValue,
): WhereRangeIntent;

export function rangeOverlaps(
	fieldOrColumn: string,
	valueOrRange: RangeValue | readonly [unknown, unknown],
	rangeType: RangeType = 'daterange',
): ExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op('&&', ref(fieldOrColumn), makeRangeFn(tuple, rangeType));
	}
	return {
		kind: 'range',
		field: fieldOrColumn,
		operator: 'overlaps',
		value: valueOrRange,
	};
}

// ============================================================================
// rangeContains — @>
// ============================================================================

/**
 * Range CONTAINS — tuple API: `"column" @> rangeType($1, $2)` (ExpressionRef)
 *
 * @example rangeContains('dateRange', ['2024-06-15', '2024-06-15'])
 *          → "dateRange" @> daterange($1, $2)
 */
export function rangeContains(
	column: string,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): ExpressionRef;

/**
 * Range CONTAINS — object API: delegates to WhereRangeIntent (planner path)
 *
 * @example rangeContains('date_range', { lower: '2025-01-01', upper: '2025-01-05' })
 */
export function rangeContains(
	field: string,
	value: RangeValue,
): WhereRangeIntent;

export function rangeContains(
	fieldOrColumn: string,
	valueOrRange: RangeValue | readonly [unknown, unknown],
	rangeType: RangeType = 'daterange',
): ExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op('@>', ref(fieldOrColumn), makeRangeFn(tuple, rangeType));
	}
	return {
		kind: 'range',
		field: fieldOrColumn,
		operator: 'contains',
		value: valueOrRange,
	};
}

// ============================================================================
// rangeContainedBy — <@
// ============================================================================

/**
 * Range CONTAINED BY — tuple API: `"column" <@ rangeType($1, $2)` (ExpressionRef)
 *
 * @example rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31'])
 *          → "dateRange" <@ daterange($1, $2)
 */
export function rangeContainedBy(
	column: string,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): ExpressionRef;

/**
 * Range CONTAINED BY — object API: delegates to WhereRangeIntent (planner path)
 *
 * @example rangeContainedBy('event_dates', { lower: '2025-01-01', upper: '2025-12-31' })
 */
export function rangeContainedBy(
	field: string,
	value: RangeValue,
): WhereRangeIntent;

export function rangeContainedBy(
	fieldOrColumn: string,
	valueOrRange: RangeValue | readonly [unknown, unknown],
	rangeType: RangeType = 'daterange',
): ExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op('<@', ref(fieldOrColumn), makeRangeFn(tuple, rangeType));
	}
	return {
		kind: 'range',
		field: fieldOrColumn,
		operator: 'containedBy',
		value: valueOrRange,
	};
}
