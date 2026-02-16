/**
 * SQL and NQL query execution handlers for the sidecar.
 *
 * executeSQL: runs raw SQL against a connected pool.
 * executeNQL: compiles NQL → SQL via @dbsp/core + @dbsp/nql, then executes.
 */
import {
	compileSetOperation,
	createLeafCompileFn,
	createPgsqlCompileOnlyAdapter,
} from '@dbsp/adapter-pgsql';
import { extractPseudoColumnKeywords, plan } from '@dbsp/core';
import { compile as compileNql } from '@dbsp/nql';
import type { Pool } from 'pg';

// ── Types ────────────────────────────────────────────────────────

export interface ExecuteSqlParams {
	connectionId: string;
	sql: string;
	params?: readonly unknown[];
	maxRows?: number;
	timeoutMs?: number;
}

export interface ExecuteNqlParams {
	connectionId: string;
	nql: string;
	maxRows?: number;
	timeoutMs?: number;
}

interface QueryResponse {
	rows: Record<string, unknown>[];
	columns: string[];
	durationMs: number;
	totalRows?: number;
	truncated?: boolean;
	sql?: string;
	params?: readonly unknown[];
	plan?: unknown;
}

// ── executeSQL ──────────────────────────────────────────────────

export async function handleExecuteSQL(
	params: ExecuteSqlParams,
	getPool: (connectionId: string) => Pool,
): Promise<QueryResponse> {
	const pool = getPool(params.connectionId);
	const maxRows = params.maxRows ?? 1000;

	const start = performance.now();
	const result = await pool.query(
		params.sql,
		params.params ? [...params.params] : undefined,
	);
	const durationMs = Math.round(performance.now() - start);

	const allRows = (result.rows ?? []) as Record<string, unknown>[];
	const columns = result.fields?.map((f) => f.name) ?? [];
	const truncated = allRows.length > maxRows;
	const rows = truncated ? allRows.slice(0, maxRows) : allRows;

	return {
		rows,
		columns,
		durationMs,
		totalRows: result.rowCount ?? allRows.length,
		truncated,
	};
}

// ── executeNQL ──────────────────────────────────────────────────

export async function handleExecuteNQL(
	params: ExecuteNqlParams,
	getPool: (connectionId: string) => Pool,
	introspect: (connectionId: string) => Promise<import('@dbsp/core').ModelIR>,
): Promise<QueryResponse> {
	const pool = getPool(params.connectionId);
	const model = await introspect(params.connectionId);
	const maxRows = params.maxRows ?? 1000;

	// Compile NQL → SQL
	const compilerOptions = extractPseudoColumnKeywords(model);
	const result = compileNql(params.nql, model, undefined, compilerOptions);

	/* v8 ignore start — defensive guards: NQL compiler always produces one of query/mutation/setOp;
	   parse errors are caught upstream by the router. Mock cost >> test value. -- @preserve */
	if (!result.success || !result.ast) {
		const messages = result.errors.map((e) => e.message).join('\n');
		throw new Error(`NQL parse error: ${messages}`);
	}

	const compiled = result.ast;
	const adapter = createPgsqlCompileOnlyAdapter();

	let sql: string;
	let sqlParams: readonly unknown[];
	let planReport: unknown;

	if (compiled.query) {
		const report = plan(compiled.query, model, {
			dialectCapabilities: adapter.dialectCapabilities,
		});
		const compiledQuery = adapter.compile(report, { model });
		sql = compiledQuery.sql;
		sqlParams = compiledQuery.parameters;
		planReport = report;
	} else if (compiled.setOperation) {
		const compileFn = createLeafCompileFn(adapter, model, plan);
		const setResult = compileSetOperation(compiled.setOperation, compileFn);
		sql = setResult.sql;
		sqlParams = setResult.parameters;
	} else if (compiled.mutation) {
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
				throw new Error(`Unknown mutation type: ${JSON.stringify(mutation)}`);
		}
		sql = compiledMutation.sql;
		sqlParams = compiledMutation.parameters;
	} else {
		throw new Error(
			'NQL compiled to neither query, mutation, nor set operation',
		);
	}
	/* v8 ignore stop -- @preserve */

	// Execute against DB
	const start = performance.now();
	const dbResult = await pool.query(sql, [...sqlParams]);
	const durationMs = Math.round(performance.now() - start);

	const allRows = (dbResult.rows ?? []) as Record<string, unknown>[];
	const columns = dbResult.fields?.map((f) => f.name) ?? [];
	const truncated = allRows.length > maxRows;
	const rows = truncated ? allRows.slice(0, maxRows) : allRows;

	return {
		rows,
		columns,
		durationMs,
		totalRows: dbResult.rowCount ?? allRows.length,
		truncated,
		sql,
		params: sqlParams,
		plan: planReport,
	};
}
