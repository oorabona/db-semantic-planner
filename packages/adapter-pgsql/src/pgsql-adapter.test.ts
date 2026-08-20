/**
 * PgsqlAdapter Unit Tests
 *
 * Tests adapter interface implementation without database connection.
 */

import type { PlanReport } from '@dbsp/core';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
} from './pgsql-adapter.js';
import { derivePreparedStatementName } from './prepared-statements.js';

// ============================================================================
// Mock Pool
// ============================================================================

function createMockPool(): Pool {
	return {
		query: vi.fn(),
		connect: vi.fn(),
		end: vi.fn(),
		// Add other Pool methods as needed
	} as unknown as Pool;
}

function testQuery<T = unknown>(
	sql: string,
	parameters: readonly unknown[] = [],
) {
	return projectionlessCompiledQuery<T>(
		{ sql, parameters },
		'pgsql-adapter-unit-test',
	);
}

function deferredPromise<T>() {
	let resolve: (value: T | PromiseLike<T>) => void;
	let reject: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve: resolve!, reject: reject! };
}

// ============================================================================
// Tests
// ============================================================================

describe('PgsqlAdapter', () => {
	describe('constructor', () => {
		it('should create adapter with default options', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool);

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
			expect(adapter.dbCasing).toBe('preserve');
			expect(adapter.capabilities).toEqual({
				supportsReturning: true,
				supportsSchemas: true,
				supportsStreaming: true,
				supportsTransactions: true,
				supportsTransactionOptions: true,
				supportsPinnedConnections: true,
				supportsRecursiveCTE: true,
				supportsWindowFunctions: true,
				supportsArrayType: true,
			});
		});

		it('should create adapter with custom dbCasing', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool, {
				dbCasing: 'snake_case',
			});

			expect(adapter.dbCasing).toBe('snake_case');
		});

		it('should create adapter with schema name', () => {
			const pool = createMockPool();
			const adapter = new PgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
		});

		it('rejects a checked-out PoolClient passed as the pool', () => {
			const client = {
				query: vi.fn(),
				release: vi.fn(),
			} as unknown as PoolClient;

			expect(() => createPgsqlAdapter(client as unknown as Pool)).toThrow(
				/createPgsqlAdapter\(\) received a pg PoolClient\. Pass borrowedClient: true/,
			);
		});

		it.each([
			{ label: 'string', value: 'false' },
			{ label: 'number', value: 0 },
			{ label: 'null', value: null },
			{ label: 'array', value: [] },
			{ label: 'function', value: () => undefined },
		])('rejects an invalid preparedStatements $label', ({ value }) => {
			expect(
				() =>
					new PgsqlAdapter(undefined, {
						preparedStatements: value,
					} as any),
			).toThrowError(Error);
			expect(
				() =>
					new PgsqlAdapter(undefined, {
						preparedStatements: value,
					} as any),
			).toThrow(
				/preparedStatements must be true, false, or a non-null options object/,
			);
		});

		it('normalizes prepared statements independently of later caller mutation', () => {
			const pool = createMockPool();
			const preparedStatements = { maxStatements: 1 };
			const adapter = createPgsqlAdapter(pool, { preparedStatements });
			preparedStatements.maxStatements = 2;

			const scoped = adapter.withSchema('tenant_1') as PgsqlAdapter;
			const parentConfig = (adapter as any).preparedStatements;
			const childConfig = (scoped as any).preparedStatements;
			expect(parentConfig.maxStatements).toBe(1);
			expect(childConfig).not.toBe(parentConfig);
			expect(childConfig.maxStatements).toBe(1);
		});

		it('shares equal prepared-statement caps and rejects conflicting pool caps', () => {
			const pool = createMockPool();
			const first = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});
			const equal = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});

			expect((equal as any).preparedStatementRegistry).toBe(
				(first as any).preparedStatementRegistry,
			);
			expect(() =>
				createPgsqlAdapter(pool, { preparedStatements: { maxStatements: 2 } }),
			).toThrow(
				/preparedStatements\.maxStatements is configured pool-wide: expected 1, received 2/,
			);
		});

		it('shares equal prepared-statement caps and rejects conflicting client caps', () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const first = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});
			const equal = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});

			expect((equal as any).preparedStatementRegistry).toBe(
				(first as any).preparedStatementRegistry,
			);
			expect(() =>
				createPgsqlAdapter(client, {
					borrowedClient: true,
					preparedStatements: { maxStatements: 2 },
				}),
			).toThrow(
				/preparedStatements\.maxStatements is configured borrowed client-wide: expected 1, received 2/,
			);
		});
	});

	describe('createPgsqlAdapter', () => {
		it('accepts Pool and opted-in PoolClient factory overloads only', () => {
			const pool = createMockPool();
			const client = {
				query: vi.fn(),
				release: vi.fn(),
			} as unknown as PoolClient;

			expectTypeOf(createPgsqlAdapter(pool)).toEqualTypeOf<PgsqlAdapter>();
			expectTypeOf(
				createPgsqlAdapter(client, { borrowedClient: true }),
			).toEqualTypeOf<PgsqlAdapter>();

			if (process.env.DBSP_TYPECHECK_ONLY === '1') {
				// @ts-expect-error a PoolClient requires an explicit borrowedClient opt-in.
				createPgsqlAdapter(client);
				// @ts-expect-error borrowedClient requires a PoolClient, not a Pool.
				createPgsqlAdapter(pool, { borrowedClient: true });
			}
		});
	});

	describe('getPoolInstance', () => {
		it('declares that the current executor can be a pool or transaction client', () => {
			const adapter = createPgsqlAdapter(createMockPool());

			expectTypeOf(adapter.getPoolInstance()).toEqualTypeOf<
				Pool | PoolClient
			>();
		});
	});

	describe('capabilities', () => {
		it('should report full PostgreSQL capabilities', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(adapter.capabilities.supportsReturning).toBe(true);
			expect(adapter.capabilities.supportsSchemas).toBe(true);
			expect(adapter.capabilities.supportsStreaming).toBe(true);
			expect(adapter.capabilities.supportsTransactions).toBe(true);
			expect(adapter.capabilities.supportsRecursiveCTE).toBe(true);
			expect(adapter.capabilities.supportsWindowFunctions).toBe(true);
			expect(adapter.capabilities.supportsArrayType).toBe(true);
		});
	});

	describe('compile', () => {
		it('should compile a plan to CompiledQuery', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// Mock plan (simplified)
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
			expect(typeof compiled.sql).toBe('string');
			expect(Array.isArray(compiled.parameters)).toBe(true);
		});

		it('should use schema from adapter options', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan);

			// Should include schema in SQL
			expect(compiled.sql).toContain('tenant_123');
		});

		it('should use schema from compile options', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const compiled = adapter.compile(plan, { schemaName: 'custom_schema' });

			expect(compiled.sql).toContain('custom_schema');
		});
	});

	describe('compileWithIncludes', () => {
		it('should compile plan with includes', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			} as any;

			const result = adapter.compileWithIncludes(plan);

			expect(result).toHaveProperty('main');
			expect(result).toHaveProperty('subqueryIncludes');
			expect(result.main).toHaveProperty('sql');
			expect(result.main).toHaveProperty('parameters');
			expect(Array.isArray(result.subqueryIncludes)).toBe(true);
		});
	});

	describe('mutations', () => {
		it('should compile insert intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
				values: [{ name: 'Alice', email: 'alice@example.com' }],
			} as any;

			const compiled = adapter.compileInsert(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile update intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
				set: [{ column: 'name', value: 'Bob' }],
			} as any;

			const compiled = adapter.compileUpdate(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile delete intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				table: 'users',
			} as any;

			const compiled = adapter.compileDelete(intent);

			expect(compiled).toHaveProperty('sql');
			expect(compiled).toHaveProperty('parameters');
		});

		it('should compile upsert intent', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				type: 'upsert' as const,
				table: 'users',
				values: [{ id: 1, name: 'Alice' }],
				onConflict: { columns: ['id'] },
				action: { type: 'doUpdate' as const },
			};

			const compiled = adapter.compileUpsert(intent);

			expect(compiled.sql).toContain('INSERT INTO');
			expect(compiled.sql).toContain('ON CONFLICT');
			expect(compiled.parameters).toBeDefined();
		});

		it('should emit type-cast for range columns in INSERT', () => {
			const pool = createMockPool();
			const model = {
				tables: new Map([
					[
						'priceTiers',
						{
							name: 'price_tiers',
							columns: [
								{ name: 'name', type: 'string', nullable: false },
								{
									name: 'quantityRange',
									type: 'int4range',
									nullable: false,
								},
							],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable(name: string) {
					return this.tables.get(name);
				},
				getRelation() {
					return undefined;
				},
				getRelationsFrom() {
					return [];
				},
				getRelationsTo() {
					return [];
				},
				isAmbiguous() {
					return { ambiguous: false as const };
				},
			} as any;

			const adapter = createPgsqlAdapter(pool, { model });

			const intent = {
				table: 'priceTiers',
				values: [{ name: 'Tier 1', quantityRange: '[1,50)' }],
			} as any;

			const compiled = adapter.compileInsert(intent);

			// Should contain int4range type cast in SQL (CAST($N AS int4range))
			expect(compiled.sql).toContain('int4range');
			expect(compiled.parameters).toEqual(['Tier 1', '[1,50)']);
		});

		it('should emit type-cast for range columns in UPDATE', () => {
			const pool = createMockPool();
			const model = {
				tables: new Map([
					[
						'priceTiers',
						{
							name: 'price_tiers',
							columns: [
								{ name: 'name', type: 'string', nullable: false },
								{
									name: 'quantityRange',
									type: 'int4range',
									nullable: false,
								},
							],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
				getTable(name: string) {
					return this.tables.get(name);
				},
				getRelation() {
					return undefined;
				},
				getRelationsFrom() {
					return [];
				},
				getRelationsTo() {
					return [];
				},
				isAmbiguous() {
					return { ambiguous: false as const };
				},
			} as any;

			const adapter = createPgsqlAdapter(pool, { model });

			const intent = {
				table: 'priceTiers',
				set: { name: 'Updated Tier', quantityRange: '[10,100)' },
			} as any;

			const compiled = adapter.compileUpdate(intent);

			// Should contain int4range type cast in SQL (CAST($N AS int4range))
			expect(compiled.sql).toContain('int4range');
			expect(compiled.parameters).toEqual(['Updated Tier', '[10,100)']);
		});
	});

	describe('execute', () => {
		it('should execute query and return all results', async () => {
			const pool = createMockPool();
			const mockRows = [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			];
			vi.mocked(pool.query).mockResolvedValue({
				rows: mockRows,
				rowCount: 2,
				command: 'SELECT',
			} as any);

			const adapter = createPgsqlAdapter(pool);
			const query = testQuery('SELECT * FROM users');

			const results = await adapter.execute(query);

			expect(results).toEqual(mockRows);
			expect(results).not.toHaveProperty('rowCount');
			expect(results).not.toHaveProperty('command');
			expect(pool.query).toHaveBeenCalledWith(query.sql, query.parameters);
		});

		it('uses a named config object only after the second eligible compiled execution', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({
				rows: [{ id: 7 }],
				rowCount: 1,
				command: 'SELECT',
			} as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery('SELECT id FROM users WHERE id = $1', [7]);

			await expect(adapter.execute(query)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(query)).resolves.toEqual([{ id: 7 }]);

			expect(pool.connect).not.toHaveBeenCalled();
			expect(pool.query).toHaveBeenNthCalledWith(1, query.sql, [7]);
			expect(pool.query).toHaveBeenNthCalledWith(2, {
				name: expect.stringMatching(/^dbsp_ps_[0-9a-f]{32}$/),
				text: query.sql,
				values: [7],
			});
		});

		it('does not manually acquire or release a pooled client while a query is pending', async () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const sql = 'SELECT id FROM users WHERE id = $1';
			const query = testQuery(sql, [7]);
			const deferred = deferredPromise<unknown>();
			const error = new Error('pool query failure');
			vi.mocked(pool.query).mockReturnValueOnce(deferred.promise as any);

			const operation = adapter.execute(query);
			await Promise.resolve();
			await Promise.resolve();
			expect(pool.connect).not.toHaveBeenCalled();

			deferred.reject(error);
			await expect(operation).rejects.toBe(error);
			expect(pool.connect).not.toHaveBeenCalled();
		});

		it('does not name compiled executions without parameters', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery('SELECT 1');

			await adapter.execute(query);
			await adapter.execute(query);

			expect(pool.query).toHaveBeenNthCalledWith(1, query.sql, []);
			expect(pool.query).toHaveBeenNthCalledWith(2, query.sql, []);
		});

		it.each([
			{ code: '0A000', routine: 'RevalidateCachedQuery' },
			{ code: '42P05', routine: 'StorePreparedStatement' },
		])('quarantines a verified $code named-statement failure before rejection is observable', async (error) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValue({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sqlA = 'SELECT id FROM users WHERE id = $1';
			const sqlB = 'SELECT id FROM accounts WHERE id = $1';

			await (adapter as any).issueConnectionQuery(client, sqlA, [7], true);
			await (adapter as any).issueConnectionQuery(client, sqlB, [8], true);
			const failed = (adapter as any).issueConnectionQuery(
				client,
				sqlA,
				[7],
				true,
			);
			const fallbackAtObservation = failed.catch(() =>
				(adapter as any).issueConnectionQuery(client, sqlA, [7], true),
			);
			await expect(fallbackAtObservation).resolves.toMatchObject({
				rows: [{ id: 7 }],
			});
			await expect(
				(adapter as any).issueConnectionQuery(client, sqlB, [8], true),
			).resolves.toMatchObject({ rows: [{ id: 8 }] });

			expect(client.query).toHaveBeenNthCalledWith(3, {
				name: expect.stringMatching(/^dbsp_ps_[0-9a-f]{32}$/),
				text: sqlA,
				values: [7],
			});
			expect(client.query).toHaveBeenNthCalledWith(4, sqlA, [7]);
			expect(client.query).toHaveBeenNthCalledWith(5, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});
		});

		it('quarantines every admitted SQL after a verified client-wide statement loss', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const error = { code: '26000', routine: 'FetchPreparedStatement' };
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sqlA = 'SELECT id FROM users WHERE id = $1';
			const sqlB = 'SELECT id FROM accounts WHERE id = $1';

			await (adapter as any).issueConnectionQuery(client, sqlA, [7], true);
			await (adapter as any).issueConnectionQuery(client, sqlB, [8], true);
			await (adapter as any).issueConnectionQuery(client, sqlA, [7], true);
			await (adapter as any).issueConnectionQuery(client, sqlB, [8], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sqlA, [7], true),
			).rejects.toBe(error);
			await expect(
				(adapter as any).issueConnectionQuery(client, sqlB, [8], true),
			).resolves.toMatchObject({ rows: [{ id: 8 }] });

			expect(client.query).toHaveBeenNthCalledWith(6, sqlB, [8]);
		});

		it('does not quarantine a pool query after a verified failure', async () => {
			const pool = createMockPool();
			const error = { code: '26000', routine: 'FetchPreparedStatement' };
			vi.mocked(pool.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
			});
			const sql = 'SELECT id FROM users WHERE id = $1';

			await (adapter as any).issueConnectionQuery(pool, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(pool, sql, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(pool, sql, [7], true);

			expect(pool.query).toHaveBeenNthCalledWith(3, {
				name: expect.stringMatching(/^dbsp_ps_[0-9a-f]{32}$/),
				text: sql,
				values: [7],
			});
		});

		it.each([
			{ label: 'missing routine', error: { code: '0A000' } },
			{
				label: 'wrong routine',
				error: { code: '26000', routine: 'RevalidateCachedQuery' },
			},
		])('keeps naming after a fabricated $label', async ({ error }) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sql = 'SELECT id FROM users WHERE id = $1';

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true);

			expect(client.query).toHaveBeenNthCalledWith(3, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it('quarantines a duplicate prepared statement name without retrying it', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const error = { code: '42P05', routine: 'StorePreparedStatement' };
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sql = 'SELECT id FROM users WHERE id = $1';

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true);

			expect(client.query).toHaveBeenNthCalledWith(3, sql, [7]);
		});

		it('quarantines an exact-name driver-local collision without retrying it', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = new Error(
				`Prepared statements must be unique - '${derivePreparedStatementName(sql)}' was used for a different statement`,
			);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true);

			expect(client.query).toHaveBeenNthCalledWith(3, sql, [7]);
		});

		it('keeps naming after a driver-local collision names another statement', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = new Error(
				"Prepared statements must be unique - 'dbsp_ps_unexpected' was used for a different statement",
			);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).resolves.toMatchObject({ rows: [{ id: 7 }] });

			expect(client.query).toHaveBeenNthCalledWith(3, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it.each([
			'23505',
			'57014',
		])('keeps naming admitted after a non-invalidation SQLSTATE %s', async (code) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = { code };
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValue({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).resolves.toMatchObject({ rows: [{ id: 7 }] });

			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: expect.stringMatching(/^dbsp_ps_[0-9a-f]{32}$/),
				text: sql,
				values: [7],
			});
			expect(client.query).toHaveBeenNthCalledWith(3, {
				name: expect.stringMatching(/^dbsp_ps_[0-9a-f]{32}$/),
				text: sql,
				values: [7],
			});
		});
	});

	describe('executeWithMeta', () => {
		it('should return transformed rows with mutation rowCount and command', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({
				rows: [{ id: 1, full_name: 'Alice' }],
				rowCount: 1,
				command: 'UPDATE',
			} as any);

			const adapter = createPgsqlAdapter(pool, { dbCasing: 'snake_case' });
			const query = testQuery('UPDATE users SET full_name = $1 WHERE id = $2', [
				'Alice',
				1,
			]);

			const result = await adapter.executeWithMeta(query);

			expect(result).toEqual({
				rows: [{ id: 1, fullName: 'Alice' }],
				rowCount: 1,
				command: 'UPDATE',
			});
			expect(pool.query).toHaveBeenCalledWith(query.sql, query.parameters);
		});

		it('should normalize null rowCount to zero', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({
				rows: [],
				rowCount: null,
				command: 'UPDATE',
			} as any);

			const adapter = createPgsqlAdapter(pool);
			const result = await adapter.executeWithMeta(
				testQuery('UPDATE users SET active = false'),
			);

			expect(result).toEqual({
				rows: [],
				rowCount: 0,
				command: 'UPDATE',
			});
		});
	});

	describe('executeOne', () => {
		it('should return first result', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = testQuery('SELECT * FROM users LIMIT 1');

			const result = await adapter.executeOne(query);

			expect(result).toEqual(mockRows[0]);
		});

		it('should return null when no results', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = testQuery('SELECT * FROM users WHERE id = $1', [999]);

			const result = await adapter.executeOne(query);

			expect(result).toBeNull();
		});
	});

	describe('executeOneOrThrow', () => {
		it('should return first result', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = testQuery('SELECT * FROM users LIMIT 1');

			const result = await adapter.executeOneOrThrow(query);

			expect(result).toEqual(mockRows[0]);
		});

		it('should throw when no results', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [] } as any);

			const adapter = createPgsqlAdapter(pool);
			const query = testQuery('SELECT * FROM users WHERE id = $1', [999]);

			await expect(adapter.executeOneOrThrow(query)).rejects.toThrow(
				'No results found',
			);
		});
	});

	describe('executeRaw', () => {
		it('should execute raw SQL', async () => {
			const pool = createMockPool();
			const mockRows = [{ count: 5 }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const sql = 'SELECT COUNT(*) FROM users';

			const results = await adapter.executeRaw(sql);

			expect(results).toEqual(mockRows);
			expect(pool.query).toHaveBeenCalledWith(sql, []);
		});

		it('should execute raw SQL with parameters', async () => {
			const pool = createMockPool();
			const mockRows = [{ id: 1, name: 'Alice' }];
			vi.mocked(pool.query).mockResolvedValue({ rows: mockRows } as any);

			const adapter = createPgsqlAdapter(pool);
			const sql = 'SELECT * FROM users WHERE id = $1';
			const params = [1];

			const results = await adapter.executeRaw(sql, params);

			expect(results).toEqual(mockRows);
			expect(pool.query).toHaveBeenCalledWith(sql, params);
		});

		it('never names raw SQL even when prepared statements are enabled', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: 1 }] } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const sql = 'SELECT id FROM users WHERE id = $1';

			await adapter.executeRaw(sql, [1]);
			await adapter.executeRaw(sql, [1]);

			expect(pool.query).toHaveBeenNthCalledWith(1, sql, [1]);
			expect(pool.query).toHaveBeenNthCalledWith(2, sql, [1]);
		});
	});

	describe('preparedStatements disabled', () => {
		it('preserves each existing driver argument shape', async () => {
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({ rows: [], rowCount: 0 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: false });

			await adapter.execute(testQuery('SELECT $1', [1]));
			await adapter.executeRaw('SELECT $1', [1]);
			await adapter.executeDDL('CREATE TABLE disabled_path_test (id integer)');

			expect(pool.query).toHaveBeenNthCalledWith(1, 'SELECT $1', [1]);
			expect(pool.query).toHaveBeenNthCalledWith(2, 'SELECT $1', [1]);
			expect(pool.query).toHaveBeenNthCalledWith(
				3,
				'CREATE TABLE disabled_path_test (id integer)',
			);
		});
	});

	describe('withSchema', () => {
		it('should create schema-scoped adapter', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const scopedAdapter = adapter.withSchema('tenant_456');

			expect(scopedAdapter).toBeInstanceOf(PgsqlAdapter);
			expect(scopedAdapter).not.toBe(adapter);
		});

		it('should validate schema name', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// Invalid schema name with SQL injection attempt
			expect(() => adapter.withSchema('tenant"; DROP TABLE users--')).toThrow();
		});
	});

	describe('validateIdentifier', () => {
		it('should accept valid identifiers', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(() => adapter.validateIdentifier('users', 'table')).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('user_id', 'column'),
			).not.toThrow();
			expect(() =>
				adapter.validateIdentifier('tenant_123', 'schema'),
			).not.toThrow();
		});

		it('should reject invalid identifiers', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			// SQL injection attempts
			expect(() =>
				adapter.validateIdentifier('users; DROP TABLE users--', 'table'),
			).toThrow();
			expect(() =>
				adapter.validateIdentifier("users' OR 1=1--", 'table'),
			).toThrow();
		});
	});

	describe('createDump', () => {
		it('should create dump with plan and query', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [],
			} as any;

			const query = testQuery('SELECT * FROM users');

			const dump = adapter.createDump(plan, query);

			expect(dump.plan).toBe(plan);
			expect(dump.sql).toBe(query.sql);
			expect(dump.params).toBe(query.parameters);
			expect(dump.meta).toBeDefined();
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should include schema in dump metadata', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				schemaName: 'tenant_123',
			});

			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [],
			} as any;

			const query = testQuery('SELECT * FROM users');

			const dump = adapter.createDump(plan, query);

			expect(dump.meta?.schema).toBe('tenant_123');
		});
	});

	describe('factory function', () => {
		it('should create adapter via factory', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
		});

		it('should pass options to adapter', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool, {
				dbCasing: 'snake_case',
				schemaName: 'public',
			});

			expect(adapter.dbCasing).toBe('snake_case');
		});
	});

	describe('stubs (not yet implemented)', () => {
		it('compileSubqueryInclude generates SELECT with IN clause', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'authorId',
				sourceKey: 'id',
			} as any;
			const parentIds = [1, 2, 3];

			const compiled = adapter.compileSubqueryInclude(info, parentIds);

			expect(compiled.sql).toContain('SELECT');
			expect(compiled.sql).toContain('posts');
			expect(compiled.sql).toContain('IN');
			expect(compiled.parameters).toEqual([1, 2, 3]);
		});

		it('compileSubqueryInclude returns empty result for no parent IDs', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const info = {
				relationName: 'posts',
				targetTable: 'posts',
				foreignKey: 'authorId',
				sourceKey: 'id',
			} as any;
			const parentIds: unknown[] = [];

			const compiled = adapter.compileSubqueryInclude(info, parentIds);

			expect(compiled.sql).toContain('WHERE FALSE');
			expect(compiled.parameters).toEqual([]);
		});

		it('compileInsertFrom generates INSERT ... SELECT', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const intent = {
				type: 'insert_from' as const,
				table: 'archivedUsers',
				source: 'users',
				columns: ['id', 'name'],
			};

			const compiled = adapter.compileInsertFrom(intent);

			expect(compiled.sql).toContain('INSERT INTO');
			expect(compiled.sql).toContain('SELECT');
		});

		it('stream returns async iterator', () => {
			const pool = createMockPool();
			const adapter = createPgsqlAdapter(pool);

			const query = testQuery('SELECT * FROM users');

			const iterator = adapter.stream(query);

			// Should return an async iterator
			expect(typeof iterator[Symbol.asyncIterator]).toBe('function');
		});

		it('introspect should throw on compile-only adapter', async () => {
			const adapter = createPgsqlCompileOnlyAdapter();

			await expect(adapter.introspect()).rejects.toThrow(
				'Cannot introspect: this PgsqlAdapter was constructed without a connection',
			);
		});

		// generateDDL is now implemented - see ddl.test.ts for comprehensive tests
	});

	// =========================================================================
	// Compile-Only Mode (dry-run)
	// =========================================================================

	describe('compile-only mode', () => {
		it('should create adapter without pool via factory', () => {
			const adapter = new PgsqlAdapter(undefined, {});

			expect(adapter).toBeInstanceOf(PgsqlAdapter);
			expect(adapter.dbCasing).toBe('preserve');
			expect(adapter.capabilities.supportsStreaming).toBe(false);
		});

		it('should compile SELECT in compile-only mode', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'id' }] as any,
			} as unknown as PlanReport;

			const result = adapter.compile(plan);
			expect(result.sql).toContain('SELECT');
			expect(result.sql).toContain('users');
		});

		it('should throw on execute in compile-only mode', async () => {
			const adapter = new PgsqlAdapter(undefined, {});
			await expect(adapter.execute(testQuery('SELECT 1'))).rejects.toThrow(
				'constructed without a connection',
			);
		});

		it('should throw on stream in compile-only mode', async () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const iter = adapter.stream(testQuery('SELECT 1'));
			await expect(iter.next()).rejects.toThrow(
				'constructed without a connection',
			);
		});

		it('should throw on transaction in compile-only mode', async () => {
			const adapter = new PgsqlAdapter(undefined, {});
			await expect(adapter.transaction(async () => {})).rejects.toThrow(
				'constructed without a connection',
			);
		});

		it('should throw on executeRaw in compile-only mode', async () => {
			const adapter = new PgsqlAdapter(undefined, {});
			await expect(adapter.executeRaw('SELECT 1')).rejects.toThrow(
				'constructed without a connection',
			);
		});

		it('should create schema-scoped compile-only adapter via withSchema', async () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const scoped = adapter.withSchema('tenant_1');

			expect(scoped).toBeInstanceOf(PgsqlAdapter);
			// Scoped adapter should also be in compile-only mode
			await expect(scoped.execute(testQuery('SELECT 1'))).rejects.toThrow(
				'constructed without a connection',
			);
		});

		it('should generate DDL in compile-only mode', () => {
			const schema = {
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{ name: 'name', type: 'string', nullable: false },
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
				relations: new Map(),
			} as any;

			const adapter = new PgsqlAdapter(undefined, {});
			const ddl = adapter.generateDDL(schema);
			expect(ddl.length).toBeGreaterThan(0);
			expect(ddl[0]).toContain('CREATE TABLE');
		});

		it('should createDump in compile-only mode', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan: PlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'id' }] as any,
			} as unknown as PlanReport;
			const query = adapter.compile(plan);
			const dump = adapter.createDump(plan, query);

			expect(dump.sql).toContain('SELECT');
			expect(dump.params).toBeDefined();
		});
	});

	// ========================================================================
	// Column propagation from selectRelationColumn → includeStrategy
	// ========================================================================

	describe('column propagation to include strategy', () => {
		/**
		 * Build a PlanReport that triggers:
		 * 1. intentToDecisions → selectRelationColumn decisions
		 * 2. extractAllIncludeDecisions → includeStrategy decisions
		 * 3. Deduplication merges column info before compiling
		 */
		function buildPlanWithRelationColumns(
			rootTable: string,
			selectExprs: unknown[],
			includeDecisions: unknown[],
		): PlanReport {
			return {
				rootTable,
				intent: {
					type: 'query',
					table: rootTable,
					select: {
						type: 'expressions',
						columns: selectExprs,
					},
				},
				decisions: includeDecisions,
			} as unknown as PlanReport;
		}

		function lateralInclude(relation: string, targetTable: string): unknown {
			return {
				type: 'include-strategy',
				choice: 'lateral',
				context: {
					relation,
					target: targetTable,
					relationType: 'hasMany',
					sourceTable: undefined,
				},
			};
		}

		it('propagates specific columns from selectRelationColumn to lateral include', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'name',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			const compiled = adapter.compile(plan);
			// Should have specific column, not star
			expect(compiled.sql).toContain('orders_lat_0.name');
			expect(compiled.sql).not.toContain('orders_lat_0.*');
		});

		it('propagates multiple columns for same relation', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'name',
					},
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'total',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			const compiled = adapter.compile(plan);
			expect(compiled.sql).toContain('orders_lat_0.name');
			expect(compiled.sql).toContain('orders_lat_0.total');
			expect(compiled.sql).not.toContain('orders_lat_0.*');
		});

		it('keeps star expansion when column is *', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: '*',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			const compiled = adapter.compile(plan);
			expect(compiled.sql).toContain('orders_lat_0.*');
		});

		it('validates columns against model schema', () => {
			const model = {
				getTable: (name: string) => {
					if (name === 'orders') {
						return {
							name: 'orders',
							columns: [
								{ name: 'id', type: 'integer', nullable: false },
								{
									name: 'name',
									type: 'string',
									nullable: false,
								},
								{
									name: 'total',
									type: 'numeric',
									nullable: false,
								},
							],
							primaryKey: 'id',
							foreignKeys: [],
							indexes: [],
						};
					}
					return undefined;
				},
				getRelation: () => undefined,
			};

			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'nonexistent',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			expect(() => adapter.compile(plan, { model } as any)).toThrow(
				/Unknown column.*'nonexistent'.*relation 'orders'.*table 'orders'/,
			);
		});

		it('skips validation when no model is provided', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'anything',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			// Should not throw — no model means no validation
			const compiled = adapter.compile(plan);
			expect(compiled.sql).toContain('orders_lat_0.anything');
		});

		it('skips validation when target table not found in model', () => {
			const model = {
				getTable: () => undefined, // No tables known
				getRelation: () => undefined,
			};

			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'customers',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'orders',
						column: 'anything',
					},
				],
				[lateralInclude('orders', 'orders')],
			);

			// Should not throw — table not in model = fail open
			const compiled = adapter.compile(plan, { model } as any);
			expect(compiled.sql).toContain('orders_lat_0.anything');
		});

		// ── RELATION-COL-RESULT fix ──────────────────────────────────────────
		// relationColumn('file', 'path', 'file_path') with join strategy must
		// produce `"file"."path" AS "file_path"` in the SELECT list.
		// Before the fix, the alias was dropped and "file.path" (pg notation)
		// was used instead, making the result column unreachable.

		function joinInclude(relation: string, targetTable: string): unknown {
			return {
				type: 'include-strategy',
				choice: 'join',
				context: {
					relation,
					target: targetTable,
					relationType: 'belongsTo',
					sourceTable: undefined,
				},
			};
		}

		it('propagates user-supplied alias for join include (RELATION-COL-RESULT)', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'symbols',
				[
					{ kind: 'column', column: 'id' },
					{ kind: 'column', column: 'name' },
					{
						kind: 'relationColumn',
						relation: 'file',
						column: 'path',
						as: 'file_path',
					},
				],
				[joinInclude('file', 'files')],
			);

			const compiled = adapter.compile(plan);
			// SQL must contain the user-supplied alias file_path (user alias),
			// not the default "file.path" alias (convention fallback).
			// We check for " file_path" (with space) to avoid false positives on "file_path_extra".
			expect(compiled.sql).toMatch(/\bfile_path\b/);
			expect(compiled.sql).not.toMatch(/AS\s+"?file\.path"?/);
		});

		it('falls back to relation.column alias when no alias provided (join)', () => {
			const adapter = new PgsqlAdapter(undefined, {});
			const plan = buildPlanWithRelationColumns(
				'symbols',
				[
					{ kind: 'column', column: 'id' },
					{
						kind: 'relationColumn',
						relation: 'file',
						column: 'path',
						// No `as` — fall back to "file.path" convention
					},
				],
				[joinInclude('file', 'files')],
			);

			const compiled = adapter.compile(plan);
			expect(compiled.sql).toContain('"file.path"');
		});
	});
});
