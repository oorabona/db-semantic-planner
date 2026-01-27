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
	bindings: NqlLetBinding[];
	statements: NqlStatement[];
}

export interface NqlLetBinding {
	type: 'let';
	name: string;
	query: NqlQuery;
}

export type NqlStatement = NqlQuery | NqlMutationPipeline;

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
	| NqlUpsert;

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
	| NqlOffsetClause;

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
	params?: NqlJoinParam[];
	via?: string; // Disambiguation when multiple FKs to same table
	condition?: NqlExpression;
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
	| NqlBetweenExpression
	| NqlIsNullExpression
	| NqlExistsExpression
	| NqlRelationFilterExpression
	| NqlFunctionCall
	| NqlWindowExpression
	| NqlCaseExpression
	| NqlPathExpression
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
	whenClauses: Array<{
		condition: NqlExpression;
		result: NqlExpression;
	}>;
	elseClause?: NqlExpression;
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
	assignments: NqlAssignment[];
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
	columns?: string[];
	/** WHERE clause to filter source rows */
	where?: NqlExpression;
	/** LIMIT clause to restrict rows */
	limit?: number;
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

export interface NqlAssignment {
	column: string;
	value: NqlExpression;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

export function isQuery(stmt: NqlStatement): stmt is NqlQuery {
	return stmt.type === 'query';
}

export function isMutationPipeline(
	stmt: NqlStatement,
): stmt is NqlMutationPipeline {
	return stmt.type === 'mutationPipeline';
}

export function isMutation(node: unknown): node is NqlMutation {
	if (typeof node !== 'object' || node === null) return false;
	const type = (node as { type?: string }).type;
	return ['insert', 'update', 'delete', 'upsert'].includes(type ?? '');
}

export function isLiteral(expr: NqlExpression): expr is NqlLiteral {
	return [
		'string',
		'number',
		'boolean',
		'null',
		'dateRange',
		'rangeLiteral',
	].includes(expr.type);
}
