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
	WhereRangeIntent,
	WindowFunction,
	WindowIntent,
} from '../intent-ast.js';
import type { ExpressionSpec } from './types.js';

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

// ============================================================================
// Range Operators (PostgreSQL)
// ============================================================================

/**
 * Range value for PostgreSQL range types.
 * @see WhereRangeIntent
 */
export interface RangeValue {
	readonly lower: unknown;
	readonly upper: unknown;
	/** Bounds specification: '[)' (default), '[]', '()', '(]' */
	readonly bounds?: '[)' | '[]' | '()' | '(]';
}

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
export function relationColumn(
	relation: string,
	column: string,
	as: string,
): ExpressionSpec {
	if (!relation || relation.trim() === '') {
		throw new Error('relationColumn() requires a non-empty relation path');
	}
	if (!column || column.trim() === '') {
		throw new Error('relationColumn() requires a non-empty column name');
	}
	if (!as || as.trim() === '') {
		throw new Error('relationColumn() requires a non-empty alias');
	}
	return {
		__expr: true,
		intent: { kind: 'relationColumn', relation, column, as },
	};
}

// ============================================================================
// Window Function Builders
// ============================================================================

/**
 * Internal state for WindowBuilder
 * Distinguishes between ranking (no field), aggregate (requires field), and offset (requires field)
 */
type WindowFunctionKind =
	| { type: 'ranking'; fn: 'row_number' | 'rank' | 'dense_rank' }
	| {
			type: 'aggregate';
			fn: 'sum' | 'avg' | 'count' | 'min' | 'max';
			field: string;
	  }
	| { type: 'offset'; fn: 'lag' | 'lead'; field: string };

/**
 * Fluent builder for window functions.
 *
 * Create via factory functions: rowNumber(), rank(), sum(field), etc.
 * Chain with .partitionBy(), .orderBy(), then finalize with .as(alias).
 *
 * @example
 * ```typescript
 * // Ranking
 * rowNumber().orderBy('created_at', 'desc').as('rn')
 *
 * // Aggregate with partition
 * sum('amount').partitionBy('user_id').orderBy('date').as('running_total')
 *
 * // Multiple partition/order fields (chaining appends)
 * rank().partitionBy('region').partitionBy('year').orderBy('sales', 'desc').as('region_year_rank')
 * ```
 */
export class WindowBuilder {
	private constructor(
		private readonly fnKind: WindowFunctionKind,
		private readonly partitions: readonly string[] = [],
		private readonly orders: readonly {
			field: string;
			direction: 'asc' | 'desc';
		}[] = [],
	) {}

	/**
	 * Create a ranking window builder (row_number, rank, dense_rank)
	 * @internal Use factory functions instead: rowNumber(), rank(), denseRank()
	 */
	static ranking(fn: 'row_number' | 'rank' | 'dense_rank'): WindowBuilder {
		return new WindowBuilder({ type: 'ranking', fn });
	}

	/**
	 * Create an aggregate window builder (sum, avg, count, min, max)
	 * @internal Use factory functions instead: sum(field), avg(field), etc.
	 */
	static aggregate(
		fn: 'sum' | 'avg' | 'count' | 'min' | 'max',
		field: string,
	): WindowBuilder {
		return new WindowBuilder({ type: 'aggregate', fn, field });
	}

	/**
	 * Create an offset window builder (lag, lead)
	 * @internal Use factory functions instead: lag(field), lead(field)
	 */
	static offset(fn: 'lag' | 'lead', field: string): WindowBuilder {
		return new WindowBuilder({ type: 'offset', fn, field });
	}

	/**
	 * Add partition field(s) to the OVER clause.
	 * Multiple calls APPEND fields (not replace).
	 *
	 * @example
	 * sum('amount').partitionBy('user_id').partitionBy('category')
	 * // → PARTITION BY "user_id", "category"
	 */
	partitionBy(...fields: string[]): WindowBuilder {
		return new WindowBuilder(
			this.fnKind,
			[...this.partitions, ...fields],
			this.orders,
		);
	}

	/**
	 * Add order field to the OVER clause.
	 * Multiple calls APPEND fields (not replace).
	 *
	 * @param field - Column name to order by
	 * @param direction - Sort direction: 'asc' (default) or 'desc'
	 *
	 * @example
	 * rowNumber().orderBy('created_at').orderBy('id', 'desc')
	 * // → ORDER BY "created_at" ASC, "id" DESC
	 */
	orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): WindowBuilder {
		return new WindowBuilder(this.fnKind, this.partitions, [
			...this.orders,
			{ field, direction },
		]);
	}

	/**
	 * Finalize the window expression with an alias.
	 * Returns ExpressionSpec for use in columns().
	 *
	 * @param alias - Required alias for the result column
	 *
	 * @example
	 * columns(['id', rowNumber().orderBy('date').as('rn')])
	 */
	as(alias: string): ExpressionSpec {
		return {
			__expr: true,
			intent: this.toWindowIntent(alias),
		};
	}

	/**
	 * Convert builder state to WindowIntent
	 */
	private toWindowIntent(alias: string): WindowIntent {
		const fn = this.fnKind.fn as WindowFunction;
		const field =
			this.fnKind.type === 'aggregate' || this.fnKind.type === 'offset'
				? this.fnKind.field
				: undefined;

		const over: WindowIntent['over'] = {};
		if (this.partitions.length > 0) {
			(over as { partitionBy: readonly string[] }).partitionBy =
				this.partitions;
		}
		if (this.orders.length > 0) {
			(
				over as {
					orderBy: readonly { field: string; direction?: 'asc' | 'desc' }[];
				}
			).orderBy = this.orders;
		}

		const intent: WindowIntent = {
			kind: 'window',
			function: fn,
			alias,
			over,
		};

		if (field !== undefined) {
			return { ...intent, field };
		}
		return intent;
	}
}

// ============================================================================
// Window Function Factory Functions
// ============================================================================

/**
 * ROW_NUMBER window function: sequential row number within partition
 *
 * @example
 * rowNumber().orderBy('created_at', 'desc').as('rn')
 * // → ROW_NUMBER() OVER (ORDER BY "created_at" DESC) AS "rn"
 */
export function rowNumber(): WindowBuilder {
	return WindowBuilder.ranking('row_number');
}

/**
 * RANK window function: rank with gaps for ties
 *
 * @example
 * rank().partitionBy('category').orderBy('price').as('price_rank')
 * // → RANK() OVER (PARTITION BY "category" ORDER BY "price" ASC) AS "price_rank"
 */
export function rank(): WindowBuilder {
	return WindowBuilder.ranking('rank');
}

/**
 * DENSE_RANK window function: rank without gaps
 *
 * @example
 * denseRank().partitionBy('dept').orderBy('salary', 'desc').as('salary_rank')
 * // → DENSE_RANK() OVER (PARTITION BY "dept" ORDER BY "salary" DESC) AS "salary_rank"
 */
export function denseRank(): WindowBuilder {
	return WindowBuilder.ranking('dense_rank');
}

/**
 * SUM window function: running/cumulative sum
 *
 * @param field - Field to sum
 *
 * @example
 * wSum('amount').partitionBy('user_id').orderBy('date').as('running_total')
 * // → SUM("amount") OVER (PARTITION BY "user_id" ORDER BY "date" ASC) AS "running_total"
 */
export function wSum(field: string): WindowBuilder {
	return WindowBuilder.aggregate('sum', field);
}

/**
 * AVG window function: running/cumulative average
 *
 * @param field - Field to average
 *
 * @example
 * wAvg('price').partitionBy('category').as('avg_price')
 * // → AVG("price") OVER (PARTITION BY "category") AS "avg_price"
 */
export function wAvg(field: string): WindowBuilder {
	return WindowBuilder.aggregate('avg', field);
}

/**
 * COUNT window function: count within partition
 *
 * @param field - Field to count
 *
 * @example
 * wCount('id').partitionBy('category').as('items_in_category')
 * // → COUNT("id") OVER (PARTITION BY "category") AS "items_in_category"
 */
export function wCount(field: string): WindowBuilder {
	return WindowBuilder.aggregate('count', field);
}

/**
 * MIN window function: minimum value within partition
 *
 * @param field - Field to find minimum of
 *
 * @example
 * wMin('price').partitionBy('category').as('min_price')
 * // → MIN("price") OVER (PARTITION BY "category") AS "min_price"
 */
export function wMin(field: string): WindowBuilder {
	return WindowBuilder.aggregate('min', field);
}

/**
 * MAX window function: maximum value within partition
 *
 * @param field - Field to find maximum of
 *
 * @example
 * wMax('price').partitionBy('category').as('max_price')
 * // → MAX("price") OVER (PARTITION BY "category") AS "max_price"
 */
export function wMax(field: string): WindowBuilder {
	return WindowBuilder.aggregate('max', field);
}

/**
 * LAG window function: access previous row value
 *
 * @param field - Field to access from previous row
 *
 * @example
 * lag('amount').orderBy('date').as('prev_amount')
 * // → LAG("amount") OVER (ORDER BY "date" ASC) AS "prev_amount"
 */
export function lag(field: string): WindowBuilder {
	return WindowBuilder.offset('lag', field);
}

/**
 * LEAD window function: access next row value
 *
 * @param field - Field to access from next row
 *
 * @example
 * lead('amount').orderBy('date').as('next_amount')
 * // → LEAD("amount") OVER (ORDER BY "date" ASC) AS "next_amount"
 */
export function lead(field: string): WindowBuilder {
	return WindowBuilder.offset('lead', field);
}
