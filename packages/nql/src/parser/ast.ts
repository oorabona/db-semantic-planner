/**
 * NQL Abstract Syntax Tree Types
 *
 * These types represent the parsed structure of NQL queries,
 * independent of the underlying database schema.
 */

// ============================================================
// TOP-LEVEL PROGRAM
// ============================================================

/**
 * A complete NQL program with let bindings and statements
 * Supports multiple statements for mutation chaining
 */
export interface NqlProgram {
	type: 'program';
	statements: NqlStatement[];
}

export type NqlStatement = NqlQuery | NqlMutationPipeline | NqlWithQuery;

// ============================================================
// WITH / CTE SYNTAX
// ============================================================

export interface NqlCteItem {
	type: 'cteItem';
	name: string;
	query: NqlQuery;
}

export interface NqlWithQuery {
	type: 'withQuery';
	ctes: NqlCteItem[];
	query: NqlQuery;
}

// ============================================================
// QUERIES
// ============================================================

export interface NqlQuery {
	type: 'query';
	table: string;
	clauses: NqlClause[];
}

// ============================================================
// MUTATION PIPELINE (with optional RETURNING via pipe)
// ============================================================

export interface NqlMutationPipeline {
	type: 'mutationPipeline';
	mutation: NqlMutation;
	clauses: NqlMutationClause[];
}

export type NqlMutation =
	| NqlInsert
	| NqlInsertFrom
	| NqlUpdate
	| NqlDelete
	| NqlUpsert
	| NqlUpsertFrom;

export type NqlMutationClause = NqlSelectClause | NqlBindClause;

// ============================================================
// QUERY CLAUSES
// ============================================================

export type NqlClause =
	| NqlWhereClause
	| NqlSelectClause
	| NqlFlatClause
	| NqlGroupByClause
	| NqlOrderByClause
	| NqlLimitClause
	| NqlOffsetClause
	| NqlBindClause
	| NqlSetClause
	| NqlLockClause;

/**
 * Where clause - position determines compilation:
 * - Before `group by` → SQL WHERE (aggregates forbidden)
 * - After `group by` → SQL HAVING (aggregates allowed)
 */
export interface NqlWhereClause {
	type: 'where';
	condition: NqlExpression;
}

export interface NqlSelectClause {
	type: 'select';
	distinct: boolean;
	items: NqlSelectItem[];
}

/**
 * NQL v2.1: Forces JOIN strategy instead of json_agg for relation includes
 */
export interface NqlFlatClause {
	type: 'flat';
}

export interface NqlGroupByClause {
	type: 'groupBy';
	expressions: NqlExpression[];
}

export interface NqlOrderByClause {
	type: 'orderBy';
	items: NqlOrderItem[];
}

export interface NqlLimitClause {
	type: 'limit';
	count: number;
	relation?: string;
}

export interface NqlOffsetClause {
	type: 'offset';
	count: number;
}

/**
 * Capture mutation result into a variable (for chained mutations)
 * Used with `bind` keyword: `insert ... | bind result | ...`
 */
export interface NqlBindClause {
	type: 'bind';
	name: string;
}

/**
 * Set operation clause: UNION, INTERSECT, EXCEPT
 * The right operand is either an inline query or a bound name reference.
 */
export interface NqlSetClause {
	type: 'setOperation';
	op: 'union' | 'intersect' | 'except';
	all: boolean;
	/** Inline sub-query (parenthesized) */
	right?: NqlQuery;
	/** Bound name reference (via | bind) */
	boundName?: string;
}

/**
 * Lock clause (E15): FOR UPDATE | FOR SHARE | FOR NO KEY UPDATE | FOR KEY SHARE
 * with optional wait policy: SKIP LOCKED | NOWAIT
 */
export interface NqlLockClause {
	type: 'lock';
	strength: 'forUpdate' | 'forShare' | 'forNoKeyUpdate' | 'forKeyShare';
	waitPolicy: 'block' | 'skipLocked' | 'noWait';
}

// ============================================================
// SELECT ITEMS
// ============================================================

export type NqlSelectItem =
	| NqlSelectStar
	| NqlSelectRelationStar
	| NqlSelectExpression;

export interface NqlSelectStar {
	type: 'star';
}

export interface NqlSelectRelationStar {
	type: 'relationStar';
	relation: string[];
}

export interface NqlSelectExpression {
	type: 'expression';
	expression: NqlExpression;
	alias?: string;
}

// ============================================================
// JOIN SPECIFICATION
// ============================================================

export interface NqlJoinSpec {
	relation: string;
	params?: NqlJoinParam[] | undefined;
	via?: string | undefined; // Disambiguation when multiple FKs to same table
	condition?: NqlExpression | undefined;
}

export interface NqlJoinParam {
	name: string;
	value: NqlLiteral;
}

// ============================================================
// ORDER ITEM
// ============================================================

export interface NqlOrderItem {
	expression: NqlExpression;
	direction: 'asc' | 'desc';
}

// ============================================================
// EXPRESSIONS
// ============================================================

export type NqlExpression =
	| NqlBinaryExpression
	| NqlUnaryExpression
	| NqlComparisonExpression
	| NqlRangeOpExpression
	| NqlInExpression
	| NqlAnyExpression
	| NqlBetweenExpression
	| NqlIsNullExpression
	| NqlExistsExpression
	| NqlRelationFilterExpression
	| NqlFunctionCall
	| NqlWindowExpression
	| NqlCaseExpression
	| NqlPathExpression
	| NqlJsonAccessExpression
	| NqlJsonComparisonExpression
	| NqlLiteral
	| NqlSubquery
	| NqlVariableRef;

export interface NqlBinaryExpression {
	type: 'binary';
	operator: 'and' | 'or' | '+' | '-' | '*' | '/' | '%';
	left: NqlExpression;
	right: NqlExpression;
}

export interface NqlUnaryExpression {
	type: 'unary';
	operator: 'not' | '-';
	operand: NqlExpression;
}

export interface NqlComparisonExpression {
	type: 'comparison';
	operator: '=' | '!=' | '<' | '>' | '<=' | '>=' | 'like';
	left: NqlExpression;
	right: NqlExpression;
}

/**
 * PostgreSQL range operator expression: column RANGE_OP range_literal
 * Examples: dateRange overlaps [2024-01-01,2024-12-31)
 */
export interface NqlRangeOpExpression {
	type: 'rangeOp';
	operator: 'overlaps' | 'contains' | 'containedBy';
	left: NqlExpression;
	range?: NqlRangeLiteral;
	scalar?: NqlLiteral;
}

export interface NqlInExpression {
	type: 'in';
	negated: boolean;
	expression: NqlExpression;
	values: NqlExpression[] | NqlSubquery | NqlDateRangeLiteral;
}


/**
 * BATCH-001: ANY expression — col = ANY(:paramName)
 * Compiles to WhereAnyIntent with values resolved from named parameters.
 */
export interface NqlAnyExpression {
	type: 'any';
	column: NqlExpression;
	paramName: string;
}

/**
 * BETWEEN is a ternary operator: expr BETWEEN low AND high
 */
export interface NqlBetweenExpression {
	type: 'between';
	expression: NqlExpression;
	low: NqlExpression;
	high: NqlExpression;
}

/**
 * IS NULL / IS NOT NULL check
 */
export interface NqlIsNullExpression {
	type: 'isNull';
	expression: NqlExpression;
	negated: boolean;
}

export interface NqlExistsExpression {
	type: 'exists';
	negated: boolean;
	subquery: NqlSubquery;
}

/**
 * SPEC-002: Relation filter expression for cross-table pseudo-columns
 *
 * Quantifier modes:
 * - 'some' (default): EXISTS - at least one related record matches
 * - 'none': NOT EXISTS - no related record matches
 * - 'every': ALL - every related record matches (vacuous truth if empty)
 *
 * Syntax forms:
 * - Implicit: `posts.featured = true` (some), `not posts.featured = true` (none), `all posts.featured = true` (every)
 * - Explicit: `some(posts).featured = true`, `none(posts).featured = true`, `every(posts).featured = true`
 * - With alias: `posts as p, p.featured = true and p.published = true`
 */
export interface NqlRelationFilterExpression {
	type: 'relationFilter';
	/** Relation path (can be multi-hop, e.g., ['author', 'company']) */
	relation: string[];
	/** The filter condition applied to the relation */
	condition: NqlExpression;
	/** Quantifier mode */
	mode: 'some' | 'none' | 'every';
	/** Optional alias for the relation (for complex conditions) */
	alias?: string;
}

export interface NqlFunctionCall {
	type: 'function';
	name: string;
	args: NqlExpression[];
	/** Whether DISTINCT modifier was used: count(distinct col) */
	distinct?: boolean;
}

/**
 * Window expression: function OVER (PARTITION BY ... ORDER BY ...)
 */
export interface NqlWindowExpression {
	type: 'window';
	function: string; // rank, dense_rank, row_number, lag, lead, or aggregate name
	args: NqlExpression[]; // function arguments (e.g., field for sum(), offset for lag())
	partitionBy: NqlExpression[];
	orderBy: NqlOrderItem[];
}

/**
 * CASE expression: CASE WHEN cond THEN result [WHEN ...] [ELSE default] END
 */
export interface NqlCaseExpression {
	type: 'case';
	/** Subject expression for simple CASE (CASE expr WHEN val ...) */
	subject?: NqlExpression;
	whenClauses: Array<{
		condition: NqlExpression;
		result: NqlExpression;
	}>;
	elseClause?: NqlExpression;
}

/**
 * JSON access expression: col->'a'->'b'->>'c'
 * Chained path extraction with final mode determined by last operator.
 */
export interface NqlJsonAccessExpression {
	type: 'jsonAccess';
	/** Base expression (typically a path/column reference) */
	base: NqlExpression;
	/** Keys to extract in order */
	path: string[];
	/** 'json' = ->, 'text' = ->> (determined by LAST operator) */
	mode: 'json' | 'text';
}

/**
 * JSON comparison expression: col @> val, col <@ val, col ? key
 */
export interface NqlJsonComparisonExpression {
	type: 'jsonComparison';
	/** Left expression (column/field) */
	left: NqlExpression;
	/** Operator: @> (contains), <@ (containedBy), ? (exists) */
	operator: '@>' | '<@' | '?';
	/** Right expression (value/key) */
	right: NqlExpression;
}

export interface NqlPathExpression {
	type: 'path';
	segments: string[];
	/** Optional depth hint for scoped traversal: ascendant[3].column */
	depthHint?: number;
}

export interface NqlSubquery {
	type: 'subquery';
	query: NqlQuery;
}

/**
 * Reference to a let-bound variable
 */
export interface NqlVariableRef {
	type: 'variable';
	name: string;
}

// ============================================================
// LITERALS
// ============================================================

export type NqlLiteral =
	| NqlStringLiteral
	| NqlNumberLiteral
	| NqlBooleanLiteral
	| NqlNullLiteral
	| NqlDateRangeLiteral
	| NqlRangeLiteral;

export interface NqlStringLiteral {
	type: 'string';
	value: string;
}

export interface NqlNumberLiteral {
	type: 'number';
	value: number;
}

export interface NqlBooleanLiteral {
	type: 'boolean';
	value: boolean;
}

export interface NqlNullLiteral {
	type: 'null';
}

/**
 * Natural language date range (e.g., 'last 7 days', 'this month')
 * Semantic layer validates and converts to actual dates
 */
export interface NqlDateRangeLiteral {
	type: 'dateRange';
	value: string;
}

/**
 * PostgreSQL range literal (e.g., '[2024-01-01,2024-12-31)')
 * Used with range operators: overlaps, contains, containedBy
 */
export interface NqlRangeLiteral {
	type: 'rangeLiteral';
	value: string;
	lowerInclusive: boolean;
	upperInclusive: boolean;
	lower: string;
	upper: string;
}

// ============================================================
// MUTATIONS
// ============================================================

export interface NqlInsert {
	type: 'insert';
	table: string;
	/** Multi-row support: each element is a row's assignments */
	rows: NqlAssignment[][];
}

/**
 * INSERT INTO target FROM source query.
 * @example `insert into archived_users from users | where active = false`
 */
export interface NqlInsertFrom {
	type: 'insert_from';
	/** Target table to insert into */
	table: string;
	/** Source table to select from */
	source: string;
	/** Optional column mapping (default: same columns) */
	columns?: string[] | undefined;
	/** WHERE clause to filter source rows */
	where?: NqlExpression | undefined;
	/** LIMIT clause to restrict rows */
	limit?: number | undefined;
}

export interface NqlUpdate {
	type: 'update';
	table: string;
	assignments: NqlAssignment[];
	where?: NqlExpression;
}

export interface NqlDelete {
	type: 'delete';
	table: string;
	where?: NqlExpression; // Optional at parse time, semantic layer validates presence
}

export interface NqlUpsert {
	type: 'upsert';
	table: string;
	conflictColumns: string[];
	assignments: NqlAssignment[];
	where?: NqlExpression;
}

/**
 * UPSERT INTO target ON conflictColumns FROM source [WHERE ...] [LIMIT ...]
 * Bulk upsert by selecting from another table or bound CTE
 */
export interface NqlUpsertFrom {
	type: 'upsert_from';
	table: string;
	conflictColumns: string[];
	source: string;
	columns?: string[] | undefined;
	where?: NqlExpression | undefined;
	limit?: number | undefined;
}

export interface NqlAssignment {
	column: string;
	value: NqlExpression;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Dead type guards (isQuery, isMutationPipeline, isMutation, isLiteral) removed
// — exported but never imported anywhere in the codebase (unreachable code).
