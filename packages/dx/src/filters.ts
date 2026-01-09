/**
 * @module filters
 * Drizzle-like filter helpers for ergonomic WHERE clause building.
 *
 * These are pure factory functions that return WhereIntent objects.
 * They can be composed with and(), or(), not() for complex conditions.
 *
 * @example
 * ```typescript
 * import { eq, and, gt, like } from '@db-semantic-planner/dx';
 *
 * // Simple equality
 * orm.select('users').where(eq('status', 'active'))
 *
 * // Combined conditions
 * orm.select('users').where(
 *   and(
 *     eq('status', 'active'),
 *     gt('age', 18),
 *     like('email', '%@example.com')
 *   )
 * )
 * ```
 */

import type {
	WhereAndIntent,
	WhereComparisonIntent,
	WhereExistsIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotExistsIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
} from '@db-semantic-planner/core';
import type { ExpressionSpec } from './types.js';

// ============================================================================
// Comparison Operators
// ============================================================================

/**
 * Equals comparison: field = value
 *
 * @example eq('status', 'active') → status = 'active'
 */
export function eq(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'eq', value };
}

/**
 * Not equals comparison: field != value
 *
 * @example neq('status', 'deleted') → status != 'deleted'
 */
export function neq(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'neq', value };
}

/**
 * Greater than comparison: field > value
 *
 * @example gt('age', 18) → age > 18
 */
export function gt(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'gt', value };
}

/**
 * Greater than or equal comparison: field >= value
 *
 * @example gte('age', 18) → age >= 18
 */
export function gte(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'gte', value };
}

/**
 * Less than comparison: field < value
 *
 * @example lt('price', 100) → price < 100
 */
export function lt(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'lt', value };
}

/**
 * Less than or equal comparison: field <= value
 *
 * @example lte('price', 100) → price <= 100
 */
export function lte(field: string, value: unknown): WhereComparisonIntent {
	return { kind: 'comparison', field, operator: 'lte', value };
}

// ============================================================================
// String Operators
// ============================================================================

/**
 * LIKE pattern matching: field LIKE pattern
 *
 * @param field - Column name
 * @param pattern - SQL LIKE pattern (use % for wildcards)
 * @param caseInsensitive - If true, uses ILIKE (PostgreSQL) or LOWER()
 *
 * @example like('name', '%john%') → name LIKE '%john%'
 * @example like('email', '%@example.com', true) → email ILIKE '%@example.com'
 */
export function like(
	field: string,
	pattern: string,
	caseInsensitive?: boolean,
): WhereLikeIntent {
	const intent: WhereLikeIntent = { kind: 'like', field, pattern };
	if (caseInsensitive !== undefined) {
		return { ...intent, caseInsensitive };
	}
	return intent;
}

// ============================================================================
// Array Operators
// ============================================================================

/**
 * IN array check: field IN (values)
 *
 * @example inArray('status', ['active', 'pending']) → status IN ('active', 'pending')
 */
export function inArray(
	field: string,
	values: readonly unknown[],
): WhereInIntent {
	return { kind: 'in', field, values };
}

// ============================================================================
// Null Operators
// ============================================================================

/**
 * IS NULL check: field IS NULL
 *
 * @example isNull('deletedAt') → deletedAt IS NULL
 */
export function isNull(field: string): WhereNullIntent {
	return { kind: 'null', field, operator: 'isNull' };
}

/**
 * IS NOT NULL check: field IS NOT NULL
 *
 * @example isNotNull('email') → email IS NOT NULL
 */
export function isNotNull(field: string): WhereNullIntent {
	return { kind: 'null', field, operator: 'isNotNull' };
}

// ============================================================================
// Logical Operators
// ============================================================================

/**
 * Logical AND: all conditions must match
 *
 * Accepts variadic arguments or a single array.
 *
 * @example and(eq('a', 1), gt('b', 2)) → a = 1 AND b > 2
 * @example and([eq('a', 1), gt('b', 2)]) → a = 1 AND b > 2
 */
export function and(
	...conditions: WhereIntent[] | [readonly WhereIntent[]]
): WhereAndIntent {
	// Handle both variadic and array forms
	const flatConditions =
		conditions.length === 1 && Array.isArray(conditions[0])
			? (conditions[0] as readonly WhereIntent[])
			: (conditions as WhereIntent[]);

	return { kind: 'and', conditions: flatConditions };
}

/**
 * Logical OR: at least one condition must match
 *
 * Accepts variadic arguments or a single array.
 *
 * @example or(eq('status', 'active'), eq('status', 'pending'))
 * @example or([eq('status', 'active'), eq('status', 'pending')])
 */
export function or(
	...conditions: WhereIntent[] | [readonly WhereIntent[]]
): WhereOrIntent {
	// Handle both variadic and array forms
	const flatConditions =
		conditions.length === 1 && Array.isArray(conditions[0])
			? (conditions[0] as readonly WhereIntent[])
			: (conditions as WhereIntent[]);

	return { kind: 'or', conditions: flatConditions };
}

/**
 * Logical NOT: condition must not match
 *
 * @example not(eq('deleted', true)) → NOT (deleted = true)
 */
export function not(condition: WhereIntent): WhereNotIntent {
	return { kind: 'not', condition };
}

// ============================================================================
// Relation Operators
// ============================================================================

/**
 * EXISTS subquery: filter by existence of related records
 *
 * @param relation - Relation name defined in schema
 * @param options - Optional nested filter on related records
 *
 * @example exists('posts') → EXISTS (SELECT 1 FROM posts WHERE ...)
 * @example exists('posts', { where: eq('published', true) })
 */
export function exists(
	relation: string,
	options?: { where?: WhereIntent },
): WhereExistsIntent {
	const intent: WhereExistsIntent = { kind: 'exists', relation };
	if (options?.where !== undefined) {
		return { ...intent, where: options.where };
	}
	return intent;
}

/**
 * NOT EXISTS subquery: filter by absence of related records
 *
 * @param relation - Relation name defined in schema
 * @param options - Optional nested filter on related records
 *
 * @example notExists('comments') → NOT EXISTS (SELECT 1 FROM comments WHERE ...)
 */
export function notExists(
	relation: string,
	options?: { where?: WhereIntent },
): WhereNotExistsIntent {
	const intent: WhereNotExistsIntent = { kind: 'notExists', relation };
	if (options?.where !== undefined) {
		return { ...intent, where: options.where };
	}
	return intent;
}

// ============================================================================
// Expression Helpers
// ============================================================================

/**
 * COALESCE expression: returns first non-null value from a list of fields
 *
 * Use this for locale fallback patterns (e.g., FR → EN → default)
 *
 * @param fields - Array of field names to check in order
 * @param as - Required alias for the result column
 *
 * @example
 * ```typescript
 * // Locale fallback: prefer French, fall back to English
 * coalesce(['name_fr', 'name_en'], 'display_name')
 * // → COALESCE(name_fr, name_en) AS display_name
 *
 * // Use in QueryBuilder select with expressions
 * orm.select('products')
 *   .selectWithExpressions(['id', 'sku'], [
 *     coalesce(['title_fr', 'title_en', 'title_default'], 'title')
 *   ])
 * ```
 */
export function coalesce(
	fields: readonly string[],
	as: string,
): ExpressionSpec {
	if (fields.length === 0) {
		throw new Error('coalesce() requires at least one field');
	}
	if (!as || as.trim() === '') {
		throw new Error('coalesce() requires a non-empty alias');
	}
	return {
		__expr: true,
		intent: { kind: 'coalesce', fields, as },
	};
}

/**
 * Raw SQL expression (escape hatch for advanced use cases)
 *
 * @warning Use sparingly - bypasses type safety and SQL injection protection.
 * NEVER pass user input directly to this function.
 *
 * @param sqlFragment - Raw SQL fragment (must be safe, no user input!)
 * @param as - Required alias for the result column
 *
 * @example
 * ```typescript
 * // Current timestamp
 * raw('NOW()', 'current_time')
 * // → NOW() AS current_time
 *
 * // Complex expression
 * raw('price_cents / 100.0', 'price_dollars')
 * // → price_cents / 100.0 AS price_dollars
 * ```
 */
export function raw(sqlFragment: string, as: string): ExpressionSpec {
	if (!as || as.trim() === '') {
		throw new Error('raw() requires a non-empty alias');
	}
	return {
		__expr: true,
		intent: { kind: 'raw', sql: sqlFragment, as },
	};
}
