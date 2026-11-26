/**
 * @module object-filter
 * Object filter syntax for ergonomic WHERE clause building.
 *
 * Converts Prisma/Drizzle-like object syntax to WhereIntent:
 * - `{ status: 'active' }` → `eq('status', 'active')`
 * - `{ age: { $gt: 18 } }` → `gt('age', 18)`
 * - `{ status: 'active', role: 'admin' }` → `and(eq('status', 'active'), eq('role', 'admin'))`
 *
 * @example
 * ```typescript
 * import { createOrm } from '@dbsp/core';
 *
 * // Object syntax (new)
 * orm.select('users').where({ status: 'active', age: { $gte: 18 } })
 *
 * // Equivalent to (legacy)
 * orm.select('users').where(and(eq('status', 'active'), gte('age', 18)))
 * ```
 */

import type {
	ComparisonOperator,
	WhereAndIntent,
	WhereComparisonIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNullIntent,
	WhereSubqueryIntent,
} from '../intent-ast.js';
import {
	coerceLikePattern,
	coerceListElement,
	coerceValue,
	type ValueExpression,
} from './coerce.js';
import { InvalidOperationError } from './errors.js';
import { isSubqueryExpression } from './subquery-builder.js';

// ============================================================================
// Operator Types
// ============================================================================

/**
 * Comparison operators for object filter syntax.
 * Use `$` prefix to distinguish from field names.
 * Values can be literal values or expressions (ADR 0011 value position).
 */
export interface FilterOperators<T = unknown> {
	/** Equals (explicit) - value or expression (subquery, column, ExpressionRef) */
	readonly $eq?: T | ValueExpression;
	/** Not equals - value or expression (subquery, column, ExpressionRef) */
	readonly $neq?: T | ValueExpression;
	/** Greater than - value or expression (subquery, column, ExpressionRef) */
	readonly $gt?: T | ValueExpression;
	/** Greater than or equal - value or expression (subquery, column, ExpressionRef) */
	readonly $gte?: T | ValueExpression;
	/** Less than - value or expression (subquery, column, ExpressionRef) */
	readonly $lt?: T | ValueExpression;
	/** Less than or equal - value or expression (subquery, column, ExpressionRef) */
	readonly $lte?: T | ValueExpression;
	/** In array */
	readonly $in?: readonly T[];
	/** LIKE pattern matching */
	readonly $like?: string;
	/** Case-insensitive LIKE (ILIKE in PostgreSQL) */
	readonly $ilike?: string;
	/** IS NOT NULL check */
	readonly $notNull?: true;
}

/**
 * Filter value for a single field.
 * Can be:
 * - Direct value (equality)
 * - null (IS NULL)
 * - Operator object ({ $gt: 18 })
 */
export type FilterValue<T = unknown> =
	| T
	| null
	| ValueExpression
	| FilterOperators<T>;

/**
 * Object filter type for WHERE clause.
 * Maps field names to filter values.
 *
 * @typeParam T - The row type for type-safe field names.
 *
 * @example
 * ```typescript
 * // Simple equality
 * const filter: WhereFilter<User> = { status: 'active' };
 *
 * // With operators
 * const filter: WhereFilter<User> = {
 *   status: 'active',
 *   age: { $gte: 18 },
 *   email: { $like: '%@example.com' },
 * };
 * ```
 */
export type WhereFilter<T = Record<string, unknown>> = {
	readonly [K in keyof T]?: FilterValue<T[K]>;
};

// ============================================================================
// Type Guards
// ============================================================================

/**
 * The member that every `WhereIntent` of a kind carries, used to tell an
 * intent from an object filter over a column named `kind` (#624).
 */
const WHERE_INTENT_MEMBER: Readonly<Record<WhereIntent['kind'], string>> = {
	and: 'conditions',
	or: 'conditions',
	not: 'condition',
	comparison: 'field',
	like: 'field',
	in: 'field',
	any: 'field',
	null: 'field',
	range: 'field',
	subquery: 'field',
	jsonContains: 'field',
	jsonExists: 'field',
	exists: 'relation',
	notExists: 'relation',
	relationFilter: 'relation',
	rawExists: 'subquery',
	rawNotExists: 'subquery',
	expression: 'expr',
};

/**
 * Check if a value is a WhereIntent (not an object filter).
 *
 * True only when `kind` is a `WhereIntent` kind and the object owns that
 * kind's member (`conditions`, `condition`, `field`, `relation`, `subquery`
 * or `expr`). An object filter over a column named `kind` is therefore not an
 * intent; one that also names the kind's member column is, and is written in
 * operator form instead (`{ kind: { $eq: 'comparison' }, field: 'x' }`).
 */
export function isWhereIntent(value: unknown): value is WhereIntent {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { readonly kind?: unknown }).kind;
	if (typeof kind !== 'string' || !Object.hasOwn(WHERE_INTENT_MEMBER, kind))
		return false;
	return Object.hasOwn(value, WHERE_INTENT_MEMBER[kind as WhereIntent['kind']]);
}

/**
 * Check if a value is an operator object (has $-prefixed keys).
 */
function isOperatorObject(value: unknown): value is FilterOperators {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert a single field-value pair to WhereIntent.
 */
function convertFieldValue(field: string, value: FilterValue): WhereIntent {
	// Handle null → isNull
	if (value === null) {
		return {
			kind: 'null',
			field,
			operator: 'isNull',
		} satisfies WhereNullIntent;
	}

	// Handle operator object
	if (isOperatorObject(value)) {
		return convertOperatorObject(field, value);
	}

	// Handle direct value → equality
	return {
		kind: 'comparison',
		field,
		operator: 'eq',
		value: coerceValue(value, 'where'),
	} satisfies WhereComparisonIntent;
}

/**
 * Create a comparison intent (value or subquery).
 */
function createComparisonIntent(
	field: string,
	operator: ComparisonOperator,
	value: unknown,
): WhereIntent {
	if (isSubqueryExpression(value)) {
		return value.toWhereIntent(field, operator) satisfies WhereSubqueryIntent;
	}
	return {
		kind: 'comparison',
		field,
		operator,
		value: coerceValue(value, 'where'),
	} satisfies WhereComparisonIntent;
}

/**
 * Convert an operator object to WhereIntent.
 */
function convertOperatorObject(
	field: string,
	ops: FilterOperators,
): WhereIntent {
	const conditions: WhereIntent[] = [];

	// $eq
	if (Object.hasOwn(ops, '$eq') && ops.$eq !== undefined) {
		conditions.push(createComparisonIntent(field, 'eq', ops.$eq));
	}

	// $neq
	if (Object.hasOwn(ops, '$neq') && ops.$neq !== undefined) {
		conditions.push(createComparisonIntent(field, 'neq', ops.$neq));
	}

	// $gt
	if (Object.hasOwn(ops, '$gt') && ops.$gt !== undefined) {
		conditions.push(createComparisonIntent(field, 'gt', ops.$gt));
	}

	// $gte
	if (Object.hasOwn(ops, '$gte') && ops.$gte !== undefined) {
		conditions.push(createComparisonIntent(field, 'gte', ops.$gte));
	}

	// $lt
	if (Object.hasOwn(ops, '$lt') && ops.$lt !== undefined) {
		conditions.push(createComparisonIntent(field, 'lt', ops.$lt));
	}

	// $lte
	if (Object.hasOwn(ops, '$lte') && ops.$lte !== undefined) {
		conditions.push(createComparisonIntent(field, 'lte', ops.$lte));
	}

	// $in
	if (Object.hasOwn(ops, '$in') && ops.$in !== undefined) {
		conditions.push({
			kind: 'in',
			field,
			values: Array.isArray(ops.$in)
				? ops.$in.map((v) => coerceListElement(v, 'where'))
				: ops.$in,
		} satisfies WhereInIntent);
	}

	// $like
	if (Object.hasOwn(ops, '$like') && ops.$like !== undefined) {
		conditions.push({
			kind: 'like',
			field,
			pattern: coerceLikePattern(ops.$like, 'where'),
		} satisfies WhereLikeIntent);
	}

	// $ilike (case-insensitive)
	if (Object.hasOwn(ops, '$ilike') && ops.$ilike !== undefined) {
		conditions.push({
			kind: 'like',
			field,
			pattern: coerceLikePattern(ops.$ilike, 'where'),
			caseInsensitive: true,
		} satisfies WhereLikeIntent);
	}

	// $notNull
	if (Object.hasOwn(ops, '$notNull') && ops.$notNull === true) {
		conditions.push({
			kind: 'null',
			field,
			operator: 'isNotNull',
		} satisfies WhereNullIntent);
	}

	// Return single condition or AND
	if (conditions.length === 0) {
		throw new Error(
			`Invalid filter: operator object for field "${field}" has no recognized operators`,
		);
	}

	if (conditions.length === 1) {
		// Type assertion safe: length check guarantees element exists
		return conditions[0] as WhereIntent;
	}

	return { kind: 'and', conditions } satisfies WhereAndIntent;
}

// Keys that must never appear in a filter object — they target prototype slots
// and can poison object properties on older engines. Defined at module scope
// so the Set is allocated once, not per call.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Convert an object filter to WhereIntent.
 *
 * @param filter - Object filter with field-value pairs
 * @returns WhereIntent for use in QueryBuilder.where()
 *
 * @example
 * ```typescript
 * // Single field
 * objectToWhereIntent({ status: 'active' })
 * // → { kind: 'comparison', field: 'status', operator: 'eq', value: 'active' }
 *
 * // Multiple fields (AND)
 * objectToWhereIntent({ status: 'active', role: 'admin' })
 * // → { kind: 'and', conditions: [...] }
 *
 * // With operators
 * objectToWhereIntent({ age: { $gte: 18, $lt: 65 } })
 * // → { kind: 'and', conditions: [gte, lt] }
 * ```
 */
export function objectToWhereIntent(
	filter: WhereFilter<Record<string, unknown>>,
): WhereIntent {
	// FIND-005: Reject prototype-poisoning keys before any processing.
	// Object.keys() already returns only own enumerable properties — the
	// hasOwn check below was redundant and has been removed.
	for (const key of Object.keys(filter)) {
		if (FORBIDDEN_KEYS.has(key)) {
			throw new InvalidOperationError(
				'where',
				`Filter key not allowed: ${key}`,
			);
		}
	}

	const entries = Object.entries(filter);

	if (entries.length === 0) {
		throw new Error('Invalid filter: empty object');
	}

	const conditions: WhereIntent[] = entries.map(([field, value]) =>
		convertFieldValue(field, value as FilterValue),
	);

	// Single condition → return directly
	if (conditions.length === 1) {
		// Type assertion safe: length check guarantees element exists
		return conditions[0] as WhereIntent;
	}

	// Multiple conditions → AND
	return { kind: 'and', conditions } satisfies WhereAndIntent;
}
