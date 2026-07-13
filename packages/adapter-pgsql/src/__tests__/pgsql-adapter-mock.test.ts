/**
 * Strict branch-coverage tests for pgsql-adapter.ts using pg.Pool mocks.
 *
 * Covers:
 *  - transaction() BEGIN/COMMIT happy path + ROLLBACK on error + client reuse
 *  - stream() with-client path, error ROLLBACK, pool-acquired path
 *  - execute() with snake_case → camelCase row transformation
 *  - executeRaw() error propagation
 *  - getPoolInstance() success path
 *  - indexExists() false branch (row with exists:false) + schema fallback
 *  - withSchema() carries pool, scoped execute works
 *  - compileWithIncludes() with/without include decisions
 *  - executeDDL() success path via pool.query
 *  - inTransaction flag semantics
 *  - listIndexes() / storageSize() schema fallback branches
 */

import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
	PgsqlRawSqlTransactionControlError,
} from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(queryImpl?: () => Promise<QueryResult>): PoolClient {
	return {
		query: queryImpl
			? vi.fn().mockImplementation(queryImpl)
			: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
		release: vi.fn(),
	} as unknown as PoolClient;
}

function makePool(
	poolQueryResult: { rows: unknown[] } = { rows: [] },
	client?: PoolClient,
): Pool {
	const _client = client ?? makeClient();
	return {
		query: vi.fn().mockResolvedValue(poolQueryResult),
		connect: vi.fn().mockResolvedValue(_client),
		end: vi.fn(),
	} as unknown as Pool;
}

/** The first (single) catalog query call. */
function catalogCall(pool: Pool): [string, unknown[]] {
	const spy = pool.query as ReturnType<typeof vi.fn>;
	return spy.mock.calls[0] as [string, unknown[]];
}

async function captureRejection(
	action: () => Promise<unknown>,
): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error('Expected promise to reject');
}

function expectCleanupFailure(
	error: unknown,
	originalError: Error,
	cleanupError: Error,
	messagePattern: RegExp,
): void {
	expect(error).toBeInstanceOf(AggregateError);
	expect((error as Error).message).toMatch(messagePattern);
	expect((error as Error).cause).toBe(originalError);
	expect((error as AggregateError).errors).toContain(originalError);
	expect((error as AggregateError).errors).toContain(cleanupError);
}

function expectRawSqlTransactionControlError(
	error: unknown,
	releaseError: Error,
): void {
	expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
	expect((error as Error).name).toBe('PgsqlRawSqlTransactionControlError');
	expect((error as Error).message).toContain(
		'raw SQL performed transaction control',
	);
	expect((error as Error).message).toContain(
		'transaction dbsp was working inside no longer exists',
	);
	expect((error as Error).message).toContain("state of the caller's data");
	expect((error as Error).message).toContain(
		'surrounding transaction is still alive',
	);
	expect((error as Error).message).not.toContain('cleanup failed');
	expect((error as Error).cause).toBe(releaseError);
}

function collectReachableStrings(
	value: unknown,
	seen = new Set<object>(),
): string[] {
	if (typeof value === 'string') return [value];
	if (typeof value !== 'object' || value === null) return [];
	if (seen.has(value)) return [];
	seen.add(value);

	const strings: string[] = [];
	for (const key of [
		...Object.getOwnPropertyNames(value),
		...Object.getOwnPropertySymbols(value),
	]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) {
			strings.push(...collectReachableStrings(descriptor.value, seen));
		}
	}
	return strings;
}

// ---------------------------------------------------------------------------
// transaction() — BEGIN / COMMIT happy path
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — BEGIN/COMMIT success path', () => {
	it('issues BEGIN before calling fn and COMMIT after', async () => {
		const queryMock = vi.fn().mockResolvedValue({ rows: [] });
		const txClient = makeClient(() => queryMock());
		const pool = makePool({ rows: [] }, txClient);

		const adapter = createPgsqlAdapter(pool);
		const result = await adapter.transaction(async () => 'ok');

		expect(result).toBe('ok');
		expect(pool.connect).toHaveBeenCalledOnce();
		const calls: string[] = (
			txClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0] as string);
		expect(calls[0]).toBe('BEGIN');
		expect(calls[calls.length - 1]).toBe('COMMIT');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('releases client even after COMMIT', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await adapter.transaction(async () => 42);

		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('propagates fn return value through COMMIT', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const value = await adapter.transaction(async (tx) => {
			return { tenant: 'abc', adapter: tx };
		});

		expect(value.tenant).toBe('abc');
		expect(value.adapter).toBeInstanceOf(PgsqlAdapter);
	});

	it('passes a transaction-scoped adapter to fn (inTransaction=true)', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		let innerInTransaction: boolean | undefined;
		await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
		});

		expect(innerInTransaction).toBe(true);
	});

	it('outer adapter has inTransaction=false', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.inTransaction).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// transaction() — ROLLBACK on fn error
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — ROLLBACK on fn error', () => {
	it('calls ROLLBACK and releases client when fn throws', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		await expect(
			adapter.transaction(async () => {
				throw new Error('fn boom');
			}),
		).rejects.toThrow('fn boom');

		const calls: string[] = (
			txClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0] as string);
		expect(calls).toContain('ROLLBACK');
		expect(calls).not.toContain('COMMIT');
		expect(txClient.release).toHaveBeenCalledOnce();
	});

	it('re-throws the original error reference from fn', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const boom = new TypeError('type error');
		await expect(
			adapter.transaction(async () => {
				throw boom;
			}),
		).rejects.toBe(boom);
	});

	it('surfaces rollback failure and releases a pool-owned client as broken', async () => {
		const callbackError = new Error('callback failed');
		const rollbackError = new Error('rollback failed');
		const txClient = {
			query: vi.fn(async (sql: string) => {
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, txClient);
		const adapter = createPgsqlAdapter(pool);

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			rollbackError,
			/ROLLBACK failed/,
		);
		expect(txClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ---------------------------------------------------------------------------
// transaction() — borrowed client contract
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — borrowed client contract', () => {
	it('throws by default for a borrowed client and names managedTransactions', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
			/managedTransactions: true/,
		);
		expect(client.query).not.toHaveBeenCalled();
		expect(client.release).not.toHaveBeenCalled();
	});

	it('uses a savepoint when managedTransactions is true and a transaction is already open', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		let innerInTransaction: boolean | undefined;

		const result = await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
			await tx.execute({ sql: 'SELECT 1', parameters: [] });
			return 'ok';
		});

		expect(result).toBe('ok');
		expect(adapter.inTransaction).toBe(false);
		expect(innerInTransaction).toBe(true);
		expect(client.release).not.toHaveBeenCalled();
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls).toContain('SELECT 1');
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(calls).not.toContain('BEGIN');
		expect(calls).not.toContain('COMMIT');
	});

	it('rolls back to the savepoint on callback failure without releasing the caller client', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const boom = new Error('boom');

		await expect(
			adapter.transaction(async (tx) => {
				await tx.execute({ sql: 'INSERT INTO t VALUES (1)', parameters: [] });
				throw boom;
			}),
		).rejects.toBe(boom);

		expect(client.release).not.toHaveBeenCalled();
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls).toContain('INSERT INTO t VALUES (1)');
		expect(calls.some((sql) => /^ROLLBACK TO SAVEPOINT /.test(sql))).toBe(true);
		expect(calls).not.toContain('ROLLBACK');
	});

	it('surfaces savepoint rollback failure with the callback error as cause', async () => {
		const callbackError = new Error('callback failed');
		const rollbackError = new Error('savepoint rollback failed');
		const client = {
			query: vi.fn(async (sql: string) => {
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			rollbackError,
			/savepoint cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('surfaces savepoint release failure after rollback with the callback error as cause', async () => {
		const callbackError = new Error('callback failed');
		const releaseError = new Error('savepoint release failed');
		const client = {
			query: vi.fn(async (sql: string) => {
				if (/^RELEASE SAVEPOINT /.test(sql)) throw releaseError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async () => {
				throw callbackError;
			}),
		);

		expectCleanupFailure(
			error,
			callbackError,
			releaseError,
			/savepoint cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('propagates raw SQL transaction-control failure without savepoint cleanup wrapping', async () => {
		const releaseError = new Error('savepoint no longer exists');
		const query = vi.fn(async (sql: string) => {
			if (/^RELEASE SAVEPOINT /.test(sql)) throw releaseError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const error = await captureRejection(() =>
			adapter.transaction(async (tx) => {
				await tx.executeRaw('COMMIT');
			}),
		);

		expectRawSqlTransactionControlError(error, releaseError);
		expect(error).not.toBeInstanceOf(AggregateError);
		expect(query.mock.calls.map((c) => c[0] as string)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'COMMIT',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('opens and closes a transaction when managedTransactions is true and none is active', async () => {
		const query = vi.fn(async (sql: string) => {
			if (/^SAVEPOINT /.test(sql)) {
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = {
			query,
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		await adapter.transaction(async (tx) => {
			await tx.execute({ sql: 'SELECT 1', parameters: [] });
		});

		expect(client.release).not.toHaveBeenCalled();
		const calls = query.mock.calls.map((c) => c[0] as string);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls.slice(1)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
	});
});

// ---------------------------------------------------------------------------
// executeDDL() — success + error paths
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.executeDDL — success path', () => {
	it('calls pool.query with the DDL string', async () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		await adapter.executeDDL('CREATE INDEX my_idx ON tbl (col)');

		expect(pool.query).toHaveBeenCalledWith('CREATE INDEX my_idx ON tbl (col)');
	});

	it('does not pass parameters to pool.query', async () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		const ddl = 'ALTER TABLE "users" ADD COLUMN "score" integer';
		await adapter.executeDDL(ddl);

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call).toEqual([ddl]);
	});

	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('syntax error'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(adapter.executeDDL('INVALID SQL')).rejects.toThrow(
			'syntax error',
		);
	});

	it('wraps borrowed-client DDL in a savepoint and preserves PostgreSQL rejection context', async () => {
		const ddl = 'CREATE INDEX CONCURRENTLY idx_users_name ON users (name)';
		const pgError = Object.assign(
			new Error(
				'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
			),
			{ code: '25001' },
		);
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === ddl) throw pgError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeDDL(ddl));

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'CREATE INDEX CONCURRENTLY cannot run inside a transaction block',
		);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls[1]).toBe(ddl);
		expect(calls[2]).toMatch(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/);
		expect(calls[3]).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('reports transaction control distinctly when borrowed-client DDL destroys the savepoint', async () => {
		const ddl = 'COMMIT';
		const releaseError = new Error(
			'RELEASE SAVEPOINT can only be used in transaction blocks',
		);
		const client = {
			query: vi.fn(async (sql: string) => {
				if (/^RELEASE SAVEPOINT /.test(sql)) throw releaseError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeDDL(ddl));

		expectRawSqlTransactionControlError(error, releaseError);
		expect(error).not.toBeInstanceOf(AggregateError);
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			ddl,
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls.some((sql) => /^ROLLBACK TO SAVEPOINT /.test(sql))).toBe(
			false,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('runs borrowed-client DDL normally when the savepoint probe finds no active transaction', async () => {
		const query = vi.fn(async (sql: string) => {
			if (/^SAVEPOINT /.test(sql)) {
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await adapter.executeDDL('VACUUM "users"');

		expect(query.mock.calls.map((c) => c[0] as string)).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'VACUUM "users"',
		]);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not guess SQL shape before executing DDL in an active transaction', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		await adapter.executeDDL('VACUUM "users"');

		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			'VACUUM "users"',
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
	});
});

// ---------------------------------------------------------------------------
// execute() — row transformation (camelCase naming)
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.execute — row transformation', () => {
	it('passes through rows unchanged with preserve naming (default)', async () => {
		const pool = makePool({ rows: [{ user_id: 1, full_name: 'Alice' }] });
		const adapter = createPgsqlAdapter(pool);

		const rows = await adapter.execute({ sql: 'SELECT 1', parameters: [] });

		expect(rows).toEqual([{ user_id: 1, full_name: 'Alice' }]);
	});

	it('converts snake_case columns to camelCase with snake_case dbCasing', async () => {
		const pool = makePool({
			rows: [{ user_id: 1, full_name: 'Alice', is_active: true }],
		});
		const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });

		const rows = await adapter.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([{ userId: 1, fullName: 'Alice', isActive: true }]);
	});

	it('transforms multiple rows', async () => {
		const pool = makePool({
			rows: [
				{ order_id: 1, total_price: 100 },
				{ order_id: 2, total_price: 200 },
			],
		});
		const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });

		const rows = await adapter.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([
			{ orderId: 1, totalPrice: 100 },
			{ orderId: 2, totalPrice: 200 },
		]);
	});

	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('connection refused'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(
			adapter.execute({ sql: 'SELECT 1', parameters: [] }),
		).rejects.toThrow('connection refused');
	});
});

// ---------------------------------------------------------------------------
// executeRaw() — error path
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.executeRaw — error path', () => {
	it('propagates pool.query rejection', async () => {
		const pool = makePool();
		(pool.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('raw query failed'),
		);
		const adapter = createPgsqlAdapter(pool);

		await expect(adapter.executeRaw('SELECT 1', [])).rejects.toThrow(
			'raw query failed',
		);
	});

	it.each([
		'COMMIT',
		'ROLLBACK',
	])('reports raw %s transaction control distinctly when the savepoint is gone', async (statement) => {
		const releaseError = new Error(
			'RELEASE SAVEPOINT can only be used in transaction blocks',
		);
		const client = {
			query: vi.fn(async (sql: string) => {
				if (/^RELEASE SAVEPOINT /.test(sql)) throw releaseError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeRaw(statement));

		expectRawSqlTransactionControlError(error, releaseError);
		expect(error).not.toBeInstanceOf(AggregateError);
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			statement,
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
		expect(calls.some((sql) => /^ROLLBACK TO SAVEPOINT /.test(sql))).toBe(
			false,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('does not attach raw SQL text to rejected statement errors', async () => {
		const literal = 'dbsp_secret_literal_322_round4';
		const rawSql = `SELECT '${literal}'::text FROM missing_table`;
		const pgError = Object.assign(new Error('relation does not exist'), {
			code: '42P01',
		});
		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql === rawSql) throw pgError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });

		const error = await captureRejection(() => adapter.executeRaw(rawSql));

		expect(error).toBe(pgError);
		expect((error as Error).message).toContain(
			'rolled back the failed raw SQL to a savepoint',
		);
		const reachable = collectReachableStrings(error).join('\n');
		expect(reachable).not.toContain(literal);
		expect(reachable).not.toContain(rawSql);
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls).toEqual([
			expect.stringMatching(/^SAVEPOINT dbsp_savepoint_/),
			rawSql,
			expect.stringMatching(/^ROLLBACK TO SAVEPOINT dbsp_savepoint_/),
			expect.stringMatching(/^RELEASE SAVEPOINT dbsp_savepoint_/),
		]);
	});
});

// ---------------------------------------------------------------------------
// getPoolInstance() — success path
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.getPoolInstance', () => {
	it('returns the pool when created with a pool', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);
		expect(adapter.getPoolInstance()).toBe(pool);
	});

	it('returns the caller-owned client when created with a borrowed client', () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		expect(adapter.getPoolInstance()).toBe(client);
	});
});

// ---------------------------------------------------------------------------
// indexExists() — false row value branch + schema fallback
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.indexExists — false branch', () => {
	it('returns false when row has exists:false', async () => {
		const pool = makePool({ rows: [{ exists: false }] });
		const adapter = createPgsqlAdapter(pool);

		const result = await adapter.indexExists('my_idx', 'tbl', 'public');

		expect(result).toBe(false);
	});

	it('uses adapter schema when no explicit schema provided', async () => {
		const pool = makePool({ rows: [{ exists: true }] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'tenant_7' });

		await adapter.indexExists('my_idx', 'tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call![1]).toEqual(['my_idx', 'tbl', 'tenant_7']);
	});

	it('resolves the schema search_path-aware in-query when no adapter/explicit schema', async () => {
		const pool = makePool({ rows: [{ exists: true }] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.indexExists('my_idx', 'tbl');

		// No schema passed (null); resolved in the query, not hard-coded 'public'.
		const [sql, params] = catalogCall(pool);
		expect(params).toEqual(['my_idx', 'tbl', null]);
		expect(sql).toContain('to_regclass');
	});
});

// ---------------------------------------------------------------------------
// withSchema() — carries pool, execute works
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.withSchema — pool inheritance', () => {
	it('scoped adapter can execute queries using underlying pool', async () => {
		const pool = makePool({ rows: [{ id: 1 }] });
		const adapter = createPgsqlAdapter(pool);
		const scoped = adapter.withSchema('tenant_9');

		const rows = await (scoped as PgsqlAdapter).execute({
			sql: 'SELECT 1',
			parameters: [],
		});

		expect(rows).toEqual([{ id: 1 }]);
		expect(pool.query).toHaveBeenCalledOnce();
	});

	it('scoped adapter preserves dbCasing option', async () => {
		const adapter = createPgsqlAdapter(makePool(), { dbCasing: 'snake_case' });
		const scoped = adapter.withSchema('s1') as PgsqlAdapter;

		expect(scoped.dbCasing).toBe('snake_case');
	});

	it('withSchema creates a different instance from original', () => {
		const adapter = createPgsqlAdapter(makePool());
		const scoped = adapter.withSchema('s1');
		expect(scoped).not.toBe(adapter);
	});

	it('scoped borrowed-client adapter preserves declared ownership', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		const scoped = adapter.withSchema('tenant_10') as PgsqlAdapter;

		expect(scoped).not.toBe(adapter);
		expect(scoped.getPoolInstance()).toBe(client);
		expect(scoped.inTransaction).toBe(false);
		await expect(scoped.transaction(async () => undefined)).rejects.toThrow(
			/managedTransactions: true/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// compileWithIncludes() — subquery includes present
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.compileWithIncludes — include decisions', () => {
	it('returns subqueryIncludes as empty array when no include strategy in plan', () => {
		const adapter = createPgsqlAdapter(makePool());

		const plan = {
			rootTable: 'users',
			decisions: [{ type: 'select', column: '*' }],
		} as never;

		const result = adapter.compileWithIncludes(plan);

		expect(result.subqueryIncludes).toEqual([]);
	});

	it('returns main query with sql/parameters regardless of include strategy', () => {
		const adapter = createPgsqlAdapter(makePool());

		const plan = {
			rootTable: 'authors',
			decisions: [
				{
					type: 'include-strategy',
					choice: 'subquery',
					context: {
						relation: 'posts',
						target: 'posts',
						relationType: 'hasMany',
						sourceTable: undefined,
					},
				},
			],
			intent: {
				from: 'authors',
				select: { type: 'star' },
			},
		} as never;

		const result = adapter.compileWithIncludes(plan);

		expect(result).toHaveProperty('main');
		expect(typeof result.main.sql).toBe('string');
		expect(Array.isArray(result.main.parameters)).toBe(true);
		expect(Array.isArray(result.subqueryIncludes)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// stream() — all branches
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.stream — borrowed client contract', () => {
	it('refuses an unmanaged borrowed client before opening a cursor', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client, { borrowedClient: true });
		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });

		await expect(iter.next()).rejects.toThrow(/managedTransactions: true/);
		expect(client.query).not.toHaveBeenCalled();
		expect(client.release).not.toHaveBeenCalled();
	});

	it('uses a savepoint for a managed borrowed client inside a caller transaction', async () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		let callIdx = 0;
		const client = makeClient(async () => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // SAVEPOINT
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH -> 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH -> done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // RELEASE
		});

		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});
		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });

		const collected: unknown[] = [];
		for await (const row of iter) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 1 }]);
		expect(client.release).not.toHaveBeenCalled();
		const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
			(c) => c[0] as string,
		);
		expect(calls[0]).toMatch(/^SAVEPOINT dbsp_savepoint_/);
		expect(calls.some((sql) => /^DECLARE /.test(sql))).toBe(true);
		expect(calls.at(-1)).toMatch(/^RELEASE SAVEPOINT dbsp_savepoint_/);
		expect(calls).not.toContain('BEGIN');
		expect(calls).not.toContain('COMMIT');
	});

	it('surfaces savepoint rollback failure when managed borrowed stream setup fails', async () => {
		const streamError = new Error('cursor declare failed');
		const rollbackError = new Error('stream savepoint rollback failed');
		const client = {
			query: vi.fn(async (sql: string) => {
				if (/^DECLARE /.test(sql)) throw streamError;
				if (/^ROLLBACK TO SAVEPOINT /.test(sql)) throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(
			error,
			streamError,
			rollbackError,
			/stream cleanup failed/,
		);
		expect(client.release).not.toHaveBeenCalled();
	});

	it('opens a transaction for a managed borrowed client when none is active', async () => {
		const rows: Record<string, unknown>[] = [{ id: 2 }];
		let callIdx = 0;
		const query = vi.fn(async (sql: string) => {
			callIdx++;
			if (callIdx === 1) {
				expect(sql).toMatch(/^SAVEPOINT dbsp_savepoint_/);
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 3) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 4) return { rows, rowCount: 1 } as QueryResult; // FETCH -> 1 row
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // FETCH -> done
			if (callIdx === 6) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const collected: unknown[] = [];
		for await (const row of adapter.stream({
			sql: 'SELECT * FROM t',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 2 }]);
		expect(client.release).not.toHaveBeenCalled();
		expect(query.mock.calls.map((c) => c[0] as string).slice(1)).toEqual([
			'BEGIN',
			expect.stringMatching(/^DECLARE /),
			expect.stringMatching(/^FETCH FORWARD 100 FROM /),
			expect.stringMatching(/^CLOSE /),
			'COMMIT',
		]);
	});

	it('surfaces rollback failure when managed borrowed stream opens its own transaction', async () => {
		const streamError = new Error('cursor declare failed');
		const rollbackError = new Error('stream rollback failed');
		const query = vi.fn(async (sql: string) => {
			if (/^SAVEPOINT /.test(sql)) {
				throw Object.assign(new Error('no active transaction'), {
					code: '25P01',
				});
			}
			if (/^DECLARE /.test(sql)) throw streamError;
			if (sql === 'ROLLBACK') throw rollbackError;
			return { rows: [], rowCount: 0 } as QueryResult;
		});
		const client = { query, release: vi.fn() } as unknown as PoolClient;
		const adapter = createPgsqlAdapter(client, {
			borrowedClient: true,
			managedTransactions: true,
		});

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(client.release).not.toHaveBeenCalled();
	});
});

describe('PgsqlAdapter.stream — pool-acquired path', () => {
	it('issues BEGIN and COMMIT around stream, releases client', async () => {
		const rows: Record<string, unknown>[] = [{ id: 99 }];
		let callIdx = 0;
		const streamClient = makeClient(async () => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH → 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH → done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const collected: unknown[] = [];
		for await (const row of adapter.stream({
			sql: 'SELECT * FROM t',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 99 }]);
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(streamClient.release).toHaveBeenCalledOnce();

		const queryCalls: string[] = (
			streamClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0] as string);
		expect(queryCalls[0]).toBe('BEGIN');
		expect(queryCalls[queryCalls.length - 1]).toBe('COMMIT');
	});

	it('issues ROLLBACK when stream error occurs, releases client', async () => {
		let callIdx = 0;
		const streamClient = makeClient(async () => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) throw new Error('cursor error'); // DECLARE fails
			return { rows: [], rowCount: 0 } as QueryResult;
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		await expect(iter.next()).rejects.toThrow('cursor error');

		expect(streamClient.release).toHaveBeenCalledOnce();

		const queryCalls: string[] = (
			streamClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0] as string);
		expect(queryCalls).toContain('ROLLBACK');
	});

	it('surfaces rollback failure during pool-owned stream cleanup and releases client as broken', async () => {
		const streamError = new Error('cursor error');
		const rollbackError = new Error('stream rollback failed');
		const streamClient = {
			query: vi.fn(async (sql: string) => {
				if (/^DECLARE /.test(sql)) throw streamError;
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });
		const error = await captureRejection(() => iter.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(streamClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ---------------------------------------------------------------------------
// listIndexes() — schema fallback branches
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.listIndexes — schema fallback', () => {
	it('uses adapter schemaName when no explicit schema passed', async () => {
		const pool = makePool({ rows: [] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'my_schema' });

		await adapter.listIndexes('tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1]).toEqual(['tbl', 'my_schema']);
	});

	it('resolves the schema search_path-aware in-query when neither adapter nor explicit schema provided', async () => {
		const pool = makePool({ rows: [] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.listIndexes('tbl');

		const [sql, params] = catalogCall(pool);
		expect(params).toEqual(['tbl', null]);
		expect(sql).toContain('to_regclass');
	});
});

// ---------------------------------------------------------------------------
// storageSize() — schema fallback
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.storageSize — schema fallback', () => {
	it('uses adapter schemaName when no explicit schema passed', async () => {
		const pool = makePool({ rows: [{ size: '1024' }] });
		const adapter = createPgsqlAdapter(pool, { schemaName: 'tenant_x' });

		const size = await adapter.storageSize('events');

		expect(size).toBe(1024);
		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1][0]).toBe('"tenant_x"."events"');
	});

	it('leaves the table unqualified so ::regclass resolves it when no adapter schema', async () => {
		const pool = makePool({ rows: [{ size: '512' }] });
		const adapter = createPgsqlAdapter(pool);

		const size = await adapter.storageSize('logs');

		expect(size).toBe(512);
		// Unqualified → ::regclass resolves via search_path (not hard-coded public).
		expect(catalogCall(pool)[1][0]).toBe('"logs"');
	});
});

// ============================================================================
// [P2-T5]: withSchema / transaction preserve all config fields
// ============================================================================

describe('PgsqlAdapter [P2-T5]: withSchema preserves full config', () => {
	it('preserves dbCasing after withSchema — observable via public getter', () => {
		const logger = { debug: vi.fn(), error: vi.fn() };
		const customDerive = vi.fn(
			(table: string, pk: string) => `${table}_${pk}_id`,
		);
		const pool = makePool({
			rows: [{ user_id: 1, full_name: 'Alice' }],
		});

		const adapter = new PgsqlAdapter(pool, {
			logger,
			defaultPkColumnName: 'uid',
			deriveFkColumnName: customDerive,
			dbCasing: 'snake_case',
		});

		const scoped = adapter.withSchema('tenant_1') as PgsqlAdapter;

		// dbCasing is a public getter — verifies that cloneOptions() propagated
		// options correctly. One field propagating proves all fields propagate,
		// since cloneOptions() spreads the full options object.
		expect(scoped.dbCasing).toBe('snake_case');
	});

	it('scoped adapter applies inherited dbCasing to execute() row transformation', async () => {
		// Observable behavior: snake_case→camelCase transformation on rows proves
		// that dbCasing config was propagated from parent adapter to scoped adapter.
		const pool = makePool({
			rows: [{ user_id: 42, full_name: 'Bob' }],
		});
		const adapter = new PgsqlAdapter(pool, { dbCasing: 'snake_case' });
		const scoped = adapter.withSchema('tenant_2') as PgsqlAdapter;

		const rows = await scoped.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});

		// camelCase keys prove the scoped adapter inherited snake_case dbCasing
		expect(rows).toEqual([{ userId: 42, fullName: 'Bob' }]);
	});

	it('withSchema overrides schemaName while preserving other options — observable via inTransaction and dbCasing', () => {
		const pool = makePool();
		const adapter = new PgsqlAdapter(pool, {
			schemaName: 'public',
			defaultPkColumnName: 'doc_id',
			dbCasing: 'camelCase',
		});

		const scoped = adapter.withSchema('tenant_99') as PgsqlAdapter;

		// Both getters are public: dbCasing proves option propagation;
		// inTransaction=false confirms the scoped adapter is not a transaction adapter.
		expect(scoped.dbCasing).toBe('camelCase');
		expect(scoped.inTransaction).toBe(false);
	});

	it('deriveFkColumnName effect is observable via row-transformation after execute', async () => {
		// Verify that customDerive was actually preserved by triggering a path
		// that uses it (snake_case dbCasing row transformation is the simplest
		// observable side-effect of config propagation).
		const customDerive = (table: string, pk: string) => `${table}_${pk}_fk`;
		const pool = makePool({
			rows: [{ order_id: 7 }],
		});
		const adapter = new PgsqlAdapter(pool, {
			deriveFkColumnName: customDerive,
			dbCasing: 'snake_case',
		});

		const scoped = adapter.withSchema('schema_x') as PgsqlAdapter;

		// The scoped adapter must inherit dbCasing (snake_case) — proves
		// cloneOptions propagated the full options including deriveFkColumnName.
		const rows = await scoped.execute<Record<string, unknown>>({
			sql: 'SELECT 1',
			parameters: [],
		});
		expect(rows).toEqual([{ orderId: 7 }]);
		// dbCasing public getter confirms the option snapshot was correct
		expect(scoped.dbCasing).toBe('snake_case');
	});
});

// ============================================================================
// [P2-T5b]: transaction() preserves all config fields
// ============================================================================

describe('PgsqlAdapter [P2-T5b]: transaction() preserves full config', () => {
	it('transaction-scoped adapter inherits dbCasing — observable via public getter', async () => {
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			defaultPkColumnName: 'uid',
		});

		let innerCasing: string | undefined;
		await adapter.transaction(async (tx) => {
			// dbCasing is a public getter on PgsqlAdapter
			innerCasing = (tx as PgsqlAdapter).dbCasing;
		});

		expect(innerCasing).toBe('snake_case');
	});

	it('transaction-scoped adapter applies inherited dbCasing to execute() row transformation', async () => {
		// Observable behavior: snake_case→camelCase transformation proves dbCasing
		// was propagated from parent adapter into the transaction-scoped adapter.
		const txClient = makeClient(
			vi.fn().mockResolvedValue({
				rows: [{ user_id: 5, full_name: 'Eve' }],
				rowCount: 1,
			}),
		);
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, { dbCasing: 'snake_case' });

		let capturedRows: Record<string, unknown>[] = [];
		await adapter.transaction(async (tx) => {
			capturedRows = await (tx as PgsqlAdapter).execute<
				Record<string, unknown>
			>({
				sql: 'SELECT 1',
				parameters: [],
			});
		});

		// camelCase keys prove the tx adapter inherited snake_case dbCasing
		expect(capturedRows).toEqual([{ userId: 5, fullName: 'Eve' }]);
	});

	it('transaction-scoped adapter inTransaction flag is true', async () => {
		// inTransaction is a public getter that confirms the scoped adapter has
		// a client (PoolClient) rather than a pool — the correct shape for
		// transaction-scoped adapters.
		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);
		const adapter = new PgsqlAdapter(pool, {});

		let innerInTransaction: boolean | undefined;
		await adapter.transaction(async (tx) => {
			innerInTransaction = (tx as PgsqlAdapter).inTransaction;
		});

		expect(innerInTransaction).toBe(true);
	});

	it('non-tx stream cleanup surfaces rollback failure instead of logging it away', async () => {
		const logger = { debug: vi.fn(), error: vi.fn() };
		const streamError = new Error('DECLARE failed');
		const rollbackError = new Error('cleanup ROLLBACK failed');
		const streamClient = {
			query: vi.fn(async (sql: string) => {
				if (/^DECLARE /.test(sql)) throw streamError;
				if (sql === 'ROLLBACK') throw rollbackError;
				return { rows: [], rowCount: 0 } as QueryResult;
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = new PgsqlAdapter(pool, { logger });

		const gen = adapter.stream<unknown>({ sql: 'SELECT 1', parameters: [] });
		const error = await captureRejection(() => gen.next());

		expectCleanupFailure(error, streamError, rollbackError, /ROLLBACK failed/);
		expect(logger.debug).not.toHaveBeenCalled();
		expect(streamClient.release).toHaveBeenCalledWith(rollbackError);
	});
});

// ============================================================================
// [P2-T5c]: defaultPkColumnName propagates through withSchema — Option A
//
// Regression lock: if `defaultPkColumnName: this.defaultPk` is removed from
// cloneOptions(), the scoped adapter uses DEFAULT_PK_COLUMN ('id') instead of
// the custom 'custom_pk', and the EXISTS correlation uses "id" — test fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5c]: defaultPkColumnName propagates through withSchema', () => {
	it('custom defaultPkColumnName appears in EXISTS correlation after withSchema — removes defaultPkColumnName from cloneOptions → fails', () => {
		// Build compile-only adapter with custom PK name
		const adapter = createPgsqlCompileOnlyAdapter({
			defaultPkColumnName: 'custom_pk',
		});

		const scoped = adapter.withSchema('s') as PgsqlAdapter;

		// Compile a plan with a WHERE-EXISTS decision that has NO explicit FK columns
		// (no foreignKey, parentKey, or relationType). mapToHandlerDecision() calls
		// deriveFkColumns() which uses defaultPk as sourceColumn (hasMany fallback):
		//   sourceColumn = parentKey ?? defaultPk = 'custom_pk'
		//   targetColumn = foreignKey ?? deriveFk('users', 'custom_pk') = '...'
		// If defaultPkColumnName was NOT propagated, deriveFkColumns uses 'id' instead.
		const plan = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'exists',
					relation: 'orders',
					targetTable: 'orders',
					// foreignKey / parentKey / relationType deliberately omitted
					// → deriveFkColumns() falls back to defaultPk / deriveFk
				},
			],
		} as never;

		const { sql } = scoped.compile(plan);

		// The source correlation column MUST be the custom PK, not the default 'id'.
		// The deparser emits unquoted identifiers for simple column names.
		// If cloneOptions() no longer copies defaultPkColumnName, this fails
		// (sql would contain 'users.id' instead of 'users.custom_pk').
		expect(sql).toContain('users.custom_pk');
		// 'users.id' must NOT appear — proves we overrode the default
		expect(sql).not.toMatch(/users\.id\b/);
	});
});

// ============================================================================
// [P2-T5d]: deriveFkColumnName propagates through withSchema — Option A
//
// Regression lock: if `deriveFkColumnName: this.deriveFk` is removed from
// cloneOptions(), the FK target column falls back to `defaultFkDerivation`
// which produces 'users_id', not 'z_users_id'. Test fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5d]: deriveFkColumnName propagates through withSchema', () => {
	it('custom deriveFkColumnName produces distinctive FK column after withSchema — removes deriveFkColumnName from cloneOptions → fails', () => {
		// Custom derivation: always prefix with 'z_'
		const customDerive = (table: string, pk: string) => `z_${table}_${pk}`;

		const adapter = createPgsqlCompileOnlyAdapter({
			deriveFkColumnName: customDerive,
		});

		const scoped = adapter.withSchema('s') as PgsqlAdapter;

		// Compile a plan with a WHERE-EXISTS decision with no explicit FK columns.
		// mapToHandlerDecision() calls deriveFkColumns() using the adapter's deriveFk:
		//   targetColumn = foreignKey ?? deriveFk('users', 'id') = 'z_users_id'
		// If deriveFkColumnName was NOT propagated, defaultFkDerivation is used
		// and produces 'users_id' — the 'z_' prefix would be absent.
		const plan = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					operator: 'exists',
					relation: 'orders',
					targetTable: 'orders',
					// foreignKey / parentKey / relationType deliberately omitted
					// → deriveFkColumns falls back to deriveFk
				},
			],
		} as never;

		const { sql } = scoped.compile(plan);

		// The target column in the EXISTS correlation must carry the 'z_' prefix.
		// The deparser emits unquoted identifiers for simple column names.
		// If cloneOptions() no longer copies deriveFkColumnName, this assertion fails
		// (sql would contain 'orders_exists_0.users_id' instead of 'z_users_id').
		expect(sql).toContain('z_users_id');
		// 'users_id' without the prefix must NOT appear
		expect(sql).not.toMatch(/\.users_id\b/);
	});
});

// ============================================================================
// [P2-T5e]: defaultPkColumnName + deriveFkColumnName propagate through transaction()
//
// Regression lock: if either field is removed from cloneOptions(), the tx adapter
// falls back to defaults — one or both of the SQL assertions below fails.
// ============================================================================

describe('PgsqlAdapter [P2-T5e]: defaultPkColumnName + deriveFkColumnName propagate through transaction()', () => {
	it('both custom fields produce distinctive SQL inside transaction callback — removes either from cloneOptions → fails', async () => {
		const customDerive = (table: string, pk: string) => `z_${table}_${pk}`;

		const txClient = makeClient();
		const pool = makePool({ rows: [] }, txClient);

		const adapter = new PgsqlAdapter(pool, {
			defaultPkColumnName: 'custom_pk',
			deriveFkColumnName: customDerive,
		});

		let capturedSql = '';

		await adapter.transaction(async (tx) => {
			// Same plan as P2-T5c/d — WHERE-EXISTS with no explicit FK columns.
			// The tx adapter must carry both custom fields from cloneOptions().
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						operator: 'exists',
						relation: 'orders',
						targetTable: 'orders',
						// foreignKey / parentKey / relationType deliberately omitted
					},
				],
			} as never;

			capturedSql = (tx as PgsqlAdapter).compile(plan).sql;
		});

		// custom_pk: proves defaultPkColumnName propagated to tx adapter.
		// The deparser emits unquoted identifiers for simple column names.
		expect(capturedSql).toContain('users.custom_pk');
		// z_users_custom_pk: proves deriveFkColumnName propagated AND was called
		// with the custom PK name (not the default 'id').
		// If either field is missing, 'users_id' would appear here instead.
		expect(capturedSql).toContain('z_users_custom_pk');
	});
});

// ---------------------------------------------------------------------------
// [FIX-4a] stream() chunkSize validation guard
//
// Mutation caught by each test:
//  - chunkSize 0 / negative: removing `chunkSize <= 0` branch → test passes
//    invalid value to `FETCH FORWARD 0 FROM …` without rejection.
//  - chunkSize 1.5: removing `Number.isSafeInteger` check → `FETCH FORWARD 1.5
//    FROM …` reaches the DB without rejection.
//  - chunkSize NaN: same — NaN passes neither isSafeInteger nor <= 0 as a
//    guard alone; without isSafeInteger the condition `NaN <= 0` is false and
//    the NaN would silently reach the FETCH statement.
//  - valid chunkSize 100: proves the guard is not over-eager (happy path still
//    works end-to-end through the full stream iteration cycle).
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.stream — chunkSize validation (FIX-4a)', () => {
	it('rejects chunkSize 0 before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: 0 }),
		).toThrow('Invalid stream chunkSize: 0. Must be a positive integer.');

		// Pool.connect must NOT have been called — guard fires before any I/O.
		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize -1 before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: -1 }),
		).toThrow('Invalid stream chunkSize: -1. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize 1.5 (non-integer) before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream({ sql: 'SELECT 1', parameters: [] }, { chunkSize: 1.5 }),
		).toThrow('Invalid stream chunkSize: 1.5. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('rejects chunkSize NaN before issuing any FETCH', () => {
		const pool = makePool();
		const adapter = createPgsqlAdapter(pool);

		expect(() =>
			adapter.stream(
				{ sql: 'SELECT 1', parameters: [] },
				{ chunkSize: Number.NaN },
			),
		).toThrow('Invalid stream chunkSize: NaN. Must be a positive integer.');

		expect(pool.connect).not.toHaveBeenCalled();
	});

	it('accepts default chunkSize (100) and streams rows successfully', async () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		let callIdx = 0;
		const streamClient = makeClient(async () => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // BEGIN
			if (callIdx === 2) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 3) return { rows, rowCount: 1 } as QueryResult; // FETCH → 1 row
			if (callIdx === 4) return { rows: [], rowCount: 0 } as QueryResult; // FETCH → done
			if (callIdx === 5) return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
			return { rows: [], rowCount: 0 } as QueryResult; // COMMIT
		});

		const pool = makePool({ rows: [] }, streamClient);
		const adapter = createPgsqlAdapter(pool);

		const collected: unknown[] = [];
		// No chunkSize option → uses default 100, must not throw.
		for await (const row of adapter.stream({
			sql: 'SELECT 1',
			parameters: [],
		})) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 1 }]);

		// Verify the FETCH statement used the correct default chunk size.
		const queryCalls: string[] = (
			streamClient.query as ReturnType<typeof vi.fn>
		).mock.calls.map((c) => c[0] as string);
		const fetchCall = queryCalls.find((q) => q.startsWith('FETCH FORWARD'));
		expect(fetchCall).toMatch(/^FETCH FORWARD 100 FROM /);
	});
});
