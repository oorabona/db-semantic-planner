/**
 * @fileoverview Type-safe SQL functions (aggregates, scalars, CASE).
 *
 * Provides type-safe wrappers for SQL functions that work with ColumnRef.
 * These functions return expression objects that can be used in select().
 *
 * @module functions
 * @since DX-040
 */

import type {
	AggregateExpressionIntent,
	CoalesceExpressionIntent,
	RawExpressionIntent,
} from '../intent-ast.js';

import { COLUMN_META, type ColumnRef, type RelationRef } from './table-ref.js';

// ============================================================================
// Expression Types (Branded for Type Safety)
// ============================================================================

/**
 * Brand symbol for aggregate expressions.
 */
export const AGGREGATE_BRAND = Symbol('AggregateExpr');

/**
 * Brand symbol for scalar expressions.
 */
export const SCALAR_BRAND = Symbol('ScalarExpr');

/**
 * Brand symbol for case expressions.
 */
export const CASE_BRAND = Symbol('CaseExpr');

/**
 * Aggregate expression result (count, sum, avg, min, max).
 *
 * @typeParam T - The result type of the aggregate
 */
export interface AggregateExpr<T> {
	readonly [AGGREGATE_BRAND]: true;
	readonly _type: T;
	/** Intent representation for compilation */
	readonly _intent: AggregateExpressionIntent;
	/** Add an alias to the expression */
	as(alias: string): AggregateExpr<T>;
}

/**
 * Scalar expression result (coalesce, lower, upper, concat).
 *
 * @typeParam T - The result type of the scalar expression
 */
export interface ScalarExpr<T> {
	readonly [SCALAR_BRAND]: true;
	readonly _type: T;
	/** Intent representation for compilation */
	readonly _intent: CoalesceExpressionIntent | RawExpressionIntent;
	/** Add an alias to the expression */
	as(alias: string): ScalarExpr<T>;
}

/**
 * Case expression for conditional logic.
 *
 * @typeParam T - The result type of the case expression
 */
export interface CaseExpr<T> {
	readonly [CASE_BRAND]: true;
	readonly _type: T;
	/** Intent representation for compilation */
	readonly _intent: RawExpressionIntent;
	/** Add an alias to the expression */
	as(alias: string): CaseExpr<T>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract column name from a ColumnRef.
 */
function getColumnName(col: ColumnRef<any, any, any>): string {
	const name = (col as unknown as Record<symbol, string>)[COLUMN_META];
	if (name === undefined) {
		throw new Error('Invalid ColumnRef: missing COLUMN_META');
	}
	return name;
}

/**
 * Validate an alias name.
 */
function validateAlias(alias: string): void {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias)) {
		throw new Error(
			`Invalid alias "${alias}": must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`,
		);
	}
}

/**
 * Create an aggregate expression with the given intent.
 */
function createAggregateExpr<T>(
	intent: AggregateExpressionIntent,
): AggregateExpr<T> {
	const expr: AggregateExpr<T> = {
		[AGGREGATE_BRAND]: true,
		_type: undefined as T,
		_intent: intent,
		as(alias: string): AggregateExpr<T> {
			validateAlias(alias);
			return createAggregateExpr({ ...intent, as: alias });
		},
	};
	return expr;
}

/**
 * Create a scalar expression with the given intent.
 */
function createScalarExpr<T>(
	intent: CoalesceExpressionIntent | RawExpressionIntent,
): ScalarExpr<T> {
	const expr: ScalarExpr<T> = {
		[SCALAR_BRAND]: true,
		_type: undefined as T,
		_intent: intent,
		as(alias: string): ScalarExpr<T> {
			validateAlias(alias);
			if (intent.kind === 'coalesce') {
				return createScalarExpr({ ...intent, as: alias });
			} else {
				return createScalarExpr({ ...intent, as: alias });
			}
		},
	};
	return expr;
}

// ============================================================================
// Aggregate Functions
// ============================================================================

/**
 * COUNT aggregate function.
 *
 * @example
 * ```typescript
 * // COUNT(*)
 * count()
 *
 * // COUNT(users.id)
 * count(users.id)
 *
 * // COUNT(users.posts) - count relation
 * count(users.posts)
 * ```
 */
export function count(): AggregateExpr<number>;
export function count<T>(column: ColumnRef<any, any, T>): AggregateExpr<number>;
export function count<T>(
	relation: RelationRef<any, T[], any, any>,
): AggregateExpr<number>;
export function count(
	columnOrRelation?:
		| ColumnRef<any, any, any>
		| RelationRef<any, any[], any, any>,
): AggregateExpr<number> {
	if (columnOrRelation === undefined) {
		return createAggregateExpr({
			kind: 'aggregate',
			function: 'count',
			field: '*',
			as: 'count',
		});
	}

	// Check if it's a ColumnRef
	if (COLUMN_META in (columnOrRelation as unknown as object)) {
		const field = getColumnName(columnOrRelation as ColumnRef<any, any, any>);
		return createAggregateExpr({
			kind: 'aggregate',
			function: 'count',
			field,
			as: `count_${field}`,
		});
	}

	// It's a RelationRef - count relation (subquery)
	// For now, we'll just mark it as a count on the relation
	// The actual subquery handling will be done in the compiler
	return createAggregateExpr({
		kind: 'aggregate',
		function: 'count',
		field: '*',
		as: 'count',
	});
}

/**
 * SUM aggregate function.
 * Only accepts numeric columns.
 *
 * @example
 * ```typescript
 * sum(orders.amount)
 * ```
 */
export function sum<T extends number>(
	column: ColumnRef<any, any, T>,
): AggregateExpr<number> {
	const field = getColumnName(column);
	return createAggregateExpr({
		kind: 'aggregate',
		function: 'sum',
		field,
		as: `sum_${field}`,
	});
}

/**
 * AVG aggregate function.
 * Only accepts numeric columns. Returns number | null.
 *
 * @example
 * ```typescript
 * avg(reviews.rating)
 * ```
 */
export function avg<T extends number>(
	column: ColumnRef<any, any, T>,
): AggregateExpr<number | null> {
	const field = getColumnName(column);
	return createAggregateExpr({
		kind: 'aggregate',
		function: 'avg',
		field,
		as: `avg_${field}`,
	});
}

/**
 * MIN aggregate function.
 * Returns the minimum value. Result is nullable if the set could be empty.
 *
 * @example
 * ```typescript
 * min(products.price)
 * min(users.createdAt)
 * ```
 */
export function min<T>(
	column: ColumnRef<any, any, T>,
): AggregateExpr<T | null> {
	const field = getColumnName(column);
	return createAggregateExpr({
		kind: 'aggregate',
		function: 'min',
		field,
		as: `min_${field}`,
	});
}

/**
 * MAX aggregate function.
 * Returns the maximum value. Result is nullable if the set could be empty.
 *
 * @example
 * ```typescript
 * max(products.price)
 * max(users.createdAt)
 * ```
 */
export function max<T>(
	column: ColumnRef<any, any, T>,
): AggregateExpr<T | null> {
	const field = getColumnName(column);
	return createAggregateExpr({
		kind: 'aggregate',
		function: 'max',
		field,
		as: `max_${field}`,
	});
}

// ============================================================================
// Scalar Functions
// ============================================================================

/**
 * COALESCE scalar function.
 * Returns the first non-null value from the list.
 * The result type removes null if at least one value is non-nullable.
 *
 * @example
 * ```typescript
 * // If nickname is nullable but name is not, result is string
 * coalesce(users.nickname, users.name)
 *
 * // Literal fallback
 * coalesce(users.nickname, 'Anonymous')
 * ```
 */
export function coalesce<T>(
	first: ColumnRef<any, any, T | null>,
	second: ColumnRef<any, any, T> | T,
): ScalarExpr<T>;
export function coalesce<T>(
	first: ColumnRef<any, any, T | null>,
	second: ColumnRef<any, any, T | null>,
	third: ColumnRef<any, any, T> | T,
): ScalarExpr<T>;
export function coalesce<T>(
	...values: (ColumnRef<any, any, T | null> | T)[]
): ScalarExpr<T | null>;
export function coalesce<T>(
	...values: (ColumnRef<any, any, T | null> | T)[]
): ScalarExpr<T | null> {
	const fields: string[] = [];

	for (const value of values) {
		if (
			typeof value === 'object' &&
			value !== null &&
			COLUMN_META in (value as unknown as object)
		) {
			fields.push(getColumnName(value as ColumnRef<any, any, any>));
		} else {
			// Literal value - for now we'll represent as a field
			// The compiler will need to handle this
			fields.push(String(value));
		}
	}

	return createScalarExpr({
		kind: 'coalesce',
		fields,
		as: 'coalesce_result',
	});
}

/**
 * LOWER scalar function.
 * Converts a string to lowercase.
 *
 * @example
 * ```typescript
 * lower(users.email)
 * ```
 */
export function lower(column: ColumnRef<any, any, string>): ScalarExpr<string> {
	const field = getColumnName(column);
	return createScalarExpr({
		kind: 'raw',
		sql: `LOWER(${field})`,
		as: `lower_${field}`,
	});
}

/**
 * UPPER scalar function.
 * Converts a string to uppercase.
 *
 * @example
 * ```typescript
 * upper(users.name)
 * ```
 */
export function upper(column: ColumnRef<any, any, string>): ScalarExpr<string> {
	const field = getColumnName(column);
	return createScalarExpr({
		kind: 'raw',
		sql: `UPPER(${field})`,
		as: `upper_${field}`,
	});
}

/**
 * CONCAT scalar function.
 * Concatenates strings together.
 *
 * @example
 * ```typescript
 * concat(users.firstName, ' ', users.lastName)
 * ```
 */
export function concat(
	...values: (ColumnRef<any, any, string> | string)[]
): ScalarExpr<string> {
	const parts: string[] = [];

	for (const value of values) {
		if (
			typeof value === 'object' &&
			value !== null &&
			COLUMN_META in (value as unknown as object)
		) {
			parts.push(getColumnName(value as ColumnRef<any, any, any>));
		} else {
			// Literal string - quote it
			parts.push(`'${String(value).replace(/'/g, "''")}'`);
		}
	}

	return createScalarExpr({
		kind: 'raw',
		sql: `CONCAT(${parts.join(', ')})`,
		as: 'concat_result',
	});
}

// ============================================================================
// CASE Expression Builder
// ============================================================================

/**
 * CASE expression when clause.
 */
export interface CaseWhenClause<T> {
	readonly condition: string;
	readonly result: T;
}

/**
 * CASE expression builder (in progress).
 */
export interface CaseBuilder<T> {
	/** Add a WHEN clause */
	when(condition: string, result: T | ColumnRef<any, any, T>): CaseBuilder<T>;
	/** Add the ELSE clause and finalize */
	else(result: T | ColumnRef<any, any, T>): CaseExpr<T>;
}

/**
 * Internal case builder implementation.
 */
class CaseBuilderImpl<T> implements CaseBuilder<T> {
	private clauses: CaseWhenClause<string>[] = [];

	when(condition: string, result: T | ColumnRef<any, any, T>): CaseBuilder<T> {
		const resultStr = this.resultToString(result);
		this.clauses.push({ condition, result: resultStr });
		return this;
	}

	else(result: T | ColumnRef<any, any, T>): CaseExpr<T> {
		const resultStr = this.resultToString(result);
		const whenClauses = this.clauses
			.map((c) => `WHEN ${c.condition} THEN ${c.result}`)
			.join(' ');
		const sql = `CASE ${whenClauses} ELSE ${resultStr} END`;

		const intent: RawExpressionIntent = {
			kind: 'raw',
			sql,
			as: 'case_result',
		};

		const expr: CaseExpr<T> = {
			[CASE_BRAND]: true,
			_type: undefined as T,
			_intent: intent,
			as(alias: string): CaseExpr<T> {
				validateAlias(alias);
				return {
					...expr,
					_intent: { ...intent, as: alias },
				};
			},
		};

		return expr;
	}

	private resultToString(result: T | ColumnRef<any, any, T>): string {
		if (
			typeof result === 'object' &&
			result !== null &&
			COLUMN_META in (result as unknown as object)
		) {
			return getColumnName(result as ColumnRef<any, any, any>);
		}
		if (typeof result === 'string') {
			return `'${result.replace(/'/g, "''")}'`;
		}
		return String(result);
	}
}

/**
 * Start building a CASE expression.
 *
 * @example
 * ```typescript
 * caseWhen()
 *   .when('status = "active"', 'Active')
 *   .when('status = "pending"', 'Pending')
 *   .else('Unknown')
 *   .as('statusLabel')
 * ```
 */
export function caseWhen<T>(): CaseBuilder<T> {
	return new CaseBuilderImpl<T>();
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is an AggregateExpr.
 */
export function isAggregateExpr<T>(value: unknown): value is AggregateExpr<T> {
	return (
		typeof value === 'object' && value !== null && AGGREGATE_BRAND in value
	);
}

/**
 * Check if a value is a ScalarExpr.
 */
export function isScalarExpr<T>(value: unknown): value is ScalarExpr<T> {
	return typeof value === 'object' && value !== null && SCALAR_BRAND in value;
}

/**
 * Check if a value is a CaseExpr.
 */
export function isCaseExpr<T>(value: unknown): value is CaseExpr<T> {
	return typeof value === 'object' && value !== null && CASE_BRAND in value;
}

// ============================================================================
// Re-exports
// ============================================================================

// Export intent types for use in other modules
export type {
	AggregateExpressionIntent,
	CoalesceExpressionIntent,
	RawExpressionIntent,
} from '../intent-ast.js';
