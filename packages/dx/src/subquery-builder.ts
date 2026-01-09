/**
 * @module subquery-builder
 * Subquery builder for scalar subquery expressions in WHERE clauses.
 * DX-012 Block 3
 */

import type {
	ComparisonOperator,
	ScalarSubqueryIntent,
	SubqueryRefIntent,
	WhereIntent,
	WhereSubqueryIntent,
} from '@db-semantic-planner/core';

// ============================================================================
// Subquery Builder
// ============================================================================

/**
 * Fluent builder for scalar subqueries.
 * Produces a SubqueryExpression that can be used with comparison operators.
 *
 * @example
 * // Basic scalar subquery
 * query('products')
 *   .where({ price: { $eq: subquery('prices').select('max_price').where({ categoryId: ref('categoryId') }) } })
 *
 * // With aggregate
 * query('products')
 *   .where({ avgRating: { $gt: subquery('reviews').where({ productId: ref('id') }).avg('rating') } })
 */
export class SubqueryBuilder {
	private readonly _from: string;
	private _select?: string;
	private _where?: WhereIntent;
	private _aggregate?: {
		fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
		field: string;
	};

	constructor(table: string) {
		this._from = table;
	}

	/**
	 * Specify the field to select from the subquery.
	 * For scalar subqueries, this should be a single field.
	 */
	select(field: string): SubqueryBuilder {
		const clone = this.clone();
		clone._select = field;
		return clone;
	}

	/**
	 * Add a WHERE condition to the subquery.
	 * Can include ref() to create correlated subqueries.
	 */
	where(condition: WhereIntent): SubqueryBuilder {
		const clone = this.clone();
		clone._where = condition;
		return clone;
	}

	// ========================================================================
	// Aggregate Methods
	// ========================================================================

	/**
	 * COUNT aggregate - count rows in subquery
	 */
	count(field = '*'): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'count', field };
		return clone.build();
	}

	/**
	 * SUM aggregate - sum values in subquery
	 */
	sum(field: string): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'sum', field };
		return clone.build();
	}

	/**
	 * AVG aggregate - average values in subquery
	 */
	avg(field: string): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'avg', field };
		return clone.build();
	}

	/**
	 * MIN aggregate - minimum value in subquery
	 */
	min(field: string): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'min', field };
		return clone.build();
	}

	/**
	 * MAX aggregate - maximum value in subquery
	 */
	max(field: string): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'max', field };
		return clone.build();
	}

	// ========================================================================
	// Build Methods
	// ========================================================================

	/**
	 * Build the SubqueryExpression for use in WHERE conditions.
	 * Called automatically by aggregate methods or explicitly when using select().
	 */
	build(): SubqueryExpression {
		if (!this._select && !this._aggregate) {
			throw new Error(
				'Subquery must have either select() or an aggregate function',
			);
		}

		// Build intent object conditionally to satisfy exactOptionalPropertyTypes
		const baseIntent = {
			from: this._from,
			select: this._select ?? this._aggregate?.field ?? '*',
		};

		// Add optional properties only if defined
		const intent: ScalarSubqueryIntent = this._where
			? this._aggregate
				? { ...baseIntent, where: this._where, aggregate: this._aggregate }
				: { ...baseIntent, where: this._where }
			: this._aggregate
				? { ...baseIntent, aggregate: this._aggregate }
				: baseIntent;

		return new SubqueryExpression(intent);
	}

	/**
	 * Get the intent for debugging/inspection.
	 */
	dump(): ScalarSubqueryIntent {
		return this.build().toIntent();
	}

	/**
	 * Create a clone of this builder (immutable pattern).
	 */
	private clone(): SubqueryBuilder {
		const clone = new SubqueryBuilder(this._from);
		if (this._select !== undefined) clone._select = this._select;
		if (this._where !== undefined) clone._where = this._where;
		if (this._aggregate !== undefined) clone._aggregate = this._aggregate;
		return clone;
	}
}

// ============================================================================
// Subquery Expression
// ============================================================================

/**
 * Result of building a subquery.
 * This can be used as a value in comparison operations.
 */
export class SubqueryExpression {
	readonly _type = 'subquery' as const;
	readonly intent: ScalarSubqueryIntent;

	constructor(intent: ScalarSubqueryIntent) {
		this.intent = intent;
	}

	/**
	 * Get the underlying intent.
	 */
	toIntent(): ScalarSubqueryIntent {
		return this.intent;
	}

	/**
	 * Create a WhereSubqueryIntent for comparison.
	 * Used internally by object filter syntax.
	 */
	toWhereIntent(
		field: string,
		operator: ComparisonOperator,
	): WhereSubqueryIntent {
		return {
			kind: 'subquery',
			field,
			operator,
			subquery: this.intent,
		};
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a scalar subquery builder.
 *
 * @param table - Table name for the subquery
 * @returns SubqueryBuilder for method chaining
 *
 * @example
 * // Find products where price equals max price in category
 * query('products').where({
 *   price: {
 *     $eq: subquery('products')
 *       .select('price')
 *       .where({ categoryId: ref('categoryId') })
 *       .max('price')
 *   }
 * })
 */
export function subquery(table: string): SubqueryBuilder {
	return new SubqueryBuilder(table);
}

/**
 * Create a reference to a parent query column.
 * Used in subquery WHERE conditions to create correlated subqueries.
 *
 * @param column - Column name (e.g., 'id') or qualified name (e.g., 't0.id')
 * @returns SubqueryRefIntent
 *
 * @example
 * // Reference parent 'id' column in subquery
 * subquery('reviews').where({ productId: ref('id') })
 */
export function ref(column: string): SubqueryRefIntent {
	return {
		kind: 'ref',
		column,
	};
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Check if a value is a SubqueryExpression.
 * Used to detect subqueries in object filter processing.
 */
export function isSubqueryExpression(
	value: unknown,
): value is SubqueryExpression {
	return (
		typeof value === 'object' &&
		value !== null &&
		'_type' in value &&
		(value as { _type: unknown })._type === 'subquery'
	);
}
