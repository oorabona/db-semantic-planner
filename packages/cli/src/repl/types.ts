/**
import type React from 'react';
 * DX-030: REPL Types
 */

import type { ResolvedSchema } from '@dbsp/core';

/**
 * REPL Configuration passed from CLI command
 */
export interface ReplConfig {
	schema: ResolvedSchema;
	schemaPath: string;
	/** CLI-020: Optional database connection URL for execution mode */
	databaseUrl?: string;
}

/**
 * Query mode - natural syntax or SQL
 */
export type QueryMode = 'natural' | 'sql';

/**
 * Column aliasing mode for included relations (CLI-010)
 * - 'always': Alias all columns from included tables
 * - 'onCollision': Only alias columns that exist in multiple tables
 */
export type AliasingMode = 'always' | 'onCollision';

/**
 * Include strategy for relations (CLI-011)
 * - 'auto': Let the planner choose based on relation type (DEFAULT)
 * - 'join': Use JOIN (single query, database optimizes)
 * - 'separate': Use separate queries (N+1 style with batching)
 * - 'cte': Use CTE to materialize base query before joining
 * - 'lateral': Use LATERAL JOIN (PostgreSQL only) - limit N children per parent
 * - 'json_agg': Use JSON aggregation (PostgreSQL, MySQL 8+) - no row duplication
 */
export type IncludeStrategyMode =
	| 'auto'
	| 'join'
	| 'separate'
	| 'cte'
	| 'lateral'
	| 'json_agg';

/**
 * SQL dialect for the REPL (CLI-011)
 * Determines SQL syntax and available features.
 */
export type DialectMode =
	| 'postgresql'
	| 'mysql'
	| 'sqlite'
	| 'mssql'
	| 'duckdb';

/**
 * REPL state
 */
export interface ReplState {
	mode: QueryMode;
	history: string[];
	historyIndex: number;
	splitView: boolean;
	aliasingMode: AliasingMode;
	includeStrategy: IncludeStrategyMode;
	dialect: DialectMode;
	/** CLI-020: Execution mode enabled */
	execMode: boolean;
	/** CLI-020: Database connection active */
	connected: boolean;
	/** CLI-MUT: EXPLAIN mode - show query plan with results */
	explainMode: boolean;
}

/**
 * Dot command handler result
 */
export interface DotCommandResult {
	type:
		| 'output'
		| 'clear'
		| 'exit'
		| 'mode-change'
		| 'toggle-split'
		| 'exec-toggle';
	content?: React.ReactNode;
	newMode?: QueryMode;
	/** CLI-020: New execution mode state */
	newExecMode?: boolean;
}

/**
 * Separate include query for SEPARATE strategy relations
 */
export interface SeparateQueryResult {
	relation: string;
	sql: string;
	params: readonly unknown[];
}

/**
 * Query execution result
 */
export interface QueryResult {
	sql: string;
	params: readonly unknown[];
	/** Additional queries for SEPARATE strategy relations (manyToMany, hasMany) */
	separateQueries?: SeparateQueryResult[];
	plan?: {
		strategy: string;
		tables: string[];
		warnings: string[];
	};
	error?: string;
	/** CLI-NQL: Parsed query AST for .parse mode */
	parsedQuery?: unknown;
}

/**
 * CLI-020: Database execution result
 */
export interface ExecutionResult {
	/** Result rows from database */
	rows: Record<string, unknown>[];
	/** Column names in order */
	columns: string[];
	/** Row count */
	rowCount: number;
	/** Execution time in milliseconds */
	executionTimeMs: number;
	/** Error message if execution failed */
	error?: string;
	/** Was result truncated? */
	truncated?: boolean;
}

// =============================================================================
// CLI-NQL: Path Expression Types
// =============================================================================

/**
 * CLI-NQL: A single segment of a path expression.
 * @example
 *   "category" → { name: "category", quoted: false }
 *   "\"name\"" → { name: "name", quoted: true }
 */
export interface PathSegment {
	/** The identifier name (without quotes) */
	name: string;
	/**
	 * Whether the identifier was quoted (double quotes).
	 * Quoted identifiers force column interpretation, bypassing relation lookup.
	 */
	quoted: boolean;
}

/**
 * CLI-NQL: A parsed path expression like "category.parent.name".
 * Path expressions can reference columns or traverse relations.
 */
export interface PathExpression {
	/** Array of path segments from left to right */
	segments: PathSegment[];
	/** Original string representation for error messages */
	raw: string;
}

/**
 * CLI-NQL: Resolution hint for a path expression.
 * - 'column': The path resolves to a column (terminal)
 * - 'relation': The path resolves to a relation (can be traversed further)
 * - 'unknown': Resolution pending (needs schema context)
 */
export type PathResolutionKind = 'column' | 'relation' | 'unknown';

// =============================================================================
// CLI-NQL: Recursive Relation Types (Block 7)
// =============================================================================

/**
 * CLI-NQL Block 7: Recursive direction for ancestors/descendants traversal.
 * - 'up': Traverse to ancestors (parent → grandparent → ...)
 * - 'down': Traverse to descendants (children → grandchildren → ...)
 */
export type RecursiveDirection = 'up' | 'down';

/**
 * CLI-NQL Block 7: Metadata for a recursive relation in the schema.
 * Used to detect and validate recursive path expressions.
 *
 * @example
 * Schema defines: ancestors: { recursive: { direction: 'up', through: 'parent', maxDepth: 10 } }
 * Query: "categories where ancestors has name = 'Electronics'"
 */
export interface RecursiveRelationInfo {
	/** Direction of recursion: up (ancestors) or down (descendants) */
	direction: RecursiveDirection;
	/** The relation name to follow for recursion (e.g., 'parent' for ancestors) */
	through: string;
	/** Maximum recursion depth (default: 10) */
	maxDepth: number;
}

/**
 * CLI-NQL Block 7: A recursive path in a parsed query.
 * When a path contains a recursive relation, this tracks the info needed
 * for CTE generation during execution.
 *
 * @example
 * "categories where ancestors has name = 'Electronics'"
 * → { relation: 'ancestors', table: 'categories', recursive: { direction: 'up', through: 'parent', maxDepth: 10 } }
 */
export interface RecursivePath {
	/** The recursive relation name (e.g., 'ancestors', 'descendants') */
	relation: string;
	/** The source table */
	table: string;
	/** Recursive traversal metadata */
	recursive: RecursiveRelationInfo;
}

// =============================================================================
// CLI-NQL: Subquery Types (Block 3)
// =============================================================================

/**
 * CLI-NQL: A subquery in value position.
 * Used for scalar comparisons: `categoryId = (categories where name = 'X')`
 * Or IN/NOT IN: `categoryId in (categories where active = true)`
 *
 * @example
 * products where categoryId = (categories where name = 'Electronics')
 * // → { table: 'categories', where: [...], selectColumn: 'id' }
 */
export interface ParsedSubquery {
	/** Target table of the subquery */
	table: string;
	/** Optional WHERE conditions */
	where?: Array<{ column: string; operator: string; value: unknown }>;
	/**
	 * Column to select (defaults to primary key).
	 * Explicit via `select col`: `(categories where x select id)`
	 */
	selectColumn?: string;
}

/**
 * CLI-NQL: Value that can be a subquery.
 * Extended WhereClause value type to support subqueries.
 */
export interface SubqueryValue {
	type: 'subquery';
	subquery: ParsedSubquery;
}

/**
 * CLI-NQL: Existence check for has/not has syntax.
 * Generates EXISTS/NOT EXISTS subqueries.
 *
 * @example
 * categories where has products
 * // → { type: 'exists', relation: 'products' }
 *
 * @example
 * categories where not has products where rating > 4
 * // → { type: 'not_exists', relation: 'products', where: [{ column: 'rating', operator: '>', value: 4 }] }
 */
export interface ExistenceCheck {
	type: 'exists' | 'not_exists';
	/** Relation name to check existence for */
	relation: string;
	/** Optional nested WHERE conditions on the related table */
	where?: Array<{ column: string; operator: string; value: unknown }>;
	/**
	 * CLI-NQL Block 7: Recursive relation info (if this is an ancestors/descendants check).
	 * When present, the executor should generate a recursive CTE instead of simple EXISTS.
	 */
	recursive?: RecursiveRelationInfo;
}

// =============================================================================
// CLI-NQL Block 8: Window Expression Types
// =============================================================================

/**
 * CLI-NQL Block 8: Window-only function names.
 * These functions can ONLY be used with OVER clause.
 */
export type WindowOnlyFunction =
	| 'rank'
	| 'dense_rank'
	| 'row_number'
	| 'lag'
	| 'lead';

/**
 * CLI-NQL Block 8: Aggregate functions that can be used with OVER clause.
 */
export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * CLI-NQL Block 8: All functions usable in window expressions.
 */
export type WindowFunction = WindowOnlyFunction | AggregateFunction;

/**
 * CLI-NQL Block 8: ORDER BY item in a window specification.
 */
export interface WindowOrderItem {
	/** Column or path expression */
	column: string;
	/** Sort direction (default: asc) */
	direction: 'asc' | 'desc';
}

/**
 * CLI-NQL Block 8: Window specification (OVER clause content).
 */
export interface WindowSpec {
	/** PARTITION BY columns */
	partitionBy?: string[];
	/** ORDER BY items */
	orderBy?: WindowOrderItem[];
}

/**
 * CLI-NQL Block 8: Parsed window expression.
 *
 * @example
 * rank() over (partition by categoryId order by price desc) as priceRank
 * sum(total) over (order by createdAt) as runningTotal
 * lag(price, 1, 0) over (order by id)
 */
export interface ParsedWindowExpression {
	/** Function name (rank, sum, count, etc.) */
	function: WindowFunction;
	/** Function arguments (e.g., column for sum(column), or [col, offset, default] for lag) */
	args: string[];
	/** Window specification from OVER clause */
	spec: WindowSpec;
	/** Optional alias */
	alias?: string;
}

// =============================================================================
// CLI-MUT: Mutation Types
// =============================================================================

/**
 * CLI-MUT: Mutation type
 */
export type MutationType = 'insert' | 'update' | 'delete' | 'upsert';

/**
 * CLI-MUT: Value type in mutation assignments
 */
export interface MutationValue {
	/** Value type for proper SQL generation */
	type: 'string' | 'number' | 'boolean' | 'null' | 'function' | 'json';
	/** Original text as written */
	raw: string;
	/** Parsed value for binding */
	value: unknown;
}

/**
 * CLI-MUT: Column assignment (column = value)
 */
export interface Assignment {
	column: string;
	value: MutationValue;
}

/**
 * CLI-MUT: ON CONFLICT clause for UPSERT
 */
export interface OnConflictClause {
	/** Conflict target columns */
	columns: string[];
	/** Action on conflict */
	action: 'nothing' | 'update';
	/** Assignments for DO UPDATE */
	updateAssignments?: Assignment[];
}

/**
 * CLI-NQL: FROM clause for INSERT mutations
 * Allows FK lookup and bulk inserts from a source table
 */
export interface FromClause {
	/** Source table name */
	table: string;
	/** Optional alias for source table */
	alias?: string;
	/** Bulk insert mode (from each) - source may return multiple rows */
	bulk: boolean;
	/** WHERE conditions on source table */
	where?: Array<{ column: string; operator: string; value: unknown }>;
	/** FOR UPDATE locking */
	forUpdate?: boolean;
	/** SKIP LOCKED option for FOR UPDATE */
	skipLocked?: boolean;
}

/**
 * CLI-MUT: Parsed mutation result
 */
export interface ParsedMutation {
	/** Mutation type */
	type: MutationType;
	/** Target table */
	table: string;
	/** Columns for INSERT (when using explicit column list) */
	columns?: string[];
	/** Assignments for INSERT/UPDATE/UPSERT */
	assignments?: Assignment[];
	/** WHERE clause for UPDATE/DELETE */
	where?: import('./parser.js').WhereClause[];
	/** ON CONFLICT clause for UPSERT */
	onConflict?: OnConflictClause;
	/** FROM clause for INSERT (FK lookup or bulk insert) */
	fromClause?: FromClause;
	/** Execute immediately (! suffix) */
	executeImmediate: boolean;
}
