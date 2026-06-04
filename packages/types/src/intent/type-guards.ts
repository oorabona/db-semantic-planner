/**
 * @module intent/type-guards
 * Type guard functions for all intent AST types.
 */

import type {
	AggregateWindowFunction,
	CoalesceExpressionIntent,
	ColumnAliasIntent,
	ExpressionIntent,
	OffsetWindowFunction,
	RankingWindowFunction,
	RawExpressionIntent,
	RelationColumnIntent,
	WindowFunction,
	WindowIntent,
} from './expression-intent.js';
import type {
	DeleteIntent,
	InsertIntent,
	MutationIntent,
	UpdateIntent,
	UpsertIntent,
} from './mutation-intent.js';
import type { QueryIntent } from './query-intent.js';
import type {
	AdjacencyTraversal,
	CustomTraversal,
	EdgeTableTraversal,
	RecursiveIntent,
	RecursiveTraversal,
} from './recursive-intent.js';
import type {
	SelectAggregateIntent,
	SelectAllIntent,
	SelectFieldsIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
} from './select-intent.js';
import type {
	SubqueryRefIntent,
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
	WhereRelationFilterIntent,
	WhereSubqueryIntent,
} from './where-intent.js';

// ============================================================================
// Window Intent Type Guards
// ============================================================================

/**
 * Check if an intent is a window function intent
 */
export function isWindowIntent(intent: unknown): intent is WindowIntent {
	return (
		typeof intent === 'object' &&
		intent !== null &&
		'kind' in intent &&
		(intent as Record<string, unknown>).kind === 'window'
	);
}

/**
 * Check if a window function requires a field (aggregate or offset functions)
 */
export function isAggregateWindowFunction(
	fn: WindowFunction,
): fn is AggregateWindowFunction | OffsetWindowFunction {
	return ['sum', 'avg', 'count', 'min', 'max', 'lag', 'lead'].includes(fn);
}

/**
 * Check if a window function is a ranking function (no field required)
 */
export function isRankingWindowFunction(
	fn: WindowFunction,
): fn is RankingWindowFunction {
	return ['row_number', 'rank', 'dense_rank'].includes(fn);
}

// ============================================================================
// Where Intent Type Guards
// ============================================================================

/**
 * Check if a where intent is a comparison
 */
export function isWhereComparison(
	where: WhereIntent,
): where is WhereComparisonIntent {
	return where.kind === 'comparison';
}

/**
 * Check if a where intent is a like filter
 */
export function isWhereLike(where: WhereIntent): where is WhereLikeIntent {
	return where.kind === 'like';
}

/**
 * Check if a where intent is a subquery filter
 */
export function isWhereSubquery(
	where: WhereIntent,
): where is WhereSubqueryIntent {
	return where.kind === 'subquery';
}

/**
 * Check if a value is a subquery ref (column reference in subquery)
 */
export function isSubqueryRef(value: unknown): value is SubqueryRefIntent {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		(value as Record<string, unknown>).kind === 'ref'
	);
}

/**
 * Check if a where intent is an in filter
 */
export function isWhereIn(where: WhereIntent): where is WhereInIntent {
	return where.kind === 'in';
}

/**
 * Check if a where intent is an any filter (= ANY($N::type[]))
 */
export function isWhereAny(where: WhereIntent): where is WhereAnyIntent {
	return where.kind === 'any';
}

/**
 * Check if a where intent is a null filter
 */
export function isWhereNull(where: WhereIntent): where is WhereNullIntent {
	return where.kind === 'null';
}

/**
 * Check if a where intent is a range filter (PostgreSQL range types)
 */
export function isWhereRange(where: WhereIntent): where is WhereRangeIntent {
	return where.kind === 'range';
}

/**
 * Check if a where intent is a logical AND
 */
export function isWhereAnd(where: WhereIntent): where is WhereAndIntent {
	return where.kind === 'and';
}

/**
 * Check if a where intent is a logical OR
 */
export function isWhereOr(where: WhereIntent): where is WhereOrIntent {
	return where.kind === 'or';
}

/**
 * Check if a where intent is a logical NOT
 */
export function isWhereNot(where: WhereIntent): where is WhereNotIntent {
	return where.kind === 'not';
}

/**
 * Check if a where intent is an exists filter
 */
export function isWhereExists(where: WhereIntent): where is WhereExistsIntent {
	return where.kind === 'exists';
}

/**
 * Check if a where intent is a not exists filter
 */
export function isWhereNotExists(
	where: WhereIntent,
): where is WhereNotExistsIntent {
	return where.kind === 'notExists';
}

/**
 * Check if a where intent is a relation filter
 */
export function isWhereRelationFilter(
	where: WhereIntent,
): where is WhereRelationFilterIntent {
	return where.kind === 'relationFilter';
}

/**
 * Check if a where intent is any relation-based filter
 */
export function isWhereRelationBased(
	where: WhereIntent,
): where is
	| WhereExistsIntent
	| WhereNotExistsIntent
	| WhereRelationFilterIntent {
	return (
		where.kind === 'exists' ||
		where.kind === 'notExists' ||
		where.kind === 'relationFilter'
	);
}

/**
 * Check if a where intent is a logical operator (and/or/not)
 */
export function isWhereLogical(
	where: WhereIntent,
): where is WhereAndIntent | WhereOrIntent | WhereNotIntent {
	return where.kind === 'and' || where.kind === 'or' || where.kind === 'not';
}

// ============================================================================
// Select Intent Type Guards
// ============================================================================

/**
 * Check if a select intent selects all columns
 */
export function isSelectAll(select: SelectIntent): select is SelectAllIntent {
	return select.type === 'all';
}

/**
 * Check if a select intent selects specific fields
 */
export function isSelectFields(
	select: SelectIntent,
): select is SelectFieldsIntent {
	return select.type === 'fields';
}

/**
 * Check if a select intent is an aggregate select
 */
export function isSelectAggregate(
	select: SelectIntent,
): select is SelectAggregateIntent {
	return select.type === 'aggregate';
}

/**
 * Check if a select intent has expressions
 */
export function isSelectWithExpressions(
	select: SelectIntent,
): select is SelectWithExpressionsIntent {
	return select.type === 'expressions';
}

// ============================================================================
// Expression Intent Type Guards
// ============================================================================

/**
 * Check if an expression is a COALESCE expression
 */
export function isCoalesceExpression(
	expr: ExpressionIntent,
): expr is CoalesceExpressionIntent {
	return expr.kind === 'coalesce';
}

/**
 * Check if an expression is a raw SQL expression
 */
export function isRawExpression(
	expr: ExpressionIntent,
): expr is RawExpressionIntent {
	return expr.kind === 'raw';
}

/**
 * Check if an expression is a column alias expression
 */
export function isColumnAliasExpression(
	expr: ExpressionIntent,
): expr is ColumnAliasIntent {
	return expr.kind === 'columnAlias';
}

/**
 * Check if an expression is a relation column expression
 */
export function isRelationColumnExpression(
	expr: ExpressionIntent,
): expr is RelationColumnIntent {
	return expr.kind === 'relationColumn';
}

// ============================================================================
// Recursive CTE Type Guards
// ============================================================================

/**
 * Check if a traversal is adjacency-list based
 */
export function isAdjacencyTraversal(
	traversal: RecursiveTraversal,
): traversal is AdjacencyTraversal {
	return traversal.kind === 'adjacency';
}

/**
 * Check if a traversal is edge-table based
 */
export function isEdgeTableTraversal(
	traversal: RecursiveTraversal,
): traversal is EdgeTableTraversal {
	return traversal.kind === 'edge-table';
}

/**
 * Check if a traversal is custom
 */
export function isCustomTraversal(
	traversal: RecursiveTraversal,
): traversal is CustomTraversal {
	return traversal.kind === 'custom';
}

/**
 * Check if an intent is a recursive CTE intent
 */
export function isRecursiveIntent(
	intent: QueryIntent | RecursiveIntent,
): intent is RecursiveIntent {
	return intent.type === 'recursive';
}

// ============================================================================
// Mutation Intent Type Guards
// ============================================================================

/**
 * Check if an intent is an insert intent
 */
export function isInsertIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is InsertIntent {
	return intent.type === 'insert';
}

/**
 * Check if an intent is an update intent
 */
export function isUpdateIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is UpdateIntent {
	return intent.type === 'update';
}

/**
 * Check if an intent is a delete intent
 */
export function isDeleteIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is DeleteIntent {
	return intent.type === 'delete';
}

/**
 * Check if an intent is an upsert intent (DX-026)
 */
export function isUpsertIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is UpsertIntent {
	return intent.type === 'upsert';
}

/**
 * Check if an intent is any mutation intent
 */
export function isMutationIntent(
	intent: QueryIntent | RecursiveIntent | MutationIntent,
): intent is MutationIntent {
	return (
		intent.type === 'insert' ||
		intent.type === 'insert_from' ||
		intent.type === 'upsert_from' ||
		intent.type === 'update' ||
		intent.type === 'batchUpdate' ||
		intent.type === 'delete' ||
		intent.type === 'upsert'
	);
}
