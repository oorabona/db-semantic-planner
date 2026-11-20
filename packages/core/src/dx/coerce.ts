/**
 * @module coerce
 * The one leaf rule shared by the expression constructors (ADR 0011).
 *
 * A constructor first recognises its own grammar (names, operators, cast
 * types, `distinct()` and `aggOrderBy()` markers). Every scalar leaf left over
 * goes through {@link coerceReference}, which turns it into an expression
 * intent or refuses it by name. It never binds an expression object, a
 * builder, a `ColumnRef`, an `outerRef()`, a `sql()` marker or a plain object
 * as a parameter value.
 */

import { EXPRESSION_BRAND, NotYetSupportedError, REF_BRAND } from '@dbsp/types';
import type {
	ExpressionIntent,
	LiteralExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	SubqueryExpressionIntent,
} from '../intent-ast.js';
import { getColumnName, isRelationPathColumn } from './column-utils.js';
import { InvalidOperationError } from './errors.js';
import type { ExpressionRef } from './expressions.js';
import { isSqlRaw } from './filters.js';
import type { RefDefinition } from './schema.js';
import {
	isSubqueryExpression,
	SubqueryBuilder,
	type SubqueryExpression,
} from './subquery-builder.js';
import { CALLBACK_SCOPE } from './symbols.js';
import { type ColumnRef, isColumnRef } from './table-ref.js';
import type { ExpressionSpec } from './types.js';

/**
 * A scalar argument of an expression constructor (`fn`, `boolFn`, `op`,
 * `unary`, `namedArg`, `array`, `cast`, `arrayAgg`, CASE results).
 *
 * - a string is a column;
 * - a finite number, a boolean, or a `bigint` within the safe-integer range
 *   is an inlined constant;
 * - a non-finite number, a `bigint` outside that range, an array or a `Date`
 *   is a bound parameter;
 * - an expression object (`ExpressionRef`, `ExpressionSpec`, `ColumnRef`,
 *   `SubqueryExpression`, schema `ref()`) is used as is.
 *
 * Use `literal()`, `param()` or `exprRef()` to force a position.
 */
export type ReferenceLeaf =
	| string
	| number
	| boolean
	| bigint
	| Date
	| readonly unknown[]
	| ExpressionRef
	| ExpressionSpec
	| ColumnRef<string, string, unknown>
	| SubqueryExpression
	| RefDefinition;

const EXPRESSION_ARGUMENT = 'expression argument';

function isBrandedExpression(
	leaf: object,
): leaf is { readonly intent: ExpressionIntent } {
	return (
		EXPRESSION_BRAND in leaf &&
		(leaf as { [EXPRESSION_BRAND]: unknown })[EXPRESSION_BRAND] === true &&
		'intent' in leaf
	);
}

function isOuterRef(leaf: object): boolean {
	const candidate = leaf as { kind?: unknown; outer?: unknown };
	return candidate.kind === 'ref' && candidate.outer === true;
}

function isQueryBuilder(leaf: object): boolean {
	if (leaf instanceof SubqueryBuilder) return true;
	const candidate = leaf as {
		buildIntent?: unknown;
		buildSubqueryIntent?: unknown;
	};
	return (
		typeof candidate.buildIntent === 'function' ||
		typeof candidate.buildSubqueryIntent === 'function'
	);
}

function refuse(helper: string, kind: string): never {
	throw new InvalidOperationError(
		helper,
		`${kind} is not an expression argument; use literal(null), param(value) or an expression`,
	);
}

/**
 * Coerce one scalar leaf in reference position (ADR 0011).
 *
 * @param leaf - The argument as the caller passed it
 * @param helper - The public helper name, used in refusal messages
 * @throws InvalidOperationError for `null`, `undefined`, a `sql()` marker and
 *   any other plain object (a hand-built intent included)
 * @throws NotYetSupportedError for `outerRef()`, a relation-reached or
 *   callback-scoped `ColumnRef`, and a query builder
 */
export function coerceReference(
	leaf: unknown,
	helper: string,
): ExpressionIntent {
	switch (typeof leaf) {
		case 'string':
			return { kind: 'ref', column: leaf } satisfies RefExpressionIntent;
		case 'number':
			return Number.isFinite(leaf)
				? ({ kind: 'literal', value: leaf } satisfies LiteralExpressionIntent)
				: ({ kind: 'param', value: leaf } satisfies ParamExpressionIntent);
		case 'boolean':
			return { kind: 'literal', value: leaf } satisfies LiteralExpressionIntent;
		case 'bigint':
			return leaf >= BigInt(Number.MIN_SAFE_INTEGER) &&
				leaf <= BigInt(Number.MAX_SAFE_INTEGER)
				? ({
						kind: 'literal',
						value: Number(leaf),
					} satisfies LiteralExpressionIntent)
				: ({ kind: 'param', value: leaf } satisfies ParamExpressionIntent);
		case 'undefined':
			return refuse(helper, 'undefined');
		case 'object':
			break;
		default:
			return refuse(helper, `a ${typeof leaf}`);
	}
	if (leaf === null) return refuse(helper, 'null');
	if (Array.isArray(leaf) || leaf instanceof Date)
		return { kind: 'param', value: leaf } satisfies ParamExpressionIntent;
	if (isBrandedExpression(leaf)) return leaf.intent;
	if (isSubqueryExpression(leaf))
		return {
			kind: 'subquery',
			query: leaf.intent,
		} satisfies SubqueryExpressionIntent;
	if (isColumnRef(leaf)) {
		if (
			(leaf as { readonly [CALLBACK_SCOPE]?: object })[CALLBACK_SCOPE] !==
			undefined
		)
			throw new NotYetSupportedError(
				'a callback-scoped ColumnRef',
				EXPRESSION_ARGUMENT,
				1052,
			);
		if (isRelationPathColumn(leaf))
			throw new NotYetSupportedError(
				'a relation-reached ColumnRef',
				EXPRESSION_ARGUMENT,
				1052,
			);
		return {
			kind: 'ref',
			column: getColumnName(leaf),
		} satisfies RefExpressionIntent;
	}
	if (REF_BRAND in leaf)
		return {
			kind: 'ref',
			column: (leaf as RefDefinition).target,
		} satisfies RefExpressionIntent;
	if (isOuterRef(leaf))
		throw new NotYetSupportedError('outerRef()', EXPRESSION_ARGUMENT, 1029);
	if (isQueryBuilder(leaf))
		throw new NotYetSupportedError(
			'a query builder',
			EXPRESSION_ARGUMENT,
			1053,
		);
	if (isSqlRaw(leaf))
		throw new InvalidOperationError(
			helper,
			'sql() is only accepted as an update or upsert value; use literal(), param() or an expression here',
		);
	return refuse(helper, 'a plain object');
}
