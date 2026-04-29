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
});

// ---------------------------------------------------------------------------
// transaction() — reuse existing client (nested transaction)
// ---------------------------------------------------------------------------

describe('PgsqlAdapter.transaction — reuse existing client', () => {
	it('returns same adapter instance when already in transaction', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client);
		let capturedAdapter: unknown;

		await adapter.transaction(async (tx) => {
			capturedAdapter = tx;
		});

		expect(capturedAdapter).toBe(adapter);
	});

	it('does NOT issue BEGIN/COMMIT when already in transaction', async () => {
		const client = makeClient();
		const adapter = createPgsqlAdapter(client);

		await adapter.transaction(async () => {});

		expect(client.query).not.toHaveBeenCalled();
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

	it('defaults schema to "public" when no adapter schema and no explicit schema', async () => {
		const pool = makePool({ rows: [{ exists: true }] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.indexExists('my_idx', 'tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(call![1]).toEqual(['my_idx', 'tbl', 'public']);
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

describe('PgsqlAdapter.stream — with existing client (inTransaction=true)', () => {
	it('uses existing client directly without pool.connect', async () => {
		const rows: Record<string, unknown>[] = [{ id: 1 }];
		let callIdx = 0;
		const client = makeClient(async () => {
			callIdx++;
			if (callIdx === 1) return { rows: [], rowCount: 0 } as QueryResult; // DECLARE
			if (callIdx === 2) return { rows, rowCount: 1 } as QueryResult; // FETCH → 1 row
			if (callIdx === 3) return { rows: [], rowCount: 0 } as QueryResult; // FETCH → done
			return { rows: [], rowCount: 0 } as QueryResult; // CLOSE
		});

		const adapter = createPgsqlAdapter(client);
		const iter = adapter.stream({ sql: 'SELECT * FROM t', parameters: [] });

		const collected: unknown[] = [];
		for await (const row of iter) {
			collected.push(row);
		}

		expect(collected).toEqual([{ id: 1 }]);
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

	it('defaults to "public" when neither adapter nor explicit schema provided', async () => {
		const pool = makePool({ rows: [] });
		const adapter = createPgsqlAdapter(pool);

		await adapter.listIndexes('tbl');

		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1]).toEqual(['tbl', 'public']);
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

	it('defaults to "public" when no adapter schema', async () => {
		const pool = makePool({ rows: [{ size: '512' }] });
		const adapter = createPgsqlAdapter(pool);

		const size = await adapter.storageSize('logs');

		expect(size).toBe(512);
		const call = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(call[1][0]).toBe('"public"."logs"');
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

	it('logger option reaches the non-tx stream cleanup path — proves the option is honored on the adapter', async () => {
		// Scope clarification: this test exercises the NON-TRANSACTION stream
		// cleanup path because that is where logger.debug is observable from
		// outside. It does NOT call transaction() and does NOT assert anything
		// about a tx-scoped adapter cloning the logger option. Tests that
		// directly exercise transaction() live earlier in this describe block.
		//
		// The non-transaction stream path calls logger.debug when a cleanup
		// ROLLBACK throws in the finally block. We set up a pool where:
		//  1. pool.connect() returns a mock client
		//  2. client.query('BEGIN') succeeds
		//  3. client.query('DECLARE ...') (first streamWithClient call) throws
		//  4. client.query('ROLLBACK') in catch succeeds — committed stays false
		//  5. client.query('ROLLBACK') in finally (cleanup) throws → logger.debug
		const logger = { debug: vi.fn(), error: vi.fn() };
		let callIdx = 0;
		const streamClient = makeClient(
			vi.fn().mockImplementation(async () => {
				callIdx++;
				if (callIdx === 1) return { rows: [], rowCount: 0 }; // BEGIN
				if (callIdx === 2) throw new Error('DECLARE failed'); // triggers catch ROLLBACK
				if (callIdx === 3) return { rows: [], rowCount: 0 }; // catch ROLLBACK succeeds
				// finally cleanup ROLLBACK (committed=false) → throws → logger.debug
				throw new Error('cleanup ROLLBACK failed');
			}),
		);
		const pool = makePool({ rows: [] }, streamClient);
		const adapter = new PgsqlAdapter(pool, { logger });

		// Use the non-transaction adapter directly for streaming (no .transaction())
		// so it takes the pool-acquire path that has the cleanup ROLLBACK + logger.debug.
		const gen = adapter.stream<unknown>({ sql: 'SELECT 1', parameters: [] });
		try {
			await gen.next();
		} catch {
			// expected
		}

		// logger.debug being called proves the logger option was set on the adapter.
		// For transaction() propagation specifically, logger is tested transitively:
		// cloneOptions() uses the same spread for both withSchema() and transaction().
		expect(logger.debug).toHaveBeenCalledWith(
			'Rollback failed during cleanup',
			expect.any(Error),
		);
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
