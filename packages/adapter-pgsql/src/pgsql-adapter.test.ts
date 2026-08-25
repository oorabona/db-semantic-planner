/**
 * PgsqlAdapter Unit Tests
 *
 * Tests adapter interface implementation without database connection.
 */

import { type PlanReport, supportsExecution } from '@dbsp/core';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createPgsqlAdapter,
	createPgsqlCompileOnlyAdapter,
	PgsqlAdapter,
	PgsqlPreparedStatementReplayError,
	PgsqlTransactionAbortedError,
} from './pgsql-adapter.js';
import {
	derivePreparedStatementFingerprint,
	derivePreparedStatementName,
} from './prepared-statements.js';

// ============================================================================
// Mock Pool
// ============================================================================

function createMockPool(): Pool {
	return {
		query: vi.fn<Pool['query']>(),
		connect: vi.fn<Pool['connect']>(),
		end: vi.fn<Pool['end']>(),
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
		it('accepts the zero-argument compile-only constructor overload', () => {
			expectTypeOf(new PgsqlAdapter()).toEqualTypeOf<PgsqlAdapter>();
		});

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

		it('rejects replayInvalidatedPlans for borrowed and compile-only JavaScript callers', () => {
			const client = {
				query: vi.fn(),
				release: vi.fn(),
			} as unknown as PoolClient;

			expect(() =>
				createPgsqlAdapter(client, {
					borrowedClient: true,
					replayInvalidatedPlans: true,
				} as any),
			).toThrow(
				'replayInvalidatedPlans requires a pg Pool-owned adapter; it is not supported by borrowed-client or compile-only adapters.',
			);
			expect(() =>
				createPgsqlCompileOnlyAdapter({
					replayInvalidatedPlans: true,
				} as any),
			).toThrow(
				'replayInvalidatedPlans requires a pg Pool-owned adapter; it is not supported by borrowed-client or compile-only adapters.',
			);
		});

		it('rejects replayInvalidatedPlans without preparedStatements for JavaScript callers', () => {
			const pool = createMockPool();

			expect(() =>
				createPgsqlAdapter(pool, {
					replayInvalidatedPlans: true,
				} as any),
			).toThrow(
				'replayInvalidatedPlans: true requires preparedStatements: true or a preparedStatements options object.',
			);
		});

		it('rejects an own non-boolean replayInvalidatedPlans option', () => {
			const pool = createMockPool();

			expect(() =>
				createPgsqlAdapter(pool, {
					preparedStatements: true,
					replayInvalidatedPlans: 'true',
				} as any),
			).toThrow('replayInvalidatedPlans: expected a boolean.');
		});

		it('honors replayInvalidatedPlans on a callable options container', () => {
			const pool = createMockPool();
			const options = Object.assign(() => {}, {
				preparedStatements: true as const,
				replayInvalidatedPlans: true as const,
			});

			const adapter = createPgsqlAdapter(pool, options);

			expect((adapter as any).replayInvalidatedPlans).toBe(true);
		});

		it('rejects a non-boolean replayInvalidatedPlans on a callable options container', () => {
			const pool = createMockPool();
			const options = Object.assign(() => {}, {
				preparedStatements: true as const,
				replayInvalidatedPlans: 'true',
			});

			expect(() => createPgsqlAdapter(pool, options as any)).toThrow(
				'replayInvalidatedPlans: expected a boolean.',
			);
		});

		it('honors borrowedClient on a callable options container', () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const options = Object.assign(() => {}, {
				borrowedClient: true as const,
			});

			const adapter = createPgsqlAdapter(client, options);

			expect(adapter.getPoolInstance()).toBe(client);
		});

		it('refuses a callable Proxy options container', () => {
			const pool = createMockPool();
			const options = new Proxy(
				Object.assign(() => {}, {
					preparedStatements: true as const,
					replayInvalidatedPlans: true as const,
				}),
				{},
			);

			expect(() => createPgsqlAdapter(pool, options)).toThrow(
				'replayInvalidatedPlans: expected a boolean.',
			);
		});

		it.each([
			{
				label: 'throwing descriptor trap',
				createOptions: () =>
					new Proxy(
						{},
						{
							getOwnPropertyDescriptor() {
								throw new Error('descriptor trap escaped');
							},
						},
					),
			},
			{
				label: 'revoked Proxy',
				createOptions: () => {
					const proxy = Proxy.revocable({}, {});
					proxy.revoke();
					return proxy.proxy;
				},
			},
			{
				label: 'accessor descriptor',
				createOptions: () =>
					Object.defineProperty({}, 'replayInvalidatedPlans', {
						enumerable: true,
						get() {
							throw new Error('accessor must not be read');
						},
					}),
			},
		])('refuses a $label replayInvalidatedPlans option with the named validation error', ({
			createOptions,
		}) => {
			const pool = createMockPool();

			expect(() => createPgsqlAdapter(pool, createOptions() as any)).toThrow(
				'replayInvalidatedPlans: expected a boolean.',
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
			expectTypeOf(
				createPgsqlAdapter(pool, {
					preparedStatements: true,
					replayInvalidatedPlans: true,
				}),
			).toEqualTypeOf<PgsqlAdapter>();

			if (process.env.DBSP_TYPECHECK_ONLY === '1') {
				const uncoupledPoolReplayOptions = {
					replayInvalidatedPlans: true,
				} as const;
				const borrowedReplayOptions = {
					borrowedClient: true,
					replayInvalidatedPlans: true,
				} as const;
				const compileOnlyReplayOptions = {
					replayInvalidatedPlans: true,
				} as const;
				// @ts-expect-error a PoolClient requires an explicit borrowedClient opt-in.
				createPgsqlAdapter(client);
				// @ts-expect-error borrowedClient requires a PoolClient, not a Pool.
				createPgsqlAdapter(pool, { borrowedClient: true });
				// @ts-expect-error replay requires preparedStatements through a predeclared pool options object.
				createPgsqlAdapter(pool, uncoupledPoolReplayOptions);
				// @ts-expect-error replay requires a pool-owned adapter.
				createPgsqlAdapter(client, {
					borrowedClient: true,
					replayInvalidatedPlans: true,
				});
				// @ts-expect-error replay remains forbidden through a predeclared borrowed options object.
				createPgsqlAdapter(client, borrowedReplayOptions);
				// @ts-expect-error replay requires a pool-owned adapter.
				createPgsqlCompileOnlyAdapter({ replayInvalidatedPlans: true });
				// @ts-expect-error replay remains forbidden through a predeclared compile-only options object.
				createPgsqlCompileOnlyAdapter(compileOnlyReplayOptions);
				// @ts-expect-error replay requires a pool-owned adapter.
				new PgsqlAdapter(undefined, { replayInvalidatedPlans: true });
				// @ts-expect-error replay remains forbidden through a predeclared compile-only options object.
				new PgsqlAdapter(undefined, compileOnlyReplayOptions);
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

	describe('executionAvailable', () => {
		it('is true for pool and pinned adapters, and false for compile-only adapters', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const adapter = createPgsqlAdapter(pool);

			expect(adapter.executionAvailable()).toBe(true);
			await adapter.withPinnedConnection(async (pinned) => {
				expect((pinned as PgsqlAdapter).executionAvailable()).toBe(true);
			});
			expect(createPgsqlCompileOnlyAdapter().executionAvailable()).toBe(false);
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

		it('releases a pool admission after a connection failure but retains it after a server error', async () => {
			const sqlA = 'SELECT id FROM pool_admission_a WHERE id = $1';
			const sqlB = 'SELECT id FROM pool_admission_b WHERE id = $1';
			const queryA = testQuery(sqlA, [7]);
			const queryB = testQuery(sqlB, [8]);
			const connectionError = Object.assign(new Error('connect ECONNREFUSED'), {
				code: 'ECONNREFUSED',
			});
			const pool = createMockPool();
			vi.mocked(pool.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(connectionError)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});

			await expect(adapter.execute(queryA)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(queryA)).rejects.toBe(connectionError);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);

			expect(pool.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});

			const serverError = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
			};
			const serverPool = createMockPool();
			vi.mocked(serverPool.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(serverError)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const serverAdapter = createPgsqlAdapter(serverPool, {
				preparedStatements: { maxStatements: 1 },
			});

			await expect(serverAdapter.execute(queryA)).resolves.toEqual([{ id: 7 }]);
			await expect(serverAdapter.execute(queryA)).rejects.toBe(serverError);
			await expect(serverAdapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);
			await expect(serverAdapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);

			expect(serverPool.query).toHaveBeenNthCalledWith(4, sqlB, [8]);
		});

		it('aborts a reservation when named parameter iteration throws before submission', async () => {
			const sqlA = 'SELECT id FROM parameter_iteration_a WHERE id = $1';
			const sqlB = 'SELECT id FROM parameter_iteration_b WHERE id = $1';
			const iterationError = new Error('parameter iterator failed');
			const throwingParameters = [7];
			Object.defineProperty(throwingParameters, Symbol.iterator, {
				value() {
					throw iterationError;
				},
			});
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({
				rows: [{ id: 8 }],
				rowCount: 1,
			} as any);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});

			await (adapter as any).issueConnectionQuery(pool, sqlA, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(
					pool,
					sqlA,
					throwingParameters,
					true,
				),
			).rejects.toBe(iterationError);
			expect(pool.query).toHaveBeenCalledTimes(1);

			await (adapter as any).issueConnectionQuery(pool, sqlB, [8], true);
			await (adapter as any).issueConnectionQuery(pool, sqlB, [8], true);

			expect(pool.query).toHaveBeenNthCalledWith(3, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});
		});

		it('aborts a pool admission and rethrows the query error when classification reads a throwing getter', async () => {
			const sqlA = 'SELECT id FROM pool_throwing_getter_a WHERE id = $1';
			const sqlB = 'SELECT id FROM pool_throwing_getter_b WHERE id = $1';
			const error = Object.defineProperty({ code: '23505' }, 'severity', {
				get() {
					throw new Error('severity getter must not escape classification');
				},
			});
			const pool = createMockPool();
			vi.mocked(pool.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});

			await (adapter as any).issueConnectionQuery(pool, sqlA, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(pool, sqlA, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(pool, sqlB, [8], true);
			await (adapter as any).issueConnectionQuery(pool, sqlB, [8], true);

			expect(pool.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});
		});

		it('aborts a borrowed-client admission and rethrows the query error when classification reads a throwing getter', async () => {
			const sqlA = 'SELECT id FROM client_throwing_getter_a WHERE id = $1';
			const sqlB = 'SELECT id FROM client_throwing_getter_b WHERE id = $1';
			const error = Object.defineProperty({ code: '23505' }, 'severity', {
				get() {
					throw new Error('severity getter must not escape classification');
				},
			});
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});

			await (adapter as any).issueConnectionQuery(client, sqlA, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sqlA, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sqlB, [8], true);
			await (adapter as any).issueConnectionQuery(client, sqlB, [8], true);

			expect(client.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});
		});

		it.each([
			{
				label: 'ECONNREFUSED-shaped error',
				error: Object.assign(new Error('connect ECONNREFUSED'), {
					code: 'ECONNREFUSED',
				}),
			},
			...['EPIPE', 'EPERM'].map((code) => ({
				label: `${code}-shaped local Node error`,
				error: Object.assign(new Error(`write ${code}`), { code }),
			})),
			{
				label: 'wrong-name driver-local collision',
				error: new Error(
					"Prepared statements must be unique - 'dbsp_ps_unexpected' was used for a different statement",
				),
			},
			{
				label: 'truncated driver-local collision prefix',
				error: new Error("Prepared statements must be unique - '"),
			},
			{
				label: 'error with an own undefined code',
				error: Object.assign(new Error('connection failed'), {
					code: undefined,
				}),
			},
		])('releases a borrowed-client admission after a non-server-reported $label', async ({
			error,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sqlA = 'SELECT id FROM client_admission_a WHERE id = $1';
			const sqlB = 'SELECT id FROM client_admission_b WHERE id = $1';
			const queryA = testQuery(sqlA, [7]);
			const queryB = testQuery(sqlB, [8]);
			vi.mocked(client.query).mockImplementation((statement: any) => {
				if (
					typeof statement === 'string' &&
					statement.startsWith('SAVEPOINT ')
				) {
					return Promise.reject({ code: '25P01', severity: 'ERROR' });
				}
				if (typeof statement === 'object' && statement.text === sqlA)
					return Promise.reject(error);
				if (statement === sqlA)
					return Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 } as any);
				return Promise.resolve({ rows: [{ id: 8 }], rowCount: 1 } as any);
			});
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});

			await expect(adapter.execute(queryA)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(queryA)).rejects.toBe(error);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);

			expect(client.query).toHaveBeenNthCalledWith(8, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
			});
		});

		it('retains a borrowed-client admission after a protocol-evidenced SQLSTATE-shaped positionless error', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sqlA = 'SELECT id FROM client_admission_a WHERE id = $1';
			const sqlB = 'SELECT id FROM client_admission_b WHERE id = $1';
			const queryA = testQuery(sqlA, [7]);
			const queryB = testQuery(sqlB, [8]);
			const error = { code: '23505', severity: 'ERROR' };
			vi.mocked(client.query).mockImplementation((statement: any) => {
				if (
					typeof statement === 'string' &&
					statement.startsWith('SAVEPOINT ')
				) {
					return Promise.reject({ code: '25P01', severity: 'ERROR' });
				}
				if (typeof statement === 'object' && statement.text === sqlA)
					return Promise.reject(error);
				if (statement === sqlA)
					return Promise.resolve({ rows: [{ id: 7 }], rowCount: 1 } as any);
				return Promise.resolve({ rows: [{ id: 8 }], rowCount: 1 } as any);
			});
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});

			await expect(adapter.execute(queryA)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(queryA)).rejects.toBe(error);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);

			expect(client.query).toHaveBeenNthCalledWith(8, sqlB, [8]);
		});

		it.each([
			'EPIPE',
			'EPERM',
		])('aborts a pool admission after a local %s-shaped Node error', async (code) => {
			const sqlA = 'SELECT id FROM pool_local_admission_a WHERE id = $1';
			const sqlB = 'SELECT id FROM pool_local_admission_b WHERE id = $1';
			const queryA = testQuery(sqlA, [7]);
			const queryB = testQuery(sqlB, [8]);
			const error = Object.assign(new Error(`write ${code}`), { code });
			const pool = createMockPool();
			vi.mocked(pool.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: { maxStatements: 1 },
			});

			await expect(adapter.execute(queryA)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(queryA)).rejects.toBe(error);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);
			await expect(adapter.execute(queryB)).resolves.toEqual([{ id: 8 }]);

			expect(pool.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sqlB),
				text: sqlB,
				values: [8],
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
			{
				label: '26000/FetchPreparedStatement',
				createError: (sql: string) => ({
					code: '26000',
					severity: 'ERROR',
					routine: 'FetchPreparedStatement',
					message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
				}),
			},
			{
				label: '42P05/StorePreparedStatement',
				createError: (sql: string) => ({
					code: '42P05',
					severity: 'ERROR',
					routine: 'StorePreparedStatement',
					message: `prepared statement "${derivePreparedStatementName(sql)}" already exists`,
				}),
			},
		])('replays a matching $label named-statement failure unnamed in a pool-owned pinned scope', async ({
			createError,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = createError(sql);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			await adapter.withPinnedConnection(async (pinned) => {
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
			});

			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
			expect(client.query).toHaveBeenNthCalledWith(3, sql, [7]);
			expect(client.query).toHaveBeenNthCalledWith(4, sql, [7]);
		});

		it.each([
			{
				label: '26000/FetchPreparedStatement',
				error: {
					code: '26000',
					severity: 'ERROR',
					routine: 'FetchPreparedStatement',
					message: 'prepared statement "nested_missing" does not exist',
				},
			},
			{
				label: '42P05/StorePreparedStatement',
				error: {
					code: '42P05',
					severity: 'ERROR',
					routine: 'StorePreparedStatement',
					message: 'prepared statement "nested_duplicate" already exists',
				},
			},
		])('propagates a nested-shaped $label for another statement without replay or quarantine', async ({
			error,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).rejects.toBe(error);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).resolves.toMatchObject({ rows: [{ id: 7 }] });
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).resolves.toMatchObject({ rows: [{ id: 7 }] });

			expect(client.query).toHaveBeenCalledTimes(4);
			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
			expect(client.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it.each([
			{
				label: '26000/FetchPreparedStatement with duplicate suffix',
				error: (sql: string) => ({
					code: '26000',
					severity: 'ERROR',
					routine: 'FetchPreparedStatement',
					message: `prepared statement "${derivePreparedStatementName(sql)}" already exists`,
				}),
			},
			{
				label: '42P05/StorePreparedStatement with missing suffix',
				error: (sql: string) => ({
					code: '42P05',
					severity: 'ERROR',
					routine: 'StorePreparedStatement',
					message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
				}),
			},
		])('propagates a cross-paired $label without replay or quarantine', async ({
			error: createError,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = createError(sql);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);

			expect(client.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it('refuses a reserved-looking nested diagnostic name outside the server message', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: 'nested SQL function failed',
				detail: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);

			expect(client.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it('propagates 0A000/RevalidateCachedQuery by default without replay', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '0A000',
				severity: 'ERROR',
				routine: 'RevalidateCachedQuery',
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true, true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true, true),
			).rejects.toBe(error);

			expect(client.query).toHaveBeenCalledTimes(2);
		});

		it('replays from a stable parameter graph after the caller mutates Buffer, Date, and nested aliases', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const bytes = Buffer.from([1, 2, 3]);
			const timestamp = new Date('2026-08-24T12:00:00.000Z');
			const nested = { key: 'original' };
			const parameters: unknown[] = [bytes, timestamp, nested];
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockImplementationOnce(async () => {
					bytes[0] = 9;
					timestamp.setUTCFullYear(2030);
					nested.key = 'mutated';
					parameters[0] = Buffer.from([4, 5, 6]);
					throw error;
				})
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, parameters);

			await adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(query);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
			});

			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [
					Buffer.from([1, 2, 3]),
					new Date('2026-08-24T12:00:00.000Z'),
					{ key: 'original' },
				],
			});
			expect(client.query).toHaveBeenNthCalledWith(3, sql, [
				Buffer.from([1, 2, 3]),
				new Date('2026-08-24T12:00:00.000Z'),
				{ key: 'original' },
			]);
			const replayValues = vi.mocked(client.query).mock
				.calls[2]?.[1] as unknown as unknown[];
			expect(replayValues[0]).not.toBe(bytes);
			expect(replayValues[1]).not.toBe(timestamp);
			expect(replayValues[2]).not.toBe(nested);
		});

		it('keeps an own __proto__ JSON member through named execution and replay', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE payload = $1';
			const payload = JSON.parse('{"__proto__":{"tenant":"wrong"}}');
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [payload]);

			await adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(query);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
			});

			const namedValues = (
				vi.mocked(client.query).mock.calls[1]?.[0] as unknown as {
					readonly values: unknown[];
				}
			).values;
			const replayValues = vi.mocked(client.query).mock
				.calls[2]?.[1] as unknown as unknown[];
			for (const value of [namedValues[0], replayValues[0]]) {
				expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
				expect(
					Object.getOwnPropertyDescriptor(value as object, '__proto__')?.value,
				).toEqual({
					tenant: 'wrong',
				});
			}
		});

		it('replays a clean Date', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE created_at = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [new Date('2026-08-24T12:00:00.000Z')]);

			await adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(query);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
			});
			expect(client.query).toHaveBeenNthCalledWith(3, sql, [
				new Date('2026-08-24T12:00:00.000Z'),
			]);
		});

		it('declines a decorated Date', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE created_at = $1';
			const value = Object.assign(new Date('2026-08-24T12:00:00.000Z'), {
				futureNodePostgresSerializationHook: () => 1999,
			});
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(testQuery(sql, [value]));
					await pinned.execute(testQuery(sql, [value]));
				}),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
		});

		it('replays arrays and Buffers with serialization-irrelevant symbol metadata', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE payload = $1';
			const metadata = Symbol('metadata');
			const array = Object.assign([7], { [metadata]: 'ignored' });
			const bytes = Object.assign(Buffer.from([1, 2, 3]), {
				[metadata]: 'ignored',
			});
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });

			await adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(testQuery(sql, [array, bytes]));
				await expect(
					pinned.execute(testQuery(sql, [array, bytes])),
				).resolves.toEqual([{ id: 7 }]);
			});

			expect(client.query).toHaveBeenNthCalledWith(3, sql, [
				[7],
				Buffer.from([1, 2, 3]),
			]);
		});

		it('refuses an empty sparse array at its declared node limit without materializing its property table', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE payload = $1';
			const value = new Array(64 * 1024);
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			const descriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });

			try {
				await expect(
					adapter.withPinnedConnection(async (pinned) => {
						await pinned.execute(testQuery(sql, [value]));
						await pinned.execute(testQuery(sql, [value]));
					}),
				).rejects.toBe(error);
			} finally {
				descriptors.mockRestore();
			}
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(descriptors).not.toHaveBeenCalledWith(value);
		});

		it('refuses a Proxy parameter before its traps run', async () => {
			let trapCalls = 0;
			const value = new Proxy(
				{ id: 7 },
				{
					getPrototypeOf() {
						trapCalls += 1;
						return Object.prototype;
					},
					ownKeys() {
						trapCalls += 1;
						return ['id'];
					},
				},
			);
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE payload = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await (pinned as any).issueConnectionQuery(
						client,
						sql,
						[value],
						true,
						true,
					);
					await (pinned as any).issueConnectionQuery(
						client,
						sql,
						[value],
						true,
						true,
					);
				}),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(
				vi
					.mocked(client.query)
					.mock.calls.filter(([statement]) => statement === sql),
			).toHaveLength(1);
			expect(trapCalls).toBe(0);
		});

		it('declines replay after getPoolInstance exposes a pinned client', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					expect((pinned as PgsqlAdapter).getPoolInstance()).toBe(client);
					await pinned.execute(query);
					await pinned.execute(query);
				}),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
		});

		it('keeps a pinned scope replay-eligible when supportsExecution checks it', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			await adapter.withPinnedConnection(async (pinned) => {
				expect(supportsExecution(pinned)).toBe(true);
			});
			expect(vi.mocked(client.release).mock.calls[0]).toEqual([]);

			await adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(query);
				await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
			});

			expect(client.query).toHaveBeenNthCalledWith(3, sql, [7]);
		});

		it('declines replay when the physical client was exposed by an earlier pinned scope', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			let retained: PgsqlAdapter | undefined;
			await adapter.withPinnedConnection(async (pinned) => {
				retained = pinned as PgsqlAdapter;
				expect(retained.getPoolInstance()).toBe(client);
			});
			expect(client.release).toHaveBeenCalledOnce();
			const [releaseReason] = vi.mocked(client.release).mock.calls[0] ?? [];
			expect(releaseReason).toBeTruthy();
			expect(releaseReason).toBeInstanceOf(Error);

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(query);
					await pinned.execute(query);
				}),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(
				vi
					.mocked(client.query)
					.mock.calls.filter(([statement]) => statement === sql),
			).toHaveLength(1);
			expect(() => retained!.getPoolInstance()).toThrow(
				'This PostgreSQL pinned connection adapter belongs to a withPinnedConnection() scope that has ended.',
			);
		});

		it('declines replay when a pinned client is exposed after named submission', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			const namedFailure = deferredPromise<unknown>();
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockReturnValueOnce(namedFailure.promise as any)
				.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
				.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(query);
					const pending = pinned.execute(query);
					await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(2));
					const rawClient = (
						pinned as PgsqlAdapter
					).getPoolInstance() as PoolClient;
					await rawClient.query('BEGIN');
					await rawClient.query('SET ROLE injected_role');
					namedFailure.reject(error);
					await expect(pending).rejects.toBe(error);
				}),
			).rejects.toBeInstanceOf(PgsqlTransactionAbortedError);
			expect(
				vi
					.mocked(client.query)
					.mock.calls.filter(([statement]) => statement === sql),
			).toHaveLength(1);
		});

		it('snapshots a large Buffer with a byte copy and no descriptor walk', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM blobs WHERE bytes = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			const bytes = Buffer.alloc(256 * 1024, 7);
			const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
			const inspectedBuffers: Buffer[] = [];
			const descriptors = vi
				.spyOn(Object, 'getOwnPropertyDescriptors')
				.mockImplementation((value: unknown) => {
					if (Buffer.isBuffer(value)) inspectedBuffers.push(value);
					return getOwnPropertyDescriptors(value as object);
				});
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [bytes]);

			try {
				await adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(query);
					await expect(pinned.execute(query)).resolves.toEqual([{ id: 7 }]);
				});
			} finally {
				descriptors.mockRestore();
			}

			expect(inspectedBuffers).toHaveLength(0);
			const replayBytes = vi.mocked(client.query).mock
				.calls[2]?.[1] as unknown as unknown[];
			expect(Buffer.isBuffer(replayBytes[0])).toBe(true);
			expect(replayBytes[0]).not.toBe(bytes);
			expect(replayBytes[0]).toEqual(bytes);
		});

		it.each([
			{
				label: 'visited-node',
				atBudget: () => Array.from({ length: 64 * 1024 }, () => 7),
				overBudget: () => Array.from({ length: 64 * 1024 + 1 }, () => 7),
			},
			{
				label: 'string-byte',
				atBudget: () => ['x'.repeat(16 * 1024 * 1024)],
				overBudget: () => ['x'.repeat(16 * 1024 * 1024 + 1)],
			},
			{
				label: 'object-key-string-byte',
				atBudget: () => [{ ['x'.repeat(16 * 1024 * 1024)]: null }],
				overBudget: () => [{ ['x'.repeat(16 * 1024 * 1024 + 1)]: null }],
			},
			{
				label: 'Buffer-byte',
				atBudget: () => [Buffer.alloc(16 * 1024 * 1024, 7)],
				overBudget: () => [Buffer.alloc(16 * 1024 * 1024 + 1, 7)],
			},
		])('replays at the $label budget boundary and declines an over-budget snapshot', async ({
			label,
			atBudget,
			overBudget,
		}) => {
			const sql = 'SELECT id FROM replay_snapshot_budget WHERE payload = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			const run = async (
				parameters: unknown[],
				expectedReplay: boolean,
			): Promise<PoolClient> => {
				const client = Object.assign(createMockPool(), {
					release: vi.fn(),
					_txStatus: 'I',
				}) as unknown as PoolClient;
				const pool = Object.assign(createMockPool(), {
					connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
				});
				vi.mocked(client.query)
					.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
					.mockRejectedValueOnce(error);
				if (expectedReplay) {
					vi.mocked(client.query).mockResolvedValueOnce({
						rows: [{ id: 7 }],
						rowCount: 1,
					} as any);
				}
				const adapter = createPgsqlAdapter(pool, { preparedStatements: true });

				if (expectedReplay) {
					await adapter.withPinnedConnection(async (pinned) => {
						await (pinned as any).issueConnectionQuery(
							client,
							sql,
							parameters,
							true,
							true,
						);
						await expect(
							(pinned as any).issueConnectionQuery(
								client,
								sql,
								parameters,
								true,
								true,
							),
						).resolves.toEqual({ rows: [{ id: 7 }], rowCount: 1 });
					});
					expect(client.query).toHaveBeenCalledTimes(3);
					expect(client.query).toHaveBeenNthCalledWith(
						3,
						sql,
						expect.any(Array),
					);
				} else {
					await expect(
						adapter.withPinnedConnection(async (pinned) => {
							await (pinned as any).issueConnectionQuery(
								client,
								sql,
								parameters,
								true,
								true,
							);
							await (pinned as any).issueConnectionQuery(
								client,
								sql,
								parameters,
								true,
								true,
							);
						}),
					).rejects.toBe(error);
					expect(client.query).toHaveBeenCalledTimes(2);
					expect(
						vi
							.mocked(client.query)
							.mock.calls.filter(([statement]) => statement === sql),
					).toHaveLength(1);
					expect(
						(
							vi.mocked(client.query).mock.calls[1]?.[0] as unknown as {
								readonly values: unknown[];
							}
						).values[0],
					).toBe(parameters[0]);
				}
				return client;
			};

			await run(atBudget(), true);
			if (label !== 'Buffer-byte') {
				await run(overBudget(), false);
				return;
			}
			const bufferFrom = vi.spyOn(Buffer, 'from');
			try {
				await run(overBudget(), false);
			} finally {
				bufferFrom.mockRestore();
			}
			expect(bufferFrom).not.toHaveBeenCalled();
		}, 30_000);

		it.each([
			{
				label: 'data property',
				shadowByteLength: (value: Buffer) => {
					Object.defineProperty(value, 'byteLength', { value: 0 });
				},
			},
			{
				label: 'accessor',
				shadowByteLength: (value: Buffer) => {
					Object.defineProperty(value, 'byteLength', { get: () => 0 });
				},
			},
		])('declines an oversized Buffer with a shadowed byteLength $label at capture and submits named shallowly', async ({
			shadowByteLength,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM replay_snapshot_budget WHERE payload = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			const value = Buffer.alloc(16 * 1024 * 1024 + 1, 7);
			shadowByteLength(value);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const bufferFrom = vi.spyOn(Buffer, 'from');
			try {
				await (adapter as any).issueConnectionQuery(
					client,
					sql,
					[value],
					true,
					true,
				);
				await expect(
					(adapter as any).issueConnectionQuery(
						client,
						sql,
						[value],
						true,
						true,
					),
				).rejects.toBe(error);
			} finally {
				bufferFrom.mockRestore();
			}
			expect(bufferFrom).not.toHaveBeenCalled();
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(
				(
					vi.mocked(client.query).mock.calls[1]?.[0] as unknown as {
						readonly values: unknown[];
					}
				).values[0],
			).toBe(value);
		});

		it('keeps named parameters shallow in pool and borrowed modes', async () => {
			const parameter = { nested: { mutable: true } };
			const sql = 'SELECT id FROM users WHERE payload = $1';
			const pool = createMockPool();
			vi.mocked(pool.query).mockResolvedValue({
				rows: [{ id: 7 }],
				rowCount: 1,
			} as any);
			const poolAdapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
			});
			await (poolAdapter as any).issueConnectionQuery(
				pool,
				sql,
				[parameter],
				true,
				false,
			);
			await (poolAdapter as any).issueConnectionQuery(
				pool,
				sql,
				[parameter],
				true,
				false,
			);
			expect(
				(
					vi.mocked(pool.query).mock.calls[1]?.[0] as unknown as {
						values: unknown[];
					}
				).values[0],
			).toBe(parameter);

			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			vi.mocked(client.query).mockResolvedValue({
				rows: [{ id: 7 }],
				rowCount: 1,
			} as any);
			const borrowedAdapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			await (borrowedAdapter as any).issueConnectionQuery(
				client,
				sql,
				[parameter],
				true,
				false,
			);
			await (borrowedAdapter as any).issueConnectionQuery(
				client,
				sql,
				[parameter],
				true,
				false,
			);
			expect(
				(
					vi.mocked(client.query).mock.calls[1]?.[0] as unknown as {
						values: unknown[];
					}
				).values[0],
			).toBe(parameter);
		});

		it.each([
			{
				label: 'symbol-valued parameter',
				value: Symbol('not replayable'),
			},
			{
				label: 'plain object symbol key',
				value: Object.assign({}, { [Symbol('metadata')]: true }),
			},
			{
				label: 'shadowed Date',
				value: Object.assign(new Date('2026-08-24T12:00:00.000Z'), {
					getFullYear: () => 1999,
				}),
			},
			{
				label: 'custom toPostgres value',
				value: { toPostgres: () => 'serialized' },
			},
			{
				label: 'cyclic object',
				value: (() => {
					const cycle: { self?: unknown } = {};
					cycle.self = cycle;
					return cycle;
				})(),
			},
			{
				label: 'accessor object',
				value: Object.defineProperty({}, 'value', {
					enumerable: true,
					get: () => 'not read by the replay snapshot',
				}),
			},
		])('declines replay for a replay-ineligible $label', async ({ value }) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [value]);

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(query);
					await pinned.execute(query);
				}),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
		});

		it('wraps the unnamed replay failure with its admission and original infrastructure error', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const initialError = {
				code: '0A000',
				severity: 'ERROR',
				routine: 'RevalidateCachedQuery',
			};
			const replayError = new Error(
				`unnamed replay failed for ${'top-secret-replay-parameter'}`,
			);
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(initialError)
				.mockRejectedValueOnce(replayError);
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
				replayInvalidatedPlans: true,
			});
			expect((adapter as any).replayInvalidatedPlans).toBe(true);
			const secret = 'top-secret-replay-parameter';
			const query = testQuery(sql, [secret]);
			const operation = adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(query);
				await pinned.execute(query);
			});
			const recoveryError = await operation.catch((error: unknown) => error);
			expect(recoveryError).toBeInstanceOf(PgsqlPreparedStatementReplayError);
			expect(recoveryError).toMatchObject({
				admissionFingerprint: derivePreparedStatementFingerprint(sql),
				infrastructureError: initialError,
				cause: replayError,
			});
			expect((recoveryError as Error).message).not.toContain(secret);
			expect(
				(recoveryError as Error & { cause: Error }).cause.message,
			).toContain(secret);
			expect(client.query).toHaveBeenCalledTimes(3);
			expect(client.query).toHaveBeenNthCalledWith(3, sql, [secret]);
		});

		it.each([
			'BEGIN',
			'SET search_path TO public',
		])('does not replay a borrowed client around a queued %s session mutation', async (sessionMutation) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const initialError = {
				code: '0A000',
				severity: 'ERROR',
				routine: 'RevalidateCachedQuery',
			};
			const namedFailure = deferredPromise<never>();
			let signalNamedFailure!: () => void;
			const namedFailureReached = new Promise<void>((resolve) => {
				signalNamedFailure = resolve;
			});
			let namedAttempts = 0;
			let running = false;
			const queue: (() => Promise<void>)[] = [];
			const runNext = (): void => {
				if (running) return;
				const next = queue.shift();
				if (next === undefined) return;
				running = true;
				void next().finally(() => {
					running = false;
					runNext();
				});
			};
			const query = vi.fn(
				(statement: unknown, parameters?: unknown) =>
					new Promise((resolve, reject) => {
						queue.push(async () => {
							if (
								typeof statement === 'string' &&
								statement.startsWith('SAVEPOINT ')
							) {
								reject({ code: '25P01', severity: 'ERROR' });
								return;
							}
							if (
								typeof statement === 'object' &&
								statement !== null &&
								'text' in statement &&
								statement.text === sql
							) {
								namedAttempts++;
								if (namedAttempts === 1) {
									resolve({ rows: [{ id: 7 }], rowCount: 1 });
									return;
								}
								signalNamedFailure();
								try {
									await namedFailure.promise;
								} catch (error) {
									reject(error);
								}
								return;
							}
							if (statement === sessionMutation) {
								resolve({ rows: [], rowCount: null });
								return;
							}
							if (statement === sql && parameters !== undefined) {
								resolve({ rows: [{ id: 7 }], rowCount: 1 });
								return;
							}
							reject(
								new Error(`unexpected queued query: ${String(statement)}`),
							);
						});
						runNext();
					}),
			);
			client.query = query as typeof client.query;
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const compiled = testQuery(sql, [7]);
			const unnamedCallCount = () =>
				query.mock.calls.filter(
					([statement, parameters]) =>
						statement === sql &&
						Array.isArray(parameters) &&
						parameters.length === 1 &&
						parameters[0] === 7,
				).length;

			await expect(adapter.execute(compiled)).resolves.toEqual([{ id: 7 }]);
			await expect(adapter.execute(compiled)).resolves.toEqual([{ id: 7 }]);
			const unnamedCallsBeforeFailure = unnamedCallCount();
			const failed = adapter.execute(compiled);
			await namedFailureReached;
			const mutation = client.query(sessionMutation);
			namedFailure.reject(initialError);

			await expect(failed).rejects.toBe(initialError);
			await expect(mutation).resolves.toMatchObject({ rowCount: null });
			expect(unnamedCallCount()).toBe(unnamedCallsBeforeFailure);

			await expect(adapter.execute(compiled)).resolves.toEqual([{ id: 7 }]);
			expect(unnamedCallCount()).toBe(unnamedCallsBeforeFailure + 1);
		});

		it('does not replay a non-listed named-statement error', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = { code: '42P01', severity: 'ERROR' };
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it.each([
			{ label: 'open transaction', txStatus: 'T' },
			{ label: 'aborted transaction', txStatus: 'E' },
			{ label: 'absent transaction status', txStatus: undefined },
		])('propagates a verified named-statement failure without replay for an owned pinned client with $label', async ({
			txStatus,
		}) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				...(txStatus === undefined ? {} : { _txStatus: txStatus }),
			}) as unknown as PoolClient;
			const pool = Object.assign(createMockPool(), {
				connect: vi.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
			});
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '0A000',
				severity: 'ERROR',
				routine: 'RevalidateCachedQuery',
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error);
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const query = testQuery(sql, [7]);

			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					await pinned.execute(query);
					await expect(pinned.execute(query)).rejects.toBe(error);
				}),
			).rejects.toBeInstanceOf(PgsqlTransactionAbortedError);
			expect(client.query).toHaveBeenCalledTimes(2);
			expect(client.query).toHaveBeenNthCalledWith(1, sql, [7]);
			expect(client.query).toHaveBeenNthCalledWith(2, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it('quarantines every admitted SQL after a verified client-wide statement loss', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
				_txStatus: 'I',
			}) as unknown as PoolClient;
			const sqlA = 'SELECT id FROM users WHERE id = $1';
			const sqlB = 'SELECT id FROM accounts WHERE id = $1';
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sqlA)}" does not exist`,
			};
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 8 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

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
			const error = {
				code: '26000',
				severity: 'ERROR',
				routine: 'FetchPreparedStatement',
			};
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
			{
				label: 'missing routine',
				error: { code: '0A000', severity: 'ERROR' },
			},
			{
				label: 'wrong routine',
				error: {
					code: '26000',
					severity: 'ERROR',
					routine: 'RevalidateCachedQuery',
				},
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

		it.each([
			{ code: '0A000', routine: 'RevalidateCachedQuery' },
			{ code: '26000', routine: 'FetchPreparedStatement' },
			{ code: '42P05', routine: 'StorePreparedStatement' },
		])('does not quarantine or downgrade a severity-free $code/$routine object', async (error) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			vi.mocked(client.query)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any)
				.mockRejectedValueOnce(error)
				.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 } as any);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true);
			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [7], true),
			).rejects.toBe(error);
			await (adapter as any).issueConnectionQuery(client, sql, [7], true);

			expect(client.query).toHaveBeenNthCalledWith(4, {
				name: derivePreparedStatementName(sql),
				text: sql,
				values: [7],
			});
		});

		it('quarantines a duplicate prepared statement name without retrying it', async () => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = {
				code: '42P05',
				severity: 'ERROR',
				routine: 'StorePreparedStatement',
				message: `prepared statement "${derivePreparedStatementName(sql)}" already exists`,
			};
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

		it.each([
			'23505',
			'57014',
		])('keeps naming admitted after a non-invalidation SQLSTATE %s', async (code) => {
			const client = Object.assign(createMockPool(), {
				release: vi.fn(),
			}) as unknown as PoolClient;
			const sql = 'SELECT id FROM users WHERE id = $1';
			const error = { code, severity: 'ERROR' };
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
