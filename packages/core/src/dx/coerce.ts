/**
 * @module coerce
 * The leaf rule shared by the expression constructors and the filter helpers
 * (ADR 0011).
 *
 * A helper first recognises its own grammar (names, operators, cast types,
 * `distinct()` and `aggOrderBy()` markers). Every scalar leaf left over goes
 * through one function per position:
 * - {@link coerceReference} (reference position) turns it into an expression
 *   intent or refuses it by name;
 * - {@link coerceValue} (value position) keeps plain values for binding and
 *   turns the expression objects core cannot read on its own into an
 *   `ExpressionRef`;
 * - {@link coerceListElement} and {@link coerceLikePattern} serve the value
 *   positions that cannot carry an expression yet, and refuse one as not yet
 *   supported.
 *
 * None of them binds an expression object, a builder, a `ColumnRef`, an
 * `outerRef()` or a `sql()` marker as a parameter value.
 */

import { EXPRESSION_BRAND, NotYetSupportedError, REF_BRAND } from '@dbsp/types';
import type {
	ExpressionIntent,
	LiteralExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	SubqueryExpressionIntent,
	SubqueryRefIntent,
} from '../intent-ast.js';
import { CaseBuilder } from './case-when-builder.js';
import { getColumnName, isRelationPathColumn } from './column-utils.js';
import { InvalidOperationError } from './errors.js';
import { ExpressionRef } from './expressions.js';
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
			'sql() is only accepted in set(), values(), doUpdate() and batchSet().set(); use literal(), param() or an expression here',
		);
	if (leaf instanceof CaseBuilder)
		throw new InvalidOperationError(helper, UNFINISHED_CASE);
	return refuse(helper, 'a plain object');
}

/**
 * A single `orderBy` leaf (ADR 0011, reference position): a column name, an
 * output-column position, an expression, a `ColumnRef`, a subquery or a schema
 * `ref()`. Arrays, `Date`s, booleans and `bigint`s do not order rows.
 */
export type OrderByLeaf =
	| string
	| number
	| ExpressionRef
	| ExpressionSpec
	| ColumnRef<string, string, unknown>
	| SubqueryExpression
	| RefDefinition;

/**
 * An expression object accepted in a value position (a filter's right
 * operand, an object-filter value): it is compiled as SQL, never bound.
 */
export type ValueExpression =
	| ExpressionRef
	| ExpressionSpec
	| ColumnRef<string, string, unknown>
	| SubqueryExpression
	| RefDefinition
	| SubqueryRefIntent;

const UNFINISHED_CASE =
	'caseWhen() is unfinished; complete it with .else(value) before using it as a value';

function isParamExpression(leaf: object): boolean {
	return (
		isBrandedExpression(leaf) &&
		(leaf.intent as { kind?: unknown }).kind === 'param'
	);
}

/**
 * Coerce one scalar leaf in value position (ADR 0011).
 *
 * Plain values (strings, numbers, booleans, `bigint`, arrays, `Date`, plain
 * objects), `null` and `undefined` are returned unchanged: they are bound.
 * In a filter operand, core still reads the intent shapes
 * `{ kind: 'param', value }`, `{ kind: 'fieldRef', … }` and
 * `{ kind: 'ref', column }` structurally; wrap such an object in `param()` to
 * bind it as data. In a mutation value (`set()`, `values()`, `doUpdate()`,
 * `batchSet().set()`) only branded expressions, schema `ref()` and the
 * `outerRef()` shape are read structurally, and a plain `ParamIntent`-shaped
 * object is unwrapped one level as before (`param(obj)` binds such an object
 * as opaque data); every other plain object is bound.
 * `ExpressionRef`s, branded specs, schema `ref()` and `outerRef()` are
 * returned unchanged; core compiles them. A `ColumnRef` and a bare
 * `SubqueryExpression` become an `ExpressionRef`.
 *
 * @param leaf - The value as the caller passed it
 * @param helper - The public helper name, used in refusal messages
 * @throws InvalidOperationError for a `sql()` marker or an unfinished
 *   `caseWhen()`
 * @throws NotYetSupportedError for a query builder and for a relation-reached
 *   or callback-scoped `ColumnRef`
 */
export function coerceValue(leaf: unknown, helper: string): unknown {
	if (typeof leaf !== 'object' || leaf === null) return leaf;
	if (Array.isArray(leaf) || leaf instanceof Date) return leaf;
	if (isBrandedExpression(leaf) || REF_BRAND in leaf || isOuterRef(leaf))
		return leaf;
	if (isColumnRef(leaf) || isSubqueryExpression(leaf) || isQueryBuilder(leaf))
		return new ExpressionRef(coerceReference(leaf, helper));
	if (isSqlRaw(leaf)) return coerceReference(leaf, helper);
	if (leaf instanceof CaseBuilder)
		throw new InvalidOperationError(helper, UNFINISHED_CASE);
	return leaf;
}

function expressionKind(leaf: object): string | undefined {
	if (isBrandedExpression(leaf)) return 'an expression';
	if (isColumnRef(leaf)) return 'a ColumnRef';
	if (isSubqueryExpression(leaf)) return 'a SubqueryExpression';
	if (REF_BRAND in leaf) return 'ref()';
	if (isOuterRef(leaf)) return 'outerRef()';
	if (isQueryBuilder(leaf)) return 'a query builder';
	return undefined;
}

/**
 * The kind of a leaf, in the words the refusal messages use (`null`,
 * `a number`, `an expression`, `a ColumnRef`, `a plain object` …).
 */
export function leafKind(leaf: unknown): string {
	if (leaf === null) return 'null';
	if (leaf === undefined) return 'undefined';
	if (typeof leaf !== 'object') return `a ${typeof leaf}`;
	const kind = expressionKind(leaf);
	if (kind !== undefined) return kind;
	if (Array.isArray(leaf)) return 'an array';
	if (leaf instanceof Date) return 'a Date';
	if (isSqlRaw(leaf)) return 'a sql() marker';
	if (leaf instanceof CaseBuilder) return 'an unfinished caseWhen()';
	return 'a plain object';
}

/**
 * Whether a value is an expression object in value position, as
 * {@link coerceValue} leaves it: an `ExpressionRef` or branded spec, a schema
 * `ref()` or an `outerRef()`. Plain values, `null`, arrays, `Date`s and plain
 * objects are not.
 */
export function isValueExpression(leaf: unknown): boolean {
	if (typeof leaf !== 'object' || leaf === null) return false;
	return isBrandedExpression(leaf) || REF_BRAND in leaf || isOuterRef(leaf);
}

/**
 * Whether a value-position expression is a `param(v)` wrapper, and its `v`.
 */
export function paramWrapperValue(
	leaf: unknown,
): { readonly value: unknown } | undefined {
	if (typeof leaf !== 'object' || leaf === null) return undefined;
	if (!isParamExpression(leaf)) return undefined;
	return { value: (leaf as { intent: { value: unknown } }).intent.value };
}

function coerceUncarriedValue(
	leaf: unknown,
	helper: string,
	position: string,
	issue: number,
): void {
	if (typeof leaf !== 'object' || leaf === null) return;
	if (Array.isArray(leaf) || leaf instanceof Date) return;
	if (isSqlRaw(leaf)) coerceReference(leaf, helper);
	if (leaf instanceof CaseBuilder)
		throw new InvalidOperationError(helper, UNFINISHED_CASE);
	const kind = expressionKind(leaf);
	if (kind !== undefined) throw new NotYetSupportedError(kind, position, issue);
}

/**
 * Check one element of an `inArray`, `any` or `$in` list (ADR 0011, value
 * position). The list is bound as one array, so it cannot carry an expression
 * yet (#1064). `param(v)` elements are kept; plain values, `null` and
 * `undefined` are kept.
 *
 * @throws InvalidOperationError for a `sql()` marker or an unfinished
 *   `caseWhen()`
 * @throws NotYetSupportedError for any other expression object
 */
export function coerceListElement(leaf: unknown, helper: string): unknown {
	if (typeof leaf === 'object' && leaf !== null && isParamExpression(leaf))
		return leaf;
	coerceUncarriedValue(leaf, helper, 'list element', 1064);
	return leaf;
}

/**
 * Check a `like` pattern (ADR 0011, value position). No `like` route can
 * carry an expression pattern yet (#1066). Plain values and `param()` are
 * kept.
 *
 * @throws InvalidOperationError for a `sql()` marker or an unfinished
 *   `caseWhen()`
 * @throws NotYetSupportedError for any other expression object
 */
export function coerceLikePattern<T>(leaf: T, helper: string): T {
	if (typeof leaf === 'object' && leaf !== null && isParamExpression(leaf))
		return leaf;
	coerceUncarriedValue(leaf, helper, 'like pattern', 1066);
	return leaf;
}

/**
 * Whether a value is one of the objects the leaf rule recognises (an
 * expression, a `ColumnRef`, a subquery, a schema `ref()`, an `outerRef()`, a
 * builder, a `sql()` marker or an unfinished `caseWhen()`), as opposed to a
 * record or options object a helper reads by its keys.
 */
export function isReferenceObject(leaf: unknown): boolean {
	if (typeof leaf !== 'object' || leaf === null) return false;
	return (
		isBrandedExpression(leaf) ||
		isColumnRef(leaf) ||
		isSubqueryExpression(leaf) ||
		REF_BRAND in leaf ||
		isOuterRef(leaf) ||
		isQueryBuilder(leaf) ||
		isSqlRaw(leaf) ||
		leaf instanceof CaseBuilder
	);
}

function notAColumn(helper: string, kind: string): never {
	throw new InvalidOperationError(
		helper,
		`${kind} is not a column; use a column name or a ColumnRef`,
	);
}

/**
 * Coerce a leaf of a position that stores a column name only (GROUP BY,
 * DISTINCT ON, aggregate and window fields; ADR 0011 reference position).
 * A string is kept; a `ColumnRef` becomes its qualified name, or its bare
 * name when it is a column of `ownTable` reached without a relation path.
 * An expression cannot be carried yet (#1072).
 *
 * @param leaf - The argument as the caller passed it
 * @param helper - The public helper name, used in refusal messages
 * @param position - The position named in a not-yet refusal
 * @param ownTable - The query's table, when the compiled SQL qualifies a bare
 *   field there
 */
export function coerceColumnName(
	leaf: unknown,
	helper: string,
	position: string,
	ownTable?: string,
): string {
	if (typeof leaf === 'string') return leaf;
	if (leaf === null) return notAColumn(helper, 'null');
	if (leaf === undefined) return notAColumn(helper, 'undefined');
	if (typeof leaf === 'function') return notAColumn(helper, 'a function');
	if (typeof leaf === 'symbol') return notAColumn(helper, 'a symbol');
	if (typeof leaf === 'object' && isColumnRef(leaf)) {
		if (
			(leaf as { readonly [CALLBACK_SCOPE]?: object })[CALLBACK_SCOPE] !==
			undefined
		)
			throw new NotYetSupportedError(
				'a callback-scoped ColumnRef',
				position,
				1052,
			);
		const name = getColumnName(leaf);
		if (ownTable !== undefined && !isRelationPathColumn(leaf)) {
			const prefix = `${ownTable}.`;
			if (name.startsWith(prefix)) return name.slice(prefix.length);
		}
		return name;
	}
	if (typeof leaf === 'object' && isSqlRaw(leaf))
		throw new InvalidOperationError(
			helper,
			'sql() is only accepted in set(), values(), doUpdate() and batchSet().set(); use literal(), param() or an expression here',
		);
	if (leaf instanceof CaseBuilder)
		throw new InvalidOperationError(helper, UNFINISHED_CASE);
	if (typeof leaf === 'object') {
		const kind = expressionKind(leaf);
		if (kind !== undefined)
			throw new NotYetSupportedError(kind, position, 1072);
		if (Array.isArray(leaf))
			throw new NotYetSupportedError('an array', position, 1072);
		if (leaf instanceof Date)
			throw new NotYetSupportedError('a Date', position, 1072);
		return notAColumn(helper, 'a plain object');
	}
	throw new NotYetSupportedError(`a ${typeof leaf}`, position, 1072);
}
