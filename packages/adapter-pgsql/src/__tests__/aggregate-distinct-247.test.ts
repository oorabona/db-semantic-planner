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
 *
 * #1015: string `.columns()` replace the group-by fields beside builder aggregates
 * instead of being dropped.
 */

import {
	arrayAgg,
	cast,
	createOrm,
	distinct,
	fn,
	gt,
	literal,
	plan,
	schema,
	star,
} from '@dbsp/core';
import { stringAgg } from '@dbsp/core/internal';
import type { ExpressionIntent, QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { buildSubqueryFromIntent } from '../compile-where.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	tool_metrics: {
		id: { type: 'integer', primaryKey: true },
		session_id: { type: 'text' },
		tokens_saved: { type: 'integer' },
	},
} as const);

const salesSchema = schema({
	orders: {
		id: { type: 'integer', primaryKey: true },
		total: { type: 'integer' },
		amount: { type: 'integer' },
	},
	products: {
		id: { type: 'integer', primaryKey: true },
		price: { type: 'integer' },
	},
} as const);

function buildSalesOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: salesSchema.model });
	return createOrm({ model: salesSchema.model, adapter });
}

function compileSalesIntent(intent: QueryIntent) {
	const adapter = createPgCompileOnlyAdapter({ model: salesSchema.model });
	const { sql, parameters } = adapter.compile(plan(intent, salesSchema.model));
	return { sql, params: parameters };
}

const scalarSubqueryIntent = (aggregate: {
	readonly function: 'avg' | 'count';
	readonly field: string;
	readonly distinct?: boolean;
}): QueryIntent => ({
	type: 'select',
	from: 'orders',
	where: {
		kind: 'subquery',
		field: 'total',
		operator: 'gt',
		subquery: {
			type: 'select',
			from: 'products',
			select: { type: 'aggregate', aggregates: [aggregate] },
		},
	},
});

function buildOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

const COUNT_DISTINCT_STAR =
	'count(DISTINCT *) is not valid SQL — PostgreSQL does not support DISTINCT on a star aggregate; provide a specific column.';

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

	it('Form B: a lone fn(count, star()) column emits count(*) with no param binding', () => {
		const dump = buildOrm()
			.select('tool_metrics')
			.columns([fn('count', star())])
			.dump();
		expect(dump.sql).toBe('SELECT count(*) FROM tool_metrics');
		expect(dump.params).toEqual([]);
	});

	it('Form B: a lone aliased fn(count, star()) column emits count(*) AS alias', () => {
		const dump = buildOrm()
			.select('tool_metrics')
			.columns([fn('count', star()).as('total')])
			.dump();
		expect(dump.sql).toBe('SELECT count(*) AS total FROM tool_metrics');
		expect(dump.params).toEqual([]);
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
			'SELECT tool_metrics.* FROM tool_metrics HAVING count(DISTINCT tool_metrics.id) > $1',
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
		const { sql, params } = compileSalesIntent(
			scalarSubqueryIntent({ function: 'avg', field: 'price', distinct: true }),
		);
		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total > (SELECT avg(DISTINCT products_subq_0.price) FROM products AS products_subq_0)',
			params: [],
		});
	});

	it('scalar subquery regression: non-distinct aggregate has no DISTINCT', () => {
		const { sql, params } = compileSalesIntent(
			scalarSubqueryIntent({ function: 'avg', field: 'price' }),
		);
		expect({ sql, params }).toEqual({
			sql: 'SELECT orders.* FROM orders WHERE orders.total > (SELECT avg(products_subq_0.price) FROM products AS products_subq_0)',
			params: [],
		});
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
			expect(() =>
				compileSalesIntent(
					scalarSubqueryIntent({
						function: 'count',
						field: '*',
						distinct: true,
					}),
				),
			).toThrow(new Error(COUNT_DISTINCT_STAR));
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
					undefined,
					undefined,
					'scalar-direct',
				),
			).toThrow(/count\(DISTINCT \*\) is not valid SQL/);
		});

		it('expression aggregate lowering: count with no field propagates distinct instead of dropping it (select-expression-handlers.ts chokepoint)', () => {
			expect(() =>
				compileSalesIntent({
					type: 'select',
					from: 'orders',
					select: {
						type: 'expressions',
						columns: [
							// The shape NQL builds for a field-less aggregate.
							{
								kind: 'aggregate',
								function: 'count',
								distinct: true,
							} as unknown as ExpressionIntent,
						],
					},
				}),
			).toThrow(new Error(COUNT_DISTINCT_STAR));
		});
	});

	describe('#247: NQL aggregate DISTINCT — extraArgs and nested-argument paths', () => {
		it('top-level NQL aggregate with no field but extraArgs propagates distinct (e.g. sum(distinct :p))', () => {
			const dump = buildSalesOrm()
				.nql`orders | select sum(distinct amount) as total`.dump();
			expect({
				sql: dump.sql,
				params: 'params' in dump ? dump.params : 'mutation dump',
			}).toEqual({
				sql: 'SELECT sum(DISTINCT orders.amount) AS total FROM orders',
				params: [],
			});
		});

		it('nested NQL aggregate arg propagates distinct (e.g. round(sum(distinct amount)))', () => {
			const { sql, params } = compileSalesIntent({
				type: 'select',
				from: 'orders',
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'function',
							name: 'round',
							args: [
								{
									kind: 'aggregate',
									function: 'sum',
									field: 'amount',
									distinct: true,
								},
							],
							as: 'total',
						},
					],
				},
			});
			expect({ sql, params }).toEqual({
				sql: 'SELECT round(sum(DISTINCT orders.amount)) AS total FROM orders',
				params: [],
			});
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

describe('#1015 builder aggregates keep string columns()', () => {
	it('projects string columns instead of the group-by fields', () => {
		const dump = buildOrm()
			.select('tool_metrics')
			.groupBy(['id', 'session_id'])
			.columns(['session_id'])
			.sum('tokens_saved', 'total')
			.dump();
		expect(dump.sql).toBe(
			'SELECT tool_metrics.session_id, sum(tool_metrics.tokens_saved) AS total FROM tool_metrics GROUP BY tool_metrics.id, tool_metrics.session_id',
		);
	});

	it('keeps string columns set after a DISTINCT aggregate and resolves its HAVING alias', () => {
		const dump = buildOrm()
			.select('tool_metrics')
			.groupBy(['id', 'session_id'])
			.count(distinct('tokens_saved'), 'n')
			.columns(['session_id'])
			.having(gt('n', 2))
			.dump();
		expect(dump.sql).toBe(
			'SELECT tool_metrics.session_id, count(DISTINCT tool_metrics.tokens_saved) AS n FROM tool_metrics GROUP BY tool_metrics.id, tool_metrics.session_id HAVING count(DISTINCT tool_metrics.tokens_saved) > CAST($1 AS bigint)',
		);
		expect(dump.params).toEqual([2]);
	});
});
