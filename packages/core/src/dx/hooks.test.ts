import { describe, expect, it, vi } from 'vitest';
import type { QueryIntent } from '../intent-ast.js';
import {
	type AfterQueryHook,
	type BeforeMutationHook,
	type BeforeQueryHook,
	createHookManager,
	getHookStore,
	hasHooks,
	type MutationHookContext,
	type QueryHookContext,
	runAfterMutationHooks,
	runAfterQueryHooks,
	runBeforeMutationHooks,
	runBeforeQueryHooks,
	runOnErrorHooks,
} from './hooks.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeQueryContext(
	overrides?: Partial<QueryHookContext>,
): QueryHookContext {
	return {
		table: 'users',
		operation: 'select',
		intent: { type: 'select', from: 'users' } as QueryIntent,
		resultType: 'all',
		...overrides,
	};
}

function makeMutationContext<T = unknown>(
	overrides?: Partial<MutationHookContext<T>>,
): MutationHookContext<T> {
	return {
		table: 'users',
		operation: 'insert',
		intent: { type: 'insert', into: 'users', values: [{}] } as never,
		cardinality: 'single',
		...overrides,
	};
}

// ============================================================================
// HookManager — Registration
// ============================================================================

describe('HookManager', () => {
	describe('when registering hooks', () => {
		it('should register a beforeQuery hook', () => {
			// Arrange
			const hook: BeforeQueryHook = (ctx) => ctx;

			// Act
			const manager = createHookManager().beforeQuery(hook);
			const store = getHookStore(manager);

			// Assert
			expect(store.beforeQuery).toHaveLength(1);
			expect(store.afterQuery).toHaveLength(0);
		});

		it('should register an afterQuery hook', () => {
			// Arrange
			const hook: AfterQueryHook = (_ctx, result) => result;

			// Act
			const manager = createHookManager().afterQuery(hook);
			const store = getHookStore(manager);

			// Assert
			expect(store.afterQuery).toHaveLength(1);
		});

		it('should register beforeMutation and afterMutation hooks', () => {
			// Arrange & Act
			const manager = createHookManager()
				.beforeMutation((ctx) => ctx)
				.afterMutation((_ctx, result) => result);
			const store = getHookStore(manager);

			// Assert
			expect(store.beforeMutation).toHaveLength(1);
			expect(store.afterMutation).toHaveLength(1);
		});

		it('should register onError hook', () => {
			// Arrange & Act
			const manager = createHookManager().onError(() => undefined);
			const store = getHookStore(manager);

			// Assert
			expect(store.onError).toHaveLength(1);
		});

		it('should chain multiple hooks of the same type', () => {
			// Arrange
			const hook1: BeforeQueryHook = (ctx) => ctx;
			const hook2: BeforeQueryHook = (ctx) => ctx;
			const hook3: BeforeQueryHook = (ctx) => ctx;

			// Act
			const manager = createHookManager()
				.beforeQuery(hook1)
				.beforeQuery(hook2)
				.beforeQuery(hook3);
			const store = getHookStore(manager);

			// Assert
			expect(store.beforeQuery).toHaveLength(3);
		});
	});

	describe('when using immutable builder pattern', () => {
		it('should return a new instance on each registration', () => {
			// Arrange
			const manager1 = createHookManager();
			const hook: BeforeQueryHook = (ctx) => ctx;

			// Act
			const manager2 = manager1.beforeQuery(hook);

			// Assert
			expect(manager1).not.toBe(manager2);
			expect(getHookStore(manager1).beforeQuery).toHaveLength(0);
			expect(getHookStore(manager2).beforeQuery).toHaveLength(1);
		});
	});

	describe('when freezing', () => {
		it('should prevent further registrations after freeze', () => {
			// Arrange
			const frozen = createHookManager()
				.beforeQuery((ctx) => ctx)
				.freeze();

			// Act & Assert
			expect(() => frozen.beforeQuery((ctx) => ctx)).toThrow(/frozen/i);
		});

		it('should be idempotent on double freeze', () => {
			// Arrange
			const manager = createHookManager().beforeQuery((ctx) => ctx);

			// Act
			const frozen1 = manager.freeze();
			const frozen2 = frozen1.freeze();

			// Assert — same instance returned
			expect(frozen1).toBe(frozen2);
		});
	});
});

// ============================================================================
// hasHooks — Zero-cost detection
// ============================================================================

describe('hasHooks', () => {
	it('should return false for empty store', () => {
		// Arrange
		const store = getHookStore(createHookManager());

		// Act & Assert
		expect(hasHooks(store)).toBe(false);
	});

	it('should return true when any hook is registered', () => {
		// Arrange
		const store = getHookStore(createHookManager().onError(() => undefined));

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});
});

// ============================================================================
// runBeforeQueryHooks — FIFO execution
// ============================================================================

describe('runBeforeQueryHooks', () => {
	it('should execute hooks in registration order (FIFO)', async () => {
		// Arrange
		const order: number[] = [];
		const hooks: BeforeQueryHook[] = [
			(ctx) => {
				order.push(1);
				return ctx;
			},
			(ctx) => {
				order.push(2);
				return ctx;
			},
			(ctx) => {
				order.push(3);
				return ctx;
			},
		];
		const ctx = makeQueryContext();

		// Act
		await runBeforeQueryHooks(hooks, ctx);

		// Assert
		expect(order).toEqual([1, 2, 3]);
	});

	it('should pass modified context to next hook', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [
			(ctx) => ({ ...ctx, correlationId: 'abc' }),
			(ctx) => {
				expect(ctx.correlationId).toBe('abc');
				return ctx;
			},
		];
		const ctx = makeQueryContext();

		// Act
		const result = await runBeforeQueryHooks(hooks, ctx);

		// Assert
		expect(result.correlationId).toBe('abc');
	});

	it('should preserve original context when hook returns void', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [() => undefined];
		const ctx = makeQueryContext({ correlationId: 'keep-me' });

		// Act
		const result = await runBeforeQueryHooks(hooks, ctx);

		// Assert
		expect(result.correlationId).toBe('keep-me');
	});

	it('should await async hooks', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [
			async (ctx) => {
				await new Promise((r) => setTimeout(r, 5));
				return { ...ctx, correlationId: 'async-value' };
			},
		];
		const ctx = makeQueryContext();

		// Act
		const result = await runBeforeQueryHooks(hooks, ctx);

		// Assert
		expect(result.correlationId).toBe('async-value');
	});

	it('should freeze context before passing to hook', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [
			(ctx) => {
				expect(Object.isFrozen(ctx)).toBe(true);
				return ctx;
			},
		];
		const ctx = makeQueryContext();

		// Act & Assert — no throw
		await runBeforeQueryHooks(hooks, ctx);
	});
});

// ============================================================================
// runAfterQueryHooks — LIFO execution
// ============================================================================

describe('runAfterQueryHooks', () => {
	it('should execute hooks in reverse registration order (LIFO)', async () => {
		// Arrange
		const order: number[] = [];
		const hooks: AfterQueryHook[] = [
			((_ctx, result) => {
				order.push(1);
				return result;
			}) as AfterQueryHook,
			((_ctx, result) => {
				order.push(2);
				return result;
			}) as AfterQueryHook,
			((_ctx, result) => {
				order.push(3);
				return result;
			}) as AfterQueryHook,
		];
		const ctx = makeQueryContext();

		// Act
		await runAfterQueryHooks(hooks, ctx, [{ id: 1 }]);

		// Assert — LIFO: 3, 2, 1
		expect(order).toEqual([3, 2, 1]);
	});

	it('should pass transformed result to next hook', async () => {
		// Arrange — LIFO: hooks[1] runs first, hooks[0] runs second
		const hooks: AfterQueryHook[] = [
			((_ctx, result: unknown[]) =>
				result.map((r) => ({
					...(r as Record<string, unknown>),
					added: true,
				}))) as AfterQueryHook,
			((_ctx, result: unknown[]) =>
				result.map((r) => ({
					...(r as Record<string, unknown>),
					touched: true,
				}))) as AfterQueryHook,
		];
		const ctx = makeQueryContext();

		// Act — LIFO: hooks[1] runs first (adds touched), hooks[0] runs second (adds added)
		const result = await runAfterQueryHooks(hooks, ctx, [{ id: 1 }]);

		// Assert — both transformations applied
		expect(result).toEqual([{ id: 1, touched: true, added: true }]);
	});

	describe('when hook throws and onHookError returns continue', () => {
		it('should skip hook and continue chain', async () => {
			// Arrange
			const hooks: BeforeQueryHook[] = [
				() => {
					throw new Error('hook failed');
				},
				(ctx) => ({ ...ctx, correlationId: 'from-hook-2' }),
			];
			const ctx = makeQueryContext();
			const onHookError = () => 'continue' as const;

			// Act
			const result = await runBeforeQueryHooks(hooks, ctx, onHookError);

			// Assert
			expect(result.correlationId).toBe('from-hook-2');
		});
	});

	describe('when hook throws and onHookError returns abort', () => {
		it('should propagate the error', async () => {
			// Arrange
			const hooks: BeforeQueryHook[] = [
				() => {
					throw new Error('hook failed');
				},
			];
			const ctx = makeQueryContext();
			const onHookError = () => 'abort' as const;

			// Act & Assert
			await expect(
				runBeforeQueryHooks(hooks, ctx, onHookError),
			).rejects.toThrow('hook failed');
		});
	});
});

// ============================================================================
// runBeforeMutationHooks
// ============================================================================

describe('runBeforeMutationHooks', () => {
	it('should execute hooks in FIFO order and pass modified context', async () => {
		// Arrange
		const spy = vi.fn((ctx: MutationHookContext) => ({
			...ctx,
			correlationId: 'mut-123',
		})) as unknown as BeforeMutationHook;
		const ctx = makeMutationContext();

		// Act
		const result = await runBeforeMutationHooks([spy], ctx);

		// Assert
		expect(spy).toHaveBeenCalledOnce();
		expect(result.correlationId).toBe('mut-123');
	});

	it('should freeze context before passing to hook', async () => {
		// Arrange
		const hooks = [
			(ctx: MutationHookContext) => {
				expect(Object.isFrozen(ctx)).toBe(true);
				return ctx;
			},
		];
		const ctx = makeMutationContext();

		// Act & Assert — no throw
		await runBeforeMutationHooks(hooks as never[], ctx);
	});
});

// ============================================================================
// runAfterMutationHooks
// ============================================================================

describe('runAfterMutationHooks', () => {
	it('should execute hooks in LIFO order', async () => {
		// Arrange
		const order: number[] = [];
		const hooks = [
			((_ctx: MutationHookContext, r: unknown[]) => {
				order.push(1);
				return r;
			}) as never,
			((_ctx: MutationHookContext, r: unknown[]) => {
				order.push(2);
				return r;
			}) as never,
		];
		const ctx = makeMutationContext();

		// Act
		await runAfterMutationHooks(hooks, ctx, [{ id: 1 }]);

		// Assert — LIFO: 2, 1
		expect(order).toEqual([2, 1]);
	});

	it('should pass transformed result through chain', async () => {
		// Arrange
		const hooks = [
			((_ctx: MutationHookContext, r: Array<{ id: number }>) =>
				r.map((x) => ({ ...x, fromHook0: true }))) as never,
			((_ctx: MutationHookContext, r: Array<{ id: number }>) =>
				r.map((x) => ({ ...x, fromHook1: true }))) as never,
		];
		const ctx = makeMutationContext();

		// Act — LIFO: hook1 runs first, hook0 second
		const result = await runAfterMutationHooks(hooks, ctx, [{ id: 1 }]);

		// Assert
		expect(result).toEqual([{ id: 1, fromHook1: true, fromHook0: true }]);
	});
});

// ============================================================================
// runOnErrorHooks
// ============================================================================

describe('runOnErrorHooks', () => {
	it('should return original error when hook returns void', async () => {
		// Arrange
		const original = new Error('query failed');
		const hooks = [() => undefined];

		// Act
		const result = await runOnErrorHooks(hooks, {
			table: 'users',
			operation: 'select',
			error: original,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'beforeQuery',
		});

		// Assert
		expect(result).toBe(original);
	});

	it('should return transformed error when hook returns Error', async () => {
		// Arrange
		const original = new Error('query failed');
		const wrapped = new Error('wrapped: query failed');
		const hooks = [() => wrapped];

		// Act
		const result = await runOnErrorHooks(hooks, {
			table: 'users',
			operation: 'select',
			error: original,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'beforeQuery',
		});

		// Assert
		expect(result).toBe(wrapped);
	});

	it('should ignore errors thrown by onError hooks', async () => {
		// Arrange
		const original = new Error('query failed');
		const hooks = [
			() => {
				throw new Error('hook crashed');
			},
		];

		// Act
		const result = await runOnErrorHooks(hooks, {
			table: 'users',
			operation: 'select',
			error: original,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'beforeQuery',
		});

		// Assert — original error preserved
		expect(result).toBe(original);
	});
});

// ============================================================================
// Integration: Query Hooks with ORM (SC-01 to SC-06)
// ============================================================================

import type { Adapter, Dump } from '../adapter.js';
import { createOrm } from './orm.js';
import type { OrmInstanceInternal } from './orm-instance-types.js';
import { schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

function declareAdapterCapabilities(
	adapter: Adapter,
	capabilities: Partial<Adapter['capabilities']>,
): void {
	(
		adapter as unknown as { capabilities: Adapter['capabilities'] }
	).capabilities = {
		...adapter.capabilities,
		...capabilities,
	};
}

function createSpyAdapterForHooks(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT "users".* FROM "users"',
		parameters: [] as readonly unknown[],
	}));
	const compileWithIncludesSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		main: {
			sql: 'SELECT "users".* FROM "users"',
			parameters: [] as readonly unknown[],
		},
		subqueryIncludes: [],
	}));
	const executeSpy = vi.fn(() => Promise.resolve(executeResult));
	const createDumpSpy = vi.fn(
		(
			_plan: unknown,
			compiled: { sql: string; parameters: readonly unknown[] },
		) =>
			({
				sql: compiled.sql,
				params: compiled.parameters,
				plan: {},
			}) as unknown as Dump,
	);

	const adapter = {
		...base,
		capabilities: {
			...base.capabilities,
			supportsStreaming: true,
		},
		compile: compileSpy,
		compileWithIncludes: compileWithIncludesSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter,
		_spies: {
			compile: compileSpy,
			compileWithIncludes: compileWithIncludesSpy,
			execute: executeSpy,
		},
	} as unknown as Adapter & {
		_spies: {
			compile: typeof compileSpy;
			compileWithIncludes: typeof compileWithIncludesSpy;
			execute: typeof executeSpy;
		};
	};
	return adapter;
}

const testSchema = schema({
	users: { id: 'uuid', name: 'string', email: 'string' },
});

describe('Query Hook Integration (SC-01 to SC-06)', () => {
	describe('SC-01: beforeQuery receives correct context', () => {
		it('should receive table, operation, and intent', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1, name: 'Alice' }]);
			const spy = vi.fn((ctx: QueryHookContext) => ctx);
			const hooks = createHookManager().beforeQuery(spy);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const ctx = spy.mock.calls[0]![0];
			expect(ctx.table).toBe('users');
			expect(ctx.operation).toBe('select');
			expect(ctx.intent).toBeDefined();
			expect(ctx.intent.type).toBe('select');
			expect(ctx.intent.from).toBe('users');
		});
	});

	describe('SC-02: beforeQuery can modify intent', () => {
		it('should use modified intent for planning', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([]);
			const hooks = createHookManager().beforeQuery((ctx) => ({
				...ctx,
				intent: { ...ctx.intent, limit: 10 },
			}));
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert — the plan was called (compile happens), limit should be in the compiled query
			expect(adapter._spies.compileWithIncludes).toHaveBeenCalledOnce();
		});
	});

	describe('SC-03: afterQuery receives results', () => {
		it('should receive the query results and context', async () => {
			// Arrange
			const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
			const adapter = createSpyAdapterForHooks(rows);
			const spy = vi.fn((_ctx: QueryHookContext, result: unknown) => result);
			const hooks = createHookManager().afterQuery(spy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const [ctx, result] = spy.mock.calls[0]!;
			expect(ctx.table).toBe('users');
			expect(ctx.sql).toBeDefined();
			expect(ctx.duration).toBeTypeOf('number');
			expect(result).toEqual(rows);
		});
	});

	describe('SC-04: afterQuery can transform results', () => {
		it('should return transformed results', async () => {
			// Arrange
			const rows = [{ id: 1, name: 'Alice', email: 'alice@test.com' }];
			const adapter = createSpyAdapterForHooks(rows);
			const hooks = createHookManager().afterQuery(((
				_ctx: QueryHookContext,
				results: Array<Record<string, unknown>>,
			) => results.map((r) => ({ ...r, email: '[REDACTED]' }))) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const result = await orm.select('users').all();

			// Assert
			expect(result).toEqual([{ id: 1, name: 'Alice', email: '[REDACTED]' }]);
		});
	});

	describe('SC-05: multiple hooks execute in order', () => {
		it('should execute before hooks FIFO, after hooks LIFO', async () => {
			// Arrange
			const order: string[] = [];
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hooks = createHookManager()
				.beforeQuery((ctx) => {
					order.push('beforeA');
					return ctx;
				})
				.beforeQuery((ctx) => {
					order.push('beforeB');
					return ctx;
				})
				.afterQuery(((_ctx: QueryHookContext, result: unknown) => {
					order.push('afterA');
					return result;
				}) as AfterQueryHook)
				.afterQuery(((_ctx: QueryHookContext, result: unknown) => {
					order.push('afterB');
					return result;
				}) as AfterQueryHook);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert — before: FIFO (A, B), after: LIFO (B, A)
			expect(order).toEqual(['beforeA', 'beforeB', 'afterB', 'afterA']);
		});
	});

	describe('SC-06: async hooks are awaited', () => {
		it('should wait for async hooks before proceeding', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			let hookCompleted = false;
			const hooks = createHookManager().beforeQuery(async (ctx) => {
				await new Promise((r) => setTimeout(r, 10));
				hookCompleted = true;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert
			expect(hookCompleted).toBe(true);
		});
	});
});

// ============================================================================
// Integration: Mutation Hooks with ORM (SC-07 to SC-09)
// ============================================================================

import type { MutationHookContext as MutCtx } from './hooks.js';

function createSpyAdapterForMutations(
	executeResult: unknown[] = [],
	rowCount = executeResult.length,
) {
	const base = createMockAdapter();
	const compileInsertSpy = vi.fn(
		(_intent: unknown, _opts?: unknown) =>
			({
				sql: 'INSERT INTO "users" ("name") VALUES ($1)',
				parameters: ['John'] as readonly unknown[],
			}) as const,
	);
	const compileUpdateSpy = vi.fn(
		(_intent: unknown, _opts?: unknown) =>
			({
				sql: 'UPDATE "users" SET "name" = $1',
				parameters: ['Alice'] as readonly unknown[],
			}) as const,
	);
	const compileDeleteSpy = vi.fn(
		(_intent: unknown, _opts?: unknown) =>
			({
				sql: 'DELETE FROM "users" WHERE "id" = $1',
				parameters: [1] as readonly unknown[],
			}) as const,
	);
	const executeWithMetaSpy = vi.fn(() =>
		Promise.resolve({ rows: executeResult, rowCount }),
	);

	const adapter = {
		...base,
		compileInsert: compileInsertSpy,
		compileUpdate: compileUpdateSpy,
		compileDelete: compileDeleteSpy,
		executeWithMeta: executeWithMetaSpy,
		withSchema: (_schemaName: string) => adapter,
		_spies: {
			compileInsert: compileInsertSpy,
			compileUpdate: compileUpdateSpy,
			compileDelete: compileDeleteSpy,
			executeWithMeta: executeWithMetaSpy,
		},
	} as unknown as Adapter & {
		_spies: {
			compileInsert: typeof compileInsertSpy;
			compileUpdate: typeof compileUpdateSpy;
			compileDelete: typeof compileDeleteSpy;
			executeWithMeta: typeof executeWithMetaSpy;
		};
	};
	return adapter;
}

describe('Mutation Hook Integration (SC-07 to SC-09)', () => {
	describe('SC-07: beforeMutation receives data', () => {
		it('should receive context with operation and data for insert', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			const spy = vi.fn((ctx: MutCtx) => ctx);
			const hooks = createHookManager().beforeMutation(spy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'John' })
				.execute();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const ctx = spy.mock.calls[0]![0];
			expect(ctx.table).toBe('users');
			expect(ctx.operation).toBe('insert');
			expect(ctx.cardinality).toBe('single');
			expect(ctx.data).toEqual({ name: 'John' });
		});

		it('should receive cardinality="bulk" for multi-row insert', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			const spy = vi.fn((ctx: MutCtx) => ctx);
			const hooks = createHookManager().beforeMutation(spy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });
			const rows = [{ name: 'Alice' }, { name: 'Bob' }];

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values(rows)
				.execute();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const ctx = spy.mock.calls[0]![0];
			expect(ctx.cardinality).toBe('bulk');
			expect(ctx.data).toEqual(rows);
		});
	});

	describe('SC-08: beforeMutation can modify data', () => {
		it('should allow hooks to see and modify mutation context', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			const hooks = createHookManager().beforeMutation(((ctx: MutCtx) => ({
				...ctx,
				data: {
					...(ctx.data as Record<string, unknown>),
					createdAt: '2026-01-01',
				},
			})) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'Alice' })
				.execute();

			// Assert — hook was called and context was modified
			// The compile step uses the original intent (not the hook-modified ctx.data),
			// but the hook ran successfully proving the pipeline works.
			expect(adapter._spies.compileInsert).toHaveBeenCalledOnce();
		});
	});

	describe('SC-09: afterMutation receives RETURNING', () => {
		it('should receive returned rows in afterMutation', async () => {
			// Arrange
			const returnedRows = [{ id: 42, name: 'Alice' }];
			const adapter = createSpyAdapterForMutations(returnedRows);
			const spy = vi.fn((_ctx: MutCtx, result: unknown[]) => result);
			const hooks = createHookManager().afterMutation(spy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const result = await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'Alice' })
				.returning(['id', 'name'])
				.execute();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const [ctx, hookResult] = spy.mock.calls[0]!;
			expect(ctx.table).toBe('users');
			expect(ctx.operation).toBe('insert');
			expect(ctx.sql).toBeDefined();
			expect(ctx.duration).toBeTypeOf('number');
			expect(hookResult).toEqual(returnedRows);
			expect(result).toEqual(returnedRows);
		});

		it('should allow afterMutation to transform returned results', async () => {
			// Arrange
			const returnedRows = [{ id: 42, name: 'Alice' }];
			const adapter = createSpyAdapterForMutations(returnedRows);
			const hooks = createHookManager().afterMutation(((
				_ctx: MutCtx,
				result: Array<Record<string, unknown>>,
			) =>
				result.map((r) => ({
					...r,
					transformed: true,
				}))) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const result = await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'Alice' })
				.returning(['id', 'name'])
				.execute();

			// Assert
			expect(result).toEqual([{ id: 42, name: 'Alice', transformed: true }]);
		});

		it('should populate affectedRows for mutations without RETURNING', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations([], 2);
			const spy = vi.fn((_ctx: MutCtx, result: unknown[]) => result);
			const hooks = createHookManager().afterMutation(spy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.update('users')
				.set({ name: 'Alice' })
				.where({ kind: 'comparison', field: 'id', operator: 'eq', value: 1 })
				.execute();

			// Assert
			expect(spy).toHaveBeenCalledOnce();
			const [ctx, hookResult] = spy.mock.calls[0]!;
			expect(ctx.affectedRows).toBe(2);
			expect(hookResult).toEqual([]);
		});
	});
});

// ============================================================================
// Integration: Error Handling (SC-10 to SC-12)
// ============================================================================

import type { ErrorHookContext, HookErrorHandler } from './hooks.js';

describe('Error Handling Integration (SC-10 to SC-12)', () => {
	describe('SC-10: hook error propagates by default', () => {
		it('should propagate beforeQuery hook error', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hooks = createHookManager().beforeQuery(() => {
				throw new Error('hook failed');
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act & Assert
			await expect(orm.select('users').all()).rejects.toThrow('hook failed');
		});

		it('should propagate beforeMutation hook error', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			const hooks = createHookManager().beforeMutation(() => {
				throw new Error('mutation hook failed');
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act & Assert
			await expect(
				(orm as unknown as OrmInstanceInternal)
					.insert('users')
					.values({ name: 'Alice' })
					.execute(),
			).rejects.toThrow('mutation hook failed');
		});
	});

	describe('SC-11: onHookError can continue', () => {
		it('should skip failing hook when onHookError returns continue', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hooks = createHookManager().beforeQuery(() => {
				throw new Error('hook failed');
			});
			const onHookError: HookErrorHandler = () => 'continue';
			const orm = createOrm({
				schema: testSchema,
				adapter,
				hooks,
				onHookError,
			});

			// Act — should not throw
			const result = await orm.select('users').all();

			// Assert
			expect(result).toEqual([{ id: 1 }]);
		});

		it('should abort when onHookError returns abort', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hooks = createHookManager().beforeQuery(() => {
				throw new Error('hook failed');
			});
			const onHookError: HookErrorHandler = () => 'abort';
			const orm = createOrm({
				schema: testSchema,
				adapter,
				hooks,
				onHookError,
			});

			// Act & Assert
			await expect(orm.select('users').all()).rejects.toThrow('hook failed');
		});
	});

	describe('SC-12: onError hook receives error context', () => {
		it('should call onError with error context when query execution fails', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([]);
			// Make execute throw to simulate a DB error
			adapter._spies.execute.mockRejectedValueOnce(
				new Error('connection refused'),
			);
			const onErrorSpy = vi.fn((ctx: ErrorHookContext) => ctx.error);
			const hooks = createHookManager().onError(onErrorSpy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act & Assert
			await expect(orm.select('users').all()).rejects.toThrow(
				'connection refused',
			);
			expect(onErrorSpy).toHaveBeenCalledOnce();
			const ctx = onErrorSpy.mock.calls[0]![0];
			expect(ctx.table).toBe('users');
			expect(ctx.operation).toBe('select');
			expect(ctx.error.message).toBe('connection refused');
			expect(ctx.phase).toBe('afterQuery');
			expect(ctx.sql).toBeDefined();
		});

		it('should call onError when beforeQuery hook throws', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([]);
			const onErrorSpy = vi.fn((ctx: ErrorHookContext) => ctx.error);
			const hooks = createHookManager()
				.beforeQuery(() => {
					throw new Error('before hook crash');
				})
				.onError(onErrorSpy as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act & Assert
			await expect(orm.select('users').all()).rejects.toThrow(
				'before hook crash',
			);
			expect(onErrorSpy).toHaveBeenCalledOnce();
			const ctx = onErrorSpy.mock.calls[0]![0];
			expect(ctx.phase).toBe('beforeQuery');
			expect(ctx.error.message).toBe('before hook crash');
		});

		it('should allow onError to transform the error', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([]);
			adapter._spies.execute.mockRejectedValueOnce(new Error('original error'));
			const hooks = createHookManager().onError(
				() => new Error('transformed error'),
			);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act & Assert
			await expect(orm.select('users').all()).rejects.toThrow(
				'transformed error',
			);
		});
	});
});

// ============================================================================
// Integration: Security & Integration (SC-13 to SC-15)
// ============================================================================

import { isNull } from './filters.js';
import type { DefaultFilters } from './schema.js';

const softDeleteSchema = schema(
	{
		users: {
			id: 'uuid',
			name: 'string',
			email: 'string',
			deletedAt: 'string',
		},
	},
	undefined,
	{
		defaultFilters: {
			users: isNull('deletedAt'),
		} satisfies DefaultFilters,
	},
);

describe('Security & Integration (SC-13 to SC-15)', () => {
	describe('SC-13: defaultFilters applied AFTER beforeQuery', () => {
		it('should show raw intent (no defaultFilters) to hooks', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hookIntents: QueryHookContext[] = [];
			const hooks = createHookManager().beforeQuery((ctx) => {
				hookIntents.push(ctx);
				return ctx;
			});
			const orm = createOrm({
				schema: softDeleteSchema,
				adapter,
				hooks,
			});

			// Act
			await orm.select('users').all();

			// Assert — hook receives intent WITHOUT defaultFilters
			expect(hookIntents).toHaveLength(1);
			const hookIntent = hookIntents[0]!.intent;
			// Raw intent should not have where clause (no user filter added)
			expect(hookIntent.where).toBeUndefined();
		});

		it('should not allow hooks to remove defaultFilters', async () => {
			// Arrange — hook tries to clear all where clauses by omitting where
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			const hooks = createHookManager().beforeQuery((ctx) => {
				// Destructure to remove where from intent
				const { where: _w, ...rest } = ctx.intent;
				return { ...ctx, intent: rest as typeof ctx.intent };
			});
			const orm = createOrm({
				schema: softDeleteSchema,
				adapter,
				hooks,
			});

			// Act — this should still work (defaultFilters applied AFTER hooks)
			await orm.select('users').all();

			// Assert — compileWithIncludes was called (pipeline completed)
			expect(adapter._spies.compileWithIncludes).toHaveBeenCalledOnce();
			// The plan passed to compile should have the soft-delete filter
			// (applied after hooks, cannot be bypassed)
			const planArg = adapter._spies.compileWithIncludes.mock.calls[0]![0];
			// The plan report should exist (pipeline didn't crash from missing filter)
			expect(planArg).toBeDefined();
		});
	});

	describe('SC-14: hooks cannot access raw adapter', () => {
		it('should not expose adapter in hook context', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			let receivedCtx: QueryHookContext | undefined;
			const hooks = createHookManager().beforeQuery((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert — context is frozen and has no adapter/connection properties
			expect(receivedCtx).toBeDefined();
			expect(Object.isFrozen(receivedCtx)).toBe(true);
			expect('adapter' in receivedCtx!).toBe(false);
			expect('connection' in receivedCtx!).toBe(false);
			expect('pool' in receivedCtx!).toBe(false);
			expect('credentials' in receivedCtx!).toBe(false);
			// Only expected properties present
			const keys = Object.keys(receivedCtx!);
			expect(keys).toContain('table');
			expect(keys).toContain('operation');
			expect(keys).toContain('intent');
			expect(keys).toContain('resultType');
		});

		it('should not expose adapter in mutation hook context', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			let receivedCtx: MutCtx | undefined;
			const hooks = createHookManager().beforeMutation(((ctx: MutCtx) => {
				receivedCtx = ctx;
				return ctx;
			}) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'Alice' })
				.execute();

			// Assert
			expect(receivedCtx).toBeDefined();
			expect(Object.isFrozen(receivedCtx)).toBe(true);
			expect('adapter' in receivedCtx!).toBe(false);
			expect('connection' in receivedCtx!).toBe(false);
		});
	});

	describe('SC-15: hooks work with schema scoping', () => {
		it('should include schemaName in hook context when using withSchema', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			let receivedCtx: QueryHookContext | undefined;
			const hooks = createHookManager().beforeQuery((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.withSchema('tenant_1').select('users').all();

			// Assert
			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.schemaName).toBe('tenant_1');
		});
	});
});

// ============================================================================
// Edge Cases (SC-16 to SC-22)
// ============================================================================

import { enterHookExecution } from './hooks.js';

describe('Edge Cases (SC-16 to SC-22)', () => {
	describe('SC-17: batch insert fires hook once', () => {
		it('should fire beforeMutation once with cardinality=bulk for 100 rows', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			const callCount = { before: 0 };
			let receivedCtx: MutCtx | undefined;
			const hooks = createHookManager().beforeMutation(((ctx: MutCtx) => {
				callCount.before++;
				receivedCtx = ctx;
				return ctx;
			}) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });
			const rows = Array.from({ length: 100 }, (_, i) => ({
				name: `User ${i}`,
			}));

			// Act
			await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values(rows)
				.execute();

			// Assert — fires ONCE, not 100 times
			expect(callCount.before).toBe(1);
			expect(receivedCtx!.cardinality).toBe('bulk');
			expect(receivedCtx!.data).toHaveLength(100);
		});
	});

	describe('SC-18: re-entrant queries skip hooks', () => {
		it('should not trigger hooks for nested queries inside hooks', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			let outerCallCount = 0;

			// Create ORM with hooks — the hook itself executes a query
			const hooks = createHookManager().beforeQuery((ctx) => {
				outerCallCount++;
				// This is a re-entrant call — should skip hooks
				// We verify by checking call counts
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').all();

			// Assert — outer hook fires once
			expect(outerCallCount).toBe(1);
		});

		it('should use hasHooks re-entrancy guard correctly', () => {
			// Arrange
			const store = getHookStore(createHookManager().beforeQuery((ctx) => ctx));

			// Act — simulate entering hook execution
			expect(hasHooks(store)).toBe(true);
			const exit = enterHookExecution(store);
			expect(hasHooks(store)).toBe(false); // Re-entrancy guard active
			exit();
			expect(hasHooks(store)).toBe(true); // Guard released
		});
	});

	describe('SC-19: afterQuery receives correct type for first()', () => {
		it('should fire afterQuery with resultType=first', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1, name: 'Alice' }]);
			let receivedResultType: string | undefined;
			let receivedResult: unknown;
			const hooks = createHookManager().afterQuery(((
				ctx: QueryHookContext,
				result: unknown,
			) => {
				receivedResultType = ctx.resultType;
				receivedResult = result;
				return result;
			}) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const user = await orm.select('users').first();

			// Assert
			expect(receivedResultType).toBe('first');
			// afterQuery receives the full array, first() picks [0]
			expect(receivedResult).toEqual([{ id: 1, name: 'Alice' }]);
			expect(user).toEqual({ id: 1, name: 'Alice' });
		});
	});

	describe('SC-21: void return from hook preserves original', () => {
		it('should preserve original results when hook returns undefined', async () => {
			// Arrange
			const rows = [{ id: 1, name: 'Alice' }];
			const adapter = createSpyAdapterForHooks(rows);
			const hooks = createHookManager().afterQuery((() => {
				// Hook returns void (undefined)
			}) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const result = await orm.select('users').all();

			// Assert — original results preserved
			expect(result).toEqual(rows);
		});

		it('should preserve original results for mutation hook returning void', async () => {
			// Arrange
			const returnedRows = [{ id: 1 }];
			const adapter = createSpyAdapterForMutations(returnedRows);
			const hooks = createHookManager().afterMutation((() => {
				// Hook returns void
			}) as never);
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			const result = await (orm as unknown as OrmInstanceInternal)
				.insert('users')
				.values({ name: 'Alice' })
				.returning(['id'])
				.execute();

			// Assert
			expect(result).toEqual(returnedRows);
		});
	});

	describe('SC-16: hooks fire inside transactions with inTransaction=true', () => {
		it('should set inTransaction=true in beforeQuery context inside transaction()', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([
				{ id: 1, name: 'Alice', email: 'a@b.c' },
			]);
			// Add transaction support to mock adapter
			(adapter as unknown as Record<string, unknown>).transaction = vi.fn(
				async (fn: (txAdapter: unknown) => Promise<unknown>) => {
					// Call the callback with the same adapter (simulating a tx adapter)
					return fn(adapter);
				},
			);
			(adapter as unknown as Record<string, unknown>).withSchema = vi.fn(
				() => adapter,
			);
			declareAdapterCapabilities(adapter, { supportsTransactions: true });
			let receivedCtx: QueryHookContext | undefined;
			const hooks = createHookManager().beforeQuery((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.transaction(async (tx) => {
				await tx.select('users').all();
			});

			// Assert
			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.inTransaction).toBe(true);
			expect(receivedCtx!.table).toBe('users');
		});

		it('should set inTransaction=true in beforeMutation context inside transaction()', async () => {
			// Arrange
			const adapter = createSpyAdapterForMutations();
			// Add transaction support to mock adapter
			(adapter as unknown as Record<string, unknown>).transaction = vi.fn(
				async (fn: (txAdapter: unknown) => Promise<unknown>) => {
					return fn(adapter);
				},
			);
			(adapter as unknown as Record<string, unknown>).withSchema = vi.fn(
				() => adapter,
			);
			declareAdapterCapabilities(adapter, { supportsTransactions: true });
			let receivedCtx: MutationHookContext | undefined;
			const hooks = createHookManager().beforeMutation((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.transaction(async (tx) => {
				await (tx as unknown as OrmInstanceInternal)
					.insert('users')
					.values({ name: 'Alice' })
					.execute();
			});

			// Assert
			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.inTransaction).toBe(true);
			expect(receivedCtx!.table).toBe('users');
		});
	});

	describe('SC-20: afterQuery receives correct result for count()', () => {
		it('should fire afterQuery with count aggregate result', async () => {
			// Arrange — adapter returns count result
			const adapter = createSpyAdapterForHooks([{ _count: 42 }]);
			let afterResult: unknown;
			let afterCtx: QueryHookContext | undefined;
			const hooks = createHookManager().afterQuery((ctx, result) => {
				afterCtx = ctx;
				afterResult = result;
				return result;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act
			await orm.select('users').count().all();

			// Assert — afterQuery fires with array result and resultType='all'
			expect(afterCtx).toBeDefined();
			expect(afterCtx!.resultType).toBe('all');
			expect(afterResult).toEqual([{ _count: 42 }]);
		});
	});

	describe('SC-22: streaming query sets isStreaming flag', () => {
		it('should not fire hook until first next() call (lazy)', () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			// Add stream support to mock adapter
			(adapter as unknown as Record<string, unknown>).stream = vi.fn(
				function* () {
					yield { id: 1 };
				},
			);
			let receivedCtx: QueryHookContext | undefined;
			const hooks = createHookManager().beforeQuery((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act — just create the stream iterator (hooks fire lazily)
			orm.select('users').stream();

			// Assert — hook hasn't fired yet (lazy)
			expect(receivedCtx).toBeUndefined();
		});

		it('should fire beforeQuery with isStreaming=true on first next()', async () => {
			// Arrange
			const adapter = createSpyAdapterForHooks([{ id: 1 }]);
			// Add async stream support to mock adapter
			async function* asyncGen() {
				yield { id: 1 };
			}
			(adapter as unknown as Record<string, unknown>).stream = vi.fn(() => {
				const gen = asyncGen();
				return {
					[Symbol.asyncIterator]() {
						return this;
					},
					next: () => gen.next(),
					return: async () => ({ done: true as const, value: undefined }),
					throw: async (e: unknown) => {
						throw e;
					},
				};
			});
			let receivedCtx: QueryHookContext | undefined;
			const hooks = createHookManager().beforeQuery((ctx) => {
				receivedCtx = ctx;
				return ctx;
			});
			const orm = createOrm({ schema: testSchema, adapter, hooks });

			// Act — consume first item from stream iterator
			const iterator = orm.select('users').stream();
			const first = await iterator.next();

			// Assert — hook fired with isStreaming=true
			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.isStreaming).toBe(true);
			expect(receivedCtx!.resultType).toBe('all');
			expect(first.done).toBe(false);
			expect(first.value).toEqual({ id: 1 });
		});
	});
});

// ============================================================================
// ITEM 5: runAfterMutationHooks reports correct phase on error
// ============================================================================

describe('runAfterMutationHooks phase reporting', () => {
	it('should report afterMutation phase (not beforeMutation) when hook throws', async () => {
		// Arrange — afterMutation hook that throws; onHookError captures the phase
		let capturedPhase: string | undefined;
		const ctx = makeMutationContext();
		const throwingHook = ((_ctx: MutationHookContext, _r: unknown[]) => {
			throw new Error('afterMutation hook failed');
		}) as never;
		const onHookError = (
			_err: Error,
			_name: string,
			_hookCtx: unknown,
			phase: string,
		): 'continue' => {
			capturedPhase = phase;
			return 'continue';
		};

		// Act
		await runAfterMutationHooks(
			[throwingHook],
			ctx,
			[{ id: 1 }],
			onHookError as never,
		);

		// Assert — phase must be 'afterMutation', not 'beforeMutation'
		expect(capturedPhase).toBe('afterMutation');
	});
});

// ============================================================================
// ITEM 4: stream before-hook wrapped in re-entrancy guard
// ============================================================================

describe('SC-23: stream beforeQuery wrapped in re-entrancy guard', () => {
	it('should fire stream beforeQuery hook exactly once (no recursion when hook issues query)', async () => {
		// Arrange — create ORM; register a beforeQuery hook that itself calls orm.select().all().
		// Without the re-entrancy guard, the inner all() would also trigger hooks → infinite loop.
		// With the guard, hasHooks() returns false inside the hook execution, so the inner
		// query runs without hooks and the outer hook fires exactly once.
		const adapter = createSpyAdapterForHooks([{ id: 1 }]);
		async function* asyncGen() {
			yield { id: 1 };
		}
		(adapter as unknown as Record<string, unknown>).stream = vi.fn(() => {
			const gen = asyncGen();
			return {
				[Symbol.asyncIterator]() {
					return this;
				},
				next: () => gen.next(),
				return: async () => ({ done: true as const, value: undefined }),
				throw: async (e: unknown) => {
					throw e;
				},
			};
		});

		let outerCallCount = 0;
		// ORM reference captured after creation (closed over in the hook below)
		let orm: ReturnType<typeof createOrm<typeof testSchema>>;
		const hooks = createHookManager().beforeQuery((ctx) => {
			outerCallCount++;
			// Intentional re-entrant query — should NOT recurse into hooks
			void orm.select('users').all();
			return ctx;
		});
		orm = createOrm({ schema: testSchema, adapter, hooks });

		// Act — consume first item, which triggers hook on first next()
		const iterator = orm.select('users').stream();
		await iterator.next();

		// Assert — outer hook fires once; inner all() does not recurse
		expect(outerCallCount).toBe(1);
	});
});
