/**
 * @module intent/where-intent
 * Where intent types for filter conditions.
 */

import type { RangeValue } from '../shared/utils.js';
import type { ExpressionIntent } from './expression-intent.js';
import type { ComparisonOperator, NullOperator } from './operators.js';
import type { QueryIntent } from './query-intent.js';
import type { RecursiveExistsOptions } from './recursive-types.js';

export type { RangeValue };

// ============================================================================
// Where Intent - Filter Conditions
// ============================================================================

/**
 * Typed field reference for cross-table column comparisons in relation filters.
 *
 * When using aliased relation filters like `some(orders as o, o.total > minOrder)`,
 * the RHS `minOrder` is a reference to the parent table's column, not a literal value.
 * FieldRef captures this distinction so the adapter can compile it as a column reference
 * instead of a parameterized value.
 *
 * @example
 * // some(rel as r, r.col > bareCol) → value: { kind: 'fieldRef', column: 'bareCol', scope: 'outer' }
 * // some(rel as r, r.col > r.otherCol) → value: { kind: 'fieldRef', column: 'otherCol', scope: 'inner' }
 * // some(a as x, some(b as y, y.f > x.g)) → value: { kind: 'fieldRef', column: 'g', scope: 'outer', alias: 'x' }
 */
export interface FieldRef {
	readonly kind: 'fieldRef';
	readonly column: string;
	readonly scope: 'inner' | 'outer';
	/** Named alias for outer scope (when referencing a specific outer alias in nested filters) */
	readonly alias?: string;
}

/**
 * Type guard for FieldRef values
 */
export function isFieldRef(value: unknown): value is FieldRef {
	return (
		value !== null &&
		typeof value === 'object' &&
		(value as Record<string, unknown>).kind === 'fieldRef'
	);
}

export interface WhereComparisonIntent {
	readonly kind: 'comparison';
	readonly field: string;
	readonly operator: ComparisonOperator;
	readonly value: unknown;
	/** JSON path extraction before comparison (e.g., data->'key' = 'val') */
	readonly jsonPath?: readonly string[];
	/** JSON extraction mode: 'json' = ->, 'text' = ->> */
	readonly jsonMode?: 'json' | 'text';
}

/**
 * String filter: field like pattern
 */
export interface WhereLikeIntent {
	readonly kind: 'like';
	readonly field: string;
	readonly pattern: string;
	/** Case-insensitive matching */
	readonly caseInsensitive?: boolean;
	/** Escape character for LIKE pattern (e.g. '\\' to escape _ and %) */
	readonly escape?: string;
}

/**
 * Array filter: field in [values]
 */
/**
 * Array filter (values branch): field IN (v1, v2, ...)
 */
export interface WhereInValueIntent {
	readonly kind: 'in';
	readonly field: string;
	readonly values: readonly unknown[];
	readonly subquery?: never;
	readonly not?: boolean;
}

/**
 * Array filter (subquery branch): field IN (SELECT ...)
 */
export interface WhereInSubqueryIntent {
	readonly kind: 'in';
	readonly field: string;
	readonly subquery: QueryIntent;
	readonly values?: never;
	readonly not?: boolean;
}

/**
 * Array filter: field in [values] OR field IN (subquery)
 * XOR: exactly one of `values` or `subquery` must be present.
 */
export type WhereInIntent = WhereInValueIntent | WhereInSubqueryIntent;

/**
 * Array membership filter using PostgreSQL ANY() operator.
 * Compiles to: "col" = ANY($N::type[])
 */
export interface WhereAnyIntent {
	readonly kind: 'any';
	readonly field: string;
	readonly values: readonly unknown[];
}

/**
 * Operand accepted by range WHERE filters.
 * - RangeValue: for range-to-range operators (overlaps, contains, containedBy)
 * - string: ISO date/timestamp literals (e.g. '2025-01-15', '2025-01-15T08:00:00Z')
 * - number: integer/numeric point values (e.g. 50000 for salary_range @> 50000)
 * - boolean: rarely used but valid PostgreSQL range operand
 */
export type RangeOperand = RangeValue | string | number | boolean;

/**
 * Range operator for PostgreSQL range types.
 * - overlaps: && (ranges have common points)
 * - contains: @> (range contains value or range)
 * - containedBy: <@ (range is contained by another range)
 */
export type RangeOperator = 'overlaps' | 'contains' | 'containedBy' | 'between';

/**
 * Range filter: field overlaps/contains/containedBy range value
 * PostgreSQL range types: daterange, tsrange, tstzrange, int4range, int8range, numrange
 *
 * @example
 * // Check if booking dates overlap a period
 * { kind: 'range', field: 'dates', operator: 'overlaps', value: { lower: '2025-01-15', upper: '2025-01-20' } }
 *
 * // Check if salary range contains a value
 * { kind: 'range', field: 'salary_range', operator: 'contains', value: 50000 }
 */
/**
 * Range filter: field overlaps/contains/containedBy range value
 * PostgreSQL range types: daterange, tsrange, tstzrange, int4range, int8range, numrange
 *
 * @example
 * // Check if booking dates overlap a period
 * { kind: 'range', field: 'dates', operator: 'overlaps', value: { lower: '2025-01-15', upper: '2025-01-20' } }
 *
 * // Check if salary range contains a value
 * { kind: 'range', field: 'salary_range', operator: 'contains', value: 50000 }
 */
export interface WhereRangeIntent {
	readonly kind: 'range';
	readonly field: string;
	readonly operator: RangeOperator;
	/** Operand: RangeValue for range-to-range ops, or a scalar (string | number | boolean) for point-in-range ops */
	readonly value: RangeOperand;
}

/**
 * Null filter: field is null / is not null
 */
export interface WhereNullIntent {
	readonly kind: 'null';
	readonly field: string;
	readonly operator: NullOperator;
}

/**
 * Logical AND: all conditions must match
 */
export interface WhereAndIntent {
	readonly kind: 'and';
	readonly conditions: readonly WhereIntent[];
}

/**
 * Logical OR: at least one condition must match
 */
export interface WhereOrIntent {
	readonly kind: 'or';
	readonly conditions: readonly WhereIntent[];
}

/**
 * Logical NOT: condition must not match
 */
export interface WhereNotIntent {
	readonly kind: 'not';
	readonly condition: WhereIntent;
}

/**
 * Relation exists filter: filter by existence of related records
 * Critical for Q1 golden test - enables EXISTS subquery strategy
 *
 * @example
 * // Find users who have at least one published post
 * { kind: 'exists', relation: 'posts', where: { kind: 'comparison', field: 'status', operator: 'eq', value: 'published' } }
 */
export interface WhereExistsIntent {
	readonly kind: 'exists';
	/** Relation name to check existence */
	readonly relation: string;
	/** Optional filter on related records */
	readonly where?: WhereIntent;
	/**
	 * Recursive options for ancestor/descendant existence checks.
	 * When present, generates a recursive CTE instead of simple EXISTS.
	 */
	readonly recursive?: RecursiveExistsOptions;
	/**
	 * Optional JOIN declarations inside the EXISTS subquery.
	 * Keys are relation names (used as aliases), values specify join type.
	 * Enables filtering on joined tables inside the subquery.
	 *
	 * @example
	 * exists('callers', {
	 *   include: { callerFile: { join: 'inner' } },
	 *   where: eq('callerFile.project_id', projectId)
	 * })
	 */
	readonly include?: Readonly<Record<string, { join?: 'inner' | 'left' }>>;
}

/**
 * Relation not exists filter: filter by absence of related records
 *
 * @example
 * // Find users who have no posts
 * { kind: 'notExists', relation: 'posts' }
 */
export interface WhereNotExistsIntent {
	readonly kind: 'notExists';
	/** Relation name to check absence */
	readonly relation: string;
	/** Optional filter on related records */
	readonly where?: WhereIntent;
	/**
	 * Recursive options for ancestor/descendant absence checks.
	 * When present, generates a recursive CTE instead of simple NOT EXISTS.
	 */
	readonly recursive?: RecursiveExistsOptions;
	/**
	 * Optional JOIN declarations inside the NOT EXISTS subquery.
	 * Keys are relation names (used as aliases), values specify join type.
	 * Enables filtering on joined tables inside the subquery.
	 *
	 * @example
	 * notExists('callers', {
	 *   include: { callerFile: { join: 'inner' } },
	 *   where: eq('callerFile.project_id', projectId)
	 * })
	 */
	readonly include?: Readonly<Record<string, { join?: 'inner' | 'left' }>>;
}

/**
 * Raw EXISTS subquery filter using an arbitrary QueryIntent.
 * Unlike WhereExistsIntent (which uses FK-resolved relation names),
 * this wraps a fully-specified subquery for correlated EXISTS checks.
 *
 * @example
 * // EXISTS (SELECT 1 FROM symbols WHERE symbols.id = calls.symbol_id AND ...)
 * exists(subquery('symbols').where(eq('id', ref('calls.symbol_id'))))
 */
export interface WhereRawExistsIntent {
	readonly kind: 'rawExists';
	/** The subquery producing rows for the EXISTS check */
	readonly subquery: QueryIntent;
}

/**
 * Raw NOT EXISTS subquery filter using an arbitrary QueryIntent.
 *
 * @example
 * // NOT EXISTS (SELECT 1 FROM symbols WHERE ...)
 * notExists(subquery('symbols').where(...))
 */
export interface WhereRawNotExistsIntent {
	readonly kind: 'rawNotExists';
	/** The subquery producing rows for the NOT EXISTS check */
	readonly subquery: QueryIntent;
}

/**
 * Relation filter: filter parent by conditions on related records
 * More flexible than exists - allows filtering by related record attributes
 *
 * @example
 * // Find users whose latest post was created in 2024
 * { kind: 'relationFilter', relation: 'posts', where: {...}, mode: 'some' }
 */
export interface WhereRelationFilterIntent {
	readonly kind: 'relationFilter';
	/**
	 * Relation path for filtering.
	 * - Single relation: 'posts' or ['posts']
	 * - Multi-hop (SPEC-002): ['author', 'company'] for author.company traversal
	 */
	readonly relation: string | readonly string[];
	/** Filter conditions on related records */
	readonly where: WhereIntent;
	/**
	 * Match mode:
	 * - 'some': At least one related record matches (default)
	 * - 'every': All related records match
	 * - 'none': No related records match
	 */
	readonly mode: 'some' | 'every' | 'none';
	/** Optional alias for complex conditions (SPEC-002) */
	readonly alias?: string | undefined;
}

// ============================================================================
// Subquery Intent - Scalar Subquery in WHERE
// ============================================================================

/**
 * Reference to a parent query column in a subquery.
 * Used to create correlated subqueries.
 *
 * The `outer` field is a discriminator set by `outerRef()` in
 * `@dbsp/core` to distinguish a genuine outer-query reference from an
 * inner `ref()` expression (RefExpressionIntent), which has the same
 * structural shape `{ kind: 'ref', column }`.  Converters that need to
 * detect correlated subqueries check `outer === true`; an intent built
 * without `outer` (i.e. a plain `{ kind: 'ref', column }`) is treated
 * as a non-correlated inner expression reference.
 *
 * @example
 * // Outer reference produced by outerRef('id'):
 * { kind: 'ref', column: 'id', outer: true }
 *
 * // Inner column reference (not a correlated outer ref):
 * { kind: 'ref', column: 'id' }  // outer is absent / undefined
 */
export interface SubqueryRefIntent {
	readonly kind: 'ref';
	/** Column name or aliased column (e.g., 'id' or 't0.id') */
	readonly column: string;
	/**
	 * Discriminator that marks this as a genuine outer-query reference
	 * (set by `outerRef()`).  Absent on plain inner expression refs.
	 * Optional so that existing raw intents built per the type without
	 * this field remain valid (non-breaking addition).
	 */
	readonly outer?: true;
}

/**
 * Subquery intent for scalar subquery comparisons.
 * Produces correlated subqueries in SQL.
 *
 * @example
 * // Find products where price equals max price of category
 * {
 *   kind: 'subquery',
 *   field: 'price',
 *   operator: 'eq',
 *   subquery: { from: 'products', select: { kind: 'aggregate', fn: 'max', field: 'price' } }
 * }
 */
export interface WhereSubqueryIntent {
	readonly kind: 'subquery';
	/** Field to compare on the parent query */
	readonly field: string;
	/** Comparison operator */
	readonly operator: ComparisonOperator;
	/** Subquery producing scalar value */
	readonly subquery: QueryIntent;
}

/**
 * Scalar subquery intent - produces a single value.
 * Simplified QueryIntent for subquery context.
 */
/** @deprecated Use QueryIntent instead — subqueries are full queries with contextual validation */
export type ScalarSubqueryIntent = QueryIntent;

// ============================================================================
// JSON/JSONB WHERE Intents (E13)
// ============================================================================

/**
 * JSON containment filter: col @> value or col <@ value.
 * @example { kind: 'jsonContains', field: 'data', value: '{"active":true}', reversed: false }
 *          → WHERE "data" @> $1
 */
export interface WhereJsonContainsIntent {
	readonly kind: 'jsonContains';
	readonly field: string;
	readonly value: unknown;
	/** false = @> (field contains value), true = <@ (field contained by value) */
	readonly reversed: boolean;
}

/**
 * JSON key existence filter: col ? 'key'.
 * @example { kind: 'jsonExists', field: 'data', key: 'email' }
 *          → WHERE "data" ? $1
 */
export interface WhereJsonExistsIntent {
	readonly kind: 'jsonExists';
	readonly field: string;
	readonly key: string;
}

/** WHERE clause using a custom expression with comparison */
export interface WhereExpressionIntent {
	readonly kind: 'expression';
	readonly expr: ExpressionIntent;
	readonly operator: ComparisonOperator;
	readonly value: unknown;
}

/**
 * Where intent - filter conditions union type
 * Discriminated union using 'kind' field
 */
export type WhereIntent =
	| WhereComparisonIntent
	| WhereLikeIntent
	| WhereInIntent
	| WhereAnyIntent
	| WhereNullIntent
	| WhereRangeIntent
	| WhereAndIntent
	| WhereOrIntent
	| WhereNotIntent
	| WhereExistsIntent
	| WhereNotExistsIntent
	| WhereRawExistsIntent
	| WhereRawNotExistsIntent
	| WhereRelationFilterIntent
	| WhereSubqueryIntent
	| WhereJsonContainsIntent
	| WhereJsonExistsIntent
	| WhereExpressionIntent;
