import {
	col,
	createOrm,
	eq,
	exprRef,
	fn,
	isNotNull,
	ResultHydrator,
	ref,
	relationColumn,
	schema,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	calls: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'calls' }),
		amount: { type: 'bigint', js: 'bigint' },
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
it('907 item 1 duplicate wildcard keeps exact SQL shape and hydrated rows', () => {
	for (const strategy of ['json_agg', 'lateral'] as const) {
		for (const path of ['calls', 'calls.users']) {
			const base = orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.include(path);
			const single = adapter.compile(base.plan());
			const duplicate = adapter.compile(base.include(path).plan());
			expect(duplicate.sql).toBe(single.sql);
			expect(duplicate.hydrationPlan?.includePayloads).toEqual(
				single.hydrationPlan?.includePayloads,
			);
			expect(
				duplicate.hydrationPlan?.includePayloads?.[0]?.columns.map(
					(c) => c.publicKey,
				),
			).toEqual(['id', 'userId', 'amount']);
			const row =
				strategy === 'json_agg'
					? {
							calls_json: [
								{
									id: 2,
									userId: 1,
									amount: '42',
									...(path.includes('.') && { users: [{ id: 1 }] }),
								},
							],
						}
					: {
							'calls.id': 2,
							'calls.userId': 1,
							'calls.amount': '42',
							...(path.includes('.') && { 'calls.users.id': 1 }),
						};
			const hydrate = (query: typeof single) => {
				const rows = [structuredClone(row)];
				const hydrator = new ResultHydrator(model, 'users');
				hydrator.hydrateJsonAggIncludes(rows, base.plan(), query);
				hydrator.hydrateJoinIncludes(rows, base.plan(), query);
				return rows;
			};
			const expectedCall = {
				id: 2,
				userId: 1,
				amount: 42n,
				...(path.includes('.') && { users: { id: 1 } }),
			};
			expect(hydrate(single)).toEqual([
				{ calls: strategy === 'json_agg' ? [expectedCall] : expectedCall },
			]);
			expect(hydrate(duplicate)).toEqual(hydrate(single));
		}
	}
	for (const strategy of ['json_agg', 'lateral'] as const) {
		const report = orm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: strategy })
			.include('calls')
			.include('calls')
			.columns([
				relationColumn('calls', '*', 'all'),
				relationColumn('calls', 'amount', 'extra'),
			])
			.plan();
		const query = adapter.compile(report);
		expect(
			query.hydrationPlan?.includePayloads?.[0]?.columns.map(
				(c) => c.publicKey,
			),
		).toEqual(['id', 'userId', 'amount', 'extra']);
	}
});
it('907 item 2 bigint expression binds and special literal identities stay distinct', () => {
	const expression = (value: unknown) =>
		subquery('calls')
			.where(eq('id', value as number))
			.count()
			.asExpr('n');
	expect(
		orm
			.select('users')
			.columns([expression(1n)])
			.dump().params,
	).toEqual([1n]);
	const values = [undefined, null, NaN, Infinity, -Infinity, -0, 0, 1n, 1];
	for (let i = 0; i < values.length; i++)
		for (let j = i + 1; j < values.length; j++) {
			expect(() =>
				orm
					.select('users')
					.columns([expression(values[i]), expression(values[j])])
					.dump(),
			).toThrow(/conflicting public key 'n'/);
		}
});
it('907 item 3 model-free compile refuses unavailable include read authority', () => {
	const report = orm
		.select('users')
		.columns([col('id', 'id')])
		.include('calls', { select: { type: 'fields', fields: ['amount'] } })
		.plan();
	expect(() => createPgCompileOnlyAdapter().compile(report)).toThrow(
		new Error(
			"Include payload 'calls' cannot establish read conversions for column 'amount' without a compile model.",
		),
	);
	const query = adapter.compile(report);
	expect(query.sql).toContain('amount');
	const rows = [{ calls_json: [{ amount: '9007199254740993' }] }];
	new ResultHydrator(model, 'users').hydrateJsonAggIncludes(
		rows,
		report,
		query,
	);
	expect(rows).toEqual([{ calls: [{ amount: 9007199254740993n }] }]);
	const wildcard = orm
		.select('users')
		.include('calls', { select: { type: 'fields', fields: [] } })
		.plan();
	expect(() => createPgCompileOnlyAdapter().compile(wildcard)).toThrow(
		new Error(
			"Include payload 'calls' cannot establish root wildcard ownership for 'users' without a compile model.",
		),
	);
});
it('907 item 4 hydration refuses absent compiled shapes', () => {
	const report = orm.select('users').include('calls').plan();
	const hydrator = new ResultHydrator(model, 'users');
	for (const hydrate of [
		hydrator.hydrateJsonAggIncludes.bind(hydrator),
		hydrator.hydrateJoinIncludes.bind(hydrator),
	]) {
		expect(() => hydrate([{ calls_json: [] }], report)).toThrow(
			"Include hydration 'calls' requires compiled includePayloads; supply the compiled query hydrationPlan.",
		);
		try {
			hydrate([], report);
		} catch (error) {
			expect((error as Error).name).toBe('MissingIncludePayloadShapeError');
		}
	}
});

it('907 omitted include payload retains an empty compiled shape and exact rows', () => {
	const model = schema({
		definitions: { id: { type: 'integer', primaryKey: true } },
		uses: {
			id: { type: 'integer', primaryKey: true },
			defId: ref('definitions', { as: 'definition', inverse: 'uses' }),
		},
	}).model;
	const adapter = createPgCompileOnlyAdapter({ model });
	const orm = createOrm({ model, adapter });
	const query = orm
		.withSchema('issue_154_e2e')
		.select('definitions')
		.include('uses', { join: 'left' })
		.columns([
			'id',
			fn('array_agg', exprRef('uses.id'))
				.filter(isNotNull('uses.id'))
				.as('use_ids'),
		])
		.groupBy(['id'])
		.orderBy('id');
	const plan = query.plan();
	const compiled = adapter.withSchema('issue_154_e2e').compile(plan);
	expect(compiled.sql.replace(/\s+/g, ' ').trim()).toBe(
		'SELECT definitions.id, array_agg(uses.id) FILTER (WHERE uses.id IS NOT NULL) AS use_ids FROM issue_154_e2e.definitions LEFT JOIN issue_154_e2e.uses AS uses ON definitions.id = uses."defId" GROUP BY definitions.id ORDER BY definitions.id ASC',
	);
	expect(compiled.hydrationPlan?.includePayloads).toEqual([
		expect.objectContaining({
			path: 'uses',
			strategy: 'join',
			columns: [],
			children: [],
		}),
	]);
	const rows = [
		{ id: 100, use_ids: [1000, 1001] },
		{ id: 200, use_ids: null },
	];
	const hydrator = new ResultHydrator(model, 'definitions');
	hydrator.hydrateJsonAggIncludes(rows, plan, compiled);
	hydrator.hydrateJoinIncludes(rows, plan, compiled);
	expect(rows).toEqual([
		{ id: 100, use_ids: [1000, 1001] },
		{ id: 200, use_ids: null },
	]);
});
