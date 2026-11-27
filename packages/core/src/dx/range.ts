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
 *               Compiles to: `period && daterange($1, $2)`. Each bound follows
 *               the value rule (ADR 0011): a plain value is bound, an
 *               expression is compiled.
 *
 * Object form:  `rangeOverlaps('period', { lower: '2024-01-01', upper: '2024-01-31', bounds: '[]' })` → WhereRangeIntent
 *               Compiles to the column's range constructor:
 *               `period && daterange($1, $2, '[]')`.
 *
 * Expression operand: `rangeContains('span', exprRef('score'))` → `span @> score`.
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

import type { RangeOperand, RangeValue } from '@dbsp/types';
import { NotYetSupportedError } from '@dbsp/types';
import type { WhereRangeIntent } from '../intent-ast.js';
import {
	coerceReference,
	coerceValue,
	isValueExpression,
	leafKind,
	paramWrapperValue,
	type ReferenceLeaf,
	type ValueExpression,
} from './coerce.js';
import { getColumnName, isRelationPathColumn } from './column-utils.js';
import { InvalidOperationError } from './errors.js';
import {
	ExpressionRef,
	fn,
	op,
	type PredicateExpressionRef,
	param,
} from './expressions.js';
import { CALLBACK_SCOPE } from './symbols.js';
import { type ColumnRef, isColumnRef } from './table-ref.js';

export type { RangeOperand, RangeValue } from '@dbsp/types';

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

type RangeHelper = 'rangeOverlaps' | 'rangeContains' | 'rangeContainedBy';
type RangeSymbol = '&&' | '@>' | '<@';

const RANGE_BOUNDS = new Set(['[)', '[]', '()', '(]']);

// ============================================================================
// Internal helpers
// ============================================================================

/** A value leaf as an expression argument: an expression as is, a plain value bound. */
function boundArgument(leaf: unknown, helper: RangeHelper): ExpressionRef {
	const value = coerceValue(leaf, helper);
	return isValueExpression(value)
		? new ExpressionRef(coerceReference(value, helper))
		: param(value);
}

/** The column of the tuple form and of an expression operand (reference leaf). */
function referenceColumn(column: unknown, helper: RangeHelper): ExpressionRef {
	return new ExpressionRef(coerceReference(column, helper));
}

/**
 * Build the range constructor call: `rangeType(lower, upper)`, each bound a
 * value leaf.
 */
function makeRangeFn(
	range: readonly [unknown, unknown],
	rangeType: RangeType,
	helper: RangeHelper,
): ExpressionRef {
	return fn(
		rangeType,
		boundArgument(range[0], helper),
		boundArgument(range[1], helper),
	);
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

/**
 * The field of a `WhereRangeIntent`: a column name, or a `ColumnRef` reached
 * without a relation path or a callback scope. The intent carries neither
 * `pathRef` nor a scope, so those refs and expressions cannot be carried yet.
 */
function rangeField(column: unknown): string {
	if (typeof column === 'string') return column;
	if (typeof column === 'object' && column !== null && isColumnRef(column)) {
		if (
			(column as { readonly [CALLBACK_SCOPE]?: object })[CALLBACK_SCOPE] !==
			undefined
		)
			throw new NotYetSupportedError(
				'a callback-scoped ColumnRef',
				'range column',
				1052,
			);
		if (isRelationPathColumn(column))
			throw new NotYetSupportedError(
				'a relation-reached ColumnRef',
				'range column',
				1052,
			);
		return getColumnName(column);
	}
	throw new NotYetSupportedError(leafKind(column), 'range column', 1065);
}

function formatBounds(bounds: unknown): string {
	return typeof bounds === 'string' ? JSON.stringify(bounds) : String(bounds);
}

/** A `RangeValue` operand, its bounds checked and its two sides coerced. */
function rangeValueOperand(
	value: { lower?: unknown; upper?: unknown; bounds?: unknown },
	helper: RangeHelper,
): RangeValue {
	if (value.bounds !== undefined && !RANGE_BOUNDS.has(value.bounds as string))
		throw new InvalidOperationError(
			helper,
			`bounds must be one of '[)', '[]', '()', '(]'; got ${formatBounds(value.bounds)}`,
		);
	const sides = {
		lower: coerceValue(value.lower, helper),
		upper: coerceValue(value.upper, helper),
	};
	return value.bounds === undefined
		? sides
		: { ...sides, bounds: value.bounds as NonNullable<RangeValue['bounds']> };
}

function isRangeValueShape(
	value: unknown,
): value is { lower?: unknown; upper?: unknown; bounds?: unknown } {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date) &&
		('lower' in value || 'upper' in value)
	);
}

/**
 * The object form: a `RangeValue`, a scalar, or an expression operand. An
 * expression operand compiles to the tuple form's predicate; `param(v)` with a
 * primitive or `Date` `v` is unwrapped so it gets the plain `v`'s cast.
 */
function objectForm(
	column: unknown,
	operand: unknown,
	symbol: RangeSymbol,
	operator: WhereRangeIntent['operator'],
	helper: RangeHelper,
): PredicateExpressionRef | WhereRangeIntent {
	const coerced = coerceValue(operand, helper);
	let value: unknown = coerced;
	if (isValueExpression(coerced)) {
		const wrapped = paramWrapperValue(coerced);
		const unwrap =
			wrapped !== undefined &&
			(wrapped.value === null ||
				typeof wrapped.value !== 'object' ||
				wrapped.value instanceof Date);
		if (unwrap) value = wrapped.value;
		else if (wrapped === undefined)
			return op(
				symbol,
				referenceColumn(column, helper),
				new ExpressionRef(coerceReference(coerced, helper)),
			);
	}
	return {
		kind: 'range',
		field: rangeField(column),
		operator,
		value: (isRangeValueShape(value)
			? rangeValueOperand(value, helper)
			: value) as RangeOperand,
	};
}

// ============================================================================
// rangeOverlaps — &&
// ============================================================================

/**
 * Range OVERLAPS — tuple API: `column && rangeType(lower, upper)` (ExpressionRef)
 *
 * @example rangeOverlaps('period', ['2024-01-01', '2024-01-31'])
 *          → period && daterange($1, $2)
 * @example rangeOverlaps('span', [1, 100], 'int4range')
 *          → span && int4range($1, $2)
 */
export function rangeOverlaps(
	column: ReferenceLeaf,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): PredicateExpressionRef;

/**
 * Range OVERLAPS — object API: the column's range constructor, honouring
 * `bounds` (`'[)'` when absent).
 *
 * @example rangeOverlaps('dates', { lower: '2025-01-15', upper: '2025-01-20', bounds: '[]' })
 *          → dates && daterange($1, $2, '[]')
 */
export function rangeOverlaps(
	field: string | ColumnRef<string, string, unknown>,
	// #444: PostgreSQL only defines && for two ranges; keep scalar RHS rejected.
	value: RangeValue,
): WhereRangeIntent;

/**
 * Range OVERLAPS — expression operand: `column && <expression>`. A `param()`
 * operand is bound with the cast its value gets, as a `WhereRangeIntent`.
 */
export function rangeOverlaps(
	column: ReferenceLeaf,
	value: ValueExpression,
): PredicateExpressionRef | WhereRangeIntent;

export function rangeOverlaps(
	fieldOrColumn: unknown,
	valueOrRange: unknown,
	rangeType: RangeType = 'daterange',
): PredicateExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op(
			'&&',
			referenceColumn(fieldOrColumn, 'rangeOverlaps'),
			makeRangeFn(tuple, rangeType, 'rangeOverlaps'),
		);
	}
	return objectForm(
		fieldOrColumn,
		valueOrRange,
		'&&',
		'overlaps',
		'rangeOverlaps',
	);
}

// ============================================================================
// rangeContains — @>
// ============================================================================

/**
 * Range CONTAINS — tuple API: `column @> rangeType(lower, upper)` (ExpressionRef)
 *
 * @example rangeContains('dateRange', ['2024-06-15', '2024-06-15'])
 *          → dateRange @> daterange($1, $2)
 */
export function rangeContains(
	column: ReferenceLeaf,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): PredicateExpressionRef;

/**
 * Range CONTAINS — object API: a `RangeValue` (the column's range
 * constructor) or a scalar element.
 *
 * @example rangeContains('date_range', { lower: '2025-01-01', upper: '2025-01-05' })
 */
export function rangeContains(
	field: string | ColumnRef<string, string, unknown>,
	value: RangeOperand,
): WhereRangeIntent;

/**
 * Range CONTAINS — expression operand: `column @> <expression>`. A `param()`
 * operand is bound with the cast its value gets, as a `WhereRangeIntent`.
 */
export function rangeContains(
	column: ReferenceLeaf,
	value: ValueExpression,
): PredicateExpressionRef | WhereRangeIntent;

export function rangeContains(
	fieldOrColumn: unknown,
	valueOrRange: unknown,
	rangeType: RangeType = 'daterange',
): PredicateExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op(
			'@>',
			referenceColumn(fieldOrColumn, 'rangeContains'),
			makeRangeFn(tuple, rangeType, 'rangeContains'),
		);
	}
	return objectForm(
		fieldOrColumn,
		valueOrRange,
		'@>',
		'contains',
		'rangeContains',
	);
}

// ============================================================================
// rangeContainedBy — <@
// ============================================================================

/**
 * Range CONTAINED BY — tuple API: `column <@ rangeType(lower, upper)` (ExpressionRef)
 *
 * @example rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31'])
 *          → dateRange <@ daterange($1, $2)
 */
export function rangeContainedBy(
	column: ReferenceLeaf,
	range: readonly [unknown, unknown],
	rangeType?: RangeType,
): PredicateExpressionRef;

/**
 * Range CONTAINED BY — object API: the column's range constructor, honouring
 * `bounds`.
 *
 * @example rangeContainedBy('event_dates', { lower: '2025-01-01', upper: '2025-12-31' })
 */
export function rangeContainedBy(
	field: string | ColumnRef<string, string, unknown>,
	// #444: scalar containment has the element on the left, not the RHS here.
	value: RangeValue,
): WhereRangeIntent;

/**
 * Range CONTAINED BY — expression operand: `column <@ <expression>`. A
 * `param()` operand is bound with the cast its value gets, as a
 * `WhereRangeIntent`.
 */
export function rangeContainedBy(
	column: ReferenceLeaf,
	value: ValueExpression,
): PredicateExpressionRef | WhereRangeIntent;

export function rangeContainedBy(
	fieldOrColumn: unknown,
	valueOrRange: unknown,
	rangeType: RangeType = 'daterange',
): PredicateExpressionRef | WhereRangeIntent {
	if (Array.isArray(valueOrRange)) {
		assertTupleLength(valueOrRange);
		const tuple = valueOrRange as unknown as readonly [unknown, unknown];
		return op(
			'<@',
			referenceColumn(fieldOrColumn, 'rangeContainedBy'),
			makeRangeFn(tuple, rangeType, 'rangeContainedBy'),
		);
	}
	return objectForm(
		fieldOrColumn,
		valueOrRange,
		'<@',
		'containedBy',
		'rangeContainedBy',
	);
}
