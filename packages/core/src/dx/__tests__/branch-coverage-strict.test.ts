/**
 * @fileoverview Strict branch coverage tests targeting remaining uncovered paths.
 *
 * Targets:
 * - orm-instance.ts: from() with BatchValuesRef + TableRef missing TABLE_META,
 *   withSchema without adapter, selectExpression without adapter,
 *   into/modify/removeFrom/upsertInto TableRef missing TABLE_META
 * - query-builder.ts: sum/avg with distinct, count edge cases,
 *   join with table+on+as, columns() with mixed scenarios,
 *   getSimplePkColumn array PK, buildPkCondition composite
 * - mutation-builders.ts: batchSet, UpdateBuilder.compileIntent batchUpdate path,
 *   extractIntentData for batchUpdate/delete/bulk-insert/bulk-upsert,
 *   executeWithoutHooks with returning, executeWithHooks paths
 * - filters.ts: exists with recursive/include opts, notExists with opts,
 *   inSubquery with SubqueryExpression
 * - planner.ts: optimizeInToExists not/or/and cases, processRelationFilter modes,
 *   applyDefaultFiltersToIntent
 *
 * Rules:
 * - NEVER .toContain() — always .toEqual() or .toBe()
 * - Test error paths and edge cases ONLY (not happy paths)
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../../adapter.js';
import type { QueryIntent } from '../../index.js';
import { plan } from '../../planner.js';
import { ref as exprRef } from '../expressions.js';
import {
	and,
	distinct,
	eq,
	every,
	exists,
	inSubquery,
	none,
	not,
	notExists,
	or,
	some,
} from '../filters.js';
import { createHookManager } from '../hooks.js';
import { createOrm } from '../orm.js';
import { createOrmInstance, wrapTablesProxyWithDDL } from '../orm-instance.js';
import { ref, schema } from '../schema.js';
import { subquery } from '../subquery-builder.js';
import { createMockAdapter } from '../test-utils.js';

// ============================================================================
// Shared schema + adapter factory
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	orders: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { as: 'customer', inverse: 'orders' }),
		amount: 'number',
	},
});

function makeAdapter(overrides: Partial<Adapter> = {}): Adapter {
	const base = createMockAdapter();
	const adapter = {
		...base,
		compile: vi.fn((_plan: unknown, _opts?: unknown) => ({
			sql: 'SELECT 1',
			parameters: [] as readonly unknown[],
		})),
		compileWithIncludes: vi.fn((_plan: unknown, _opts?: unknown) => ({
			main: { sql: 'SELECT 1', parameters: [] as readonly unknown[] },
			subqueryIncludes: [],
		})),
		execute: vi.fn(() => Promise.resolve([])),
		createDump: vi.fn(
			(
				_plan: unknown,
				compiled: { sql: string; parameters: readonly unknown[] },
			) =>
				({
					sql: compiled.sql,
					params: compiled.parameters,
					plan: {},
				}) as unknown as Dump,
		),
		withSchema: function (this: unknown, _s: string) {
			return adapter;
		},
		...overrides,
	} as unknown as Adapter;
	return adapter;
}

// ============================================================================
// 1. orm-instance.ts: from() with BatchValuesRef
// ============================================================================

describe('createOrmInstance.from() BatchValuesRef path', () => {
	it('should create QueryBuilderImpl when table is a BatchValuesRef', () => {
		const adapter = makeAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const bv = orm.batchValues(
			[[1], ['Alice']],
			['id', 'name'],
			['int4', 'text'],
		);
		const builder = orm.from(bv as unknown as Parameters<typeof orm.from>[0]);
		expect(builder).toBeDefined();
		const planResult = builder.plan();
		expect(planResult).toBeDefined();
	});
});

describe('createOrmInstance.from() with TableRef missing TABLE_META', () => {
	it('should throw when TableRef has no TABLE_META symbol', () => {
		const adapter = makeAdapter();
		const orm = createOrm({ schema: testSchema, adapter });
		const badRef = { someField: 'value' } as unknown as Parameters<
			typeof orm.from
		>[0];
		expect(() => orm.from(badRef)).toThrow('missing TABLE_META');
	});
});

// ============================================================================
// 2. orm-instance.ts: withSchema without adapter
// ============================================================================

describe('createOrmInstance.withSchema without adapter', () => {
	it('should not throw when called without adapter', () => {
		// Call createOrmInstance directly since createOrm requires adapter
		const orm = createOrmInstance(
			testSchema.model,
			false,
			{},
			undefined,
			undefined,
		);
		const scoped = orm.withSchema('my_schema');
		expect(scoped).toBeDefined();
	});
});

// ============================================================================
// 3. orm-instance.ts: selectExpression without adapter
// ============================================================================

describe('createOrmInstance.selectExpression without adapter', () => {
	it('should throw when called without adapter', () => {
		// Call createOrmInstance directly since createOrm requires adapter
		const orm = createOrmInstance(
			testSchema.model,
			false,
			{},
			undefined,
			undefined,
		);
		const expr = exprRef('id');
		expect(() =>
			(
				orm as unknown as { selectExpression(e: unknown): unknown }
			).selectExpression(expr),
		).toThrow('requires an adapter');
	});
});

// ============================================================================
// 4. orm-instance.ts: typed mutation entry points with bad TableRef
// ============================================================================

describe('createOrmInstance typed mutation entry points with bad TableRef', () => {
	const orm = createOrm({ schema: testSchema, adapter: makeAdapter() });
	const badRef = {} as unknown as Parameters<typeof orm.into>[0];

	it('should throw when into() receives TableRef missing TABLE_META', () => {
		expect(() => orm.into(badRef)).toThrow('missing TABLE_META');
	});

	it('should throw when modify() receives TableRef missing TABLE_META', () => {
		expect(() => orm.modify(badRef)).toThrow('missing TABLE_META');
	});

	it('should throw when removeFrom() receives TableRef missing TABLE_META', () => {
		expect(() => orm.removeFrom(badRef)).toThrow('missing TABLE_META');
	});

	it('should throw when upsertInto() receives TableRef missing TABLE_META', () => {
		expect(() => orm.upsertInto(badRef)).toThrow('missing TABLE_META');
	});
});

// ============================================================================
// 5. wrapTablesProxyWithDDL: symbol property access + null tableRef
// ============================================================================

describe('wrapTablesProxyWithDDL edge cases', () => {
	it('should pass symbol property access through unchanged', () => {
		const sym = Symbol('test');
		const proxy = wrapTablesProxyWithDDL(
			{ [sym]: 'symbol-value' } as object,
			undefined,
			undefined,
		) as Record<symbol, unknown>;
		expect(proxy[sym]).toBe('symbol-value');
	});

	it('should return null when tableRef is null', () => {
		const proxy = wrapTablesProxyWithDDL(
			{ nullTable: null } as object,
			undefined,
			undefined,
		) as Record<string, unknown>;
		expect(proxy.nullTable).toBeNull();
	});

	it('should return undefined when tableRef is undefined', () => {
		const proxy = wrapTablesProxyWithDDL(
			{ missingTable: undefined } as object,
			undefined,
			undefined,
		) as Record<string, unknown>;
		expect(proxy.missingTable).toBeUndefined();
	});

	it('should return same cached reference on second access', () => {
		const tableRef = { __tableRef: true };
		const proxy = wrapTablesProxyWithDDL(
			{ users: tableRef } as object,
			undefined,
			undefined,
		) as Record<string, unknown>;
		const first = proxy.users;
		const second = proxy.users;
		expect(first).toBe(second);
	});
});

// ============================================================================
// 6. query-builder.ts: sum/avg with distinct field
// ============================================================================

describe('QueryBuilderImpl.sum and avg with distinct', () => {
	const adapter = makeAdapter();
	const orm = createOrm({ schema: testSchema, adapter });

	it('sum(distinct("id"), alias) → sets distinct=true in aggregate', () => {
		const report = orm.select('users').sum(distinct('id'), 'total_id').plan();
		const sel = report.intent.select as {
			aggregates?: Array<{ function: string; distinct?: boolean }>;
		};
		const agg = sel?.aggregates?.[0];
		expect(agg?.function).toBe('sum');
		expect(agg?.distinct).toBe(true);
	});

	it('avg(distinct("id"), alias) → sets distinct=true in aggregate', () => {
		const report = orm.select('users').avg(distinct('id'), 'avg_id').plan();
		const sel = report.intent.select as {
			aggregates?: Array<{ function: string; distinct?: boolean }>;
		};
		const agg = sel?.aggregates?.[0];
		expect(agg?.function).toBe('avg');
		expect(agg?.distinct).toBe(true);
	});

	it('sum("id") without alias → no as field', () => {
		const report = orm.select('users').sum('id').plan();
		const sel = report.intent.select as { aggregates?: Array<{ as?: string }> };
		const agg = sel?.aggregates?.[0];
		expect(agg?.as).toBeUndefined();
	});

	it('avg("id") without alias → no as field', () => {
		const report = orm.select('users').avg('id').plan();
		const sel = report.intent.select as { aggregates?: Array<{ as?: string }> };
		const agg = sel?.aggregates?.[0];
		expect(agg?.as).toBeUndefined();
	});
});

// ============================================================================
// 7. query-builder.ts: count() edge cases
// ============================================================================

describe('QueryBuilderImpl.count() edge cases', () => {
	const adapter = makeAdapter();
	const orm = createOrm({ schema: testSchema, adapter });

	it('count() with no args → COUNT(*) — no field', () => {
		const report = orm.select('users').count().plan();
		const sel = report.intent.select as {
			aggregates?: Array<{ function: string; field?: string }>;
		};
		const agg = sel?.aggregates?.[0];
		expect(agg?.function).toBe('count');
		expect(agg?.field).toBeUndefined();
	});

	it('count({ field, as }) → AggregateOptions form sets both', () => {
		const report = orm
			.select('users')
			.count({ field: 'id', as: 'total' })
			.plan();
		const sel = report.intent.select as {
			aggregates?: Array<{ field?: string; as?: string }>;
		};
		const agg = sel?.aggregates?.[0];
		expect(agg?.field).toBe('id');
		expect(agg?.as).toBe('total');
	});

	it('count({}) with no field → no field in aggregate', () => {
		const report = orm.select('users').count({}).plan();
		const sel = report.intent.select as {
			aggregates?: Array<{ field?: string }>;
		};
		const agg = sel?.aggregates?.[0];
		expect(agg?.field).toBeUndefined();
	});
});

// ============================================================================
// 8. query-builder.ts: join() edge cases
// ============================================================================

describe('QueryBuilderImpl.join() edge cases', () => {
	const adapter = makeAdapter();
	const orm = createOrm({ schema: testSchema, adapter });

	it('join(table, { on, as, type: left }) → joinIntent has table+alias+type', () => {
		const cond = eq('users.id', 1);
		const report = orm
			.select('users')
			.join('posts', { on: cond, as: 'p', type: 'left' })
			.plan();
		expect(report.intent.joins).toBeDefined();
		const join = report.intent.joins?.[0] as {
			table?: string;
			alias?: string;
			type?: string;
		};
		expect(join?.table).toBe('posts');
		expect(join?.alias).toBe('p');
		expect(join?.type).toBe('left');
	});

	it('join(relation) without on → relation join intent', () => {
		const report = orm.select('posts').join('author').plan();
		expect(report.intent.joins).toBeDefined();
		const join = report.intent.joins?.[0] as { relation?: string };
		expect(join?.relation).toBe('author');
	});

	it('join(batchValuesRef, { on }) → batch join intent', () => {
		const bv = orm.batchValues(
			[[1], ['Alice']],
			['id', 'name'],
			['int4', 'text'],
		);
		const cond = eq('users.id', 1);
		const report = orm.select('users').join(bv, { on: cond }).plan();
		expect(report.intent.joins).toBeDefined();
	});

	it('join(batchValuesRef) without on → throws error', () => {
		const bv = orm.batchValues(
			[[1], ['Alice']],
			['id', 'name'],
			['int4', 'text'],
		);
		expect(() => orm.select('users').join(bv).plan()).toThrow(/on.*condition/i);
	});
});

// ============================================================================
// 9. query-builder.ts: columns() with mixed expressions
// ============================================================================

describe('QueryBuilderImpl.columns() with mixed expressions', () => {
	const adapter = makeAdapter();
	const orm = createOrm({ schema: testSchema, adapter });

	it('columns([]) → plan builds without error', () => {
		const report = orm.select('users').columns([]).plan();
		expect(report.intent).toBeDefined();
	});

	it('columns with ExpressionSpec → hasExpressions=true → type=expressions', () => {
		const report = orm
			.select('users')
			.columns(['id', exprRef('name').as('username')])
			.plan();
		const sel = report.intent.select as { type?: string };
		expect(sel?.type).toBe('expressions');
	});
});

// ============================================================================
// 10. query-builder.ts: getSimplePkColumn with array PK
// ============================================================================

describe('QueryBuilderImpl.getSimplePkColumn with array PK', () => {
	it('should use first PK element when PK is array', async () => {
		const schemaWithArrayPk = schema({
			compositeTable: {
				tenantId: { type: 'integer', primaryKey: true },
				userId: { type: 'integer', primaryKey: true },
				name: 'string',
			},
		});
		const adapter = makeAdapter();
		(
			adapter as unknown as { execute: ReturnType<typeof vi.fn> }
		).execute.mockResolvedValue([]);
		const orm = createOrm({ schema: schemaWithArrayPk, adapter });
		const result = await orm.select('compositeTable').byIds([1, 2]);
		expect(result).toEqual([]);
	});
});

// ============================================================================
// 11. query-builder.ts: buildPkCondition with composite PK object
// ============================================================================

describe('QueryBuilderImpl.buildPkCondition', () => {
	const adapter = makeAdapter();
	const orm = createOrm({ schema: testSchema, adapter });

	it('byId({ id: 1 }) with single-entry object → returns matching row', async () => {
		(
			adapter as unknown as { execute: ReturnType<typeof vi.fn> }
		).execute.mockResolvedValue([{ id: 1, name: 'Alice' }]);
		const result = await orm.select('users').byId({ id: 1 });
		expect(result).toEqual({ id: 1, name: 'Alice' });
	});

	it('byId({}) with empty object → throws error', async () => {
		await expect(
			orm.select('users').byId({} as Record<string, unknown>),
		).rejects.toThrow('empty');
	});

	it('byId with multi-field composite → builds AND condition without throwing', async () => {
		// Composite PK: both tenantId and userId are declared as primaryKey in schema.
		// FIND-009: buildPkCondition validates keys against schema-defined PK columns.
		const compositeSchema = schema({
			orders: {
				tenantId: { type: 'integer', primaryKey: true },
				orderId: { type: 'integer', primaryKey: true },
				amount: 'number',
			},
		});
		const compositeAdapter = makeAdapter();
		(
			compositeAdapter as unknown as { execute: ReturnType<typeof vi.fn> }
		).execute.mockResolvedValue([]);
		const compositeOrm = createOrm({
			schema: compositeSchema,
			adapter: compositeAdapter,
		});
		const result = await compositeOrm
			.select('orders')
			.byId({ tenantId: 1, orderId: 42 });
		expect(result).toBeUndefined();
	});
});

// ============================================================================
// 12. mutation-builders.ts: UpdateBuilder.batchSet coverage
// ============================================================================

describe('UpdateBuilder.batchSet coverage', () => {
	it('batchSet with string matchColumn → wraps in array', () => {
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.update('users')
			.batchSet('id', [{ id: 1, name: 'Alice' }]);
		const dump = builder.dump();
		expect((dump.intent as { type: string }).type).toBe('batchUpdate');
		expect((dump.intent as { matchColumns: string[] }).matchColumns).toEqual([
			'id',
		]);
	});

	it('batchSet with array matchColumn → keeps as-is', () => {
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.update('users')
			.batchSet(['id', 'email'], [{ id: 1, email: 'a@b.com', name: 'Alice' }]);
		const dump = builder.dump();
		expect((dump.intent as { matchColumns: string[] }).matchColumns).toEqual([
			'id',
			'email',
		]);
	});

	it('batchSet with empty data array → throws error', () => {
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm.update('users').batchSet('id', []);
		expect(() => builder.dump()).toThrow('batchSet requires at least one row');
	});

	it('batchSet with set() call → includes scalarSet in intent', () => {
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE users SET ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.update('users')
			.set({ active: true })
			.batchSet('id', [{ id: 1, name: 'Alice' }]);
		const dump = builder.dump();
		expect(
			(dump.intent as { scalarSet?: Record<string, unknown> }).scalarSet,
		).toEqual({
			active: true,
		});
	});

	it('compileIntent dispatches to compileBatchUpdate for batchUpdate intent', async () => {
		const compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE batch ...',
			parameters: [],
		}));
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = compileBatchUpdate;
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const orm = createOrm({ schema: testSchema, adapter });
		await orm
			.update('users')
			.batchSet('id', [{ id: 1, name: 'Alice' }])
			.execute();
		expect(compileBatchUpdate).toHaveBeenCalledOnce();
	});
});

// ============================================================================
// 13. mutation-builders.ts: extractIntentData for all intent types
// ============================================================================

describe('MutationBuilderBase.extractIntentData coverage', () => {
	it('insert with single value → hook sees cardinality=single', async () => {
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({ sql: 'INSERT...', parameters: [] }));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const hookCalled: string[] = [];
		const hooks = createHookManager().beforeMutation((ctx) => {
			hookCalled.push(ctx.cardinality as string);
			return ctx;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm.insert('users').values({ name: 'Alice' }).execute();
		expect(hookCalled[0]).toBe('single');
	});

	it('insert with bulk values → hook sees cardinality=bulk', async () => {
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({ sql: 'INSERT...', parameters: [] }));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const hookCalled: string[] = [];
		const hooks = createHookManager().beforeMutation((ctx) => {
			hookCalled.push(ctx.cardinality as string);
			return ctx;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm
			.insert('users')
			.values([{ name: 'Alice' }, { name: 'Bob' }])
			.execute();
		expect(hookCalled[0]).toBe('bulk');
	});

	it('delete → hook sees cardinality=single and data=undefined', async () => {
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({ sql: 'DELETE...', parameters: [] }));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const hookCalled: Array<{ cardinality: string; data: unknown }> = [];
		const hooks = createHookManager().beforeMutation((ctx) => {
			hookCalled.push({
				cardinality: ctx.cardinality as string,
				data: ctx.data,
			});
			return ctx;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm.delete('users').where(eq('id', 1)).execute();
		expect(hookCalled[0]?.cardinality).toBe('single');
		expect(hookCalled[0]?.data).toBeUndefined();
	});

	it('batchUpdate → hook sees cardinality=bulk', async () => {
		const adapter = createMockAdapter();
		adapter.compileBatchUpdate = vi.fn(() => ({
			sql: 'UPDATE...',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const hookCalled: string[] = [];
		const hooks = createHookManager().beforeMutation((ctx) => {
			hookCalled.push(ctx.cardinality as string);
			return ctx;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm
			.update('users')
			.batchSet('id', [
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			])
			.execute();
		expect(hookCalled[0]).toBe('bulk');
	});
});

// ============================================================================
// 14. mutation-builders.ts: executeWithoutHooks with returning
// ============================================================================

describe('MutationBuilderBase.executeWithoutHooks with returning', () => {
	it('returns results when returning columns are set', async () => {
		const executeMock = vi.fn(() => Promise.resolve([{ id: 42 }]));
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT ... RETURNING id',
			parameters: [],
		}));
		adapter.execute = executeMock;
		const orm = createOrm({ schema: testSchema, adapter });
		const result = await orm
			.insert('users')
			.values({ name: 'Alice' })
			.returning(['id'])
			.execute();
		expect(result).toEqual([{ id: 42 }]);
	});
});

// ============================================================================
// 15. mutation-builders.ts: executeWithHooks afterMutation + onError paths
// ============================================================================

describe('MutationBuilderBase.executeWithHooks paths', () => {
	it('fires afterMutation hooks without returning columns', async () => {
		const afterCalled: unknown[] = [];
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT ...',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([]));
		const hooks = createHookManager().afterMutation((ctx, results) => {
			afterCalled.push({ table: ctx.table, count: results.length });
			return results;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm.insert('users').values({ name: 'Alice' }).execute();
		expect(afterCalled).toHaveLength(1);
		expect((afterCalled[0] as { table: string }).table).toBe('users');
	});

	it('fires afterMutation hooks with results when returning set', async () => {
		const afterCalled: unknown[] = [];
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT ... RETURNING id',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.resolve([{ id: 1 }]));
		const hooks = createHookManager().afterMutation((_ctx, results) => {
			afterCalled.push(results);
			return results;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await orm
			.insert('users')
			.values({ name: 'Alice' })
			.returning(['id'])
			.execute();
		expect(afterCalled[0]).toEqual([{ id: 1 }]);
	});

	it('runs onError hooks when execute throws', async () => {
		const errorCaptured: Error[] = [];
		const adapter = createMockAdapter();
		adapter.compileInsert = vi.fn(() => ({
			sql: 'INSERT ...',
			parameters: [],
		}));
		adapter.execute = vi.fn(() => Promise.reject(new Error('DB failure')));
		const hooks = createHookManager().onError((ctx) => {
			errorCaptured.push(ctx.error);
			return ctx.error;
		});
		const orm = createOrm({ schema: testSchema, adapter, hooks });
		await expect(
			orm.insert('users').values({ name: 'Alice' }).execute(),
		).rejects.toThrow('DB failure');
		expect(errorCaptured).toHaveLength(1);
	});
});

// ============================================================================
// 16. filters.ts: exists/notExists with all option branches
// ============================================================================

describe('filters.ts: exists option branches', () => {
	it('exists with where option → sets result.where', () => {
		const result = exists('posts', { where: eq('title', 'Hello') });
		expect(result.kind).toBe('exists');
		expect((result.where as { field?: string }).field).toBe('title');
	});

	it('exists with recursive option → sets result.recursive', () => {
		const result = exists('posts', {
			recursive: { direction: 'down', through: 'children', maxDepth: 5 },
		});
		expect(result.kind).toBe('exists');
		expect((result.recursive as { direction?: string }).direction).toBe('down');
	});

	it('exists with include option → sets result.include', () => {
		const result = exists('posts', { include: { author: { join: 'inner' } } });
		expect(result.kind).toBe('exists');
		expect((result.include as Record<string, unknown>).author).toBeDefined();
	});

	it('exists with no options → no where/recursive/include', () => {
		const result = exists('posts');
		expect(result.kind).toBe('exists');
		expect(result.where).toBeUndefined();
		expect(result.recursive).toBeUndefined();
		expect(result.include).toBeUndefined();
	});
});

describe('filters.ts: notExists option branches', () => {
	it('notExists with where option → sets result.where', () => {
		const result = notExists('posts', { where: eq('title', 'Hello') });
		expect(result.kind).toBe('notExists');
		expect(result.where).toBeDefined();
	});

	it('notExists with recursive option → sets result.recursive', () => {
		const result = notExists('posts', {
			recursive: { direction: 'up', through: 'parent', maxDepth: 3 },
		});
		expect(result.kind).toBe('notExists');
		expect(result.recursive).toBeDefined();
	});

	it('notExists with include option → sets result.include', () => {
		const result = notExists('posts', {
			include: { author: { join: 'left' } },
		});
		expect(result.kind).toBe('notExists');
		expect(result.include).toBeDefined();
	});

	it('notExists with no options → no where/recursive/include', () => {
		const result = notExists('posts');
		expect(result.kind).toBe('notExists');
		expect(result.where).toBeUndefined();
	});
});

// ============================================================================
// 17. filters.ts: inSubquery with SubqueryExpression form
// ============================================================================

describe('filters.ts: inSubquery with SubqueryExpression', () => {
	it('inSubquery with subquery builder → kind=in with subquery intent', () => {
		const sq = subquery('posts').select(['authorId']);
		const result = inSubquery('id', sq);
		expect(result.kind).toBe('in');
		expect(result.subquery).toBeDefined();
	});
});

// ============================================================================
// 18. planner.ts: optimizeInToExists edge cases
// ============================================================================

describe('planner.ts: optimizeInToExists edge cases', () => {
	const schemaForOptimize = schema({
		customers: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		orders_opt: {
			id: { type: 'integer', primaryKey: true },
			customerId: ref('customers', { as: 'customer', inverse: 'orders_opt' }),
			amount: 'number',
		},
	});

	it('NOT(IN subquery) → optimized plan is defined', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'customers',
			where: not(
				inSubquery('id', subquery('orders_opt').select(['customerId'])),
			),
		};
		const result = plan(intent, schemaForOptimize.model);
		expect(result).toBeDefined();
		expect(result.intent).toBeDefined();
	});

	it('AND containing IN subquery → plan is defined', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'customers',
			where: and(
				eq('name', 'Alice'),
				inSubquery('id', subquery('orders_opt').select(['customerId'])),
			),
		};
		const result = plan(intent, schemaForOptimize.model);
		expect(result).toBeDefined();
	});

	it('OR containing IN subquery → plan is defined', () => {
		const intent: QueryIntent = {
			type: 'select',
			from: 'customers',
			where: or(
				eq('name', 'Bob'),
				inSubquery('id', subquery('orders_opt').select(['customerId'])),
			),
		};
		const result = plan(intent, schemaForOptimize.model);
		expect(result).toBeDefined();
	});
});

// ============================================================================
// 19. planner.ts: processRelationFilter modes (some/every/none)
// ============================================================================

describe('planner.ts: processRelationFilter modes', () => {
	const relSchema = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'string',
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
	});

	it('every() → produces filter-strategy decision', () => {
		// Access relation via parent table proxy (provides RELATION_META)
		const postsRelation = (
			relSchema.tables.users as unknown as Record<string, unknown>
		).posts;
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: every(postsRelation as Parameters<typeof every>[0], (_rel) =>
				eq('title', 'Hello'),
			),
		};
		const result = plan(intent, relSchema.model);
		expect(result).toBeDefined();
		// processRelationFilter produces 'filter-strategy' decisions
		const decisions = result.decisions.filter(
			(d) => d.type === 'filter-strategy',
		);
		expect(decisions.length).toBeGreaterThan(0);
	});

	it('some() → produces filter-strategy decision', () => {
		const postsRelation = (
			relSchema.tables.users as unknown as Record<string, unknown>
		).posts;
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: some(postsRelation as Parameters<typeof some>[0], (_rel) =>
				eq('title', 'World'),
			),
		};
		const result = plan(intent, relSchema.model);
		expect(result).toBeDefined();
		const decisions = result.decisions.filter(
			(d) => d.type === 'filter-strategy',
		);
		expect(decisions.length).toBeGreaterThan(0);
	});

	it('none() → produces filter-strategy decision', () => {
		const postsRelation = (
			relSchema.tables.users as unknown as Record<string, unknown>
		).posts;
		const intent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: none(postsRelation as Parameters<typeof none>[0], (_rel) =>
				eq('title', 'Foo'),
			),
		};
		const result = plan(intent, relSchema.model);
		expect(result).toBeDefined();
		const decisions = result.decisions.filter(
			(d) => d.type === 'filter-strategy',
		);
		expect(decisions.length).toBeGreaterThan(0);
	});
});

// ============================================================================
// 20. query-builder.ts: applyDefaultFiltersToIntent coverage
// ============================================================================

describe('QueryBuilderImpl applyDefaultFiltersToIntent', () => {
	it('defaultFilter applied without existing where → where=filter', () => {
		const adapter = makeAdapter();
		// defaultFilters must be passed via schema() options, not createOrm()
		const schemaWithFilters = schema(
			{
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
					active: 'boolean',
				},
			},
			undefined,
			{ defaultFilters: { users: eq('active', true) } },
		);
		const orm = createOrm({ schema: schemaWithFilters, adapter });
		const report = orm.from(schemaWithFilters.tables.users).plan();
		expect(report.intent.where).toBeDefined();
	});

	it('defaultFilter merged with existing where → kind=and', () => {
		const adapter = makeAdapter();
		const schemaWithFilters = schema(
			{
				users: {
					id: { type: 'integer', primaryKey: true },
					name: 'string',
					active: 'boolean',
				},
			},
			undefined,
			{ defaultFilters: { users: eq('active', true) } },
		);
		const orm = createOrm({ schema: schemaWithFilters, adapter });
		const report = orm
			.from(schemaWithFilters.tables.users)
			.where(eq('name', 'Alice'))
			.plan();
		const w = report.intent.where as { kind?: string };
		expect(w?.kind).toBe('and');
	});
});

// ============================================================================
// 21. query-builder.ts: withPlanOptions merge with existing options
// ============================================================================

describe('QueryBuilderImpl.withPlanOptions merge', () => {
	it('merges global plan options with per-query overrides', () => {
		const adapter = makeAdapter();
		const orm = createOrm({
			schema: testSchema,
			adapter,
			planOptions: { enableCTEs: false },
		});
		const report = orm
			.select('users')
			.withPlanOptions({ enableCTEs: true })
			.plan();
		expect(report).toBeDefined();
	});
});

// ============================================================================
// 22. generateAlterColumnSQL: uncovered option combinations
// ============================================================================

describe('generateAlterColumnSQL edge cases', () => {
	it('alterColumn with dropDefault → SQL contains DROP DEFAULT', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const adapter = createMockAdapter();
		adapter.executeDDL = executeDDL;
		const orm = createOrm({ schema: testSchema, adapter });
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: Record<string, unknown>): Promise<void>;
			}
		).alterColumn('name', { dropDefault: true });
		expect(executeDDL).toHaveBeenCalledOnce();
		const sql = executeDDL.mock.calls[0]?.[0] as string;
		expect(sql).toMatch(/DROP DEFAULT/i);
	});

	it('alterColumn with setNotNull → SQL contains SET NOT NULL', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const adapter = createMockAdapter();
		adapter.executeDDL = executeDDL;
		const orm = createOrm({ schema: testSchema, adapter });
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: Record<string, unknown>): Promise<void>;
			}
		).alterColumn('email', { setNotNull: true });
		expect(executeDDL).toHaveBeenCalledOnce();
		const sql = executeDDL.mock.calls[0]?.[0] as string;
		expect(sql).toMatch(/SET NOT NULL/i);
	});

	it('alterColumn with setDefault → SQL contains SET DEFAULT', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const adapter = createMockAdapter();
		adapter.executeDDL = executeDDL;
		const orm = createOrm({ schema: testSchema, adapter });
		await (
			orm.tables.users as unknown as {
				alterColumn(col: string, opts: Record<string, unknown>): Promise<void>;
			}
		).alterColumn('active', { setDefault: 'false' });
		expect(executeDDL).toHaveBeenCalledOnce();
		const sql = executeDDL.mock.calls[0]?.[0] as string;
		expect(sql).toMatch(/SET DEFAULT/i);
	});
});

// ============================================================================
// 23. buildIndexAPI.list() fallback paths
// ============================================================================

describe('buildIndexAPI.list() fallback paths', () => {
	it('uses executeRaw when adapter has no listIndexes but has executeRaw', async () => {
		const executeRaw = vi.fn().mockResolvedValue([{ name: 'idx_users_email' }]);
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const adapter = {
			...createMockAdapter(),
			executeDDL,
			executeRaw,
			listIndexes: undefined,
		} as unknown as Adapter;
		const orm = createOrm({ schema: testSchema, adapter });
		const result = await (
			orm.tables.users as unknown as {
				indexes: { list(): Promise<unknown[]> };
			}
		).indexes.list();
		expect(executeRaw).toHaveBeenCalledOnce();
		expect(result).toEqual([{ name: 'idx_users_email' }]);
	});

	it('falls back to executeDDL when adapter has neither listIndexes nor executeRaw', async () => {
		const executeDDL = vi.fn().mockResolvedValue(undefined);
		const adapter = {
			...createMockAdapter(),
			executeDDL,
			listIndexes: undefined,
			executeRaw: undefined,
		} as unknown as Adapter;
		const orm = createOrm({ schema: testSchema, adapter });
		const result = await (
			orm.tables.users as unknown as {
				indexes: { list(): Promise<unknown[]> };
			}
		).indexes.list();
		expect(executeDDL).toHaveBeenCalledOnce();
		expect(result).toEqual([]);
	});

	it('throws InvalidOperationError when no adapter is set', async () => {
		const { InvalidOperationError } = await import('../errors.js');
		// createOrmInstance accepts undefined adapter (unlike createOrm which requires it)
		const orm = createOrmInstance(
			testSchema.model,
			false,
			{},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			testSchema.tables as object,
		);
		await expect(
			(
				orm.tables.users as unknown as {
					indexes: { list(): Promise<unknown[]> };
				}
			).indexes.list(),
		).rejects.toThrow(InvalidOperationError);
	});
});

// ============================================================================
// 24. UpsertBuilder: doUpdate with where, onConflictConstraint
// ============================================================================

describe('UpsertBuilder edge cases', () => {
	it('doUpdate with set + where → action includes set and where', () => {
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT ... ON CONFLICT ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doUpdate({ name: 'Alice Updated' }, eq('active', true));
		const dump = builder.dump();
		const action = (dump.intent as { action?: Record<string, unknown> }).action;
		expect(action?.type).toBe('doUpdate');
		expect(action?.set).toEqual({ name: 'Alice Updated' });
		expect(action?.where).toBeDefined();
	});

	it('onConflictConstraint → conflictTarget has constraint property', () => {
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT ... ON CONFLICT ON CONSTRAINT ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflictConstraint('users_pkey')
			.doNothing();
		const dump = builder.dump();
		const onConflict = (dump.intent as { onConflict?: Record<string, unknown> })
			.onConflict;
		expect(onConflict?.constraint).toBe('users_pkey');
	});

	it('doUpdate without set → action has no set property', () => {
		const adapter = createMockAdapter();
		adapter.compileUpsert = vi.fn(() => ({
			sql: 'INSERT ... ON CONFLICT ...',
			parameters: [],
		}));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.upsert('users')
			.values({ id: 1, name: 'Alice' })
			.onConflict(['id'])
			.doUpdate();
		const dump = builder.dump();
		const action = (dump.intent as { action?: Record<string, unknown> }).action;
		expect(action?.type).toBe('doUpdate');
		expect(action?.set).toBeUndefined();
	});
});

// ============================================================================
// 25. DeleteBuilder: returning + cascade with array
// ============================================================================

describe('DeleteBuilder edge cases', () => {
	it('cascade with relations array → intent has cascade=array', () => {
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({ sql: 'DELETE...', parameters: [] }));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm
			.delete('users')
			.where(eq('id', 1))
			.cascade(['posts', 'orders']);
		const dump = builder.dump();
		expect((dump.intent as { cascade?: unknown }).cascade).toEqual([
			'posts',
			'orders',
		]);
	});

	it('cascade without args → intent has cascade=true', () => {
		const adapter = createMockAdapter();
		adapter.compileDelete = vi.fn(() => ({ sql: 'DELETE...', parameters: [] }));
		const orm = createOrm({ schema: testSchema, adapter });
		const builder = orm.delete('users').where(eq('id', 1)).cascade();
		const dump = builder.dump();
		expect((dump.intent as { cascade?: unknown }).cascade).toBe(true);
	});
});
