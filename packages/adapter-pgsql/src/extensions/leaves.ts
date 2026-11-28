/**
 * The ADR 0011 leaf rule for the extension helpers.
 *
 * A helper that wraps a user argument in its own markers coerces that
 * argument first, through core's leaf functions and under the helper's own
 * name, so an expression stays an expression and only a plain value is bound.
 */

import { ExpressionRef, InvalidOperationError, param } from '@dbsp/core';
import {
	coerceReference,
	coerceValue,
	isValueExpression,
	leafKind,
} from '@dbsp/core/internal';

/**
 * A value leaf: a plain value (`null` and `undefined` included) is bound as
 * given; an expression object is compiled; `param(v)` binds `v`.
 */
export function valueLeaf(leaf: unknown, helper: string): ExpressionRef {
	const coerced = coerceValue(leaf, helper, 'expression argument');
	return isValueExpression(coerced)
		? new ExpressionRef(coerceReference(coerced, helper))
		: param(coerced);
}

/**
 * A reference leaf: a string is a column, a `ColumnRef` its qualified column,
 * an expression object is compiled, a finite number or boolean is inlined.
 */
export function referenceLeaf(leaf: unknown, helper: string): ExpressionRef {
	return new ExpressionRef(coerceReference(leaf, helper));
}

/** A name argument: a string, as written; anything else is refused by name. */
export function nameArgument(
	value: unknown,
	helper: string,
	refusal: string,
): string {
	if (typeof value !== 'string')
		throw new InvalidOperationError(
			helper,
			`${refusal}; got ${leafKind(value)}`,
		);
	return value;
}
