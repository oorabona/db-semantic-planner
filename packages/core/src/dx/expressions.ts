/**
 * @module expressions
 * Dialect-agnostic expression primitives for custom operators, functions, and type casts.
 *
 * These primitives allow constructing arbitrary SQL expressions in a safe, parameterized
 * way — without raw SQL concatenation. Designed as the foundation for dialect extensions
 * (e.g., pgvector, ParadeDB) and advanced query needs.
 *
 * @example
 * ```typescript
 * import { op, ref, param, cast, fn, literal } from '@dbsp/core';
 *
 * // pgvector cosine distance: vector <=> $1::vector
 * const dist = op('<=>', ref('embedding'), cast(param([0.1, 0.2, 0.3]), 'vector'));
 *
 * // Use in SELECT with alias
 * orm.select('items').column(dist.as('score'))
 *
 * // Use in WHERE
 * orm.select('items').where(dist.gte(0.5))
 *
 * // Use in ORDER BY
 * orm.select('items').orderBy(dist, 'asc')
 * ```
 */

import type {
	AggOrderByArg,
	ArrayExpressionIntent,
	CastExpressionIntent,
	CustomFnExpressionIntent,
	CustomOpExpressionIntent,
	ExpressionIntent,
	LiteralExpressionIntent,
	NamedArgExpressionIntent,
	ParamExpressionIntent,
	PredicateOperator,
	RefExpressionIntent,
	StandaloneWhereExpressionIntent,
	StarExpressionIntent,
	UnaryExpressionIntent,
	WhereExpressionIntent,
	WhereIntent,
} from '../intent-ast.js';
import { InvalidOperationError } from './errors.js';
import type { DistinctField } from './filters.js';
import { isDistinctField as isDistinctFieldValue } from './filters.js';
import type { ExpressionSpec } from './types.js';

// ============================================================================
// Validation patterns
// ============================================================================

const OPERATOR_PATTERN = /^[a-zA-Z_<>=!@#%^&|~*+\-/.]+$/;
const FUNCTION_NAME_PATTERN =
	/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/;
const TYPE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_ ]*(\[\])?$/;

// ============================================================================
// ExprInput type
// ============================================================================

/**
 * Accepted input types for op() and fn() arguments.
 * - `ExpressionRef` → used as-is
 * - `string` → implicitly converted to ref() (column reference)
 * - `number | boolean | readonly unknown[]` → implicitly converted to param() (bound value)
 *
 * Use `ref()` / `param()` explicitly for ambiguous cases (e.g., a string that is a value,
 * not a column name → use `literal()` instead).
 */
/**
 * Accepted input types for op() and fn() arguments.
 * - `ExpressionRef` → used as-is
 * - `string` → implicitly converted to ref() (column reference)
 * - `number | boolean | readonly unknown[]` → implicitly converted to param() (bound value)
 * - `AggOrderByArg` → ORDER BY entry inside an aggregate (fn() only)
 *
 * Use `ref()` / `param()` explicitly for ambiguous cases (e.g., a string that is a value,
 * not a column name → use `literal()` instead).
 */
export type ExprInput =
	| ExpressionRef
	| ExpressionSpec
	| AggOrderByArg
	| string
	| number
	| boolean
	| readonly unknown[];

export type { PredicateOperator } from '@dbsp/types';

type BinaryPredicateOperator = Exclude<PredicateOperator, 'AND' | 'OR' | 'NOT'>;

type NonPredicateOperator<TOperator extends string> =
	TOperator extends PredicateOperator ? never : TOperator;

// ============================================================================
// Internal helpers
// ============================================================================

function toExpressionIntent(input: ExprInput): ExpressionIntent {
	// ExpressionRef check first — fastest path for the common case.
	if (input instanceof ExpressionRef) return input.intent;
	// Duck-type check AFTER instanceof: SubqueryExpression.asExpr() returns a plain
	// { __expr: true, intent } object (not an ExpressionRef instance), so instanceof
	// would miss it. Order matters: instanceof must come first.
	if (
		typeof input === 'object' &&
		input !== null &&
		'__expr' in input &&
		(input as { __expr: unknown }).__expr === true &&
		'intent' in input
	) {
		return (input as { intent: ExpressionIntent }).intent;
	}
	if (typeof input === 'string') {
		return { kind: 'ref', column: input } satisfies RefExpressionIntent;
	}
	return { kind: 'param', value: input } satisfies ParamExpressionIntent;
}

// ============================================================================
// ExpressionRef — chainable wrapper around ExpressionIntent
// ============================================================================

/**
 * A chainable wrapper around an ExpressionIntent.
 *
 * Created by factory functions (`op`, `fn`, `ref`, `param`, `cast`, `literal`, `unary`).
 * Can be used in:
 * - `.column(expr.as('alias'))` — SELECT with alias
 * - `.where(expr.gte(0.5))` — WHERE with comparison
 * - `.orderBy(expr, 'asc')` — ORDER BY expression
 *
 * Implements the `ExpressionSpec` duck-type interface (`__expr: true`, `intent`).
 */
export class ExpressionRef {
	readonly __expr: true = true;
	readonly intent: ExpressionIntent;

	constructor(intent: ExpressionIntent) {
		this.intent = Object.freeze(intent);
	}

	/**
	 * Set an alias for this expression in SELECT.
	 * Returns a new ExpressionRef — does not mutate.
	 */
	as(alias: string): ExpressionRef {
		return new ExpressionRef({
			...this.intent,
			as: alias,
		} as ExpressionIntent);
	}

	/** WHERE: expr = value */
	eq(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'eq', value };
	}

	/** WHERE: expr != value */
	neq(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'neq', value };
	}

	/** WHERE: expr > value */
	gt(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'gt', value };
	}

	/** WHERE: expr >= value */
	gte(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'gte', value };
	}

	/** WHERE: expr < value */
	lt(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'lt', value };
	}

	/** WHERE: expr <= value */
	lte(value: unknown): WhereExpressionIntent {
		return { kind: 'expression', expr: this.intent, operator: 'lte', value };
	}

	/**
	 * Add a FILTER (WHERE ...) clause to this function expression.
	 * Valid on `fn()` expressions (customFn kind), including DISTINCT calls
	 * produced by `fn(aggName, distinct(field))` (still customFn kind).
	 * Returns a new ExpressionRef — does not mutate.
	 *
	 * NOTE: the FILTER clause is only emitted when the expression is used in
	 * column position (`.columns([...])`) — the adapter patches it in at that
	 * one SELECT-list branch (compiler.ts). Using `.filter()` inside
	 * `.orderBy()`, `.having()`, `cast()`, or any other nested context compiles
	 * successfully but silently drops the FILTER clause (tracked separately,
	 * not specific to DISTINCT).
	 *
	 * @example fn('array_agg', ref('name')).filter(eq('active', true))
	 *          → array_agg("name") FILTER (WHERE "active" = $1)   // in .columns()
	 * @example fn('count', distinct('id')).filter(eq('active', true))
	 *          → count(DISTINCT id) FILTER (WHERE "active" = $1)  // in .columns()
	 * @throws Error if called on any other expression kind
	 */
	filter(condition: WhereIntent): ExpressionRef {
		if (this.intent.kind !== 'customFn') {
			throw new Error(
				`filter() can only be used on function expressions created with fn(). Got kind: '${this.intent.kind}'`,
			);
		}
		return new ExpressionRef({
			...this.intent,
			filter: condition,
		} as CustomFnExpressionIntent);
	}
}

/** Marker used to identify an invalid predicate from a different core copy. */
export const PREDICATE_REF_DISCRIMINATOR = 'dbsp.predicate.v1' as const;

/**
 * A predicate that is also a scalar expression.
 *
 * Its one canonical representation is the expression intent inherited from
 * `ExpressionRef`; the WHERE form is derived when a builder consumes it.
 */
class ExpressionPredicateRef extends ExpressionRef {
	readonly __predicateRef = PREDICATE_REF_DISCRIMINATOR;
	declare readonly intent: StandaloneWhereExpressionIntent;

	constructor(intent: StandaloneWhereExpressionIntent) {
		super(Object.freeze(intent));
		Object.freeze(this);
	}

	override as(alias: string): PredicateExpressionRef {
		return new ExpressionPredicateRef({
			...this.intent,
			as: alias,
		} as StandaloneWhereExpressionIntent);
	}
}

/** A scalar predicate created by `op()`, `boolFn()`, or `unsafeAsPredicate()`. */
export type PredicateExpressionRef = ExpressionPredicateRef;

/**
 * A composed predicate has no scalar-expression representation in this API.
 * Its canonical representation is the complete WHERE intent.
 */
class WhereOnlyPredicateRef {
	readonly __predicateRef = PREDICATE_REF_DISCRIMINATOR;

	constructor(readonly intent: WhereIntent) {
		if (intent.kind === 'and' || intent.kind === 'or') {
			Object.freeze(intent.conditions);
		}
		Object.freeze(intent);
		Object.freeze(this);
	}
}

/** A composed predicate that is accepted only in `.where()`. */
export type WhereOnlyPredicate = WhereOnlyPredicateRef;

/**
 * A value accepted by `.where()` as a predicate.
 *
 * The constructors are intentionally module-private. Use `op()`, predicate
 * helpers, or `unsafeAsPredicate()` instead.
 */
export type PredicateRef = PredicateExpressionRef | WhereOnlyPredicate;

/**
 * Recognize only predicate instances constructed by this installed core copy.
 *
 * A predicate from another installed copy is unsupported: reconstruct it with
 * this module's predicate factories before passing it to a builder.
 */
export function isPredicateRef(value: unknown): value is PredicateRef {
	return (
		value instanceof ExpressionPredicateRef ||
		value instanceof WhereOnlyPredicateRef
	);
}

/** @internal Detect a rejected foreign predicate before object-filter conversion. */
export function hasPredicateRefDiscriminator(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { __predicateRef?: unknown }).__predicateRef ===
			PREDICATE_REF_DISCRIMINATOR
	);
}

function isExpressionPredicateRef(
	predicate: PredicateRef,
): predicate is PredicateExpressionRef {
	return '__expr' in predicate && predicate.__expr === true;
}

/** Derive the WHERE representation from a predicate's single canonical intent. */
export function predicateWhereIntent(predicate: PredicateRef): WhereIntent {
	return isExpressionPredicateRef(predicate)
		? { kind: 'expression', expr: predicate.intent }
		: predicate.intent;
}

// ============================================================================
// Factory functions
// ============================================================================

/**
 * Column reference — refers to a named column (or table.column).
 *
 * @example ref('embedding') → "embedding"
 * @example ref('t.score') → "t"."score"
 */
export function ref(column: string): ExpressionRef {
	return new ExpressionRef({
		kind: 'ref',
		column,
	} satisfies RefExpressionIntent);
}

/**
 * Parameterized value — automatically bound as $N.
 * Use for user-supplied values, vectors, dynamic data.
 *
 * @example param([0.1, 0.2]) → $1  (with value bound to $1)
 */
export function param(value: unknown): ExpressionRef {
	return new ExpressionRef({
		kind: 'param',
		value,
	} satisfies ParamExpressionIntent);
}

/**
 * Type cast — compiles to expr::typeName or CAST(expr AS typeName).
 *
 * @example cast(param([0.1, 0.2]), 'vector') → $1::vector
 * @throws Error if typeName fails validation (injection guard)
 */
export function cast(expr: ExpressionRef, typeName: string): ExpressionRef {
	if (!TYPE_NAME_PATTERN.test(typeName)) {
		throw new Error(`Invalid type name: ${typeName}`);
	}
	return new ExpressionRef({
		kind: 'cast',
		expr: expr.intent,
		typeName,
	} satisfies CastExpressionIntent);
}

/**
 * Custom binary operator — left OP right.
 * Implicit conversions: string → ref(), number/boolean/array → param().
 *
 * @example op('<=>', ref('embedding'), cast(param([0.1]), 'vector'))
 * @example op('<=>', 'embedding', [0.1, 0.2])  // implicit conversions
 * @throws Error if operator fails validation (injection guard)
 */
/** Logical AND / OR — both operands must be predicates. */
export function op(
	operator: 'AND' | 'OR',
	left: PredicateRef,
	right: PredicateRef,
): WhereOnlyPredicate;

/** Logical NOT — its sole operand must be a predicate. */
export function op(operator: 'NOT', operand: PredicateRef): WhereOnlyPredicate;

/** Predicate binary operators accept expression operands. */
export function op(
	operator: BinaryPredicateOperator,
	left: ExprInput,
	right: ExprInput,
): ExpressionPredicateRef;

/** Any non-predicate operator remains an ordinary expression. */
export function op<TOperator extends string>(
	operator: NonPredicateOperator<TOperator>,
	left: ExprInput,
	right: ExprInput,
): ExpressionRef;

export function op(
	operator: string,
	...operands: (ExprInput | PredicateRef | undefined)[]
): ExpressionRef | WhereOnlyPredicateRef {
	const [left, right] = operands;
	if (!operator || !OPERATOR_PATTERN.test(operator)) {
		throw new Error(`Invalid operator: ${operator}`);
	}

	if (operator === 'AND' || operator === 'OR') {
		if (operands.length !== 2) {
			throw new Error(`${operator} requires exactly two predicate operands`);
		}
		if (!isPredicateRef(left) || !isPredicateRef(right)) {
			throw new Error(`${operator} requires predicate operands`);
		}
		return new WhereOnlyPredicateRef({
			kind: operator === 'AND' ? 'and' : 'or',
			conditions: [predicateWhereIntent(left), predicateWhereIntent(right)],
		});
	}

	if (operator === 'NOT') {
		if (operands.length !== 1) {
			throw new Error('NOT requires exactly one predicate operand');
		}
		if (!isPredicateRef(left)) {
			throw new Error('NOT requires a predicate operand');
		}
		return new WhereOnlyPredicateRef({
			kind: 'not',
			condition: predicateWhereIntent(left),
		});
	}

	if (operands.length !== 2) {
		throw new Error(`${operator} requires exactly two expression operands`);
	}

	const intent = {
		kind: 'customOp',
		operator,
		left: toExpressionIntent(left as ExprInput),
		right: toExpressionIntent(right as ExprInput),
	} satisfies CustomOpExpressionIntent;

	if (isPredicateOperator(operator)) {
		return new ExpressionPredicateRef(intent);
	}
	return new ExpressionRef(intent);
}

/**
 * Assert that an arbitrary expression is boolean for use in WHERE.
 *
 * Use this only for a user-defined operator whose boolean result cannot be
 * represented by the closed PredicateOperator union.
 */
export function unsafeAsPredicate(expr: ExpressionRef): PredicateExpressionRef {
	if (expr instanceof ExpressionPredicateRef) return expr;
	if (!isStandaloneWhereExpressionIntent(expr.intent)) {
		throw new InvalidOperationError(
			'unsafeAsPredicate',
			`unsupported standalone WHERE expression kind '${expr.intent.kind}'`,
		);
	}
	return new ExpressionPredicateRef(expr.intent);
}

function isStandaloneWhereExpressionIntent(
	intent: ExpressionIntent,
): intent is StandaloneWhereExpressionIntent {
	switch (intent.kind) {
		case 'customOp':
		case 'customFn':
		case 'ref':
		case 'param':
		case 'cast':
		case 'literal':
		case 'unary':
		case 'namedArg':
		case 'star':
		case 'array':
		case 'subquery':
		case 'relationColumn':
		case 'case':
			return true;
		default:
			return false;
	}
}

function isPredicateOperator(operator: string): operator is PredicateOperator {
	return (
		operator === '=' ||
		operator === '!=' ||
		operator === '<>' ||
		operator === '<' ||
		operator === '<=' ||
		operator === '>' ||
		operator === '>=' ||
		operator === '@@' ||
		operator === '@@@' ||
		operator === '&&' ||
		operator === '<@' ||
		operator === '@>'
	);
}

/**
 * Custom function call — name(args...).
 * Supports schema-qualified names (e.g., 'paradedb.score', 'ST_Distance').
 * Implicit conversions: string → ref(), number/boolean/array → param().
 *
 * @example fn('now') → now()
 * @example fn('paradedb.score', ref('id')) → paradedb.score("id")
 * @throws Error if name fails validation (injection guard)
 */
/**
 * Custom function call — name(args...).
 * Supports schema-qualified names (e.g., 'paradedb.score', 'ST_Distance').
 * Implicit conversions: string → ref(), number/boolean/array → param().
 *
 * Pass `aggOrderBy('col', 'asc')` args to add ORDER BY inside aggregates:
 * `fn('array_agg', ref('name'), aggOrderBy('path'))` → array_agg("name" ORDER BY "path" ASC)
 *
 * @example fn('now') → now()
 * @example fn('paradedb.score', ref('id')) → paradedb.score("id")
 * @example fn('array_agg', ref('name'), aggOrderBy('path')) → array_agg("name" ORDER BY "path" ASC)
 * @example fn('count', distinct('id')) → count(DISTINCT id)
 * @example fn('string_agg', distinct('x'), literal(',')) → string_agg(DISTINCT x, ',')
 * @throws Error if name fails validation (injection guard)
 */
export function fn(
	name: string,
	...args: (ExprInput | DistinctField)[]
): ExpressionRef {
	if (!name || !FUNCTION_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid function name: ${name}`);
	}
	// A DistinctField argument (e.g. fn('count', distinct('id'))) marks the call
	// DISTINCT and is otherwise compiled like any other arg — via its underlying
	// ref (toExpressionIntent(field)). This routes through the SAME customFn path
	// every other fn() call uses (compileExpressionIntent → funcCall(..., { distinct })),
	// so DISTINCT works in every context (columns/orderBy/having/cast/nested), not just
	// .columns(). No name whitelist: PostgreSQL validates aggregate-ness at call time.
	//
	// SQL DISTINCT is a call-level modifier rendered BEFORE the whole argument list
	// (func(DISTINCT a, b, ...)) — it is not attached to a specific argument. So
	// distinct() is only accepted as the FIRST argument: accepting it at any later
	// position (e.g. fn('string_agg', literal(','), distinct('name'))) would compile
	// to `string_agg(DISTINCT ',', name)`, misrepresenting which argument the caller
	// meant as distinct.
	const regularArgs: ExpressionIntent[] = [];
	const orderByArgs: AggOrderByArg[] = [];
	let distinct = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as ExprInput | DistinctField;
		if (isDistinctField(arg)) {
			if (i !== 0) {
				throw new Error(
					`fn('${name}', ...): distinct() is only supported as the first argument — ` +
						'SQL DISTINCT applies to the whole argument list, not a single position.',
				);
			}
			// DESIGN BOUND: COUNT(DISTINCT *) (and DISTINCT on any other star
			// aggregate) is invalid PostgreSQL — '*' has no columns to
			// deduplicate on. This is the honest typed path (fn(name,
			// distinct(field))) and gets a clear error here, same as
			// buildAggregate's equivalent check for .count/.sum/.avg(distinct(...)).
			// The generic NQL function path (compiler.ts's compileGenericNqlFunction,
			// reached via selectNqlFunction / nested 'aggregate' records) and the
			// direct custom-expression path (custom.ts's 'customFn' case) do NOT
			// have an equivalent guard — they're reached only via hand-built
			// PlanDecision/ExpressionIntent objects (bypassing the typed DX API
			// entirely, e.g. NQL parsing or hand-assembled intent JSON), and a
			// DISTINCT * there compiles to SQL PostgreSQL itself rejects with a
			// syntax error. That's an accepted, loud-failure bound — not a
			// silent-wrong-result — so it is intentionally not pre-guarded at
			// every chokepoint; this comment is the record of that decision.
			const field = arg.field;
			if (field === '*') {
				throw new Error(
					`fn('${name}', distinct('*')): DISTINCT on '*' is not valid SQL — ` +
						"'*' has no columns to deduplicate on. Provide a specific column, " +
						`or omit distinct() (e.g. fn('${name}', star())) for a plain star call.`,
				);
			}
			distinct = true;
			regularArgs.push(toExpressionIntent(field));
		} else if (isAggOrderByArg(arg)) {
			orderByArgs.push(arg);
		} else {
			regularArgs.push(toExpressionIntent(arg));
		}
	}
	const intent: CustomFnExpressionIntent = {
		kind: 'customFn',
		name,
		args: regularArgs,
		...(distinct ? { distinct: true } : {}),
		...(orderByArgs.length > 0 ? { aggOrderBy: orderByArgs } : {}),
	};
	return new ExpressionRef(intent);
}

/**
 * Declare that a custom function call is boolean-valued for use in WHERE.
 *
 * This has the same trust boundary as the SQL function name and arguments the
 * caller writes: use it only when the declared function returns boolean.
 * Unlike `fn()`, which builds a scalar expression, `boolFn()` builds a
 * predicate that can be passed directly to `.where()`.
 *
 * @example boolFn('jsonb_exists', ref('data'), literal('phone'))
 * @throws Error if name fails validation (injection guard)
 */
export function boolFn(
	name: string,
	...args: (ExprInput | DistinctField)[]
): PredicateExpressionRef {
	return new ExpressionPredicateRef(
		fn(name, ...args).intent as CustomFnExpressionIntent,
	);
}

/**
 * Literal value — inlined directly in SQL (not bound as parameter).
 * Use to distinguish SQL string literals from column references.
 *
 * | Call | SQL |
 * |------|-----|
 * | `literal(42)` | `42` (inline integer) |
 * | `literal('text')` | `'text'` (SQL string literal) |
 * | `literal(null)` | `NULL` |
 *
 * @example literal(1) → 1  (for: 1 - (col <=> vec))
 */
export function literal(
	value: string | number | boolean | null,
): ExpressionRef {
	return new ExpressionRef({
		kind: 'literal',
		value,
	} satisfies LiteralExpressionIntent);
}

/**
 * Unary operator — OP expr (prefix form).
 *
 * @example unary('NOT', ref('active')) → NOT "active"
 * @example unary('-', ref('score')) → -"score"
 * @throws Error if operator fails validation (injection guard)
 */
export function unary(operator: string, expr: ExprInput): ExpressionRef {
	if (!operator || !OPERATOR_PATTERN.test(operator)) {
		throw new Error(`Invalid operator: ${operator}`);
	}
	return new ExpressionRef({
		kind: 'unary',
		operator,
		operand: toExpressionIntent(expr),
	} satisfies UnaryExpressionIntent);
}

/**
 * Named argument for function calls: name => value.
 * Use inside fn() args to produce PostgreSQL named-argument syntax.
 *
 * @example namedArg('field', literal('name_searchable'))
 *          → field => 'name_searchable'
 * @example namedArg('query_string', param('hello'))
 *          → query_string => $1
 */
export function namedArg(name: string, value: ExprInput): ExpressionRef {
	if (!name || !FUNCTION_NAME_PATTERN.test(name)) {
		throw new Error(`namedArg: invalid argument name: ${name}`);
	}
	return new ExpressionRef({
		kind: 'namedArg',
		name,
		value: toExpressionIntent(value),
	} satisfies NamedArgExpressionIntent);
}

/** SQL wildcard (*) — use in fn('count', star()) for COUNT(*) */
export function star(): ExpressionRef {
	return new ExpressionRef({ kind: 'star' } satisfies StarExpressionIntent);
}

/**
 * PostgreSQL ARRAY constructor: ARRAY[item1, item2, ...]
 *
 * @example array(literal(1), literal(2), literal(3)) → ARRAY[1, 2, 3]
 * @example array(ref('name'), ref('kind')) → ARRAY["name", "kind"]
 */
export function array(...items: ExprInput[]): ExpressionRef {
	return new ExpressionRef({
		kind: 'array',
		elements: items.map(toExpressionIntent),
	} satisfies ArrayExpressionIntent);
}

// ============================================================================
// Aggregate ORDER BY helpers (FR-9)
// ============================================================================

/**
 * Type guard for DistinctField — distinguishes the `distinct('col')` marker
 * from regular ExprInput values inside fn() argument lists. Delegates the
 * core recognition to filters.ts's isDistinctField (the single canonical
 * check, shared with .count()/.sum()/.avg()) and additionally excludes
 * arrays/ExpressionRef, which are other possible ExprInput shapes here.
 */
function isDistinctField(input: unknown): input is DistinctField {
	return (
		!Array.isArray(input) &&
		!(input instanceof ExpressionRef) &&
		isDistinctFieldValue(input)
	);
}

/**
 * Type guard for AggOrderByArg — distinguishes aggregate ORDER BY markers
 * from regular ExprInput values inside fn() argument lists.
 */
function isAggOrderByArg(input: ExprInput): input is AggOrderByArg {
	return (
		typeof input === 'object' &&
		input !== null &&
		!Array.isArray(input) &&
		!(input instanceof ExpressionRef) &&
		'__aggOrderBy' in input &&
		(input as AggOrderByArg).__aggOrderBy === true
	);
}

/**
 * Creates an ORDER BY marker for use as an argument to `fn()`.
 * When passed to `fn()`, the compiler places it in the aggregate's
 * ORDER BY clause instead of in the regular argument list.
 *
 * @example fn('array_agg', ref('name'), aggOrderBy('path')) → array_agg("name" ORDER BY "path" ASC)
 * @example fn('array_agg', ref('name'), aggOrderBy('path', 'desc')) → array_agg("name" ORDER BY "path" DESC)
 */
export function aggOrderBy(
	field: string,
	direction: 'asc' | 'desc' = 'asc',
): AggOrderByArg {
	return { __aggOrderBy: true, field, direction };
}

/**
 * Shorthand for `fn('array_agg', col, ...orderByArgs)`.
 *
 * @example arrayAgg(ref('name')) → array_agg("name")
 * @example arrayAgg(ref('name'), aggOrderBy('path')) → array_agg("name" ORDER BY "path" ASC)
 * @example arrayAgg('name', aggOrderBy('path', 'desc')) → array_agg("name" ORDER BY "path" DESC)
 * @example arrayAgg(distinct('name')) → array_agg(DISTINCT name)
 */
export function arrayAgg(
	col: ExpressionRef | string | DistinctField,
	...rest: AggOrderByArg[]
): ExpressionRef {
	const colExpr: ExpressionRef | DistinctField =
		typeof col === 'string' ? ref(col) : col;
	return fn('array_agg', colExpr, ...rest);
}

/**
 * Shorthand for `fn('string_agg', col, separator, ...orderByArgs)`.
 *
 * @example stringAgg(ref('name'), literal(',')) → string_agg("name", ',')
 * @example stringAgg(ref('name'), literal(','), aggOrderBy('name')) → string_agg("name", ',' ORDER BY "name" ASC)
 * @example stringAgg(distinct('name'), literal(',')) → string_agg(DISTINCT name, ',')
 */
export function stringAgg(
	col: ExpressionRef | string | DistinctField,
	separator: ExpressionRef,
	...rest: AggOrderByArg[]
): ExpressionRef {
	const colExpr: ExpressionRef | DistinctField =
		typeof col === 'string' ? ref(col) : col;
	return fn('string_agg', colExpr, separator, ...rest);
}
