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
import { InvalidOperationError } from './errors.js';
import {
	isSubqueryExpression,
	type SubqueryExpression,
} from './subquery-builder.js';

// ============================================================================
// Operator Types
// ============================================================================

/**
 * Comparison operators for object filter syntax.
 * Use `$` prefix to distinguish from field names.
 * Values can be literal values or SubqueryExpression for scalar subqueries.
 */
export interface FilterOperators<T = unknown> {
	/** Equals (explicit) - value or subquery */
	readonly $eq?: T | SubqueryExpression;
	/** Not equals - value or subquery */
	readonly $neq?: T | SubqueryExpression;
	/** Greater than - value or subquery */
	readonly $gt?: T | SubqueryExpression;
	/** Greater than or equal - value or subquery */
	readonly $gte?: T | SubqueryExpression;
	/** Less than - value or subquery */
	readonly $lt?: T | SubqueryExpression;
	/** Less than or equal - value or subquery */
	readonly $lte?: T | SubqueryExpression;
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
export type FilterValue<T = unknown> = T | null | FilterOperators<T>;

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
 * Check if a value is a WhereIntent (not an object filter).
 */
export function isWhereIntent(value: unknown): value is WhereIntent {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		typeof (value as Record<string, unknown>).kind === 'string'
	);
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
		value,
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
		value,
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
	if (ops.$eq !== undefined) {
		conditions.push(createComparisonIntent(field, 'eq', ops.$eq));
	}

	// $neq
	if (ops.$neq !== undefined) {
		conditions.push(createComparisonIntent(field, 'neq', ops.$neq));
	}

	// $gt
	if (ops.$gt !== undefined) {
		conditions.push(createComparisonIntent(field, 'gt', ops.$gt));
	}

	// $gte
	if (ops.$gte !== undefined) {
		conditions.push(createComparisonIntent(field, 'gte', ops.$gte));
	}

	// $lt
	if (ops.$lt !== undefined) {
		conditions.push(createComparisonIntent(field, 'lt', ops.$lt));
	}

	// $lte
	if (ops.$lte !== undefined) {
		conditions.push(createComparisonIntent(field, 'lte', ops.$lte));
	}

	// $in
	if (ops.$in !== undefined) {
		conditions.push({
			kind: 'in',
			field,
			values: ops.$in,
		} satisfies WhereInIntent);
	}

	// $like
	if (ops.$like !== undefined) {
		conditions.push({
			kind: 'like',
			field,
			pattern: ops.$like,
		} satisfies WhereLikeIntent);
	}

	// $ilike (case-insensitive)
	if (ops.$ilike !== undefined) {
		conditions.push({
			kind: 'like',
			field,
			pattern: ops.$ilike,
			caseInsensitive: true,
		} satisfies WhereLikeIntent);
	}

	// $notNull
	if (ops.$notNull === true) {
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
	// FIND-005: Reject prototype-poisoning keys before any processing
	const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
	for (const key of Object.keys(filter)) {
		if (FORBIDDEN_KEYS.has(key)) {
			throw new InvalidOperationError(
				'where',
				`Filter key not allowed: ${key}`,
			);
		}
		if (!Object.hasOwn(filter, key)) continue;
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
