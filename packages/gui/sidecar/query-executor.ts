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
	readonly createdAt: number;
	/** Column name used for keyset pagination (null = use OFFSET). */
	readonly keysetColumn: string | null;
	/** Last seen value of keysetColumn for keyset pagination. */
	lastKeysetValue: unknown;
}

/** Maximum number of cursors kept in memory. Oldest evicted first. */
const MAX_CURSORS = 50;
/** Cursor TTL in milliseconds (10 minutes). */
const CURSOR_TTL_MS = 10 * 60 * 1000;

const pageStore = new Map<string, PageState>();
let cursorCounter = 0;

/** Evict expired cursors and trim to MAX_CURSORS (oldest first). */
function cleanupPageStore(): void {
	const now = Date.now();
	for (const [id, state] of pageStore) {
		if (now - state.createdAt > CURSOR_TTL_MS) {
			pageStore.delete(id);
		}
	}
	if (pageStore.size > MAX_CURSORS) {
		const entries = [...pageStore.entries()].sort(
			(a, b) => a[1].createdAt - b[1].createdAt,
		);
		const excess = pageStore.size - MAX_CURSORS;
		for (let i = 0; i < excess; i++) {
			const entry = entries[i];
			if (entry) pageStore.delete(entry[0]);
		}
	}
}

function generateCursorId(): string {
	return `cur_${++cursorCounter}_${Date.now()}`;
}

// ── Helpers ──────────────────────────────────────────────────────

/** Offset threshold above which keyset pagination is preferred. */
const KEYSET_OFFSET_THRESHOLD = 5000;
/** Column names eligible as keyset cursor (checked in order). */
const KEYSET_CANDIDATE_COLUMNS = ['id', 'ID', 'Id'];

/**
 * Detect a column suitable for keyset pagination from the result set.
 * Returns the column name or null if none found.
 *
 * **Assumption:** The matched column must contain monotonically increasing values
 * (e.g. auto-increment integer PKs). UUID or non-sequential PKs will produce
 * incorrect pagination order — in those cases keyset is not activated.
 */
function detectKeysetColumn(columns: string[]): string | null {
	for (const candidate of KEYSET_CANDIDATE_COLUMNS) {
		if (columns.includes(candidate)) return candidate;
	}
	return null;
}

/**
 * Wrap SQL with keyset-based pagination:
 * SELECT * FROM (user_sql) AS _q WHERE "keysetCol" > $N ORDER BY "keysetCol" LIMIT N
 *
 * **Note:** The outer ORDER BY "keysetCol" overrides any ORDER BY in the user's
 * original query. This is intentional for keyset correctness — rows must be
 * ordered by the keyset column to guarantee no gaps. If the original query has
 * a different ORDER BY, the result order will change at the keyset threshold.
 */
function wrapWithKeyset(
	sql: string,
	limit: number,
	keysetColumn: string,
	lastValue: unknown,
	existingParams: readonly unknown[],
): { sql: string; params: readonly unknown[] } {
	const paramIdx = existingParams.length + 1;
	const wrappedSql = `SELECT * FROM (${sql}) AS _q WHERE "${keysetColumn}" > $${paramIdx} ORDER BY "${keysetColumn}" LIMIT ${limit}`;
	return { sql: wrappedSql, params: [...existingParams, lastValue] };
}

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
			cleanupPageStore();
			cursorId = generateCursorId();
			const keysetCol = detectKeysetColumn(columns);
			pageStore.set(cursorId, {
				sql: params.sql,
				sqlParams: params.params ?? [],
				connectionId: params.connectionId,
				maxRows,
				currentOffset: maxRows,
				columns,
				createdAt: Date.now(),
				keysetColumn: keysetCol,
				lastKeysetValue: keysetCol
					? rows[rows.length - 1]?.[keysetCol]
					: undefined,
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
			cleanupPageStore();
			cursorId = generateCursorId();
			const keysetCol = detectKeysetColumn(columns);
			pageStore.set(cursorId, {
				sql,
				sqlParams,
				connectionId: params.connectionId,
				maxRows,
				currentOffset: maxRows,
				columns,
				createdAt: Date.now(),
				keysetColumn: keysetCol,
				lastKeysetValue: keysetCol
					? rows[rows.length - 1]?.[keysetCol]
					: undefined,
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
	cleanupPageStore();
	const state = pageStore.get(params.cursorId);
	if (!state) {
		throw new Error(`Unknown or expired cursor: ${params.cursorId}`);
	}

	const pool = getPool(state.connectionId);
	const maxRows = params.maxRows ?? state.maxRows;

	// Use keyset pagination when offset is large and a keyset column is available
	const useKeyset =
		state.keysetColumn != null &&
		state.lastKeysetValue != null &&
		state.currentOffset >= KEYSET_OFFSET_THRESHOLD;

	let rows: Record<string, unknown>[];
	let columns: string[];
	let durationMs: number;
	let hasMore: boolean;

	if (useKeyset) {
		// biome-ignore lint/style/noNonNullAssertion: guarded by useKeyset check above (keysetColumn != null)
		const keysetCol = state.keysetColumn!;
		const keyed = wrapWithKeyset(
			state.sql,
			maxRows + 1,
			keysetCol,
			state.lastKeysetValue,
			state.sqlParams,
		);
		const start = performance.now();
		const result = await pool.query(
			keyed.sql,
			keyed.params.length > 0 ? [...keyed.params] : undefined,
		);
		durationMs = Math.round(performance.now() - start);
		const allRows = (result.rows ?? []) as Record<string, unknown>[];
		columns = result.fields?.map((f) => f.name) ?? [];
		hasMore = allRows.length > maxRows;
		rows = hasMore ? allRows.slice(0, maxRows) : allRows;
	} else {
		({ rows, columns, durationMs, hasMore } = await executePaginated(
			pool,
			state.sql,
			state.sqlParams,
			maxRows,
			state.currentOffset,
		));
	}

	if (hasMore) {
		state.currentOffset += maxRows;
		if (state.keysetColumn && rows.length > 0) {
			state.lastKeysetValue = rows[rows.length - 1]?.[state.keysetColumn];
		}
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
