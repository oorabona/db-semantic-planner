/**
 * NQL Executor - Execute NQL queries via @dbsp/nql + ORM
 *
 * Flow:
 * NQL string → parse() → compile() → IntentAST → plan()/compileX() → SQL → execute
 *
 * Part of NQLM (NQL CLI Migration) - Block 2
 */

import {
	compileDelete,
	compileInsert,
	compile as compileToSql,
	compileUpdate,
	compileUpsert,
	createCompileOnlyAdapter,
	type MockDialect,
} from '@dbsp/adapter-kysely';
import {
	type DeleteIntent,
	type InsertIntent,
	type ModelIR,
	plan,
	type QueryIntent,
	type UpdateIntent,
	type UpsertIntent,
} from '@dbsp/core';
import {
	type CompileResult,
	compile as compileNql,
	type MutationIntent as NqlMutationIntent,
	type QueryIntent as NqlQueryIntent,
} from '@dbsp/nql';
import type { Kysely } from 'kysely';

// Type compatibility: NQL types are structurally compatible with core types
// Cast functions to bridge the gap
function asQueryIntent(intent: NqlQueryIntent): QueryIntent {
	return intent as unknown as QueryIntent;
}

function asInsertIntent(intent: NqlMutationIntent): InsertIntent {
	return intent as unknown as InsertIntent;
}

function asUpdateIntent(intent: NqlMutationIntent): UpdateIntent {
	return intent as unknown as UpdateIntent;
}

function asDeleteIntent(intent: NqlMutationIntent): DeleteIntent {
	return intent as unknown as DeleteIntent;
}

function asUpsertIntent(intent: NqlMutationIntent): UpsertIntent {
	return intent as unknown as UpsertIntent;
}

// Type guard functions for NQL mutation types
function isNqlInsertIntent(m: NqlMutationIntent): boolean {
	return m.type === 'insert';
}

function isNqlUpdateIntent(m: NqlMutationIntent): boolean {
	return m.type === 'update';
}

function isNqlDeleteIntent(m: NqlMutationIntent): boolean {
	return m.type === 'delete';
}

function isNqlUpsertIntent(m: NqlMutationIntent): boolean {
	return m.type === 'upsert';
}

/**
 * Extract IntentSummary from NQL compilation result
 */
function extractIntentSummary(
	compiled: CompileResult,
	intentType: IntentSummary['type'],
): IntentSummary {
	if (compiled.query) {
		const q = compiled.query;
		return {
			type: 'query',
			table: q.from,
			with: (q.include ?? []).map((i) => i.relation),
			hasWhere: !!q.where,
			hasGroupBy: !!(q.groupBy && q.groupBy.length > 0),
			hasOrderBy: !!(q.orderBy && q.orderBy.length > 0),
			ctes: [], // CTEs are at program level, not in CompileResult
		};
	}

	if (compiled.mutation) {
		const m = compiled.mutation;
		return {
			type: intentType,
			table: m.table,
			with: [],
			hasWhere: 'where' in m && !!m.where,
			hasGroupBy: false,
			hasOrderBy: false,
			ctes: [],
		};
	}

	// Fallback for edge cases
	return {
		type: intentType,
		table: '',
		with: [],
		hasWhere: false,
		hasGroupBy: false,
		hasOrderBy: false,
		ctes: [],
	};
}

/**
 * Error thrown when NQL parsing fails
 */
export class NqlParseError extends Error {
	constructor(
		public readonly errors: Array<{ code: string; message: string }>,
	) {
		const messages = errors.map((e) => e.message).join('\n');
		super(`NQL parse error:\n${messages}`);
		this.name = 'NqlParseError';
	}
}

/**
 * Error thrown when NQL compilation fails
 */
export class NqlCompileError extends Error {
	constructor(message: string) {
		super(`NQL compile error: ${message}`);
		this.name = 'NqlCompileError';
	}
}

/**
 * Result of NQL execution
 */
export interface NqlExecutionResult {
	/** Compiled SQL query */
	sql: string;
	/** Query parameters */
	params: readonly unknown[];
	/** Query result rows */
	rows: readonly Record<string, unknown>[];
	/** Number of affected rows (for mutations) */
	affectedRows?: number;
	/** Intent type that was executed */
	intentType: 'query' | 'insert' | 'update' | 'delete' | 'upsert';
}

/**
 * Simplified intent summary for assertions
 */
export interface IntentSummary {
	/** Intent type */
	type: 'query' | 'insert' | 'update' | 'delete' | 'upsert';
	/** Main table name */
	table: string;
	/** Relations joined via `with` keyword */
	with: string[];
	/** Has WHERE clause */
	hasWhere: boolean;
	/** Has GROUP BY clause */
	hasGroupBy: boolean;
	/** Has ORDER BY clause */
	hasOrderBy: boolean;
	/** CTE names (let bindings) */
	ctes: string[];
}

/**
 * Result of NQL compilation (SQL only, no execution)
 */
export interface NqlCompileOnlyResult {
	/** Compiled SQL query */
	sql: string;
	/** Query parameters */
	params: readonly unknown[];
	/** Intent type */
	intentType: 'query' | 'insert' | 'update' | 'delete' | 'upsert';
	/** Intent summary for assertions */
	intent: IntentSummary;
}

/**
 * Execute NQL query against a database
 *
 * @param nql - NQL query string
 * @param model - ModelIR schema
 * @param db - Kysely database instance
 * @param schemaName - Optional database schema name
 * @returns Execution result with SQL, params, and rows
 *
 * @example
 * ```typescript
 * const result = await executeNql(
 *   'users | where active = true | limit 10',
 *   model,
 *   kyselyDb
 * );
 * console.log(result.sql);    // SELECT * FROM "users" WHERE "active" = $1 LIMIT 10
 * console.log(result.rows);   // [{ id: 1, name: 'Alice', active: true }, ...]
 * ```
 */
export async function executeNql(
	nql: string,
	model: ModelIR,
	db: Kysely<unknown>,
	schemaName?: string,
): Promise<NqlExecutionResult> {
	// 1. Parse and compile NQL to IntentAST
	const compiled = compileNqlToIntent(nql, model);

	// 2. Compile IntentAST to Kysely query and execute
	if (compiled.query) {
		// SELECT query - cast NQL type to core type
		const queryIntent = asQueryIntent(compiled.query);
		const planReport = plan(queryIntent, model);
		const compiledQuery = compileToSql(planReport, model, db, schemaName);

		const result = await db.executeQuery(compiledQuery);

		return {
			sql: compiledQuery.sql,
			params: compiledQuery.parameters as readonly unknown[],
			rows: result.rows as readonly Record<string, unknown>[],
			intentType: 'query',
		};
	}

	if (compiled.mutation) {
		const mutation = compiled.mutation;

		if (isNqlInsertIntent(mutation)) {
			const intent = asInsertIntent(mutation);
			const compiledQuery = compileInsert(intent, db, schemaName);
			const result = await db.executeQuery(compiledQuery);

			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters as readonly unknown[],
				rows: result.rows as readonly Record<string, unknown>[],
				affectedRows: Number(result.numAffectedRows ?? result.rows.length),
				intentType: 'insert',
			};
		}

		if (isNqlUpdateIntent(mutation)) {
			const intent = asUpdateIntent(mutation);
			const compiledQuery = compileUpdate(intent, db, schemaName);
			const result = await db.executeQuery(compiledQuery);

			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters as readonly unknown[],
				rows: result.rows as readonly Record<string, unknown>[],
				affectedRows: Number(result.numAffectedRows ?? 0),
				intentType: 'update',
			};
		}

		if (isNqlDeleteIntent(mutation)) {
			const intent = asDeleteIntent(mutation);
			const compiledQuery = compileDelete(intent, db, schemaName);
			const result = await db.executeQuery(compiledQuery);

			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters as readonly unknown[],
				rows: result.rows as readonly Record<string, unknown>[],
				affectedRows: Number(result.numAffectedRows ?? 0),
				intentType: 'delete',
			};
		}

		if (isNqlUpsertIntent(mutation)) {
			const intent = asUpsertIntent(mutation);
			const compiledQuery = compileUpsert(intent, db, schemaName);
			const result = await db.executeQuery(compiledQuery);

			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters as readonly unknown[],
				rows: result.rows as readonly Record<string, unknown>[],
				affectedRows: Number(result.numAffectedRows ?? result.rows.length),
				intentType: 'upsert',
			};
		}

		throw new NqlCompileError(
			`Unknown mutation type: ${JSON.stringify(mutation)}`,
		);
	}

	throw new NqlCompileError('NQL compiled to neither query nor mutation');
}

/**
 * Dialect type that includes CLI-supported dialects (superset of MockDialect)
 * DuckDB uses PostgreSQL-compatible syntax so we map it internally.
 */
export type CliDialect = MockDialect | 'duckdb';

/**
 * Options for NQL compilation
 */
export interface NqlCompileOptions {
	/** SQL dialect for query compilation (duckdb maps to postgresql) */
	dialect?: CliDialect;
	/** Database schema name for schema-scoped queries */
	schemaName?: string;
}

/**
 * Map CLI dialect to MockDialect (duckdb → postgresql)
 */
function toMockDialect(dialect: CliDialect | undefined): MockDialect {
	if (dialect === 'duckdb') return 'postgresql';
	return dialect ?? 'postgresql';
}

/**
 * Compile NQL to SQL without executing
 *
 * Useful for REPL preview and testing. Creates its own CompileOnlyAdapter internally.
 *
 * @param nql - NQL query string
 * @param model - ModelIR schema
 * @param options - Optional compilation options (dialect, schemaName)
 * @returns Compiled SQL and parameters
 *
 * @example
 * ```typescript
 * const result = compileNqlToSql(
 *   'users | where active = true | limit 10',
 *   model
 * );
 * console.log(result.sql);    // SELECT * FROM "users" WHERE "active" = $1 LIMIT 10
 * console.log(result.params); // [true]
 * ```
 */
export function compileNqlToSql(
	nql: string,
	model: ModelIR,
	options?: NqlCompileOptions,
): NqlCompileOnlyResult {
	// Create CompileOnlyAdapter for SQL generation
	const adapter = createCompileOnlyAdapter({
		dialect: toMockDialect(options?.dialect),
		...(options?.schemaName !== undefined && {
			schemaName: options.schemaName,
		}),
	});

	// 1. Parse and compile NQL to IntentAST
	const compiled = compileNqlToIntent(nql, model);

	// 2. Compile IntentAST to SQL using adapter
	if (compiled.query) {
		const queryIntent = asQueryIntent(compiled.query);
		const planReport = plan(queryIntent, model);
		const compiledQuery = adapter.compile(planReport, { model });

		return {
			sql: compiledQuery.sql,
			params: compiledQuery.parameters,
			intentType: 'query',
			intent: extractIntentSummary(compiled, 'query'),
		};
	}

	if (compiled.mutation) {
		const mutation = compiled.mutation;

		if (isNqlInsertIntent(mutation)) {
			const intent = asInsertIntent(mutation);
			const compiledQuery = adapter.compileInsert(intent);
			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters,
				intentType: 'insert',
				intent: extractIntentSummary(compiled, 'insert'),
			};
		}

		if (isNqlUpdateIntent(mutation)) {
			const intent = asUpdateIntent(mutation);
			const compiledQuery = adapter.compileUpdate(intent);
			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters,
				intentType: 'update',
				intent: extractIntentSummary(compiled, 'update'),
			};
		}

		if (isNqlDeleteIntent(mutation)) {
			const intent = asDeleteIntent(mutation);
			const compiledQuery = adapter.compileDelete(intent);
			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters,
				intentType: 'delete',
				intent: extractIntentSummary(compiled, 'delete'),
			};
		}

		if (isNqlUpsertIntent(mutation)) {
			const intent = asUpsertIntent(mutation);
			const compiledQuery = adapter.compileUpsert(intent);
			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters,
				intentType: 'upsert',
				intent: extractIntentSummary(compiled, 'upsert'),
			};
		}

		throw new NqlCompileError(
			`Unknown mutation type: ${JSON.stringify(mutation)}`,
		);
	}

	throw new NqlCompileError('NQL compiled to neither query nor mutation');
}

/**
 * Internal: Parse and compile NQL to IntentAST
 */
function compileNqlToIntent(nql: string, _model: ModelIR): CompileResult {
	const result = compileNql(nql, _model);

	if (!result.success) {
		throw new NqlParseError(result.errors);
	}

	if (!result.ast) {
		throw new NqlCompileError('Compilation succeeded but no AST produced');
	}

	return result.ast;
}

/**
 * Check if a string is valid NQL (does not start with REPL commands)
 *
 * REPL commands: .tables, .schema, !sql, etc.
 */
export function isNqlQuery(input: string): boolean {
	const trimmed = input.trim();

	// REPL commands start with . or !
	if (trimmed.startsWith('.') || trimmed.startsWith('!')) {
		return false;
	}

	// Empty input
	if (!trimmed) {
		return false;
	}

	return true;
}

/**
 * Get the IntentAST from NQL without compiling to SQL
 *
 * Useful for debugging and introspection.
 */
export function getNqlIntent(
	nql: string,
	model: ModelIR,
): { query: QueryIntent | undefined; mutation: NqlMutationIntent | undefined } {
	const compiled = compileNqlToIntent(nql, model);
	return {
		query: compiled.query ? asQueryIntent(compiled.query) : undefined,
		mutation: compiled.mutation,
	};
}
