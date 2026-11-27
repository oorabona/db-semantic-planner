/**
 * Tests for FILTER (WHERE ...) clause support on aggregate expressions.
 *
 * Covers: COUNT, SUM, AVG, MIN, MAX with FILTER clause
 * at the handler level (unit) and the full compiler pipeline (integration).
 */

import {
	compilePlan,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import {
	createOrm,
	eq,
	exists,
	exprRef,
	fn,
	inSubquery,
	isNull,
	none,
	outerRef,
	plan,
	rangeContains,
	rangeOverlaps,
	rawExists,
	ref,
	schema,
	some,
	subquery,
} from '@dbsp/core';
import type { QueryIntent, WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { eqExpr, normalizeSQL, sqlColumnRef } from '../ast-helpers.js';
import {
	avgHandler,
	countDistinctHandler,
	countHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from '../handlers/expression/aggregate.js';
import type { CompilerContext, Decision } from '../handlers/types.js';
import { createCompilerState } from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { queryLocal } from '../sql-identifier.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		rootTable: 'orders',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

/** Build a pre-compiled filterWhere node: "status" = $1 */
function makeFilterWhere(): import('@pgsql/types').Node {
	const col = sqlColumnRef(queryLocal('status'), queryLocal('orders'));
	return eqExpr(col, { ParamRef: { number: 1 } });
}

// ============================================================================
// Handler-level unit tests (filterWhere injected directly)
// ============================================================================

describe('aggregate handler: FILTER (WHERE ...) injection', () => {
	const ctx = makeCtx();

	it('countHandler: COUNT(*) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'count',
			column: '*',
			filterWhere,
		} as unknown as Decision;

		const node = countHandler.compile(decision, ctx, state);

		expect(node).toHaveProperty('FuncCall');
		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBe(true);
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countHandler: COUNT(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'count',
			column: 'id',
			filterWhere,
		} as unknown as Decision;

		const node = countHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBeUndefined();
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('sumHandler: SUM(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'sum',
			column: 'amount',
			filterWhere,
		} as unknown as Decision;

		const node = sumHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('avgHandler: AVG(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'avg',
			column: 'price',
			filterWhere,
		} as unknown as Decision;

		const node = avgHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('minHandler: MIN(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'min',
			column: 'price',
			filterWhere,
		} as unknown as Decision;

		const node = minHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('maxHandler: MAX(column) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'max',
			column: 'price',
			filterWhere,
		} as unknown as Decision;

		const node = maxHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('genericAggregateHandler: FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'aggregate',
			function: 'sum',
			column: 'revenue',
			filterWhere,
		} as unknown as Decision;

		const node = genericAggregateHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countDistinctHandler: COUNT(DISTINCT col) FILTER (WHERE ...) produces agg_filter', () => {
		const state = createCompilerState();
		const filterWhere = makeFilterWhere();
		const decision = {
			type: 'countDistinct',
			column: 'user_id',
			filterWhere,
		} as unknown as Decision;

		const node = countDistinctHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_star).toBeUndefined();
		expect(fc.agg_filter).toBe(filterWhere);
	});

	it('countHandler: COUNT(*) without filter does NOT produce agg_filter', () => {
		const state = createCompilerState();
		const decision = { type: 'count', column: '*' } as Decision;

		const node = countHandler.compile(decision, ctx, state);

		const fc = (node as { FuncCall: Record<string, unknown> }).FuncCall;
		expect(fc.agg_filter).toBeUndefined();
	});
});

// ============================================================================
// Full compiler pipeline tests (filterCondition → SQL via compilePlan)
// ============================================================================

describe('compilePlan: FILTER (WHERE ...) clause in aggregates', () => {
	it('COUNT(*) FILTER (WHERE active = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'active_count',
					filterCondition: {
						type: 'where',
						column: 'active',
						operator: '=',
						value: true,
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select count(*) filter (where users.active = $1) as active_count from users',
		);
		expect(result.parameters).toEqual([true]);
	});

	it('SUM(amount) FILTER (WHERE status = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{
					type: 'selectFunction',
					function: 'sum',
					column: 'amount',
					alias: 'pending_total',
					filterCondition: {
						type: 'where',
						column: 'status',
						operator: '=',
						value: 'pending',
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select sum(orders.amount) filter (where orders.status = $1) as pending_total from orders',
		);
		expect(result.parameters).toEqual(['pending']);
	});

	it('AVG(price) FILTER (WHERE category = $1) produces FILTER clause in SQL', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'products',
			decisions: [
				{
					type: 'selectFunction',
					function: 'avg',
					column: 'price',
					alias: 'avg_electronics',
					filterCondition: {
						type: 'where',
						column: 'category',
						operator: '=',
						value: 'electronics',
						paramIndex: 1,
					},
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select avg(products.price) filter (where products.category = $1) as avg_electronics from products',
		);
		expect(result.parameters).toEqual(['electronics']);
	});

	it('COUNT(*) without filterCondition still works (backward compat)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total',
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toContain('count');
		expect(normalized).not.toContain('filter');
	});

	it('multiple aggregates: mixed with and without FILTER', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'total_orders',
				},
				{
					type: 'selectFunction',
					function: 'count',
					column: '*',
					alias: 'pending_orders',
					filterCondition: {
						type: 'where',
						column: 'status',
						operator: '=',
						value: 'pending',
						paramIndex: 1,
					},
				},
				{
					type: 'selectFunction',
					function: 'sum',
					column: 'amount',
					alias: 'total_amount',
				},
			],
		};

		const result = compilePlan(plan);
		const normalized = normalizeSQL(result.sql);

		expect(normalized).toEqual(
			'select count(*) as total_orders, count(*) filter (where orders.status = $1) as pending_orders, sum(orders.amount) as total_amount from orders',
		);
		expect(result.parameters).toEqual(['pending']);
	});
});

describe('raw aggregate FILTER resolves through the root resolver (#891 slice 3)', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
			period: { type: 'daterange' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
	} as const;
	const plainDb = schema(tables);
	const filteredDb = schema(tables, undefined, {
		defaultFilters: { posts: isNull('deletedAt') },
	});
	const plainOrm = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	const filteredOrm = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	const variants = [
		{ name: 'plain', db: plainDb, orm: plainOrm, on: false },
		{ name: 'default filters', db: filteredDb, orm: filteredOrm, on: true },
	] as const;
	type Variant = (typeof variants)[number];
	const deleted = (alias: string, on: boolean) =>
		on ? ` AND ${alias}."deletedAt" IS NULL` : '';
	const relationExists = (on: boolean) =>
		`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId"${deleted('posts_exists_0', on)} AND posts_exists_0.title = $1)`;
	const rawBody = (on: boolean) =>
		`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1${deleted('posts_sq', on)})`;
	const reportFor = (v: Variant, select: QueryIntent['select']) =>
		plan(
			{ type: 'select', from: 'users', select } as QueryIntent,
			v.db.model,
			v.on && v.db.defaultFilters
				? { defaultFilters: v.db.defaultFilters }
				: {},
		);
	const aggregateFilter = (v: Variant, filter: WhereIntent) =>
		reportFor(v, {
			type: 'aggregate',
			aggregates: [{ function: 'count', field: '*', as: 'n', filter }],
		});
	const compiled = (report: ReturnType<typeof plan>, model?: unknown) => {
		const d = createPgCompileOnlyAdapter().compile(
			report,
			model === undefined ? undefined : ({ model } as never),
		);
		return { sql: d.sql, params: d.parameters };
	};
	const counted = (where: string) =>
		`SELECT count(*) FILTER (WHERE ${where}) AS n FROM users`;

	const cases: readonly {
		readonly name: string;
		readonly build: (v: Variant) => WhereIntent;
		readonly where: (on: boolean) => string;
		readonly params: readonly unknown[];
	}[] = [
		{
			name: 'exists()',
			build: () => exists('posts', { where: eq('title', 'x') }),
			where: relationExists,
			params: ['x'],
		},
		{
			name: 'some()',
			build: (v) =>
				some(
					v.orm.tables.users?.posts as unknown as Parameters<typeof some>[0],
					() => eq('title', 'x'),
				),
			where: relationExists,
			params: ['x'],
		},
		{
			name: 'none()',
			build: (v) =>
				none(
					v.orm.tables.users?.posts as unknown as Parameters<typeof none>[0],
					() => eq('title', 'x'),
				),
			where: (on) => `NOT (${relationExists(on)})`,
			params: ['x'],
		},
		{
			name: 'a dotted path',
			build: () => eq('posts.title', 'x'),
			where: relationExists,
			params: ['x'],
		},
		{
			name: 'rawExists()',
			build: () =>
				rawExists(subquery('posts').select('id').where(eq('title', 'x'))),
			where: rawBody,
			params: ['x'],
		},
		{
			name: 'rawExists() of an issued builder',
			build: (v) =>
				rawExists(
					v.orm
						.select('posts')
						.columns(['id'])
						.where(eq('title', 'x')) as unknown as Parameters<
						typeof rawExists
					>[0],
				),
			where: rawBody,
			params: ['x'],
		},
		{
			name: 'rawNotExists',
			build: () =>
				({
					kind: 'rawNotExists',
					subquery: subquery('posts')
						.select('id')
						.where(eq('title', 'x'))
						.build()
						.toIntent(),
				}) as WhereIntent,
			where: (on) => `NOT (${rawBody(on)})`,
			params: ['x'],
		},
		{
			name: 'inSubquery()',
			build: () => inSubquery('id', subquery('posts').select('authorId')),
			where: (on) =>
				`users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0${on ? ' WHERE posts_subq_0."deletedAt" IS NULL' : ''})`,
			params: [],
		},
	];

	for (const v of variants)
		for (const c of cases)
			it(`AC3 ${c.name} in aggregates[].filter (${v.name}) reads the model and the read policy`, () => {
				const expected = { sql: counted(c.where(v.on)), params: c.params };
				expect(compiled(aggregateFilter(v, c.build(v)), v.db.model)).toEqual(
					expected,
				);
				// A report from plan() compiles the same without a compile-time model.
				expect(compiled(aggregateFilter(v, c.build(v)))).toEqual(expected);
			});

	it('AC3 the aggregate column of an expressions select carries its FILTER the same way', () => {
		for (const v of variants)
			expect(
				compiled(
					reportFor(v, {
						type: 'expressions',
						columns: [
							{
								kind: 'aggregate',
								function: 'count',
								field: '*',
								as: 'n',
								filter: exists('posts', { where: eq('title', 'x') }),
							},
						],
					} as QueryIntent['select']),
					v.db.model,
				),
			).toEqual({ sql: counted(relationExists(v.on)), params: ['x'] });
	});

	it('AC13 a model-less selectExpression body keeps its current output', () => {
		const d = createPgCompileOnlyAdapter().compileSelectExpression({
			kind: 'subquery',
			query: {
				type: 'select',
				from: 'users',
				select: {
					type: 'aggregate',
					aggregates: [
						{
							function: 'count',
							field: '*',
							as: 'n',
							filter: exists('posts', {
								recursive: { direction: 'down', through: 'posts' },
							} as never),
						},
					],
				},
			},
		} as never);
		expect(d.sql).toBe(
			'SELECT (SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id)) AS n FROM users AS users)',
		);
	});

	it('AC15 a correlated rawExists in aggregates[].filter compiles with outerRef bound to the root', () => {
		for (const v of variants)
			expect(
				compiled(
					aggregateFilter(
						v,
						rawExists(
							subquery('posts')
								.select('id')
								.where(eq('authorId', outerRef('id'))),
						),
					),
					v.db.model,
				),
			).toEqual({
				sql: counted(
					`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq."authorId" = users.id${deleted('posts_sq', v.on)})`,
				),
				params: [],
			});
	});

	it('AC16 a raw FILTER compiles every condition like fn().filter()', () => {
		const [v] = variants;
		expect(
			compiled(
				aggregateFilter(
					v,
					rangeOverlaps('period', { lower: '2024-01-01', upper: '2024-02-01' }),
				),
				v.db.model,
			),
		).toEqual({
			sql: counted("users.period && daterange($1, $2, '[)')"),
			params: ['2024-01-01', '2024-02-01'],
		});
		expect(
			compiled(
				aggregateFilter(v, rangeContains('period', '2024-01-05')),
				v.db.model,
			),
		).toEqual({
			sql: counted('users.period @> CAST($1 AS date)'),
			params: ['2024-01-05'],
		});
		expect(
			compiled(
				aggregateFilter(v, eq('score', fn('length', exprRef('name')))),
				v.db.model,
			),
		).toEqual({ sql: counted('users.score = length(users.name)'), params: [] });
	});
});

describe('an aggregate inside an expression keeps its FILTER (#1003, #891 slice 5c)', () => {
	const db = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
	});
	const adapter = createPgCompileOnlyAdapter({ model: db.model });
	const compileColumn = (from: string, column: object) => {
		const result = adapter.compile(
			plan(
				{
					type: 'select',
					from,
					select: { type: 'expressions', columns: [column] },
				} as QueryIntent,
				db.model,
			),
			{ model: db.model },
		);
		return { sql: result.sql, params: result.parameters };
	};
	const counted = {
		kind: 'aggregate',
		function: 'count',
		field: '*',
		filter: eq('score', 1),
	};
	const zero = { kind: 'literal', value: 0 };

	it('AC8 sql: a function argument', () => {
		expect(
			compileColumn('users', {
				kind: 'function',
				name: 'coalesce',
				args: [counted, zero],
				as: 'n',
			}),
		).toEqual({
			sql: 'SELECT COALESCE(count(*) FILTER (WHERE users.score = $1), $2) AS n FROM users',
			params: [1, 0],
		});
	});

	it('AC8 arithmetic: an arithmetic operand', () => {
		expect(
			compileColumn('posts', {
				kind: 'arithmetic',
				op: '+',
				left: counted,
				right: { kind: 'literal', value: 1 },
				as: 'n',
			}),
		).toEqual({
			sql: 'SELECT count(*) FILTER (WHERE posts.score = $1) + $2 AS n FROM posts',
			params: [1, 1],
		});
	});

	it('AC8 distinct: a DISTINCT aggregate in a function argument', () => {
		expect(
			compileColumn('posts', {
				kind: 'function',
				name: 'coalesce',
				args: [{ ...counted, distinct: true, field: 'score' }, zero],
				as: 'n',
			}),
		).toEqual({
			sql: 'SELECT COALESCE(count(DISTINCT posts.score) FILTER (WHERE posts.score = $1), $2) AS n FROM posts',
			params: [1, 0],
		});
	});
});
