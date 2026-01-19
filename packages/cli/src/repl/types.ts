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
