import {
	AmbiguousIncludeError,
	arrayAgg,
	createOrm,
	exprRef,
	fn,
	literal,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import { stringAgg } from '@dbsp/core/internal';
import type { IncludeIntent, PlanReport, QueryIntent } from '@dbsp/types';
import type { Mutable } from '@dbsp/types/internal';
import { describe, expect, it, vi } from 'vitest';
import * as compiler from '../compiler.js';
import { joinIncludeHandler } from '../handlers/include/join.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { asLegacyReport } from './legacy-include-report.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		authorId: ref('users', { as: 'author', inverse: 'createdPosts' }),
		a: ref('users', { as: 'foo_b_ar' }),
		b: ref('users', { as: 'foo_bAr' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
const caps = { dialectCapabilities: POSTGRESQL_CAPABILITIES };
function errorOf(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		return error as Error;
	}
	throw new Error('Expected refusal');
}
function report(): Mutable<PlanReport> {
	return {
		...asLegacyReport(
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [{ relation: 'author', join: 'left' }],
				},
				model,
				caps,
			),
		),
	};
}

describe('#915 / #917 / #927 public include contract', () => {
	it('external reports apply every strategy option rule before a handler runs', () => {
		const spy = vi.spyOn(joinIncludeHandler, 'compile');
		try {
			const cases: {
				strategy: 'join' | 'cte' | 'lateral' | 'json_agg';
				options: Partial<IncludeIntent>;
			}[] = [
				{ strategy: 'join', options: { limit: 1 } },
				{
					strategy: 'join',
					options: { orderBy: [{ field: 'id', direction: 'asc' }] },
				},
				{ strategy: 'cte', options: { limit: 1 } },
				{
					strategy: 'cte',
					options: { orderBy: [{ field: 'id', direction: 'asc' }] },
				},
				{ strategy: 'cte', options: { select: { type: 'all' } } },
				{
					strategy: 'lateral',
					options: { orderBy: [{ field: 'id', direction: 'asc' }] },
				},
				{
					strategy: 'lateral',
					options: { select: { type: 'fields', fields: ['name'] } },
				},
			];
			for (const type of ['aggregate', 'expressions'] as const) {
				const select =
					type === 'aggregate'
						? { type, aggregates: [{ function: 'count' as const, field: '*' }] }
						: { type, columns: [{ kind: 'ref' as const, column: 'name' }] };
				for (const strategy of ['join', 'cte', 'lateral', 'json_agg'] as const)
					cases.push({ strategy, options: { select } });
			}
			for (const { strategy, options } of cases) {
				const include: IncludeIntent = { relation: 'author', ...options };
				const expected = errorOf(() =>
					asLegacyReport(
						plan({ type: 'select', from: 'posts', include: [include] }, model, {
							...caps,
							defaultIncludeStrategy: strategy,
						}),
					),
				);
				const external = report();
				external.intent = { ...external.intent!, include: [include] };
				external.decisions = external.decisions.map((d) =>
					d.type === 'include-strategy' ? { ...d, choice: strategy } : d,
				);
				expect(errorOf(() => adapter.compile(external)).message).toBe(
					expected.message,
				);
			}
			expect(spy).not.toHaveBeenCalled();
			const all = report();
			all.intent = {
				...all.intent,
				include: [
					{ relation: 'author', join: 'left', select: { type: 'all' } },
				],
			};
			expect(adapter.compile(all).sql).toContain(
				'author.name AS "author.name"',
			);
			for (const strategy of ['json_agg', 'lateral'] as const) {
				const original = asLegacyReport(
					plan(
						{
							type: 'select',
							from: 'posts',
							include: [{ relation: 'author', limit: 1 }],
						},
						model,
						{ ...caps, defaultIncludeStrategy: strategy },
					),
				);
				const intent: QueryIntent = {
					...original.intent,
					include: [
						{
							relation: 'author',
							limit: 1,
							orderBy: [{ field: 'name', direction: 'desc' }],
						},
					],
				};
				const ordered = asLegacyReport(
					plan(intent, model, {
						...caps,
						defaultIncludeStrategy: strategy,
					}),
				);
				expect(adapter.compile({ ...original, intent }).sql).toBe(
					adapter.compile(ordered).sql,
				);
			}
		} finally {
			spy.mockRestore();
		}
	});

	it('external nested limits refuse negative, nonfinite, fractional, unsafe and string values by path', () => {
		for (const limit of [
			-1,
			NaN,
			Infinity,
			0.5,
			Number.MAX_SAFE_INTEGER + 1,
			'1',
		]) {
			const base = asLegacyReport(
				plan(
					{
						type: 'select',
						from: 'comments',
						include: [
							{
								relation: 'post',
								join: 'left',
								include: [{ relation: 'author', join: 'left' }],
							},
						],
					},
					model,
					caps,
				),
			);
			const include = {
				relation: 'post',
				join: 'left' as const,
				include: [
					{ relation: 'author', join: 'left' as const, limit: limit as number },
				],
			};
			const external: Mutable<PlanReport> = { ...base };
			external.intent = { ...base.intent!, include: [include] };
			expect(errorOf(() => adapter.compile(external)).message).toBe(
				'Invalid Include include[0].include[0](post.author) limit: Include include[0].include[0](post.author) limit must be a non-negative safe integer',
			);
		}
	});

	it('legacy synthesized joins refuse unsupported select forms with planner messages', () => {
		for (const select of [
			{
				type: 'aggregate' as const,
				aggregates: [{ function: 'count' as const, field: '*' }],
			},
			{
				type: 'expressions' as const,
				columns: [{ kind: 'ref' as const, column: 'name' }],
			},
		]) {
			const external = report();
			external.decisions = [];
			external.intent = {
				...external.intent!,
				include: [{ relation: 'author', join: 'left', select }],
			};
			const expected = errorOf(() =>
				asLegacyReport(plan(external.intent!, model, caps)),
			);
			expect(errorOf(() => adapter.compile(external)).message).toBe(
				expected.message,
			);
		}
		const missing = report();
		missing.decisions = [];
		missing.intent = { ...missing.intent, include: [{ relation: 'author' }] };
		expect(errorOf(() => adapter.compile(missing)).message).toBe(
			'Include include[0](author) has no resolved include-strategy decision',
		);
		missing.intent = {
			...missing.intent,
			include: [
				{
					relation: 'author',
					join: 'left',
					include: [{ relation: 'createdPosts', join: 'left' }],
				},
			],
		};
		expect(errorOf(() => adapter.compile(missing)).message).toBe(
			'Include include[0].include[0](author.createdPosts) has no resolved include-strategy decision',
		);
		const unmodeled = report();
		unmodeled.decisions = [];
		expect(
			errorOf(() => createPgCompileOnlyAdapter().compile(unmodeled)).message,
		).toBe('External report with includes requires a model');
	});

	it('normalized collisions expose candidates and include path in both planning modes and compilation', () => {
		for (const strict of [true, false]) {
			const error = errorOf(() =>
				asLegacyReport(
					createOrm({ model, adapter, strictMode: strict })
						.select('comments')
						.include('post.fooBAr')
						.plan(),
				),
			);
			expect(error).toBeInstanceOf(AmbiguousIncludeError);
			expect(error).toMatchObject({
				candidates: ['foo_b_ar', 'foo_bAr'],
				includePath: 'post.fooBAr',
			});
			expect(error.message).toBe(
				'Ambiguous include relation "fooBAr" from table "posts" at "post.fooBAr". Use the exact relation name or "via" to specify one of: foo_b_ar, foo_bAr',
			);
		}
		const chosen = asLegacyReport(
			plan(
				{
					type: 'select',
					from: 'posts',
					include: [{ relation: 'users', join: 'left' }],
				},
				model,
				{ ...caps, disambiguate: { 'posts.users': 'author' } },
			),
		);
		expect(adapter.compile(chosen).sql).toContain('LEFT JOIN users AS author');

		const external = report();
		external.intent = {
			...external.intent!,
			include: [{ relation: 'fooBAr' }],
		};
		expect(errorOf(() => adapter.compile(external))).toBeInstanceOf(
			AmbiguousIncludeError,
		);
		expect(
			errorOf(() => orm.select('posts').include('fooBAr').dump()),
		).toBeInstanceOf(AmbiguousIncludeError);
	});

	it('unknown includes are refused by path in both modes, builder and external report', () => {
		for (const strict of [true, false]) {
			expect(
				errorOf(() =>
					asLegacyReport(
						createOrm({ model, adapter, strictMode: strict })
							.select('posts')
							.include('nope', { join: 'left' })
							.plan(),
					),
				).message,
			).toBe(
				'Invalid include: Unknown relation "nope" from table "posts" at "nope"',
			);
		}
		expect(
			errorOf(() =>
				asLegacyReport(
					plan(
						{
							type: 'select',
							from: 'posts',
							include: [{ relation: 'nope', join: 'left' }],
						},
						model,
					),
				),
			).message,
		).toBe(
			'Invalid include: Unknown relation "nope" from table "posts" at "nope"',
		);
		expect(
			errorOf(() =>
				orm.select('posts').include('nope', { join: 'left' }).dump(),
			).message,
		).toBe(
			'Invalid include: Unknown relation "nope" from table "posts" at "nope"',
		);
		const external = report();
		external.intent = {
			...external.intent!,
			include: [{ relation: 'author', include: [{ relation: 'nope' }] }],
		};
		expect(errorOf(() => adapter.compile(external)).message).toBe(
			'Invalid include: Unknown relation "nope" from table "users" at "author.nope"',
		);
	});

	it('flat via paths compile at the root and in nested includes', () => {
		const top = asLegacyReport(
			plan(
				{
					type: 'select',
					from: 'users',
					include: [
						{
							relation: 'posts',
							via: 'createdPosts',
							strategy: 'flat',
							select: { type: 'fields', fields: ['title'] },
						},
					],
				},
				model,
				caps,
			),
		);
		expect(adapter.compile(top).sql).toBe(
			'SELECT users.*, "createdPosts".id AS "createdPosts.id", "createdPosts".title AS "createdPosts.title" FROM users LEFT JOIN posts AS "createdPosts" ON users.id = "createdPosts"."authorId"',
		);
		const nested = asLegacyReport(
			plan(
				{
					type: 'select',
					from: 'comments',
					include: [
						{
							relation: 'post',
							strategy: 'flat',
							include: [
								{
									relation: 'users',
									via: 'author',
									strategy: 'flat',
									include: [
										{
											relation: 'posts',
											via: 'createdPosts',
											strategy: 'flat',
										},
									],
								},
							],
						},
					],
				},
				model,
				caps,
			),
		);
		expect(adapter.compile(nested).sql).toContain(
			'LEFT JOIN posts AS "createdPosts" ON author.id = "createdPosts"."authorId"',
		);
	});

	it('aggregate helpers refuse join include data loss in either builder order and external reports', () => {
		for (const aggregate of [
			arrayAgg('title').as('titles'),
			stringAgg('title', literal(',')).as('titles'),
		]) {
			const expected =
				"Invalid include: Include include[0](author) cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.";
			expect(
				errorOf(() =>
					orm
						.select('posts')
						.columns([aggregate])
						.include('author', { join: 'left' })
						.dump(),
				).message,
			).toBe(expected);
			expect(
				errorOf(() =>
					orm
						.select('posts')
						.include('author', { join: 'left' })
						.columns([aggregate])
						.dump(),
				).message,
			).toBe(expected);
			const external = report();
			external.intent = {
				...external.intent!,
				select: { type: 'expressions', columns: [aggregate.intent] },
			};
			expect(errorOf(() => adapter.compile(external)).message).toBe(
				"Include include[0](author) cannot use 'join' with aggregation, groupBy or DISTINCT because its data would be dropped. Use .join() for relational columns, grouping or ordering.",
			);
		}
	});

	it('keyless join wrapper projects only used keys, fields, expression predicates and ordering columns', () => {
		const keyless = schema(
			{
				users: {
					id: { type: 'text', unique: true },
					name: 'text',
					email: 'text',
					rank: 'integer',
					unused: 'text',
				},
				posts: {
					id: { type: 'integer', primaryKey: true },
					authorCode: ref('users', { as: 'author', references: ['id'] }),
				},
			},
			undefined,
			{ defaultPkColumnName: null },
		).model;
		const sql = createOrm({
			model: keyless,
			adapter: createPgCompileOnlyAdapter({ model: keyless }),
		})
			.select('posts')
			.include('author', {
				join: 'left',
				select: { type: 'fields', fields: ['name'] },
				where: fn('lower', exprRef('email')).eq('a'),
			})
			.orderBy('author.rank', 'desc')
			.dump().sql;
		expect(sql).toBe(
			'SELECT posts.*, author.name AS "author.name", author.__dbsp_presence_author AS __dbsp_presence_author FROM posts LEFT JOIN (SELECT author.id, author.name, author.email, author.rank, 1 AS __dbsp_presence_author FROM users AS author) AS author ON posts."authorCode" = author.id WHERE lower(email) = $1 ORDER BY author.rank DESC',
		);
	});
	it('presence discovery lowers the root projection once for multiple join payloads', () => {
		const spy = vi.spyOn(compiler, 'compilePlan');
		try {
			const sql = orm
				.select('posts')
				.columns(['id'])
				.include('author', { join: 'left' })
				.include('foo_b_ar', { join: 'left' })
				.dump().sql;
			expect(sql).toContain('__dbsp_presence_author');
			expect(sql).toContain('__dbsp_presence_foo_b_ar');
			// One lowering for marker label discovery, one for final SQL emission.
			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
		}
	});
});
