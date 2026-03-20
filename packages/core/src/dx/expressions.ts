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
	CastExpressionIntent,
	CustomFnExpressionIntent,
	CustomOpExpressionIntent,
	ExpressionIntent,
	LiteralExpressionIntent,
	NamedArgExpressionIntent,
	ParamExpressionIntent,
	RefExpressionIntent,
	UnaryExpressionIntent,
	WhereExpressionIntent,
} from '../intent-ast.js';

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
export type ExprInput =
	| ExpressionRef
	| string
	| number
	| boolean
	| readonly unknown[];

// ============================================================================
// Internal helpers
// ============================================================================

function toExpressionIntent(input: ExprInput): ExpressionIntent {
	if (input instanceof ExpressionRef) return input.intent;
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
		this.intent = intent;
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
	return new ExpressionRef({ kind: 'ref', column } satisfies RefExpressionIntent);
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
export function op(
	operator: string,
	left: ExprInput,
	right: ExprInput,
): ExpressionRef {
	if (!operator || !OPERATOR_PATTERN.test(operator)) {
		throw new Error(`Invalid operator: ${operator}`);
	}
	return new ExpressionRef({
		kind: 'customOp',
		operator,
		left: toExpressionIntent(left),
		right: toExpressionIntent(right),
	} satisfies CustomOpExpressionIntent);
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
export function fn(name: string, ...args: ExprInput[]): ExpressionRef {
	if (!name || !FUNCTION_NAME_PATTERN.test(name)) {
		throw new Error(`Invalid function name: ${name}`);
	}
	return new ExpressionRef({
		kind: 'customFn',
		name,
		args: args.map(toExpressionIntent),
	} satisfies CustomFnExpressionIntent);
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
	return new ExpressionRef({
		kind: 'namedArg',
		name,
		value: toExpressionIntent(value),
	} satisfies NamedArgExpressionIntent);
}
