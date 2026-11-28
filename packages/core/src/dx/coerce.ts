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
 *   supported;
 * - {@link toSubqueryExpression} turns a select query builder or a
 *   `subquery(table)` builder into a subquery that keeps the builder's filter
 *   policy, and refuses every other builder by name.
 *
 * None of them binds an expression object, a builder, a `ColumnRef`, an
 * `outerRef()` or a `sql()` marker as a parameter value.
 */

import { EXPRESSION_BRAND, NotYetSupportedError, REF_BRAND } from '@dbsp/types';
import type {
	ExpressionIntent,
	LiteralExpressionIntent,
	ParamExpressionIntent,
	QueryIntent,
	RefExpressionIntent,
	SubqueryExpressionIntent,
	SubqueryRefIntent,
} from '../intent-ast.js';
import { forEachTypedFunctionArgs } from '../path-ref-scan.js';
import { CaseBuilder } from './case-when-builder.js';
import { getColumnName, isRelationPathColumn } from './column-utils.js';
import { InvalidOperationError } from './errors.js';
import { ExpressionRef } from './expressions.js';
import { isSqlRaw } from './filters.js';
import type { QueryBuilder } from './query-builder-types.js';
import type { RefDefinition } from './schema.js';
import {
	isSubqueryExpression,
	SubqueryBuilder,
	SubqueryExpression,
} from './subquery-builder.js';
import {
	CALLBACK_SCOPE,
	NON_SUBQUERY_BUILDER_BRAND,
	SELECT_BUILDER_BRAND,
} from './symbols.js';
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
 *   `SubqueryExpression`, schema `ref()`) is used as is;
 * - a select query builder (`orm.select(...)`) or a `subquery(table)` builder
 *   is a scalar subquery that keeps the builder's filter policy.
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
	| RefDefinition
	| QueryBuilder<unknown>
	| SubqueryBuilder;

const EXPRESSION_ARGUMENT = 'expression argument';
const COMPARISON_VALUE = 'comparison value';
const NOT_A_SUBQUERY =
	'this builder is not a subquery; use orm.select(...), subquery(table) or a SubqueryExpression';

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

function isSelectBuilder(
	leaf: object,
): leaf is { buildSubqueryIntent(): QueryIntent } {
	return (
		(leaf as { readonly [SELECT_BUILDER_BRAND]?: unknown })[
			SELECT_BUILDER_BRAND
		] === true
	);
}

/**
 * Whether a value is a builder that becomes a scalar subquery: a select query
 * builder or a `subquery(table)` builder.
 */
export function isSubqueryLeafBuilder(leaf: unknown): boolean {
	return (
		typeof leaf === 'object' &&
		leaf !== null &&
		(leaf instanceof SubqueryBuilder || isSelectBuilder(leaf))
	);
}

/**
 * Any other builder: a branded set-operation, CTE, recursive, NQL or mutation
 * builder, or any other object exposing `buildIntent` or `buildSubqueryIntent`.
 */
function isNonSubqueryBuilder(leaf: object): boolean {
	if (leaf instanceof SubqueryBuilder || isSelectBuilder(leaf)) return false;
	if (
		(leaf as { readonly [NON_SUBQUERY_BUILDER_BRAND]?: unknown })[
			NON_SUBQUERY_BUILDER_BRAND
		] === true
	)
		return true;
	const candidate = leaf as {
		buildIntent?: unknown;
		buildSubqueryIntent?: unknown;
	};
	return (
		typeof candidate.buildIntent === 'function' ||
		typeof candidate.buildSubqueryIntent === 'function'
	);
}

/**
 * Convert a subquery-shaped argument to a `SubqueryExpression` (ADR 0011):
 * - a `SubqueryExpression` is returned unchanged;
 * - a `subquery(table)` builder is built without a policy of its own, so its
 *   body inherits the filters in force where it is planned;
 * - a select query builder issues its body with its own policy: its ORM's
 *   default filters, or none for `withoutDefaultFilters()` and for an ORM
 *   without default filters.
 *
 * @returns `undefined` when the value is not a builder or a subquery
 * @throws InvalidOperationError for any other builder (set operation, CTE,
 *   recursive, NQL, insert, update, upsert, delete) and for an object exposing
 *   `buildIntent` or `buildSubqueryIntent`
 */
export function toSubqueryExpression(
	leaf: unknown,
	helper: string,
): SubqueryExpression | undefined {
	if (typeof leaf !== 'object' || leaf === null) return undefined;
	if (isSubqueryExpression(leaf)) return leaf;
	if (leaf instanceof SubqueryBuilder) return leaf.build();
	if (isSelectBuilder(leaf))
		return new SubqueryExpression(leaf.buildSubqueryIntent());
	if (isNonSubqueryBuilder(leaf))
		throw new InvalidOperationError(helper, NOT_A_SUBQUERY);
	return undefined;
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
 * @param position - The position named in a not-yet refusal
 * @throws InvalidOperationError for `null`, `undefined`, a `sql()` marker, a
 *   builder that is not a subquery (see {@link toSubqueryExpression}) and any
 *   other plain object (a hand-built intent included)
 * @throws NotYetSupportedError for `outerRef()` and a relation-reached or
 *   callback-scoped `ColumnRef`
 */
export function coerceReference(
	leaf: unknown,
	helper: string,
	position: string = EXPRESSION_ARGUMENT,
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
				position,
				1052,
			);
		if (isRelationPathColumn(leaf))
			throw new NotYetSupportedError(
				'a relation-reached ColumnRef',
				position,
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
		throw new NotYetSupportedError('outerRef()', position, 1029);
	const subquery = toSubqueryExpression(leaf, helper);
	if (subquery !== undefined)
		return {
			kind: 'subquery',
			query: subquery.intent,
		} satisfies SubqueryExpressionIntent;
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
	| RefDefinition
	| QueryBuilder<unknown>
	| SubqueryBuilder;

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
	| SubqueryRefIntent
	| QueryBuilder<unknown>
	| SubqueryBuilder;

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
 * returned unchanged; core compiles them. A `ColumnRef`, a bare
 * `SubqueryExpression`, a select query builder and a `subquery(table)` builder
 * become an `ExpressionRef` (a builder keeps its filter policy, see
 * {@link toSubqueryExpression}).
 *
 * @param leaf - The value as the caller passed it
 * @param helper - The public helper name, used in refusal messages
 * @param position - The position named in a not-yet refusal
 * @throws InvalidOperationError for a `sql()` marker, an unfinished
 *   `caseWhen()` and a builder that is not a subquery
 * @throws NotYetSupportedError for a relation-reached or callback-scoped
 *   `ColumnRef`
 */
export function coerceValue(
	leaf: unknown,
	helper: string,
	position: string = COMPARISON_VALUE,
): unknown {
	if (typeof leaf !== 'object' || leaf === null) return leaf;
	if (Array.isArray(leaf) || leaf instanceof Date) return leaf;
	if (isBrandedExpression(leaf) || REF_BRAND in leaf || isOuterRef(leaf))
		return leaf;
	if (isColumnRef(leaf))
		return new ExpressionRef(coerceReference(leaf, helper, position));
	const subquery = toSubqueryExpression(leaf, helper);
	if (subquery !== undefined)
		return new ExpressionRef({
			kind: 'subquery',
			query: subquery.intent,
		} satisfies SubqueryExpressionIntent);
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
	if (isSubqueryLeafBuilder(leaf)) return 'a query builder';
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

const TYPED_FUNCTION = 'typed function';
const TYPED_FUNCTION_GUIDANCE = 'build the call with fn(name, ...args)';

/**
 * The kind of a DX object passed as an argument of a `{ kind: 'function' }`
 * intent (a typed function intent, NQL's form), in the words of
 * {@link leafKind}; `undefined` for the forms such an argument takes: a
 * string, a number or another plain value, an array, a plain object, an
 * intent record.
 */
function typedFunctionObjectKind(arg: unknown): string | undefined {
	if (typeof arg !== 'object' || arg === null) return undefined;
	if (Array.isArray(arg) || arg instanceof Date) return undefined;
	const kind = expressionKind(arg);
	if (kind !== undefined) return kind;
	if (isNonSubqueryBuilder(arg)) return 'a query builder';
	if (isSqlRaw(arg)) return 'a sql() marker';
	if (arg instanceof CaseBuilder) return 'an unfinished caseWhen()';
	return undefined;
}

/**
 * Refuse a DX object among the arguments of a typed function intent (ADR
 * 0011, #1116). The intent takes NQL's argument forms and binds or refuses
 * anything else as data; `fn(name, ...args)` is the helper that applies the
 * leaf rule to function arguments. `args` that is not an array is left to the
 * compiler.
 *
 * @throws InvalidOperationError naming the object's kind
 */
export function refuseTypedFunctionArguments(args: unknown): void {
	if (!Array.isArray(args)) return;
	for (const arg of args) {
		const kind = typedFunctionObjectKind(arg);
		if (kind !== undefined)
			throw new InvalidOperationError(
				TYPED_FUNCTION,
				`${kind} is not a typed function argument; ${TYPED_FUNCTION_GUIDANCE}`,
			);
	}
}

/**
 * Apply {@link refuseTypedFunctionArguments} to every typed function intent
 * reachable from a query (`isQuery`) or from a condition or expression root,
 * every body below it included.
 */
export function refuseTypedFunctionObjects(
	root: unknown,
	isQuery: boolean,
): void {
	forEachTypedFunctionArgs(root, isQuery, refuseTypedFunctionArguments);
}

/**
 * The refusal of a ref resolved from its origin (a `pathRef` or callback
 * node) inside a typed function argument: the intent's arguments are not
 * resolved from an origin.
 */
export function refuseTypedFunctionOriginRef(): never {
	throw new InvalidOperationError(
		TYPED_FUNCTION,
		`a ref resolved from its origin is not a typed function argument; ${TYPED_FUNCTION_GUIDANCE}`,
	);
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
	if (isNonSubqueryBuilder(leaf))
		throw new InvalidOperationError(helper, NOT_A_SUBQUERY);
	const kind = expressionKind(leaf);
	if (kind !== undefined) throw new NotYetSupportedError(kind, position, issue);
}

/**
 * Check one element of an `inArray`, `any` or `$in` list (ADR 0011, value
 * position). The list is bound as one array, so it cannot carry an expression
 * yet (#1064). `param(v)` elements are kept; plain values, `null` and
 * `undefined` are kept.
 *
 * @throws InvalidOperationError for a `sql()` marker, an unfinished
 *   `caseWhen()` or a builder that is not a subquery
 * @throws NotYetSupportedError for any other expression object, a query builder
 *   included
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
 * @throws InvalidOperationError for a `sql()` marker, an unfinished
 *   `caseWhen()` or a builder that is not a subquery
 * @throws NotYetSupportedError for any other expression object, a query builder
 *   included
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
		isSubqueryLeafBuilder(leaf) ||
		isNonSubqueryBuilder(leaf) ||
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
	if (typeof leaf === 'object' && isNonSubqueryBuilder(leaf))
		throw new InvalidOperationError(helper, NOT_A_SUBQUERY);
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
