/**
 * @module intent-ast
 * IntentAST (Intent Abstract Syntax Tree) - Query intent representation for db-semantic-planner.
 * Represents user's query intentions before being translated to SQL by adapters.
 */

// ============================================================================
// Comparison Operators
// ============================================================================

/** Comparison operators for scalar values */
export type ComparisonOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

/** String operators */
export type StringOperator = 'like';

/** Array operators */
export type ArrayOperator = 'in';

/** Null operators */
export type NullOperator = 'isNull' | 'isNotNull';

/** Logical operators */
export type LogicalOperator = 'and' | 'or' | 'not';

/** Relation filter operators */
export type RelationOperator = 'exists' | 'notExists';

// ============================================================================
// Sort Direction
// ============================================================================

/** Sort direction */
export type SortDirection = 'asc' | 'desc';

/** Null handling in sort */
export type NullsPosition = 'first' | 'last';

// ============================================================================
// Select Intent
// ============================================================================

/**
 * Select all columns
 */
export interface SelectAllIntent {
	readonly type: 'all';
}

/**
 * Select specific fields
 */
export interface SelectFieldsIntent {
	readonly type: 'fields';
	/** Field names to select */
	readonly fields: readonly string[];
}

// ============================================================================
// Aggregate Functions
// ============================================================================

/** Aggregate function types */
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * Aggregate operation intent
 * @example { function: 'count' } → COUNT(*)
 * @example { function: 'sum', field: 'price' } → SUM(price)
 */
export interface AggregateIntent {
	/** Aggregate function */
	readonly function: AggregateFunction;
	/** Field to aggregate (optional for count without field) */
	readonly field?: string;
	/** Alias for result column */
	readonly as?: string;
}

/**
 * Select with aggregate functions
 */
export interface SelectAggregateIntent {
	readonly type: 'aggregate';
	/** Aggregate operations */
	readonly aggregates: readonly AggregateIntent[];
	/** Non-aggregate fields (for GROUP BY) */
	readonly fields?: readonly string[];
}

/**
 * Select intent - what columns to retrieve
 */
export type SelectIntent =
	| SelectAllIntent
	| SelectFieldsIntent
	| SelectAggregateIntent
	| SelectWithExpressionsIntent;

// ============================================================================
// Expression Intents - Computed/Derived Values
// ============================================================================

/**
 * COALESCE expression: returns first non-null value from a list of fields
 * @example { kind: 'coalesce', fields: ['name_fr', 'name_en'], as: 'display_name' }
 *          → COALESCE(name_fr, name_en) AS display_name
 */
export interface CoalesceExpressionIntent {
	readonly kind: 'coalesce';
	/** Fields to check in order (first non-null wins) */
	readonly fields: readonly string[];
	/** Required alias for the result column */
	readonly as: string;
}

/**
 * Raw SQL expression (escape hatch for advanced use cases)
 * @example { kind: 'raw', sql: 'NOW()', as: 'current_time' }
 *          → NOW() AS current_time
 * @warning Use sparingly - bypasses type safety and SQL injection protection
 */
export interface RawExpressionIntent {
	readonly kind: 'raw';
	/** Raw SQL fragment (must be safe, no user input!) */
	readonly sql: string;
	/** Required alias for the result column */
	readonly as: string;
}

/**
 * Expression intent union type - computed/derived values in SELECT
 * Extensible for future expression types (CASE WHEN, etc.)
 */
export type ExpressionIntent = CoalesceExpressionIntent | RawExpressionIntent;

/**
 * Select with expressions (computed columns)
 */
export interface SelectWithExpressionsIntent {
	readonly type: 'expressions';
	/** Regular fields to select */
	readonly fields?: readonly string[];
	/** Computed expressions */
	readonly expressions: readonly ExpressionIntent[];
}

// ============================================================================
// Where Intent - Filter Conditions
// ============================================================================

/**
 * Comparison filter: field op value
 * Examples: eq, neq, gt, gte, lt, lte
 */
export interface WhereComparisonIntent {
	readonly kind: 'comparison';
	readonly field: string;
	readonly operator: ComparisonOperator;
	readonly value: unknown;
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
}

/**
 * Array filter: field in [values]
 */
export interface WhereInIntent {
	readonly kind: 'in';
	readonly field: string;
	readonly values: readonly unknown[];
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
	/** Relation name */
	readonly relation: string;
	/** Filter conditions on related records */
	readonly where: WhereIntent;
	/**
	 * Match mode:
	 * - 'some': At least one related record matches (default)
	 * - 'every': All related records match
	 * - 'none': No related records match
	 */
	readonly mode: 'some' | 'every' | 'none';
}

/**
 * Where intent - filter conditions union type
 * Discriminated union using 'kind' field
 */
export type WhereIntent =
	| WhereComparisonIntent
	| WhereLikeIntent
	| WhereInIntent
	| WhereNullIntent
	| WhereAndIntent
	| WhereOrIntent
	| WhereNotIntent
	| WhereExistsIntent
	| WhereNotExistsIntent
	| WhereRelationFilterIntent;

// ============================================================================
// Include Intent - Relation Loading
// ============================================================================

/**
 * Include intent - load related records
 * Supports nested includes for deep relation loading
 */
export interface IncludeIntent {
	/** Relation name to include */
	readonly relation: string;

	/** What columns to select from related records */
	readonly select?: SelectIntent;

	/** Filter conditions on related records */
	readonly where?: WhereIntent;

	/** Nested includes for deep loading */
	readonly include?: readonly IncludeIntent[];

	/**
	 * Explicit relation path for disambiguation.
	 * Use when multiple relations exist between same tables.
	 * @example 'author' or 'editor' when User has both relations to Post
	 */
	readonly via?: string;
}

// ============================================================================
// OrderBy Intent - Sorting
// ============================================================================

/**
 * OrderBy intent - sort results
 */
export interface OrderByIntent {
	/** Field name to sort by */
	readonly field: string;

	/** Sort direction */
	readonly direction: SortDirection;

	/**
	 * Where to place NULL values
	 * @default 'last' for 'asc', 'first' for 'desc' (database default)
	 */
	readonly nulls?: NullsPosition;
}

// ============================================================================
// Query Intent - Complete Query Definition
// ============================================================================

/**
 * Query intent - complete query definition
 * Main entry point for the intent AST
 */
export interface QueryIntent {
	/** Query type - currently only 'select' supported */
	readonly type: 'select';

	/** Target table name */
	readonly from: string;

	/** Columns to retrieve */
	readonly select?: SelectIntent;

	/** Filter conditions */
	readonly where?: WhereIntent;

	/** Relations to include */
	readonly include?: readonly IncludeIntent[];

	/** Sort order */
	readonly orderBy?: readonly OrderByIntent[];

	/**
	 * Fields to group by for aggregate queries.
	 * When specified, SELECT must include only grouped fields and aggregates.
	 */
	readonly groupBy?: readonly string[];

	/** Maximum number of rows */
	readonly limit?: number;

	/** Number of rows to skip */
	readonly offset?: number;
}

// ============================================================================
// Type Guards
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
 * Check if a where intent is an in filter
 */
export function isWhereIn(where: WhereIntent): where is WhereInIntent {
	return where.kind === 'in';
}

/**
 * Check if a where intent is a null filter
 */
export function isWhereNull(where: WhereIntent): where is WhereNullIntent {
	return where.kind === 'null';
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
