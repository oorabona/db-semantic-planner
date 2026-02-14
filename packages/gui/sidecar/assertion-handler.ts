/**
 * GUI-010 Block 2: Sidecar Assertion Handler
 *
 * Parses .dbsp + .assert.dbsp content, compiles NQL to SQL,
 * optionally executes against a connected DB, and runs assertion evaluations.
 *
 * Reuses @dbsp/core assertion infrastructure (shared with CLI).
 */

import {
	compileSetOperation,
	createLeafCompileFn,
	createPgsqlCompileOnlyAdapter,
} from '@dbsp/adapter-pgsql';
import {
	type AssertionQueryResult,
	type AssertionSummary,
	extractPseudoColumnKeywords,
	type IntentSummary,
	type ModelIR,
	parseAssertionFile,
	plan,
	runAssertions,
	validateAssertionBlocks,
} from '@dbsp/core';
import { type CompileResult, compile as compileNql } from '@dbsp/nql';
import type { Pool } from 'pg';

// ── Types ────────────────────────────────────────────────────────

export interface RunAssertionsParams {
	/** Connection ID for schema introspection (required) */
	connectionId: string;
	/** NQL queries (.dbsp file content) */
	dbspContent: string;
	/** Assertions (.assert.dbsp file content) */
	assertContent: string;
	/** Execute queries on DB (default: true). When false, only compile-only. */
	execute?: boolean;
}

export interface RunAssertionsResult {
	/** Assertion evaluation summary */
	summary: AssertionSummary;
	/** Per-query results */
	queryResults: AssertionQueryResult[];
	/** Parse errors from assertion file (empty if valid) */
	parseErrors: Array<{ line: number; message: string }>;
}

// ── Query splitting ──────────────────────────────────────────────

/**
 * Split .dbsp content into individual NQL queries.
 * - Blank lines and comment lines (starting with #) are preserved for index alignment
 * - Backslash continuation joins lines
 */
export function splitQueries(content: string): string[] {
	const lines = content.split('\n');
	const queries: string[] = [];
	let current = '';

	for (const line of lines) {
		const trimmed = line.trimEnd();

		// Continuation with backslash
		if (trimmed.endsWith('\\')) {
			current += `${trimmed.slice(0, -1).trim()} `;
			continue;
		}

		current += trimmed;
		queries.push(current.trim());
		current = '';
	}

	// Flush remaining
	if (current.trim()) {
		queries.push(current.trim());
	}

	return queries;
}

// ── Intent extraction ────────────────────────────────────────────

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
			ctes: [],
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

	if (compiled.setOperation) {
		const setOp = compiled.setOperation;
		return {
			type: 'setOperation',
			table: setOp.left.from,
			with: [],
			hasWhere: !!setOp.left.where,
			hasGroupBy: false,
			hasOrderBy: false,
			ctes: [],
		};
	}

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

// ── NQL compilation ──────────────────────────────────────────────

interface CompileQueryResult {
	sql: string;
	params: readonly unknown[];
	intent: IntentSummary;
	error?: undefined;
}

interface CompileQueryError {
	error: string;
	sql?: undefined;
	params?: undefined;
	intent?: undefined;
}

/**
 * Compile a single NQL query to SQL using compile-only adapter.
 */
function compileQuery(
	nql: string,
	model: ModelIR,
): CompileQueryResult | CompileQueryError {
	const compilerOptions = extractPseudoColumnKeywords(model);
	const result = compileNql(nql, model, undefined, compilerOptions);

	if (!result.success || !result.ast) {
		const messages = result.errors.map((e) => e.message).join('\n');
		return { error: `NQL parse error: ${messages}` };
	}

	const compiled = result.ast;
	const adapter = createPgsqlCompileOnlyAdapter();

	try {
		if (compiled.query) {
			const planReport = plan(compiled.query, model, {
				dialectCapabilities: adapter.dialectCapabilities,
			});
			const compiledQuery = adapter.compile(planReport, { model });
			return {
				sql: compiledQuery.sql,
				params: compiledQuery.parameters,
				intent: extractIntentSummary(compiled, 'query'),
			};
		}

		if (compiled.setOperation) {
			const compileFn = createLeafCompileFn(adapter, model, plan);
			const setResult = compileSetOperation(compiled.setOperation, compileFn);
			return {
				sql: setResult.sql,
				params: setResult.parameters,
				intent: extractIntentSummary(compiled, 'setOperation'),
			};
		}

		if (compiled.mutation) {
			const mutation = compiled.mutation;
			let compiledMutation: { sql: string; parameters: readonly unknown[] };

			switch (mutation.type) {
				case 'insert':
					compiledMutation = adapter.compileInsert(mutation);
					break;
				case 'update':
					compiledMutation = adapter.compileUpdate(mutation);
					break;
				case 'delete':
					compiledMutation = adapter.compileDelete(mutation);
					break;
				case 'upsert':
					compiledMutation = adapter.compileUpsert(mutation);
					break;
				default:
					return {
						error: `Unknown mutation type: ${JSON.stringify(mutation)}`,
					};
			}

			return {
				sql: compiledMutation.sql,
				params: compiledMutation.parameters,
				intent: extractIntentSummary(compiled, mutation.type),
			};
		}

		return {
			error: 'NQL compiled to neither query, mutation, nor set operation',
		};
	} catch (err) {
		const detail =
			err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return { error: `Compilation error: ${detail}` };
	}
}

// ── DB execution ─────────────────────────────────────────────────

interface ExecutionResult {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	error?: undefined;
}

interface ExecutionError {
	error: string;
	rows?: undefined;
	columns?: undefined;
	rowCount?: undefined;
}

async function executeQuery(
	pool: Pool,
	sql: string,
	params: readonly unknown[],
): Promise<ExecutionResult | ExecutionError> {
	try {
		const result = await pool.query(sql, [...params]);
		const rows = (result.rows ?? []) as Record<string, unknown>[];
		const columns = result.fields?.map((f) => f.name) ?? [];
		return {
			rows,
			columns,
			rowCount: result.rowCount ?? rows.length,
		};
	} catch (err) {
		const detail =
			err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return { error: detail };
	}
}

// ── Main handler ─────────────────────────────────────────────────

/**
 * Run assertions for given .dbsp and .assert.dbsp content.
 *
 * Flow:
 * 1. Parse .assert.dbsp → assertion blocks
 * 2. Split .dbsp → NQL queries
 * 3. Compile each NQL query to SQL
 * 4. (Optional) Execute each compiled query on DB
 * 5. Build AssertionQueryResult[] from results
 * 6. Run runAssertions() from @dbsp/core
 * 7. Return summary + per-query results
 */
export async function handleRunAssertions(
	params: RunAssertionsParams,
	getModel: (connectionId: string) => Promise<ModelIR>,
	getPool: (connectionId: string) => Pool,
): Promise<RunAssertionsResult> {
	const { dbspContent, assertContent, connectionId, execute = true } = params;

	// 1. Parse assertion file
	const parseResult = parseAssertionFile(assertContent);

	if (parseResult.errors.length > 0) {
		return {
			summary: { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
			queryResults: [],
			parseErrors: parseResult.errors.map((e) => ({
				line: e.line,
				message: e.message,
			})),
		};
	}

	// 2. Split queries
	const allQueries = splitQueries(dbspContent);

	// Filter executable queries (skip blank lines and comments)
	const executableQueries: string[] = [];
	const executableIndexes: number[] = [];
	for (let i = 0; i < allQueries.length; i++) {
		const q = allQueries[i]?.trim() ?? '';
		if (q.length > 0 && !q.startsWith('#')) {
			executableQueries.push(allQueries[i] ?? '');
			executableIndexes.push(i);
		}
	}

	// 3. Validate assertion block references
	const validationErrors = validateAssertionBlocks(
		parseResult.blocks,
		executableQueries.length,
		executableQueries,
	);

	if (validationErrors.length > 0) {
		return {
			summary: { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
			queryResults: [],
			parseErrors: validationErrors.map((e) => ({
				line: e.line,
				message: e.message,
			})),
		};
	}

	// 4. Get model for NQL compilation
	const model = await getModel(connectionId);

	// 5. Compile and optionally execute each query
	const queryResults: AssertionQueryResult[] = [];
	let pool: Pool | undefined;
	if (execute) {
		try {
			pool = getPool(connectionId);
		} catch {
			// Pool not available — proceed without execution
		}
	}

	for (const nql of executableQueries) {
		const compiled = compileQuery(nql, model);

		if ('error' in compiled && compiled.error) {
			queryResults.push({
				query: nql,
				success: false,
				error: compiled.error,
			});
			continue;
		}

		// Narrowed to CompileQueryResult after error check
		const { sql, params, intent } = compiled as CompileQueryResult;

		const result: AssertionQueryResult = {
			query: nql,
			success: true,
			sql,
			params,
			intent,
		};

		// Execute on DB if requested and pool available
		if (pool && execute) {
			const execResult = await executeQuery(pool, sql, params);

			if (execResult.error) {
				result.dbSuccess = false;
				result.error = `Database error: ${execResult.error}`;
			} else {
				result.dbSuccess = true;
				result.rowCount = execResult.rowCount;
				result.columns = execResult.columns;
				result.rows = execResult.rows;
			}
		}

		queryResults.push(result);
	}

	// 6. Run assertions
	const hasDb = !!pool && execute;
	const summary = runAssertions(
		parseResult.blocks,
		queryResults,
		executableQueries,
		hasDb,
	);

	return {
		summary,
		queryResults,
		parseErrors: [],
	};
}
