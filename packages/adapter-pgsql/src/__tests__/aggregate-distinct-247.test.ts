/**
 * #247: COUNT/SUM/AVG(DISTINCT field) must compile to DISTINCT SQL.
 *
 * Reproduces the fix scenario: both `.count/.sum/.avg(distinct(field))` (Form A,
 * the SelectAggregateIntent aggregate builder path) and `fn(name, distinct(field))`
 * (Form B, routed through the shared customFn expression path) must emit
 * `DISTINCT` in the compiled SQL — in every context (.columns(), .orderBy(),
 * .having(), cast(), nested), not just .columns() — and must NOT force DISTINCT
 * onto non-distinct aggregates. Also covers the scalar-subquery aggregate
 * DISTINCT propagation (intent-to-decisions.ts convertSubquery / subquery-emission.ts).
 */

import {
	arrayAgg,
	cast,
	createOrm,
	distinct,
	fn,
	literal,
	schema,
	star,
	stringAgg,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { buildSubqueryFromIntent } from '../compile-where.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { EXPRESSION_HANDLERS } from '../select-expression-handlers.js';

const testSchema = schema({
	tool_metrics: {
		id: { type: 'integer', primaryKey: true },
		session_id: { type: 'text' },
		tokens_saved: { type: 'integer' },
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

describe('#247 aggregate DISTINCT', () => {
	it('count(distinct(field)) emits COUNT(DISTINCT ...)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.count(distinct('session_id'), 'sessions')
			.dump();
		expect(dump.sql).toBe(
			'SELECT count(DISTINCT tool_metrics.session_id) AS sessions FROM tool_metrics',
		);
	});

	it('sum(distinct(field)) emits SUM(DISTINCT ...)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.sum(distinct('tokens_saved'), 'uniq')
			.dump();
		expect(dump.sql).toBe(
			'SELECT sum(DISTINCT tool_metrics.tokens_saved) AS uniq FROM tool_metrics',
		);
	});

	it('avg(distinct(field)) emits AVG(DISTINCT ...)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.avg(distinct('tokens_saved'), 'uniq')
			.dump();
		expect(dump.sql).toBe(
			'SELECT avg(DISTINCT tool_metrics.tokens_saved) AS uniq FROM tool_metrics',
		);
	});

	it('non-distinct regression: count(field) has no DISTINCT', () => {
		const orm = buildOrm();
		const dump = orm.select('tool_metrics').count('session_id').dump();
		expect(dump.sql).toBe(
			'SELECT count(tool_metrics.session_id) FROM tool_metrics',
		);
	});

	it('non-distinct regression: sum(field) has no DISTINCT', () => {
		const orm = buildOrm();
		const dump = orm.select('tool_metrics').sum('tokens_saved').dump();
		expect(dump.sql).toBe(
			'SELECT sum(tool_metrics.tokens_saved) FROM tool_metrics',
		);
	});

	it('Form B: fn(count, distinct(field)) emits COUNT(DISTINCT ...) with no param binding', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([fn('count', distinct('session_id')).as('sessions')])
			.dump();
		// Unqualified column ref: fn()'s customFn args compile bare strings via the
		// generic 'ref' case (no table prefix) — the same as any other fn() arg
		// (e.g. fn('sum', 'tokens_saved') below). distinct() gets no special casing.
		expect(dump.sql).toBe(
			'SELECT count(DISTINCT session_id) AS sessions FROM tool_metrics',
		);
		expect(dump.params.length).toBe(0);
	});

	it('Form B: multi-aggregate columns() mixes star/plain/distinct aggregates correctly', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([
				fn('count', star()).as('total_calls'),
				fn('sum', 'tokens_saved').as('total_tokens_saved'),
				fn('count', distinct('session_id')).as('sessions'),
			])
			.dump();
		expect(dump.sql).toBe(
			'SELECT count(*) AS total_calls, sum(tokens_saved) AS total_tokens_saved, count(DISTINCT session_id) AS sessions FROM tool_metrics',
		);
		expect(dump.params.length).toBe(0);
	});

	it('Form B: fn(count, distinct(field)) works in .orderBy() (not just .columns())', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.orderBy(fn('count', distinct('id')))
			.dump();
		expect(dump.sql).toBe(
			'SELECT tool_metrics.* FROM tool_metrics ORDER BY count(DISTINCT id) ASC',
		);
		expect(dump.params.length).toBe(0);
	});

	it('Form B: fn(count, distinct(field)).gt(1) works in .having() (not just .columns())', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.having(fn('count', distinct('id')).gt(1))
			.dump();
		expect(dump.sql).toBe(
			'SELECT tool_metrics.* FROM tool_metrics HAVING count(DISTINCT id) > $1',
		);
		expect(dump.params).toEqual([1]);
	});

	it('Form B: cast(fn(count, distinct(field)), text) works (not just .columns())', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([cast(fn('count', distinct('id')), 'text')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT CAST(count(DISTINCT id) AS text) FROM tool_metrics',
		);
		expect(dump.params.length).toBe(0);
	});

	it('Form B: fn(array_agg, distinct(field)) emits ARRAY_AGG(DISTINCT ...)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([fn('array_agg', distinct('session_id')).as('names')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT array_agg(DISTINCT session_id) AS names FROM tool_metrics',
		);
		expect(dump.params.length).toBe(0);
	});

	it('Form B: fn(string_agg, distinct(field), separator) emits STRING_AGG(DISTINCT x, sep) — distinct + extra arg', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([
				fn('string_agg', distinct('session_id'), literal(',')).as('ids'),
			])
			.dump();
		expect(dump.sql).toBe(
			"SELECT string_agg(DISTINCT session_id, ',') AS ids FROM tool_metrics",
		);
		expect(dump.params.length).toBe(0);
	});

	it('scalar subquery with a distinct aggregate emits AVG(DISTINCT ...) (not silently dropped)', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					aggregate: 'avg',
					aggregateDistinct: true,
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toBe(
			normalizeSQL(
				'SELECT * FROM orders WHERE orders.total > (SELECT avg(DISTINCT products_subq_0.price) FROM products AS products_subq_0)',
			),
		);
	});

	it('scalar subquery regression: non-distinct aggregate has no DISTINCT', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'orders',
			decisions: [
				{ type: 'select', column: '*' },
				{
					type: 'where',
					column: 'total',
					operator: 'scalarSubquery',
					subqueryOperator: '>',
					targetTable: 'products',
					selectColumn: 'price',
					aggregate: 'avg',
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).toBe(
			normalizeSQL(
				'SELECT * FROM orders WHERE orders.total > (SELECT avg(products_subq_0.price) FROM products AS products_subq_0)',
			),
		);
	});

	it('arrayAgg(distinct(field)) emits ARRAY_AGG(DISTINCT ...) — #247 finding 3', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([arrayAgg(distinct('session_id')).as('names')])
			.dump();
		expect(dump.sql).toBe(
			'SELECT array_agg(DISTINCT session_id) AS names FROM tool_metrics',
		);
		expect(dump.params.length).toBe(0);
	});

	it('stringAgg(distinct(field), separator) emits STRING_AGG(DISTINCT ...) — #247 finding 3', () => {
		const orm = buildOrm();
		const dump = orm
			.select('tool_metrics')
			.columns([stringAgg(distinct('session_id'), literal(',')).as('ids')])
			.dump();
		expect(dump.sql).toBe(
			"SELECT string_agg(DISTINCT session_id, ',') AS ids FROM tool_metrics",
		);
		expect(dump.params.length).toBe(0);
	});

	describe('#247 finding 4: count(DISTINCT *) must fail clearly, never silently drop DISTINCT', () => {
		it('Form B: fn(count, distinct(star-field)) throws at construction time (core chokepoint)', () => {
			expect(() => fn('count', distinct('*'))).toThrow(
				/DISTINCT on '\*' is not valid SQL/,
			);
		});

		it("Form A: .count(distinct('*')) throws when compiled (aggregate.ts buildAggregate chokepoint)", () => {
			const orm = buildOrm();
			expect(() =>
				orm.select('tool_metrics').count(distinct('*'), 'x').dump(),
			).toThrow(/count\(DISTINCT \*\) is not valid SQL/);
		});

		it('scalar subquery: aggregateDistinct + selectColumn "*" throws (subquery-emission.ts chokepoint)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'total',
						operator: 'scalarSubquery',
						subqueryOperator: '>',
						targetTable: 'products',
						selectColumn: '*',
						aggregate: 'count',
						aggregateDistinct: true,
					},
				],
			};
			expect(() => compilePlan(plan)).toThrow(
				/count\(DISTINCT \*\) is not valid SQL/,
			);
		});

		it('direct compile-where path: aggregate with field "*" and distinct throws (compile-where.ts chokepoint)', () => {
			const intent = {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [
						{ function: 'count' as const, field: '*', distinct: true },
					],
				},
			};
			expect(() =>
				buildSubqueryFromIntent(
					intent,
					0,
					identityNaming,
					undefined,
					'scalar-direct',
				),
			).toThrow(/count\(DISTINCT \*\) is not valid SQL/);
		});

		it('expression aggregate lowering: count with no field propagates distinct instead of dropping it (select-expression-handlers.ts chokepoint)', () => {
			const decisions: SimplifiedPlanReport['decisions'] = [];
			EXPRESSION_HANDLERS.aggregate(
				{ function: 'count', distinct: true },
				'tool_metrics',
				decisions as never[],
				() => {},
				() => null,
			);
			const plan: SimplifiedPlanReport = {
				rootTable: 'tool_metrics',
				decisions,
			};
			expect(() => compilePlan(plan)).toThrow(
				/count\(DISTINCT \*\) is not valid SQL/,
			);
		});
	});

	describe('#247: NQL aggregate DISTINCT — extraArgs and nested-argument paths', () => {
		it('top-level NQL aggregate with no field but extraArgs propagates distinct (e.g. sum(distinct :p))', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectNqlFunction',
						function: 'sum',
						args: ['amount'],
						distinct: true,
						alias: 'total',
					},
				],
			};
			const result = compilePlan(plan);
			expect(normalizeSQL(result.sql)).toBe(
				normalizeSQL('SELECT sum(DISTINCT orders.amount) AS total FROM orders'),
			);
		});

		it('nested NQL aggregate arg propagates distinct (e.g. round(sum(distinct amount)))', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectNqlFunction',
						function: 'round',
						args: [
							{
								kind: 'aggregate',
								function: 'sum',
								field: 'amount',
								distinct: true,
							},
						],
						alias: 'total',
					},
				],
			};
			const result = compilePlan(plan);
			expect(normalizeSQL(result.sql)).toBe(
				normalizeSQL(
					'SELECT round(sum(DISTINCT orders.amount)) AS total FROM orders',
				),
			);
		});
	});

	describe('#247: a spread copy of distinct() must still be recognized as DistinctField', () => {
		it('.count({...distinct(field)}) still emits COUNT(DISTINCT ...), not a silent drop', () => {
			const orm = buildOrm();
			const dump = orm
				.select('tool_metrics')
				.count({ ...distinct('session_id') }, 'sessions')
				.dump();
			expect(dump.sql).toBe(
				'SELECT count(DISTINCT tool_metrics.session_id) AS sessions FROM tool_metrics',
			);
		});

		it('.sum({...distinct(field)}) still emits SUM(DISTINCT ...), not a column-name crash', () => {
			const orm = buildOrm();
			const dump = orm
				.select('tool_metrics')
				.sum({ ...distinct('tokens_saved') }, 'uniq')
				.dump();
			expect(dump.sql).toBe(
				'SELECT sum(DISTINCT tool_metrics.tokens_saved) AS uniq FROM tool_metrics',
			);
		});

		it('.avg({...distinct(field)}) still emits AVG(DISTINCT ...), not a column-name crash', () => {
			const orm = buildOrm();
			const dump = orm
				.select('tool_metrics')
				.avg({ ...distinct('tokens_saved') }, 'uniq')
				.dump();
			expect(dump.sql).toBe(
				'SELECT avg(DISTINCT tool_metrics.tokens_saved) AS uniq FROM tool_metrics',
			);
		});
	});
});
