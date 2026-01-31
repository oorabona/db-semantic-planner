/**
 * @module window-functions
 * Fluent builders for SQL window functions (ROW_NUMBER, RANK, SUM OVER, etc.).
 *
 * Extracted from filters.ts for SRP (Audit #19).
 *
 * @example
 * ```typescript
 * import { rowNumber, wSum, rank } from '@dbsp/core';
 *
 * // Ranking
 * rowNumber().orderBy('created_at', 'desc').as('rn')
 *
 * // Running total with partition
 * wSum('amount').partitionBy('user_id').orderBy('date').as('running_total')
 * ```
 */

import type { WindowFunction, WindowIntent } from '../intent-ast.js';
import { COLUMN_META, type ColumnRef } from './table-ref.js';
import type { ExpressionSpec } from './types.js';

// ============================================================================
// Internal Helpers
// ============================================================================

/** Extract column name from string or ColumnRef */
function getColumnName(
	field: ColumnRef<string, string, unknown> | string,
): string {
	if (typeof field === 'string') {
		return field;
	}
	const colName = (field as unknown as Record<symbol, string>)[COLUMN_META];
	if (colName === undefined) {
		throw new Error('Invalid ColumnRef: missing COLUMN_META');
	}
	return colName;
}

// ============================================================================
// WindowBuilder
// ============================================================================

/**
 * Internal state for WindowBuilder.
 * Distinguishes between ranking (no field), aggregate (requires field), and offset (requires field).
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
 * rank().partitionBy('dept').partitionBy('team').orderBy('salary', 'desc').as('rank')
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
	 * Supports both string field names and ColumnRef (DX-040).
	 *
	 * @example
	 * sum('amount').partitionBy('user_id').partitionBy('category')
	 * // → PARTITION BY "user_id", "category"
	 *
	 * @example DX-040 with ColumnRef
	 * rank().partitionBy(users.dept).orderBy(users.salary, 'desc')
	 */
	partitionBy(
		...fields: (string | ColumnRef<string, string, unknown>)[]
	): WindowBuilder {
		const fieldNames = fields.map((f) =>
			typeof f === 'string' ? f : getColumnName(f),
		);
		return new WindowBuilder(
			this.fnKind,
			[...this.partitions, ...fieldNames],
			this.orders,
		);
	}

	/**
	 * Add order field to the OVER clause.
	 * Multiple calls APPEND fields (not replace).
	 * Supports both string field names and ColumnRef (DX-040).
	 *
	 * @param field - Column name or ColumnRef to order by
	 * @param direction - Sort direction: 'asc' (default) or 'desc'
	 *
	 * @example
	 * rowNumber().orderBy('created_at').orderBy('id', 'desc')
	 * // → ORDER BY "created_at" ASC, "id" DESC
	 *
	 * @example DX-040 with ColumnRef
	 * rank().partitionBy(users.dept).orderBy(users.salary, 'desc')
	 */
	orderBy(
		field: string | ColumnRef<string, string, unknown>,
		direction: 'asc' | 'desc' = 'asc',
	): WindowBuilder {
		const fieldName = typeof field === 'string' ? field : getColumnName(field);
		return new WindowBuilder(this.fnKind, this.partitions, [
			...this.orders,
			{ field: fieldName, direction },
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
