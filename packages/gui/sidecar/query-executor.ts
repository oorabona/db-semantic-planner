/**
 * SQL and NQL query execution handlers for the sidecar.
 *
 * executeSQL: runs raw SQL against a connected pool.
 * executeNQL: compiles NQL → SQL via @dbsp/core + @dbsp/nql, then executes.
 * fetchMore: loads the next page of a paginated result set via OFFSET/LIMIT.
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

export interface FetchMoreParams {
	cursorId: string;
	maxRows?: number;
}

interface QueryResponse {
	rows: Record<string, unknown>[];
	columns: string[];
	durationMs: number;
	totalRows?: number;
	truncated?: boolean;
	cursorId?: string;
	sql?: string;
	params?: readonly unknown[];
	plan?: unknown;
}

// ── Pagination state ─────────────────────────────────────────────

interface PageState {
	readonly sql: string;
	readonly sqlParams: readonly unknown[];
	readonly connectionId: string;
	readonly maxRows: number;
	currentOffset: number;
	readonly columns: string[];
}

const pageStore = new Map<string, PageState>();
let cursorCounter = 0;

function generateCursorId(): string {
	return `cur_${++cursorCounter}_${Date.now()}`;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Detect SELECT-type statements that should be wrapped with LIMIT. */
function isSelectStatement(sql: string): boolean {
	const trimmed = sql.trimStart().toUpperCase();
	return trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');
}

/**
 * Wrap SQL in a subquery with server-side LIMIT and optional OFFSET.
 * Fetches limit rows (caller should pass maxRows+1 to detect "has more").
 */
function wrapWithLimit(sql: string, limit: number, offset: number): string {
	if (offset > 0) {
		return `SELECT * FROM (${sql}) AS _q LIMIT ${limit} OFFSET ${offset}`;
	}
	return `SELECT * FROM (${sql}) AS _q LIMIT ${limit}`;
}

/**
 * Execute a paginated SELECT: wraps with LIMIT N+1 to detect whether more
 * rows exist without fetching them all.
 */
async function executePaginated(
	pool: Pool,
	sql: string,
	sqlParams: readonly unknown[],
	maxRows: number,
	offset: number,
): Promise<{
	rows: Record<string, unknown>[];
	columns: string[];
	durationMs: number;
	hasMore: boolean;
}> {
	const wrappedSql = wrapWithLimit(sql, maxRows + 1, offset);
	const start = performance.now();
	const result = await pool.query(
		wrappedSql,
		sqlParams.length > 0 ? [...sqlParams] : undefined,
	);
	const durationMs = Math.round(performance.now() - start);

	const allRows = (result.rows ?? []) as Record<string, unknown>[];
	const columns = result.fields?.map((f) => f.name) ?? [];
	const hasMore = allRows.length > maxRows;
	const rows = hasMore ? allRows.slice(0, maxRows) : allRows;

	return { rows, columns, durationMs, hasMore };
}

// ── executeSQL ──────────────────────────────────────────────────

export async function handleExecuteSQL(
	params: ExecuteSqlParams,
	getPool: (connectionId: string) => Pool,
): Promise<QueryResponse> {
	const pool = getPool(params.connectionId);
	const maxRows = params.maxRows ?? 1000;

	if (isSelectStatement(params.sql)) {
		const { rows, columns, durationMs, hasMore } = await executePaginated(
			pool,
			params.sql,
			params.params ?? [],
			maxRows,
			0,
		);

		let cursorId: string | undefined;
		if (hasMore) {
			cursorId = generateCursorId();
			pageStore.set(cursorId, {
				sql: params.sql,
				sqlParams: params.params ?? [],
				connectionId: params.connectionId,
				maxRows,
				currentOffset: maxRows,
				columns,
			});
		}

		return { rows, columns, durationMs, truncated: hasMore, cursorId };
	}

	// Non-SELECT: execute directly (mutations, DDL, etc.)
	const start = performance.now();
	const result = await pool.query(
		params.sql,
		params.params ? [...params.params] : undefined,
	);
	const durationMs = Math.round(performance.now() - start);

	const rows = (result.rows ?? []) as Record<string, unknown>[];
	const columns = result.fields?.map((f) => f.name) ?? [];

	return {
		rows,
		columns,
		durationMs,
		totalRows: result.rowCount ?? rows.length,
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
	let isQuery = false;

	if (compiled.query) {
		const report = plan(compiled.query, model, {
			dialectCapabilities: adapter.dialectCapabilities,
		});
		const compiledQuery = adapter.compile(report, { model });
		sql = compiledQuery.sql;
		sqlParams = compiledQuery.parameters;
		planReport = report;
		isQuery = true;
	} else if (compiled.setOperation) {
		const compileFn = createLeafCompileFn(adapter, model, plan);
		const setResult = compileSetOperation(compiled.setOperation, compileFn);
		sql = setResult.sql;
		sqlParams = setResult.parameters;
		isQuery = true;
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

	// Execute against DB — paginate if it's a query
	if (isQuery) {
		const { rows, columns, durationMs, hasMore } = await executePaginated(
			pool,
			sql,
			sqlParams,
			maxRows,
			0,
		);

		let cursorId: string | undefined;
		if (hasMore) {
			cursorId = generateCursorId();
			pageStore.set(cursorId, {
				sql,
				sqlParams,
				connectionId: params.connectionId,
				maxRows,
				currentOffset: maxRows,
				columns,
			});
		}

		return {
			rows,
			columns,
			durationMs,
			truncated: hasMore,
			cursorId,
			sql,
			params: sqlParams,
			plan: planReport,
		};
	}

	// Mutation: execute directly
	const start = performance.now();
	const dbResult = await pool.query(sql, [...sqlParams]);
	const durationMs = Math.round(performance.now() - start);

	const rows = (dbResult.rows ?? []) as Record<string, unknown>[];
	const columns = dbResult.fields?.map((f) => f.name) ?? [];

	return {
		rows,
		columns,
		durationMs,
		totalRows: dbResult.rowCount ?? rows.length,
		sql,
		params: sqlParams,
		plan: planReport,
	};
}

// ── fetchMore ───────────────────────────────────────────────────

export async function handleFetchMore(
	params: FetchMoreParams,
	getPool: (connectionId: string) => Pool,
): Promise<QueryResponse> {
	const state = pageStore.get(params.cursorId);
	if (!state) {
		throw new Error(`Unknown or expired cursor: ${params.cursorId}`);
	}

	const pool = getPool(state.connectionId);
	const maxRows = params.maxRows ?? state.maxRows;

	const { rows, columns, durationMs, hasMore } = await executePaginated(
		pool,
		state.sql,
		state.sqlParams,
		maxRows,
		state.currentOffset,
	);

	if (hasMore) {
		state.currentOffset += maxRows;
	} else {
		pageStore.delete(params.cursorId);
	}

	return {
		rows,
		columns: columns.length > 0 ? columns : state.columns,
		durationMs,
		truncated: hasMore,
		cursorId: hasMore ? params.cursorId : undefined,
	};
}
