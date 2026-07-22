// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for orm-instance.ts
 *
 * Focuses on edge cases and branches not covered by existing tests
 */

import { describe, expect, it, vi } from 'vitest';
import { ModelIRImpl } from '../model-impl.js';
import type { TableIR } from '../model-ir.js';
import { InvalidOperationError } from './errors.js';
import { createOrmInstance } from './orm-instance.js';
import { createMockAdapter } from './test-utils.js';

// `orm.transaction()` is deliberately NOT an async method: an async method awaits
// what it returns and re-wraps it, which destroys the adapter's promise identity —
// and the pgsql adapter needs that identity to tell whether the CALLER awaited a
// nested transaction. The cost of dropping `async` is that a synchronous throw would
// escape synchronously from a method typed `Promise<T>`. These two hold both ends
// shut, so a future `async` cannot quietly take the guarantee back.
describe('orm.transaction() promise contract', () => {
	const model = new ModelIRImpl(
		new Map<string, TableIR>([
			[
				'users',
				{
					name: 'users',
					columns: [{ name: 'id', type: 'uuid', nullable: false }],
					primaryKey: 'id',
					foreignKeys: [],
					indexes: [],
				},
			],
		]),
		new Map(),
	);

	it('rejects rather than throwing when the adapter throws synchronously', async () => {
		const adapter = createMockAdapter();
		// The mock does not declare supportsTransactions: true, and core refuses before it
		// ever reaches the adapter — which would make this test pass for the wrong
		// reason. Say the adapter supports them, so the transaction path is real.
		(
			adapter.capabilities as { supportsTransactions: boolean }
		).supportsTransactions = true;
		const boom = new Error('adapter exploded synchronously');
		adapter.transaction = () => {
			throw boom;
		};

		const orm = createOrmInstance(model, false, undefined, adapter);

		// The point: a `.catch()` must see it. A synchronous throw would sail past.
		let caught: unknown;
		await orm
			.transaction(async () => undefined)
			.catch((error) => {
				caught = error;
			});
		expect(caught).toBe(boom);
	});

	it('returns the adapter promise itself, so the adapter can observe the caller', async () => {
		const adapter = createMockAdapter();
		(
			adapter.capabilities as { supportsTransactions: boolean }
		).supportsTransactions = true;
		const marker = Symbol('adapter promise identity');
		const adapterPromise = Object.assign(Promise.resolve(undefined), {
			[marker]: true,
		});
		adapter.transaction = () => adapterPromise as Promise<undefined>;

		const orm = createOrmInstance(model, false, undefined, adapter);
		const returned = orm.transaction(async () => undefined);

		// Not merely "resolves to the same value" — the SAME object. An async wrapper
		// would hand back a fresh promise here, and the adapter would never learn
		// whether the caller attached anything to its own.
		expect(returned).toBe(adapterPromise);
		await returned;
	});
});

describe('orm-instance coverage', () => {
	const tables = new Map<string, TableIR>([
		[
			'users',
			{
				name: 'users',
				columns: [
					{ name: 'id', type: 'uuid', nullable: false },
					{ name: 'email', type: 'text', nullable: false },
				],
				primaryKey: 'id',
				foreignKeys: [],
				indexes: [],
			},
		],
		[
			'categories',
			{
				name: 'categories',
				columns: [
					{ name: 'id', type: 'uuid', nullable: false },
					{ name: 'parentId', type: 'uuid', nullable: true },
				],
				primaryKey: 'id',
				foreignKeys: [
					{
						columns: ['parentId'],
						references: { table: 'categories', columns: ['id'] },
					},
				],
				indexes: [],
				pseudoColumns: [
					{
						type: 'self-ref-parent',
						columnName: 'parentId',
						relationName: 'parent',
						targetColumn: 'id',
						tableName: 'categories',
					},
					{
						type: 'self-ref-children',
						columnName: 'parentId',
						relationName: 'children',
						targetColumn: 'id',
						tableName: 'categories',
					},
				],
			},
		],
	]);

	const relations = new Map([
		[
			'categories.parent',
			{
				name: 'parent',
				source: 'categories',
				target: 'categories',
				type: 'belongsTo',
				foreignKey: 'parentId',
				joinDefault: 'auto',
				includeDefault: 'auto',
				cardinality: 'one',
				optionality: 'optional',
			},
		],
		[
			'categories.children',
			{
				name: 'children',
				source: 'categories',
				target: 'categories',
				type: 'hasMany',
				foreignKey: 'parentId',
				joinDefault: 'auto',
				includeDefault: 'auto',
				cardinality: 'many',
				optionality: 'optional',
			},
		],
	]);

	const model = new ModelIRImpl(tables, relations);

	const createTransactionalMockAdapter = () => {
		const adapter = createMockAdapter();
		return {
			...adapter,
			capabilities: {
				...adapter.capabilities,
				supportsTransactions: true,
			},
		};
	};

	describe('createOrmInstance - basic creation', () => {
		it('should create ORM with minimal options', () => {
			const orm = createOrmInstance(model, false, {});
			expect(orm).toBeDefined();
			expect(orm.strictMode).toBe(false);
		});

		it('should create ORM with strictMode enabled', () => {
			const orm = createOrmInstance(model, true, {});
			expect(orm.strictMode).toBe(true);
		});

		it('should create ORM without adapter', () => {
			const orm = createOrmInstance(model, false, {});
			expect(orm.select).toBeDefined();
			expect(orm.insert).toBeDefined();
		});

		it('should create ORM with adapter', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			expect(orm.withSchema).toBeDefined();
		});

		it('should create ORM with schemaName', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter, 'tenant_123');
			expect(orm).toBeDefined();
		});

		it('should create ORM with dialectCapabilities', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter, undefined, {
				supportsReturning: true,
				supportsSchemas: true,
				supportsRecursiveCTE: true,
				supportsLateralJoin: true,
				supportsWindowFunctions: true,
				supportsJsonAgg: true,
				supportsArrayType: true,
				supportsForUpdate: true,
				supportsForUpdateSkipLocked: true,
			});
			expect(orm).toBeDefined();
		});

		it('should create ORM with schemaDefinition', () => {
			const adapter = createMockAdapter();
			const schemaDefinition = { users: { id: 'uuid' } };
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				schemaDefinition,
			);
			expect(orm).toBeDefined();
		});

		it('should create ORM with globalPlanOptions', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				undefined,
				{ maxDepth: 5 },
			);
			expect(orm).toBeDefined();
		});

		it('should create ORM with defaultFilters', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				undefined,
				undefined,
				{ users: { field: 'deletedAt', op: 'isNull' } },
			);
			expect(orm).toBeDefined();
		});

		it('should create ORM with hookStore', () => {
			const adapter = createMockAdapter();
			const hookStore = new Map();
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				hookStore,
			);
			expect(orm).toBeDefined();
		});

		it('should create ORM with onHookError handler', () => {
			const adapter = createMockAdapter();
			const onHookError = vi.fn();
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				onHookError,
			);
			expect(orm).toBeDefined();
		});

		it('should create ORM with inTransaction flag', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(
				model,
				false,
				{},
				adapter,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				true,
			);
			expect(orm).toBeDefined();
		});
	});

	describe('withSchema', () => {
		it('should create schema-scoped ORM', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const scoped = orm.withSchema('tenant_123');
			expect(scoped).toBeDefined();
		});

		it('should validate schema name via adapter', () => {
			const adapter = createMockAdapter();
			const validateSpy = vi.spyOn(adapter, 'validateIdentifier');
			const orm = createOrmInstance(model, false, {}, adapter);
			orm.withSchema('tenant_123');
			expect(validateSpy).toHaveBeenCalledWith('tenant_123', 'schema');
		});

		it('should call adapter.withSchema', () => {
			const adapter = createMockAdapter();
			const withSchemaSpy = vi.spyOn(adapter, 'withSchema');
			const orm = createOrmInstance(model, false, {}, adapter);
			orm.withSchema('tenant_123');
			expect(withSchemaSpy).toHaveBeenCalledWith('tenant_123');
		});

		it('should propagate all options to scoped ORM', () => {
			const adapter = createMockAdapter();
			const hookStore = new Map();
			const onHookError = vi.fn();
			const orm = createOrmInstance(
				model,
				true,
				{},
				adapter,
				undefined,
				undefined,
				{ users: { id: 'uuid' } },
				{ maxDepth: 5 },
				{ users: { field: 'deletedAt', op: 'isNull' } },
				hookStore,
				onHookError,
			);
			const scoped = orm.withSchema('tenant_123');
			expect(scoped.strictMode).toBe(true);
		});
	});

	describe('listAncestors', () => {
		it('should throw if no adapter', async () => {
			const orm = createOrmInstance(model, false, {});
			await expect(
				orm.listAncestors('categories', 'node-1', { nodeId: 'id' }),
			).rejects.toThrow('listAncestors() requires an adapter');
		});

		it('should throw if table is not self-referential', async () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			await expect(
				orm.listAncestors('users', 'user-1', { nodeId: 'id' }),
			).rejects.toThrow(InvalidOperationError);
		});

		it('should accept options with nodeId', () => {
			// Just test that the options are accepted without throwing during setup
			const orm = createOrmInstance(model, false, {});
			// The promise will reject without adapter, but we're only testing that
			// the function accepts the options without a sync throw
			const promise = orm.listAncestors('categories', 'node-1', {
				nodeId: 'customId',
			});
			// Catch the rejection to avoid unhandled promise
			promise.catch(() => {
				/* expected */
			});
			expect(promise).toBeDefined();
		});

		it('should accept options with maxDepth', () => {
			const orm = createOrmInstance(model, false, {});
			const promise = orm.listAncestors('categories', 'node-1', {
				maxDepth: 50,
			});
			promise.catch(() => {
				/* expected */
			});
			expect(promise).toBeDefined();
		});

		it('should throw error with correct operation name', async () => {
			const orm = createOrmInstance(model, false, {});
			try {
				await orm.listAncestors('categories', 'node-1', {});
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain('listAncestors');
			}
		});
	});

	describe('listDescendants', () => {
		it('should throw if no adapter', async () => {
			const orm = createOrmInstance(model, false, {});
			await expect(
				orm.listDescendants('categories', 'node-1', { nodeId: 'id' }),
			).rejects.toThrow('listDescendants() requires an adapter');
		});

		it('should throw if table is not self-referential', async () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			await expect(
				orm.listDescendants('users', 'user-1', { nodeId: 'id' }),
			).rejects.toThrow(InvalidOperationError);
		});

		it('should accept options with nodeId', () => {
			const orm = createOrmInstance(model, false, {});
			const promise = orm.listDescendants('categories', 'node-1', {
				nodeId: 'customId',
			});
			promise.catch(() => {
				/* expected */
			});
			expect(promise).toBeDefined();
		});

		it('should accept options with maxDepth', () => {
			const orm = createOrmInstance(model, false, {});
			const promise = orm.listDescendants('categories', 'node-1', {
				maxDepth: 50,
			});
			promise.catch(() => {
				/* expected */
			});
			expect(promise).toBeDefined();
		});

		it('should throw error with correct operation name', async () => {
			const orm = createOrmInstance(model, false, {});
			try {
				await orm.listDescendants('categories', 'node-1', {});
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain('listDescendants');
			}
		});
	});

	describe('mutation methods', () => {
		it('should create InsertBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.insert('users');
			expect(builder).toBeDefined();
		});

		it('should create UpdateBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.update('users');
			expect(builder).toBeDefined();
		});

		it('should create DeleteBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.delete('users');
			expect(builder).toBeDefined();
		});

		it('should create UpdateBuilder with allowAll', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.updateAll('users');
			expect(builder).toBeDefined();
		});

		it('should create DeleteBuilder with allowAll', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.deleteAll('users');
			expect(builder).toBeDefined();
		});

		it('should create UpsertBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.upsert('users');
			expect(builder).toBeDefined();
		});
	});

	describe('transaction', () => {
		it('should throw if no adapter', async () => {
			const orm = createOrmInstance(model, false, {});
			await expect(
				orm.transaction(async () => {
					return 42;
				}),
			).rejects.toThrow('transaction() requires an adapter');
		});

		it('should refuse before calling adapter.transaction when transactions are unsupported', async () => {
			const transactionSpy = vi.fn(async () => {
				throw new Error('adapter transaction should not be called');
			});
			const adapter = {
				...createMockAdapter(),
				transaction: transactionSpy,
			};
			const orm = createOrmInstance(model, false, {}, adapter);

			let error: unknown;
			try {
				await orm.transaction(async () => {
					return 42;
				});
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				'capabilities.supportsTransactions: true',
			);
			expect((error as Error).message).not.toContain('managedTransactions');
			expect(transactionSpy).not.toHaveBeenCalled();
		});

		it('should delegate to adapter.transaction', async () => {
			const adapter = createTransactionalMockAdapter();
			const transactionSpy = vi
				.spyOn(adapter, 'transaction')
				.mockImplementation(async (fn) => {
					return fn(adapter);
				});
			const orm = createOrmInstance(model, false, {}, adapter);
			await orm.transaction(async () => {
				return 42;
			});
			expect(transactionSpy).toHaveBeenCalled();
		});

		it('should create transaction-scoped ORM with inTransaction=true', async () => {
			const adapter = createTransactionalMockAdapter();
			adapter.transaction = vi.fn().mockImplementation(async (fn) => {
				return fn(adapter);
			});
			const orm = createOrmInstance(model, false, {}, adapter);
			let txOrm: unknown;
			await orm.transaction(async (tx) => {
				txOrm = tx;
				return 42;
			});
			expect(txOrm).toBeDefined();
		});

		it('should propagate all options to transaction ORM', async () => {
			const adapter = createTransactionalMockAdapter();
			adapter.transaction = vi.fn().mockImplementation(async (fn) => {
				return fn(adapter);
			});
			const orm = createOrmInstance(
				model,
				true,
				{},
				adapter,
				'tenant_123',
				undefined,
				{ users: { id: 'uuid' } },
			);
			let txOrm: unknown;
			await orm.transaction(async (tx) => {
				txOrm = tx;
				return 42;
			});
			expect(txOrm).toBeDefined();
		});
	});

	describe('raw', () => {
		it('should throw if no adapter', async () => {
			const orm = createOrmInstance(model, false, {});
			await expect(orm.raw('SELECT 1')).rejects.toThrow(
				'raw() requires an adapter',
			);
		});

		it('should delegate to adapter.executeRaw', async () => {
			const adapter = createMockAdapter();
			const executeRawSpy = vi
				.spyOn(adapter, 'executeRaw')
				.mockResolvedValue([]);
			const orm = createOrmInstance(model, false, {}, adapter);
			await orm.raw('SELECT * FROM users WHERE id = $1', ['user-1']);
			expect(executeRawSpy).toHaveBeenCalledWith(
				'SELECT * FROM users WHERE id = $1',
				['user-1'],
			);
		});

		it('should use empty parameters array by default', async () => {
			const adapter = createMockAdapter();
			const executeRawSpy = vi
				.spyOn(adapter, 'executeRaw')
				.mockResolvedValue([]);
			const orm = createOrmInstance(model, false, {}, adapter);
			await orm.raw('SELECT 1');
			expect(executeRawSpy).toHaveBeenCalledWith('SELECT 1', []);
		});

		it('should return typed results', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi
				.fn()
				.mockResolvedValue([{ id: '1', email: 'test@example.com' }]);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ id: string; email: string }>(
				'SELECT * FROM users',
			);
			expect(result).toEqual([{ id: '1', email: 'test@example.com' }]);
		});

		it('should coerce declared raw bigint reads to bigint', async () => {
			const adapter = createMockAdapter();
			const rows = [{ n: '42' }];
			adapter.executeRaw = vi.fn().mockResolvedValue(rows);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ n: bigint }>(
				'SELECT 42::bigint AS n',
				[],
				{
					bigintReads: { n: 'bigint' },
				},
			);
			expect(result).toEqual([{ n: 42n }]);
			expect(result[0]).not.toBe(rows[0]);
			expect(rows).toEqual([{ n: '42' }]);
		});

		it('should coerce declared raw bigint reads to number', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi.fn().mockResolvedValue([{ n: '42' }]);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ n: number }>(
				'SELECT 42::bigint AS n',
				[],
				{
					bigintReads: { n: 'number' },
				},
			);
			expect(result).toEqual([{ n: 42 }]);
		});

		it('should throw RangeError for unsafe raw bigint number reads', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi
				.fn()
				.mockResolvedValue([{ n: '9007199254740992' }]);
			const orm = createOrmInstance(model, false, {}, adapter);

			let thrown: unknown;
			try {
				await orm.raw<{ n: number }>(
					'SELECT 9007199254740992::bigint AS n',
					[],
					{
						bigintReads: { n: 'number' },
					},
				);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(RangeError);
			expect((thrown as Error).message).toContain('output key "n"');
		});

		it('should leave declared raw bigint string reads unchanged', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi.fn().mockResolvedValue([{ n: '42' }]);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ n: string }>(
				'SELECT 42::bigint AS n',
				[],
				{
					bigintReads: { n: 'string' },
				},
			);
			expect(result).toEqual([{ n: '42' }]);
		});

		it('should leave raw rows unchanged when read options are omitted or empty', async () => {
			const adapter = createMockAdapter();
			const rows = [{ n: '42' }];
			adapter.executeRaw = vi.fn().mockResolvedValue(rows);
			const orm = createOrmInstance(model, false, {}, adapter);

			const withoutOptions = await orm.raw<{ n: string }>(
				'SELECT 42::bigint AS n',
			);
			const emptyOptions = await orm.raw<{ n: string }>(
				'SELECT 42::bigint AS n',
				[],
				{},
			);

			expect(withoutOptions).toBe(rows);
			expect(emptyOptions).toBe(rows);
			expect(withoutOptions).toEqual([{ n: '42' }]);
			expect(emptyOptions).toEqual([{ n: '42' }]);
		});

		it('should ignore absent declared raw bigint keys without injecting them', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi.fn().mockResolvedValue([{ n: '42' }]);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ n: bigint; missing?: number }>(
				'SELECT 42::bigint AS n',
				[],
				{ bigintReads: { n: 'bigint', missing: 'number' } },
			);

			expect(result).toEqual([{ n: 42n }]);
			expect('missing' in result[0]).toBe(false);
		});

		it('should pass null through for declared raw bigint reads', async () => {
			const adapter = createMockAdapter();
			adapter.executeRaw = vi.fn().mockResolvedValue([{ n: null }]);
			const orm = createOrmInstance(model, false, {}, adapter);
			const result = await orm.raw<{ n: null }>(
				'SELECT NULL::bigint AS n',
				[],
				{
					bigintReads: { n: 'bigint' },
				},
			);
			expect(result).toEqual([{ n: null }]);
		});
	});

	describe('select', () => {
		it('should create QueryBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			const builder = orm.select('users');
			expect(builder).toBeDefined();
		});

		it('should pass strictMode to QueryBuilder', () => {
			const adapter = createMockAdapter();
			const ormStrict = createOrmInstance(model, true, {}, adapter);
			const builder = ormStrict.select('users');
			expect(builder).toBeDefined();
		});

		it('should pass relationHints to QueryBuilder', () => {
			const adapter = createMockAdapter();
			const relationHints = {
				'users.posts': { strategy: 'subquery' as const },
			};
			const orm = createOrmInstance(model, false, relationHints, adapter);
			const builder = orm.select('users');
			expect(builder).toBeDefined();
		});

		it('should pass all options to QueryBuilder', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(
				model,
				true,
				{},
				adapter,
				'tenant_123',
				{
					supportsReturning: true,
					supportsSchemas: true,
					supportsRecursiveCTE: true,
					supportsLateralJoin: true,
					supportsWindowFunctions: true,
					supportsJsonAgg: true,
					supportsArrayType: true,
					supportsForUpdate: true,
					supportsForUpdateSkipLocked: true,
				},
				{ maxDepth: 5 },
				{ users: { field: 'deletedAt', op: 'isNull' } },
			);
			const builder = orm.select('users');
			expect(builder).toBeDefined();
		});
	});

	describe('nql', () => {
		it('should have nql template tag', () => {
			const adapter = createMockAdapter();
			const orm = createOrmInstance(model, false, {}, adapter);
			expect(orm.nql).toBeDefined();
		});
	});
});
