/**
 * @module filters
 * Drizzle-like filter helpers for ergonomic WHERE clause building.
 *
 * These are pure factory functions that return WhereIntent objects.
 * They can be composed with and(), or(), not() for complex conditions.
 *
 * @example
 * ```typescript
 * import { eq, and, gt, like } from '@dbsp/core';
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

import type { Mutable } from '@dbsp/types/internal';
import type {
	ComparisonOperator,
	QueryIntent,
	RecursiveExistsOptions,
	WhereAndIntent,
	WhereAnyIntent,
	WhereComparisonIntent,
	WhereExistsIntent,
	WhereInIntent,
	WhereIntent,
	WhereLikeIntent,
	WhereNotExistsIntent,
	WhereNotIntent,
	WhereNullIntent,
	WhereOrIntent,
	WhereRangeIntent,
	WhereRawExistsIntent,
	WhereRawNotExistsIntent,
	WhereRelationFilterIntent,
} from '../intent-ast.js';
import { getColumnName } from './column-utils.js';
import { validateIdentifier } from './errors.js';
import type {
	SubqueryBuilder,
	SubqueryExpression,
} from './subquery-builder.js';
import {
	type ColumnRef,
	RELATION_META,
	type RelationRef,
} from './table-ref.js';
import type { AliasedExprColumn, ExpressionSpec } from './types.js';

// ============================================================================
// Type-Safe Column Reference Support (DX-040)
// ============================================================================

// ============================================================================
// Distinct Field Helper (for aggregates)
// ============================================================================

/**
 * Represents a field with DISTINCT modifier for aggregate functions.
 *
 * @example
 * ```typescript
 * count(distinct('customerId'))        // COUNT(DISTINCT customerId)
 * sum(distinct('amount'), 'uniqueSum') // SUM(DISTINCT amount) AS uniqueSum
 * ```
 */
export interface DistinctField {
	readonly field: string;
	readonly distinct: true;
}

/**
 * Helper to mark a field as DISTINCT for aggregate functions.
 *
 * @param field - The field name to apply DISTINCT to
 * @returns A DistinctField object that can be passed to aggregate functions
 *
 * @example
 * ```typescript
 * import { distinct } from '@dbsp/core';
 *
 * // COUNT(DISTINCT customerId)
 * orm.select('orders').count(distinct('customerId')).execute();
 *
 * // COUNT(DISTINCT customerId) AS unique_customers
 * orm.select('orders').count(distinct('customerId'), 'unique_customers').execute();
 *
 * // SUM(DISTINCT amount) - rare but valid SQL
 * orm.select('orders').sum(distinct('amount'), 'unique_total').execute();
 * ```
 */
export function distinct(field: string): DistinctField {
	return { field, distinct: true };
}

/**
 * Type guard to check if a value is a DistinctField.
 */
export function isDistinctField(value: unknown): value is DistinctField {
	return (
		typeof value === 'object' &&
		value !== null &&
		'field' in value &&
		'distinct' in value &&
		(value as DistinctField).distinct === true
	);
}

// ============================================================================
// Comparison Operators
// ============================================================================

type ComparisonFilter = {
	<T extends string, C extends string, V>(
		field: ColumnRef<T, C, V>,
		value: V,
	): WhereComparisonIntent;
	(field: string, value: unknown): WhereComparisonIntent;
};

function createComparisonFilter(
	operator: ComparisonOperator,
): ComparisonFilter {
	return (
		field: ColumnRef<string, string, unknown> | string,
		value: unknown,
	): WhereComparisonIntent => ({
		kind: 'comparison',
		field: getColumnName(field),
		operator,
		value,
	});
}

/**
 * Equals comparison: field = value
 *
 * @example eq('status', 'active') → status = 'active'
 * @example eq(users.name, 'John') → type-safe with ColumnRef (DX-040)
 */
export const eq: ComparisonFilter = createComparisonFilter('eq');

/**
 * Not equals comparison: field != value
 *
 * @example neq('status', 'deleted') → status != 'deleted'
 * @example neq(users.status, 'deleted') → type-safe with ColumnRef (DX-040)
 */
export const neq: ComparisonFilter = createComparisonFilter('neq');

/**
 * Greater than comparison: field > value
 *
 * @example gt('age', 18) → age > 18
 * @example gt(users.age, 18) → type-safe with ColumnRef (DX-040)
 */
export const gt: ComparisonFilter = createComparisonFilter('gt');

/**
 * Greater than or equal comparison: field >= value
 *
 * @example gte('age', 18) → age >= 18
 * @example gte(users.age, 18) → type-safe with ColumnRef (DX-040)
 */
export const gte: ComparisonFilter = createComparisonFilter('gte');

/**
 * Less than comparison: field < value
 *
 * @example lt('price', 100) → price < 100
 * @example lt(products.price, 100) → type-safe with ColumnRef (DX-040)
 */
export const lt: ComparisonFilter = createComparisonFilter('lt');

/**
 * Less than or equal comparison: field <= value
 *
 * @example lte('price', 100) → price <= 100
 * @example lte(products.price, 100) → type-safe with ColumnRef (DX-040)
 */
export const lte: ComparisonFilter = createComparisonFilter('lte');

/**
 * Null-safe inequality: field IS DISTINCT FROM value
 *
 * Unlike neq(), returns true when one side is NULL and the other is not.
 * Standard SQL (SQL:2003).
 *
 * @example isDistinctFrom('status', 'active') → status IS DISTINCT FROM 'active'
 * @example isDistinctFrom(users.status, null) → status IS DISTINCT FROM NULL
 */
export const isDistinctFrom: ComparisonFilter =
	createComparisonFilter('isDistinctFrom');

// ============================================================================
// String Operators
// ============================================================================

/**
 * LIKE pattern matching: field LIKE pattern
 *
 * @param field - Column name or ColumnRef (must be string type)
 * @param pattern - SQL LIKE pattern (use % for wildcards)
 * @param caseInsensitive - If true, uses ILIKE (PostgreSQL) or LOWER()
 *
 * @example like('name', '%john%') → name LIKE '%john%'
 * @example like('email', '%@example.com', true) → email ILIKE '%@example.com'
 * @example like(users.name, '%John%') → type-safe with ColumnRef (DX-040)
 */
export function like<T extends string, C extends string>(
	field: ColumnRef<T, C, string>,
	pattern: string,
	options?: boolean | { caseInsensitive?: boolean; escape?: string },
): WhereLikeIntent;
export function like(
	field: string,
	pattern: string,
	options?: boolean | { caseInsensitive?: boolean; escape?: string },
): WhereLikeIntent;
export function like(
	field: ColumnRef<string, string, string> | string,
	pattern: string,
	options?: boolean | { caseInsensitive?: boolean; escape?: string },
): WhereLikeIntent {
	const caseInsensitive =
		typeof options === 'boolean' ? options : options?.caseInsensitive;
	const escapeChar = typeof options === 'object' ? options.escape : undefined;

	const intent: WhereLikeIntent = {
		kind: 'like',
		field: getColumnName(field),
		pattern,
	};
	const withCi =
		caseInsensitive !== undefined ? { ...intent, caseInsensitive } : intent;
	if (escapeChar !== undefined) {
		return { ...withCi, escape: escapeChar };
	}
	return withCi;
}

// ============================================================================
// Array Operators
// ============================================================================

/**
 * IN array check: field IN (values)
 *
 * @example inArray('status', ['active', 'pending']) → status IN ('active', 'pending')
 * @example inArray(users.role, ['admin', 'moderator']) → type-safe (DX-040)
 */
export function inArray<T extends string, C extends string, V>(
	field: ColumnRef<T, C, V>,
	values: readonly V[],
): WhereInIntent;
export function inArray(
	field: string,
	values: readonly unknown[],
): WhereInIntent;
export function inArray(
	field: ColumnRef<string, string, unknown> | string,
	values: readonly unknown[],
): WhereInIntent {
	return { kind: 'in', field: getColumnName(field), values };
}

/**
 * IN subquery: field IN (SELECT ...)
 *
 * Creates a WHERE condition that checks if a field's value exists
 * in the result set of a subquery.
 *
 * @example
 * // Users who have posts
 * orm.select('users').where(inSubquery('id',
 *   subquery('posts').select('userId')
 * )).all()
 * // SQL: SELECT * FROM users WHERE id = ANY(SELECT user_id FROM posts)
 */
export function inSubquery(
	field: ColumnRef<string, string, unknown> | string,
	query: SubqueryBuilder | SubqueryExpression,
): WhereInIntent {
	const expr =
		'build' in query
			? (query as SubqueryBuilder).build()
			: (query as SubqueryExpression);
	return {
		kind: 'in',
		field: getColumnName(field),
		values: [],
		subquery: expr.toIntent(),
	};
}

/**
 * Array membership filter using PostgreSQL ANY() operator.
 * Compiles to: "col" = ANY($N::type[])
 *
 * Unlike inArray(), any() produces an explicit type-cast in the SQL.
 * Use this when you need guaranteed type safety with array parameters.
 *
 * @example
 * orm.select('symbols').where(any('id', [1, 2, 3])).all()
 * // SQL: SELECT * FROM "symbols" WHERE "id" = ANY($1::int[])
 */
export function any(
	field: ColumnRef<string, string, unknown> | string,
	values: readonly unknown[],
): WhereAnyIntent {
	return { kind: 'any', field: getColumnName(field), values };
}

// ============================================================================
// Null Operators
// ============================================================================

/**
 * IS NULL check: field IS NULL
 *
 * @example isNull('deletedAt') → deletedAt IS NULL
 * @example isNull(users.deletedAt) → type-safe (DX-040)
 */
export function isNull<T extends string, C extends string, V>(
	field: ColumnRef<T, C, V>,
): WhereNullIntent;
export function isNull(field: string): WhereNullIntent;
export function isNull(
	field: ColumnRef<string, string, unknown> | string,
): WhereNullIntent {
	return { kind: 'null', field: getColumnName(field), operator: 'isNull' };
}

// ============================================================================
// Range Operators (PostgreSQL)
// ============================================================================

/**
 * Range value for PostgreSQL range types.
 * @see WhereRangeIntent
 */
import type { RangeValue } from '@dbsp/types';

export type { RangeValue } from '@dbsp/types';

/**
 * Range OVERLAPS check: field && range (PostgreSQL)
 * Tests if two ranges have any points in common.
 *
 * @example rangeOverlaps('dates', { lower: '2025-01-15', upper: '2025-01-20' })
 *          → dates && '[2025-01-15,2025-01-20)'
 *
 * @param field - Column name containing a range type
 * @param value - Range value with lower/upper bounds
 */
export function rangeOverlaps(
	field: string,
	value: RangeValue,
): WhereRangeIntent {
	return { kind: 'range', field, operator: 'overlaps', value };
}

/**
 * Range CONTAINS check: field @> value (PostgreSQL)
 * Tests if the range contains a point or another range.
 *
 * @example rangeContains('salary_range', 50000)
 *          → salary_range @> 50000
 * @example rangeContains('date_range', { lower: '2025-01-01', upper: '2025-01-05' })
 *          → date_range @> '[2025-01-01,2025-01-05)'
 *
 * @param field - Column name containing a range type
 * @param value - Scalar value or range to check containment
 */
export function rangeContains(
	field: string,
	value: RangeValue | unknown,
): WhereRangeIntent {
	return { kind: 'range', field, operator: 'contains', value };
}

/**
 * Range CONTAINED BY check: field <@ range (PostgreSQL)
 * Tests if the field's range is fully contained within another range.
 *
 * @example rangeContainedBy('event_dates', { lower: '2025-01-01', upper: '2025-12-31' })
 *          → event_dates <@ '[2025-01-01,2025-12-31)'
 *
 * @param field - Column name containing a range type
 * @param value - Range that should contain the field's range
 */
export function rangeContainedBy(
	field: string,
	value: RangeValue,
): WhereRangeIntent {
	return { kind: 'range', field, operator: 'containedBy', value };
}

/**
 * IS NOT NULL check: field IS NOT NULL
 *
 * @example isNotNull('email') → email IS NOT NULL
 * @example isNotNull(users.email) → type-safe (DX-040)
 */
export function isNotNull<T extends string, C extends string, V>(
	field: ColumnRef<T, C, V>,
): WhereNullIntent;
export function isNotNull(field: string): WhereNullIntent;
export function isNotNull(
	field: ColumnRef<string, string, unknown> | string,
): WhereNullIntent {
	return { kind: 'null', field: getColumnName(field), operator: 'isNotNull' };
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
 * @param options - Optional nested filter on related records, with optional recursive options
 *
 * @example exists('posts') → EXISTS (SELECT 1 FROM posts WHERE ...)
 * @example exists('posts', { where: eq('published', true) })
 * @example exists('ancestors', { recursive: { direction: 'up', through: 'parent', maxDepth: 10 }, where: eq('name', 'Electronics') })
 */
export function exists(
	relation: string,
	options?: {
		where?: WhereIntent;
		recursive?: RecursiveExistsOptions;
		include?: Record<string, { join?: 'inner' | 'left' }>;
	},
): WhereExistsIntent {
	const result: Mutable<WhereExistsIntent> = { kind: 'exists', relation };
	if (options?.where !== undefined) {
		result.where = options.where;
	}
	if (options?.recursive !== undefined) {
		result.recursive = options.recursive;
	}
	if (options?.include !== undefined) {
		result.include = options.include;
	}
	return result;
}

/**
 * NOT EXISTS subquery: filter by absence of related records
 *
 * @param relation - Relation name defined in schema
 * @param options - Optional nested filter on related records, with optional recursive options
 *
 * @example notExists('comments') → NOT EXISTS (SELECT 1 FROM comments WHERE ...)
 * @example notExists('ancestors', { recursive: { direction: 'up', through: 'parent' }, where: eq('name', 'Obsolete') })
 */
export function notExists(
	relation: string,
	options?: {
		where?: WhereIntent;
		recursive?: RecursiveExistsOptions;
		include?: Record<string, { join?: 'inner' | 'left' }>;
	},
): WhereNotExistsIntent {
	const result: Mutable<WhereNotExistsIntent> = {
		kind: 'notExists',
		relation,
	};
	if (options?.where !== undefined) {
		result.where = options.where;
	}
	if (options?.recursive !== undefined) {
		result.recursive = options.recursive;
	}
	if (options?.include !== undefined) {
		result.include = options.include;
	}
	return result;
}

/**
 * EXISTS with an arbitrary subquery (not FK-resolved).
 *
 * Use when the subquery does not follow a declared schema relation.
 * Accepts a SubqueryBuilder (must have `.build()`) or any builder
 * exposing `buildIntent(): QueryIntent` (e.g. QueryBuilder).
 *
 * @param subquery - A SubqueryBuilder or any object with buildIntent()
 *
 * @example
 * // EXISTS (SELECT 1 FROM audit_log WHERE audit_log.entity_id = users.id)
 * rawExists(subquery('audit_log').select('id').where(eq('entityId', outerRef('id'))))
 *
 * @example
 * // EXISTS with a full query builder
 * rawExists(orm.select('sessions').where(and(eq('userId', outerRef('id')), gt('expiresAt', new Date()))))
 */
export function rawExists(
	sq: SubqueryBuilder | { buildIntent(): QueryIntent },
): WhereRawExistsIntent {
	const intent =
		'buildIntent' in sq
			? (sq as { buildIntent(): QueryIntent }).buildIntent()
			: (sq as SubqueryBuilder).build().toIntent();
	return { kind: 'rawExists', subquery: intent };
}

/**
 * NOT EXISTS with an arbitrary subquery (not FK-resolved).
 *
 * Use when the subquery does not follow a declared schema relation.
 * Accepts a SubqueryBuilder (must have `.build()`) or any builder
 * exposing `buildIntent(): QueryIntent` (e.g. QueryBuilder).
 *
 * @param subquery - A SubqueryBuilder or any object with buildIntent()
 *
 * @example
 * // NOT EXISTS (SELECT 1 FROM bans WHERE bans.user_id = users.id)
 * rawNotExists(subquery('bans').select('id').where(eq('userId', outerRef('id'))))
 */
export function rawNotExists(
	sq: SubqueryBuilder | { buildIntent(): QueryIntent },
): WhereRawNotExistsIntent {
	const intent =
		'buildIntent' in sq
			? (sq as { buildIntent(): QueryIntent }).buildIntent()
			: (sq as SubqueryBuilder).build().toIntent();
	return { kind: 'rawNotExists', subquery: intent };
}

// ============================================================================
// Quantified Relation Filters (DX-040 Block 7)
// ============================================================================

/**
 * Get relation name from a RelationRef.
 * @internal
 */
function getRelationName(
	rel: RelationRef<string, unknown, 'belongsTo' | 'hasMany' | 'hasOne'>,
): string {
	const meta = rel[RELATION_META];
	if (!meta) {
		throw new Error('Invalid RelationRef: missing RELATION_META');
	}
	return meta.target;
}

/**
 * EVERY quantifier: filter parent by condition that ALL related records must match
 *
 * This generates SQL like: NOT EXISTS (SELECT 1 FROM related WHERE NOT condition)
 *
 * @param relation - RelationRef from schema (e.g., users.posts)
 * @param filter - Callback that receives relation and returns a filter condition
 *
 * @example
 * ```typescript
 * // Find users where ALL their posts are published
 * orm.from(users)
 *   .where(every(users.posts, p => eq(p.published, true)))
 *
 * // SQL: ... WHERE NOT EXISTS (
 * //   SELECT 1 FROM posts WHERE posts.author_id = users.id AND NOT (posts.published = true)
 * // )
 * ```
 */
export function every<TTarget extends string, TTargetType>(
	relation: RelationRef<TTarget, TTargetType[], 'hasMany'>,
	filter: (rel: RelationRef<TTarget, TTargetType[], 'hasMany'>) => WhereIntent,
): WhereRelationFilterIntent {
	const relationName = getRelationName(relation);
	const where = filter(relation);
	return {
		kind: 'relationFilter',
		relation: relationName,
		where,
		mode: 'every',
	};
}

/**
 * NONE quantifier: filter parent by condition that NO related records match
 *
 * This is equivalent to: NOT EXISTS (SELECT 1 FROM related WHERE condition)
 *
 * @param relation - RelationRef from schema (e.g., users.posts)
 * @param filter - Callback that receives relation and returns a filter condition
 *
 * @example
 * ```typescript
 * // Find users with no flagged posts
 * orm.from(users)
 *   .where(none(users.posts, p => eq(p.flagged, true)))
 *
 * // SQL: ... WHERE NOT EXISTS (
 * //   SELECT 1 FROM posts WHERE posts.author_id = users.id AND posts.flagged = true
 * // )
 * ```
 */
export function none<TTarget extends string, TTargetType>(
	relation: RelationRef<TTarget, TTargetType[], 'hasMany'>,
	filter: (rel: RelationRef<TTarget, TTargetType[], 'hasMany'>) => WhereIntent,
): WhereRelationFilterIntent {
	const relationName = getRelationName(relation);
	const where = filter(relation);
	return {
		kind: 'relationFilter',
		relation: relationName,
		where,
		mode: 'none',
	};
}

/**
 * SOME quantifier: filter parent by condition that at least one related record matches
 *
 * This is the default behavior for relation filters and is equivalent to EXISTS.
 *
 * @param relation - RelationRef from schema (e.g., users.posts)
 * @param filter - Callback that receives relation and returns a filter condition
 *
 * @example
 * ```typescript
 * // Find users with at least one published post
 * orm.from(users)
 *   .where(some(users.posts, p => eq(p.published, true)))
 *
 * // SQL: ... WHERE EXISTS (
 * //   SELECT 1 FROM posts WHERE posts.author_id = users.id AND posts.published = true
 * // )
 * ```
 */
export function some<TTarget extends string, TTargetType>(
	relation: RelationRef<TTarget, TTargetType[], 'hasMany'>,
	filter: (rel: RelationRef<TTarget, TTargetType[], 'hasMany'>) => WhereIntent,
): WhereRelationFilterIntent {
	const relationName = getRelationName(relation);
	const where = filter(relation);
	return {
		kind: 'relationFilter',
		relation: relationName,
		where,
		mode: 'some',
	};
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
	// FIND-008: Validate all field names and the alias as SQL identifiers
	for (const f of fields) {
		validateIdentifier(f, 'column');
	}
	validateIdentifier(as, 'column');
	return {
		__expr: true,
		intent: { kind: 'coalesce', fields, as },
	};
}

/**
 * Raw SQL expression (escape hatch for advanced use cases).
 *
 * @warning **SECURITY RISK: SQL INJECTION VULNERABILITY**
 *
 * This function bypasses ALL SQL injection protections. The SQL fragment
 * is inserted directly into queries without sanitization.
 *
 * **NEVER:**
 * - Interpolate user input: `raw(\`WHERE name = '\${userInput}'\`, 'x')` ❌
 * - Use request parameters: `raw(req.query.field, 'x')` ❌
 * - Trust client-side data: `raw(formData.expression, 'x')` ❌
 *
 * **SAFE USAGE:**
 * - Hardcoded expressions: `raw('NOW()', 'current_time')` ✅
 * - Constants: `raw('price_cents / 100.0', 'price_dollars')` ✅
 * - Server-controlled values only
 *
 * For user-provided values, use parameterized queries via the standard
 * filter functions (eq, gt, like, etc.) which properly escape values.
 *
 * @param sqlFragment - Raw SQL fragment. **Must be safe - no user input!**
 * @param as - Required alias for the result column
 * @returns ExpressionSpec for use in select()
 *
 * @example
 * ```typescript
 * // SAFE: Hardcoded expressions
 * raw('NOW()', 'current_time')
 * // → NOW() AS current_time
 *
 * raw('price_cents / 100.0', 'price_dollars')
 * // → price_cents / 100.0 AS price_dollars
 *
 * // DANGEROUS - SQL INJECTION RISK!
 * // raw(`WHERE name = '${userInput}'`, 'x')  // NEVER DO THIS!
 * ```
 *
 * @see {@link https://owasp.org/www-community/attacks/SQL_Injection | OWASP SQL Injection}
 * @see {@link https://cheatsheetseries.owasp.org/cheatsheets/Query_Parameterization_Cheat_Sheet.html | OWASP Parameterization}
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

/**
 * Creates a column alias expression using native Kysely API.
 * Preferred over raw() for simple column aliasing as it's type-safe and dialect-portable.
 *
 * Uses Kysely's `eb.ref(column).as(alias)` internally - no raw SQL.
 *
 * @param column - Column name to select
 * @param alias - Alias for the result column
 * @returns ExpressionSpec for use in columns()
 *
 * @example
 * ```typescript
 * // Simple column alias
 * col('name', 'userName')
 * // → SELECT "name" AS "userName"
 *
 * // Multiple columns with aliases
 * orm.select('users').columns([
 *   'id',
 *   col('name', 'userName'),
 *   col('email', 'userEmail'),
 * ])
 * ```
 */
export function col(column: string, alias: string): ExpressionSpec {
	if (!column || column.trim() === '') {
		throw new Error('col() requires a non-empty column name');
	}
	if (!alias || alias.trim() === '') {
		throw new Error('col() requires a non-empty alias');
	}
	return {
		__expr: true,
		intent: { kind: 'columnAlias', column, alias },
	};
}

/**
 * Creates a relation column expression for selecting a column from a related table.
 * Auto-creates JOINs via the include mechanism and selects with custom alias.
 *
 * Uses native Kysely API internally - no raw SQL. The compiler resolves the relation
 * to its join alias and uses `eb.ref(alias.column).as(as)`.
 *
 * @param relation - Relation path to traverse (dot-separated for multi-level)
 * @param column - Column name to select from the target relation
 * @param as - Alias for the result column
 * @returns ExpressionSpec for use in columns()
 *
 * @example
 * ```typescript
 * // Select from direct relation
 * relationColumn('category', 'name', 'categoryName')
 * // → SELECT t1."name" AS "categoryName" (with JOIN to categories)
 *
 * // Select from nested relation (multi-level path)
 * relationColumn('category.parent', 'name', 'parentName')
 * // → SELECT t2."name" AS "parentName" (with JOINs through category to parent)
 *
 * // In a query
 * orm.select('products').columns([
 *   'name',
 *   relationColumn('category', 'name', 'categoryName'),
 * ])
 * ```
 */
export function relationColumn<A extends string>(
	relation: string,
	column: string,
	as: A,
): AliasedExprColumn<A> {
	if (!relation || relation.trim() === '') {
		throw new Error('relationColumn() requires a non-empty relation path');
	}
	if (!column || column.trim() === '') {
		throw new Error('relationColumn() requires a non-empty column name');
	}
	if (!as || (as as string).trim() === '') {
		throw new Error('relationColumn() requires a non-empty alias');
	}
	return {
		__expr: true,
		intent: { kind: 'relationColumn', relation, column, as },
	} as unknown as AliasedExprColumn<A>;
}

// ============================================================================
// Raw SQL Set Expression (for doUpdate() / set() mutations)
// ============================================================================

/**
 * Symbol to identify raw SQL expression values in set() / doUpdate()
 * @internal
 */
export const SQL_RAW_MARKER = Symbol.for('dbsp:raw-sql');

/**
 * A raw SQL expression for use in mutation set values (doUpdate / set).
 * Created by the {@link sql} function.
 */
export interface SqlRawExpression {
	readonly [SQL_RAW_MARKER]: true;
	readonly sql: string;
}

/**
 * Create a raw SQL expression for use in `doUpdate()` and `set()` mutation values.
 *
 * @warning **SECURITY RISK: SQL INJECTION VULNERABILITY**
 * The SQL fragment is inserted **WITHOUT** parameterization.
 * Only use with hardcoded expressions — **NEVER** with user input.
 *
 * **SAFE USAGE:**
 * - Hardcoded functions: `sql('now()')` ✅
 * - Excluded references: `sql('excluded.count + 1')` ✅
 * - Server-controlled literals: `sql('gen_random_uuid()')` ✅
 *
 * **NEVER:**
 * - Interpolate user input: `` sql(`'${userInput}'`) `` ❌
 * - Use request parameters: `sql(req.query.expr)` ❌
 *
 * @param sqlFragment - Raw SQL fragment (must be safe — no user input!)
 * @returns SqlRawExpression for use in doUpdate() / set()
 *
 * @example
 * ```typescript
 * orm.upsert('files')
 *   .values({ id: 1, name: 'test' })
 *   .onConflict({ columns: ['id'] })
 *   .doUpdate({ last_parsed: sql('now()'), count: sql('excluded.count + 1') })
 *   .execute();
 *
 * orm.update('files')
 *   .set({ last_parsed: sql('now()') })
 *   .where(eq('id', 1))
 *   .execute();
 * ```
 *
 * @see {@link https://owasp.org/www-community/attacks/SQL_Injection | OWASP SQL Injection}
 */
export function sql(sqlFragment: string): SqlRawExpression {
	if (!sqlFragment || sqlFragment.trim() === '') {
		throw new Error('sql() requires a non-empty SQL fragment');
	}
	return { [SQL_RAW_MARKER]: true, sql: sqlFragment };
}

/**
 * Type guard: check if a value is a raw SQL expression created by {@link sql}.
 */
export function isSqlRaw(value: unknown): value is SqlRawExpression {
	return (
		typeof value === 'object' &&
		value !== null &&
		SQL_RAW_MARKER in value &&
		(value as Record<symbol, unknown>)[SQL_RAW_MARKER] === true
	);
}

// ============================================================================
// Window Functions (re-exported from window-functions.ts)
// ============================================================================

export {
	denseRank,
	lag,
	lead,
	rank,
	rowNumber,
	WindowBuilder,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from './window-functions.js';
