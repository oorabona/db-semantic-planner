import { brandValue, EXPRESSION_BRAND } from '@dbsp/types';
/**
 * @module subquery-builder
 * Subquery builder for scalar subquery expressions in WHERE clauses.
 * DX-012 Block 3
 */

import type {
	ComparisonOperator,
	ExpressionIntent,
	QueryIntent,
	SubqueryRefIntent,
	WhereIntent,
	WhereSubqueryIntent,
} from '../intent-ast.js';
import { andWhere } from './builder-utils.js';
import {
	coerceColumnName,
	coerceReference,
	type ReferenceLeaf,
} from './coerce.js';
import { isRelationPathColumn } from './column-utils.js';
import { CALLBACK_SCOPE } from './symbols.js';
import {
	COLUMN_META,
	type ColumnRef,
	isColumnRef,
	TABLE_META,
} from './table-ref.js';
import type { ExpressionSpec } from './types.js';

/** An aggregate field of a subquery: a column name or a `ColumnRef`. */
type SubqueryField = string | ColumnRef<string, string, unknown>;

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
 *   .where({
 *     price: {
 *       $eq: subquery('prices')
 *         .select('max_price')
 *         .where(eq('categoryId', outerRef('categoryId')))
 *         .build(),
 *     },
 *   })
 *
 * // With aggregate
 * query('products')
 *   .where({
 *     avgRating: {
 *       $gt: subquery('reviews').where(eq('productId', outerRef('id'))).avg('rating'),
 *     },
 *   })
 */
export class SubqueryBuilder {
	private readonly _from: string;
	private _select?: string;
	private _selectExpression?: ExpressionIntent;
	private _where?: WhereIntent;
	private _aggregate?: {
		fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
		field: string;
	};

	constructor(table: string) {
		this._from = table;
	}

	/**
	 * Specify what the subquery selects (ADR 0011 reference leaf). A column
	 * name or a `ColumnRef` of this table is a field; any other leaf (an
	 * expression, a constant, another table's `ColumnRef`) is an expression
	 * column. `inSubquery` takes a field only.
	 */
	select(field: ReferenceLeaf): SubqueryBuilder {
		const clone = this.clone();
		if (typeof field === 'string') {
			clone._select = field;
			delete clone._selectExpression;
		} else if (this.isOwnColumn(field)) {
			clone._select = (field as ColumnRef<string, string, unknown>)[
				COLUMN_META
			];
			delete clone._selectExpression;
		} else {
			clone._selectExpression = coerceReference(field, 'select');
			delete clone._select;
		}
		return clone;
	}

	/** A `ColumnRef` of this table, reached without a relation path or callback scope. */
	private isOwnColumn(field: unknown): boolean {
		return (
			typeof field === 'object' &&
			field !== null &&
			isColumnRef(field) &&
			field[TABLE_META] === this._from &&
			!isRelationPathColumn(field) &&
			(field as { readonly [CALLBACK_SCOPE]?: object })[CALLBACK_SCOPE] ===
				undefined
		);
	}

	private aggregateField(field: unknown, method: string): string {
		return coerceColumnName(field, method, 'aggregate field', this._from);
	}

	/**
	 * Add a WHERE condition to the subquery. Successive calls are combined with
	 * AND. Can include outerRef() to create correlated subqueries.
	 */
	where(condition: WhereIntent): SubqueryBuilder {
		const clone = this.clone();
		clone._where = andWhere(this._where, condition);
		return clone;
	}

	// ========================================================================
	// Aggregate Methods
	// ========================================================================

	/**
	 * COUNT aggregate - count rows in subquery
	 */
	count(field: SubqueryField = '*'): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = {
			fn: 'count',
			field: this.aggregateField(field, 'count'),
		};
		return clone.build();
	}

	/**
	 * SUM aggregate - sum values in subquery
	 */
	sum(field: SubqueryField): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'sum', field: this.aggregateField(field, 'sum') };
		return clone.build();
	}

	/**
	 * AVG aggregate - average values in subquery
	 */
	avg(field: SubqueryField): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'avg', field: this.aggregateField(field, 'avg') };
		return clone.build();
	}

	/**
	 * MIN aggregate - minimum value in subquery
	 */
	min(field: SubqueryField): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'min', field: this.aggregateField(field, 'min') };
		return clone.build();
	}

	/**
	 * MAX aggregate - maximum value in subquery
	 */
	max(field: SubqueryField): SubqueryExpression {
		const clone = this.clone();
		clone._aggregate = { fn: 'max', field: this.aggregateField(field, 'max') };
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
		if (!this._select && !this._selectExpression && !this._aggregate) {
			throw new Error(
				'Subquery must have either select() or an aggregate function',
			);
		}

		// Build a full QueryIntent — subqueries are queries with contextual validation
		const selectField = this._select ?? this._aggregate?.field ?? '*';

		const intent: QueryIntent = {
			type: 'select',
			from: this._from,
			// Aggregate overrides plain field select
			select: this._aggregate
				? {
						type: 'aggregate',
						aggregates: [
							{
								function: this._aggregate.fn,
								field: this._aggregate.field,
							},
						],
					}
				: this._selectExpression !== undefined
					? { type: 'expressions', columns: [this._selectExpression] }
					: { type: 'fields', fields: [selectField] },
			...(this._where && { where: this._where }),
		};

		return new SubqueryExpression(intent);
	}

	/**
	 * Get the intent for debugging/inspection.
	 */
	dump(): QueryIntent {
		return this.build().toIntent();
	}

	/**
	 * Wrap this subquery as an ExpressionSpec for use as a SELECT column.
	 * Shorthand for `.build().asExpr(alias)`.
	 *
	 * @param alias - Column alias for the result
	 * @returns ExpressionSpec suitable for passing to .columns()
	 *
	 * @example
	 * // SELECT id, (SELECT count(*) FROM calls WHERE symbol_id = s.id) AS call_count
	 * query('symbols').columns([
	 *   'id',
	 *   subquery('calls').where(eq('symbolId', outerRef('id'))).count().asExpr('call_count'),
	 * ])
	 */
	asExpr(alias: string): ExpressionSpec {
		return this.build().asExpr(alias);
	}

	/**
	 * Create a clone of this builder (immutable pattern).
	 */
	private clone(): SubqueryBuilder {
		const clone = new SubqueryBuilder(this._from);
		if (this._select !== undefined) clone._select = this._select;
		if (this._selectExpression !== undefined)
			clone._selectExpression = this._selectExpression;
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
/**
 * Brand of a genuine `SubqueryExpression`. `Symbol.for` keeps it recognised
 * across copies of the package, and a plain object (a JSON value with a
 * `_type: 'subquery'` key) never carries it.
 */
const SUBQUERY_EXPRESSION_BRAND: unique symbol = Symbol.for(
	'dbsp:subquery-expression',
);

export class SubqueryExpression {
	readonly _type = 'subquery' as const;
	readonly [SUBQUERY_EXPRESSION_BRAND] = true as const;
	readonly intent: QueryIntent;

	constructor(intent: QueryIntent) {
		this.intent = intent;
	}

	/**
	 * Get the underlying intent.
	 */
	toIntent(): QueryIntent {
		return this.intent;
	}

	/**
	 * Create a WhereSubqueryIntent for comparison.
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

	/**
	 * Wrap this subquery as an ExpressionSpec for use as a SELECT column.
	 *
	 * @param alias - Column alias for the result (required: SELECT expressions need a name)
	 * @returns ExpressionSpec suitable for passing to .columns()
	 *
	 * @example
	 * // SELECT id, (SELECT count(*) FROM calls WHERE calls.symbol_id = s.id) AS call_count
	 * // FROM symbols s
	 * query('symbols').columns([
	 *   'id',
	 *   subquery('calls').count().asExpr('call_count'),
	 * ])
	 */
	asExpr(alias: string): ExpressionSpec {
		return brandValue(
			{
				intent: { kind: 'subquery', query: this.intent, as: alias },
			},
			EXPRESSION_BRAND,
			true as const,
		);
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
 *       .where(eq('categoryId', outerRef('categoryId')))
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
 * Root SELECT WHERE resolves it at plan(). Unqualified names bind to the
 * immediately enclosing query; qualified names search nearest scopes first.
 * Exact aliases win; a logical table with multiple visible ranges is refused.
 *
 * @param column - Column name (e.g., 'id') or qualified name (e.g., 't0.id')
 * @returns SubqueryRefIntent
 *
 * @example
 * // Reference parent 'id' column in subquery
 * subquery('reviews').where(eq('productId', outerRef('id')))
 */
export function outerRef(column: string): SubqueryRefIntent {
	// `outer: true` is the discriminator that distinguishes this genuine
	// outer-query reference from an inner `ref()` (RefExpressionIntent), which
	// has the same structural shape `{ kind: 'ref', column }`.  Without the
	// marker, any subquery using `ref('a').gt(ref('b'))` as an inner WHERE
	// condition would be falsely rejected as "correlated subquery not supported".
	//
	// `SubqueryRefIntent` now declares `readonly outer?: true` so the object
	// literal is type-safe and no cast is needed.
	return {
		kind: 'ref',
		column,
		outer: true,
	};
}

// ============================================================================
// Type Guard
// ============================================================================

/**
 * Check if a value is a SubqueryExpression, by its brand: a plain object with
 * the same keys is data, not a subquery.
 */
export function isSubqueryExpression(
	value: unknown,
): value is SubqueryExpression {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { [SUBQUERY_EXPRESSION_BRAND]?: unknown })[
			SUBQUERY_EXPRESSION_BRAND
		] === true
	);
}
