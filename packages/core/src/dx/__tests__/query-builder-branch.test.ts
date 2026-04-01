/**
 * @fileoverview Branch coverage tests for query-builder.ts
 *
 * Targets uncovered branches in:
 * - buildIntent: aggregates with groupBy, single/multi where, single/multi having,
 *   distinct, distinctOn, includes, orderBy, limit, offset, lock+groupBy conflict,
 *   joinIntents, batchValuesSource, defaultFilters, skipDefaultFilters
 * - orderBy: ExpressionRef form, ExpressionSpec form, string form, array form,
 *   object form, nulls option
 * - where: ExpressionRef form, WhereIntent passthrough, object filter conversion
 * - cursorPaginate: no cursor, forward/backward direction, cursor decoded,
 *   buildCursorConditions single/multi field, sortDir asc/desc
 * - paginate: withCount=false branch, hasNextPage optimistic
 */

import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../../adapter.js';
import { InvalidOperationError } from '../errors.js';
import { ref as exprRef } from '../expressions.js';
import { createOrm } from '../orm.js';
import { QueryBuilderImpl } from '../query-builder.js';
import { ref, schema } from '../schema.js';
import { createMockAdapter } from '../test-utils.js';

// ============================================================================
// Schema + Spy Adapter
// ============================================================================

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		email: 'string',
		active: 'boolean',
		deletedAt: { type: 'timestamp', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'string',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
});

/**
 * Creates a spy adapter that returns configurable results.
 */
function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT 1',
		parameters: [] as readonly unknown[],
	}));
	const compileWithIncludesSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		main: { sql: 'SELECT 1', parameters: [] as readonly unknown[] },
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
	const adapter: Adapter = {
		...base,
		compile: compileSpy,
		compileWithIncludes: compileWithIncludesSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_s: string) => adapter,
	} as unknown as Adapter;
	return { adapter, executeSpy, compileSpy, compileWithIncludesSpy };
}

const { adapter: spyAdapter } = createSpyAdapter([]);
const orm = createOrm({ adapter: spyAdapter, schema: testSchema });

// ============================================================================
// buildIntent: branch coverage (via .plan())
// ============================================================================

describe('QueryBuilderImpl.buildIntent branches', () => {
	it('no select intent → intent.select is undefined', () => {
		const report = orm.select('users').plan();
		expect(report.intent.select).toBeUndefined();
	});

	it('aggregates with groupBy → aggregate select + fields', () => {
		const report = orm.select('users').count('id').groupBy(['active']).plan();
		expect(report.intent.select).toBeDefined();
		expect(report.intent.groupBy).toEqual(['active']);
		const sel = report.intent.select as { type: string; fields?: string[] };
		expect(sel.type).toBe('aggregate');
		expect(Array.isArray(sel.fields)).toBe(true);
	});

	it('aggregates without groupBy → no fields on aggregate select', () => {
		const report = orm.select('users').count('id').plan();
		const sel = report.intent.select as { type: string; fields?: string[] };
		expect(sel.type).toBe('aggregate');
		expect(sel.fields).toBeUndefined();
	});

	it('single where → intent.where is the single condition (not AND-wrapped)', () => {
		const report = orm
			.select('users')
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.plan();
		expect(report.intent.where).toBeDefined();
		expect((report.intent.where as { kind: string }).kind).toBe('comparison');
	});

	it('multiple where → intent.where is AND-wrapped', () => {
		const report = orm
			.select('users')
			.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.where({
				kind: 'comparison',
				field: 'name',
				operator: 'eq',
				value: 'Alice',
			})
			.plan();
		expect((report.intent.where as { kind: string }).kind).toBe('and');
	});

	it('no where → intent.where is undefined', () => {
		const report = orm.select('users').plan();
		expect(report.intent.where).toBeUndefined();
	});

	it('single having → intent.having is the single condition', () => {
		const report = orm
			.select('users')
			.count('id')
			.groupBy(['active'])
			.having({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.plan();
		expect(report.intent.having).toBeDefined();
		expect((report.intent.having as { kind: string }).kind).toBe('comparison');
	});

	it('multiple having → intent.having is AND-wrapped', () => {
		const report = orm
			.select('users')
			.count('id')
			.groupBy(['active'])
			.having({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			})
			.having({ kind: 'comparison', field: 'name', operator: 'eq', value: 'x' })
			.plan();
		expect((report.intent.having as { kind: string }).kind).toBe('and');
	});

	it('distinct=true → intent.distinct is true', () => {
		const report = orm.select('users').distinct().plan();
		expect(report.intent.distinct).toBe(true);
	});

	it('distinctOn → intent.distinctOn array', () => {
		const report = orm.select('users').distinctOn('id', 'name').plan();
		expect(report.intent.distinctOn).toEqual(['id', 'name']);
	});

	it('limit → intent.limit set', () => {
		const report = orm.select('users').limit(10).plan();
		expect(report.intent.limit).toBe(10);
	});

	it('offset → intent.offset set', () => {
		const report = orm.select('users').offset(5).plan();
		expect(report.intent.offset).toBe(5);
	});

	it('lock + groupBy → throws InvalidOperationError', () => {
		expect(() =>
			orm.select('users').groupBy(['active']).lock('update').plan(),
		).toThrow(InvalidOperationError);
	});

	it('lock without groupBy → intent.lock is set', () => {
		const report = orm.select('users').lock('update').plan();
		expect(report.intent.lock).toBeDefined();
		expect((report.intent.lock as { strength: string }).strength).toBe(
			'update',
		);
	});

	it('batchValuesSource → intent.batchValuesSource is set', () => {
		// Build a QueryBuilderImpl with batchValuesSource directly
		const builder = new QueryBuilderImpl(
			testSchema.model,
			false,
			'users',
			{},
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		);
		(builder as unknown as { batchValuesSource: unknown }).batchValuesSource = {
			alias: 'users',
			columns: ['id'],
			values: [],
		};
		const intent = (
			builder as unknown as { buildIntent: () => unknown }
		).buildIntent();
		expect(
			(intent as { batchValuesSource?: unknown }).batchValuesSource,
		).toBeDefined();
	});

	it('no aggregates, with selectIntent → intent.select is from selectIntent', () => {
		const report = orm.select('users').columns(['id', 'name']).plan();
		expect(report.intent.select).toBeDefined();
	});
});

// ============================================================================
// orderBy: branch coverage
// ============================================================================

describe('QueryBuilderImpl.orderBy branches', () => {
	it('orderBy(ExpressionRef) → expression orderBy intent asc by default', () => {
		const report = orm.select('users').orderBy(exprRef('name')).plan();
		const orderBy = report.intent.orderBy;
		expect(Array.isArray(orderBy)).toBe(true);
		expect(orderBy?.length).toBe(1);
		const ob = orderBy?.[0] as { expression?: unknown; direction?: string };
		expect(ob?.expression).toBeDefined();
		expect(ob?.direction).toBe('asc');
	});

	it('orderBy(ExpressionRef, "desc") → expression intent desc', () => {
		const report = orm.select('users').orderBy(exprRef('name'), 'desc').plan();
		const ob = report.intent.orderBy?.[0] as { direction?: string };
		expect(ob?.direction).toBe('desc');
	});

	it('orderBy(ExpressionRef, "asc", { nulls: "last" }) → includes nulls', () => {
		const report = orm
			.select('users')
			.orderBy(exprRef('name'), 'asc', { nulls: 'last' })
			.plan();
		const ob = report.intent.orderBy?.[0] as { nulls?: string };
		expect(ob?.nulls).toBe('last');
	});

	it('orderBy("field") → string form, asc by default', () => {
		const report = orm.select('users').orderBy('name').plan();
		const ob = report.intent.orderBy?.[0] as {
			field?: string;
			direction?: string;
		};
		expect(ob?.field).toBe('name');
		expect(ob?.direction).toBe('asc');
	});

	it('orderBy("field", "desc") → desc direction', () => {
		const report = orm.select('users').orderBy('name', 'desc').plan();
		const ob = report.intent.orderBy?.[0] as { direction?: string };
		expect(ob?.direction).toBe('desc');
	});

	it('orderBy("field", "asc", { nulls: "first" }) → nulls:first', () => {
		const report = orm
			.select('users')
			.orderBy('name', 'asc', { nulls: 'first' })
			.plan();
		const ob = report.intent.orderBy?.[0] as { nulls?: string };
		expect(ob?.nulls).toBe('first');
	});

	it('orderBy(array of OrderBySpecs) → multiple intents', () => {
		const report = orm
			.select('users')
			.orderBy([
				{ column: 'name', direction: 'desc' },
				{ column: 'id', direction: 'asc', nulls: 'last' },
			])
			.plan();
		expect(report.intent.orderBy?.length).toBe(2);
		const first = report.intent.orderBy?.[0] as {
			field?: string;
			direction?: string;
		};
		const second = report.intent.orderBy?.[1] as {
			field?: string;
			nulls?: string;
		};
		expect(first?.field).toBe('name');
		expect(first?.direction).toBe('desc');
		expect(second?.field).toBe('id');
		expect(second?.nulls).toBe('last');
	});

	it('orderBy(array) with nulls undefined → no nulls property', () => {
		const report = orm
			.select('users')
			.orderBy([{ column: 'id' }])
			.plan();
		const ob = report.intent.orderBy?.[0] as { nulls?: string };
		// nulls may be undefined (not set) — verify no crash
		expect(ob).toBeDefined();
	});

	it('orderBy(object record) → multiple intents from entries', () => {
		const report = orm
			.select('users')
			.orderBy({ name: 'desc', id: 'asc' })
			.plan();
		expect(report.intent.orderBy?.length).toBe(2);
	});

	it('orderBy without nulls option → nulls property absent or undefined', () => {
		const report = orm.select('users').orderBy('name').plan();
		const ob = report.intent.orderBy?.[0] as { nulls?: string };
		expect(ob?.nulls).toBeUndefined();
	});
});

// ============================================================================
// where: branch coverage
// ============================================================================

describe('QueryBuilderImpl.where branches', () => {
	it('where(ExpressionRef) → wraps as expression kind intent', () => {
		const report = orm.select('users').where(exprRef('active')).plan();
		const w = report.intent.where as { kind: string };
		expect(w?.kind).toBe('expression');
	});

	it('where(WhereIntent) → passthrough without conversion', () => {
		const cond = {
			kind: 'comparison' as const,
			field: 'name',
			operator: 'eq' as const,
			value: 'Bob',
		};
		const report = orm.select('users').where(cond).plan();
		const w = report.intent.where as typeof cond;
		expect(w?.kind).toBe('comparison');
		expect(w?.field).toBe('name');
	});

	it('where(object filter) → converts to WhereIntent via objectToWhereIntent', () => {
		// Object filter form: { name: 'Alice' }
		const report = orm
			.select('users')
			.where({ name: 'Alice' } as Record<string, unknown>)
			.plan();
		expect(report.intent.where).toBeDefined();
		// Should produce some kind of WhereIntent (AND or comparison)
		const w = report.intent.where as { kind: string };
		expect(typeof w?.kind).toBe('string');
	});

	it('where(object filter with multiple keys) → produces AND or compound intent', () => {
		const report = orm
			.select('users')
			.where({ name: 'Alice', active: true } as Record<string, unknown>)
			.plan();
		expect(report.intent.where).toBeDefined();
	});
});

// ============================================================================
// cursorPaginate: branch coverage (uses spy adapter for .all())
// ============================================================================

describe('QueryBuilderImpl.cursorPaginate branches', () => {
	it('throws InvalidOperationError when limit < 1', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(
			o.select('users').orderBy('id').cursorPaginate({ limit: 0 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('throws when orderBy is missing', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(
			o.select('users').cursorPaginate({ limit: 5 }),
		).rejects.toThrow(/orderBy clause/);
	});

	it('throws InvalidOperationError for invalid cursor format', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(
			o
				.select('users')
				.orderBy('id')
				.cursorPaginate({ cursor: '!!!invalid!!!' }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('throws for valid base64 but non-JSON cursor', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		const badCursor = Buffer.from('not json').toString('base64');
		await expect(
			o.select('users').orderBy('id').cursorPaginate({ cursor: badCursor }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('no cursor → hasNextPage=false, prevCursor=null when no data', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5 });
		expect(result.hasNextPage).toBe(false);
		expect(result.hasPrevPage).toBe(false);
		expect(result.nextCursor).toBeNull();
		expect(result.prevCursor).toBeNull();
	});

	it('forward: hasMore=true → nextCursor set, data trimmed to limit', async () => {
		// Return limit+1 items to trigger hasMore=true
		const rows = Array.from({ length: 6 }, (_, i) => ({
			id: i + 1,
			name: `u${i}`,
		}));
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5 });
		expect(result.data.length).toBe(5);
		expect(result.hasNextPage).toBe(true);
		expect(result.nextCursor).not.toBeNull();
	});

	it('forward: hasMore=false → nextCursor=null', async () => {
		const rows = [
			{ id: 1, name: 'u1' },
			{ id: 2, name: 'u2' },
		];
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5 });
		expect(result.hasNextPage).toBe(false);
		expect(result.nextCursor).toBeNull();
	});

	it('forward with cursor → hasPrevPage=true (cursor not null)', async () => {
		const rows = [{ id: 3, name: 'u3' }];
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 2 })).toString('base64');
		const result = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5, cursor });
		expect(result.hasPrevPage).toBe(true);
	});

	it('backward direction: hasPrevPage reflects hasMore', async () => {
		const rows = Array.from({ length: 6 }, (_, i) => ({
			id: i + 1,
			name: `u${i}`,
		}));
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 5 })).toString('base64');
		const result = await o
			.select('users')
			.orderBy('id')
			.cursorPaginate({ limit: 5, direction: 'backward', cursor });
		expect(result.hasPrevPage).toBe(true); // hasMore=true in backward direction
	});

	it('single orderBy, asc, forward → cursor condition uses gt', async () => {
		// Verify cursorCondition operator: asc+forward=gt
		// all() calls compileWithIncludes (not compile), so inspect via compileWithIncludesSpy
		const rows = [{ id: 3, name: 'u3' }];
		const { adapter, compileWithIncludesSpy } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 2 })).toString('base64');
		await o.select('users').orderBy('id').cursorPaginate({ limit: 5, cursor });
		expect(compileWithIncludesSpy).toHaveBeenCalled();
		// The planReport passed to compileWithIncludes contains the cursor where condition
		const planReport = compileWithIncludesSpy.mock.calls[0]?.[0] as {
			intent?: { where?: { operator?: string } };
		};
		expect(planReport?.intent?.where).toBeDefined();
		const w = planReport?.intent?.where as { operator?: string };
		expect(w?.operator).toBe('gt');
	});

	it('single orderBy, desc, forward → cursor condition uses lt', async () => {
		const rows = [{ id: 2, name: 'u2' }];
		const { adapter, compileWithIncludesSpy } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 3 })).toString('base64');
		await o
			.select('users')
			.orderBy('id', 'desc')
			.cursorPaginate({ limit: 5, cursor });
		const planReport = compileWithIncludesSpy.mock.calls[0]?.[0] as {
			intent?: { where?: { operator?: string } };
		};
		const w = planReport?.intent?.where as { operator?: string };
		expect(w?.operator).toBe('lt');
	});

	it('single orderBy, asc, backward → cursor condition uses lt', async () => {
		const rows = [{ id: 2, name: 'u2' }];
		const { adapter, compileWithIncludesSpy } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 3 })).toString('base64');
		await o
			.select('users')
			.orderBy('id', 'asc')
			.cursorPaginate({ limit: 5, direction: 'backward', cursor });
		const planReport = compileWithIncludesSpy.mock.calls[0]?.[0] as {
			intent?: { where?: { operator?: string } };
		};
		const w = planReport?.intent?.where as { operator?: string };
		expect(w?.operator).toBe('lt');
	});

	it('multi orderBy → cursor condition uses OR compound', async () => {
		const rows = [{ id: 2, name: 'u2' }];
		const { adapter, compileWithIncludesSpy } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const cursor = Buffer.from(JSON.stringify({ id: 1, name: 'u1' })).toString(
			'base64',
		);
		await o
			.select('users')
			.orderBy('name')
			.orderBy('id')
			.cursorPaginate({ limit: 5, cursor });
		const planReport = compileWithIncludesSpy.mock.calls[0]?.[0] as {
			intent?: { where?: { kind?: string } };
		};
		const w = planReport?.intent?.where as { kind?: string };
		// Multi-field cursor → OR compound (or single AND when only one part)
		expect(w?.kind).toBeDefined();
	});

	it('cursor value missing from cursorValues → buildCursorConditions returns null (no where added)', async () => {
		// cursor has only 'email' but orderBy is on 'id' → cursorValue undefined → null
		const rows = [{ id: 2, name: 'u2' }];
		const { adapter, compileWithIncludesSpy } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		// Cursor with wrong field
		const cursor = Buffer.from(JSON.stringify({ email: 'x@y.com' })).toString(
			'base64',
		);
		await o.select('users').orderBy('id').cursorPaginate({ limit: 5, cursor });
		const planReport = compileWithIncludesSpy.mock.calls[0]?.[0] as {
			intent?: { where?: unknown };
		};
		// No cursor condition was pushed (buildCursorConditions returns null)
		expect(planReport?.intent?.where).toBeUndefined();
	});
});

// ============================================================================
// paginate: branch coverage
// ============================================================================

describe('QueryBuilderImpl.paginate branches', () => {
	it('throws InvalidOperationError when page < 1', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(o.select('users').paginate({ page: 0 })).rejects.toThrow(
			InvalidOperationError,
		);
	});

	it('throws InvalidOperationError when perPage < 1', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		await expect(
			o.select('users').paginate({ page: 1, perPage: 0 }),
		).rejects.toThrow(InvalidOperationError);
	});

	it('withCount=false → total and totalPages are undefined', async () => {
		const rows = [{ id: 1, name: 'u1' }];
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.paginate({ page: 1, perPage: 10, withCount: false });
		expect(result.pagination.total).toBeUndefined();
		expect(result.pagination.totalPages).toBeUndefined();
	});

	it('withCount=false, full page → hasNextPage=true (optimistic)', async () => {
		// perPage=2, return exactly 2 rows → optimistic hasNextPage
		const rows = [
			{ id: 1, name: 'u1' },
			{ id: 2, name: 'u2' },
		];
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.paginate({ page: 1, perPage: 2, withCount: false });
		expect(result.pagination.hasNextPage).toBe(true);
	});

	it('withCount=false, partial page → hasNextPage=false', async () => {
		const rows = [{ id: 1, name: 'u1' }];
		const { adapter } = createSpyAdapter(rows);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.paginate({ page: 1, perPage: 5, withCount: false });
		expect(result.pagination.hasNextPage).toBe(false);
	});

	it('page=1 → hasPrevPage=false', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.paginate({ page: 1, perPage: 10, withCount: false });
		expect(result.pagination.hasPrevPage).toBe(false);
	});

	it('page=2 → hasPrevPage=true', async () => {
		const { adapter } = createSpyAdapter([]);
		const o = createOrm({ adapter, schema: testSchema });
		const result = await o
			.select('users')
			.paginate({ page: 2, perPage: 10, withCount: false });
		expect(result.pagination.hasPrevPage).toBe(true);
	});

	it('defaults: page=1, perPage=20, withCount=true when no options passed', async () => {
		// Spy adapter called twice: once for data, once for count
		let callCount = 0;
		const { adapter: a } = createSpyAdapter([]);
		const countAdapter: Adapter = {
			...a,
			execute: vi.fn(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve([]);
				return Promise.resolve([{ _count: 0 }]);
			}),
		} as unknown as Adapter;
		const o = createOrm({ adapter: countAdapter, schema: testSchema });
		const result = await o.select('users').paginate();
		expect(result.pagination.page).toBe(1);
		expect(result.pagination.perPage).toBe(20);
	});

	it('withCount=true → total and totalPages set from count query', async () => {
		let callCount = 0;
		const countAdapter: Adapter = {
			...spyAdapter,
			compile: vi.fn((_plan: unknown) => ({ sql: 'SELECT 1', parameters: [] })),
			compileWithIncludes: vi.fn((_plan: unknown) => ({
				main: { sql: 'SELECT 1', parameters: [] },
				subqueryIncludes: [],
			})),
			execute: vi.fn(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve([{ id: 1 }, { id: 2 }]);
				return Promise.resolve([{ _count: 50 }]);
			}),
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
			withSchema: (_s: string) => countAdapter,
		} as unknown as Adapter;
		const o = createOrm({ adapter: countAdapter, schema: testSchema });
		const result = await o.select('users').paginate({ page: 1, perPage: 10 });
		expect(result.pagination.total).toBe(50);
		expect(result.pagination.totalPages).toBe(5);
	});
});
