const plan = nativePlan;

import { createOrm, plan as nativePlan, or, ref, schema } from '@dbsp/core';
import type { PlanReport, ResolvedIncludeStrategy } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { unique: true, as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { unique: true, as: 'post', inverse: 'comments' }),
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		parentId: ref('categories', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
} as const);
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const strategies = ['join', 'json_agg', 'lateral', 'cte'] as const;
const path = /include\[0\]\(posts\)\.include\[0\]\(comments\)/;
function refuses(compile: () => unknown, parent: string, child: string) {
	let returned: unknown;
	expect(() => {
		returned = compile();
	}).toThrow(
		new RegExp(`parent strategy ${parent}.*child strategy ${child}.*#894`),
	);
	expect(() => compile()).toThrow(path);
	expect(returned).toBeUndefined();
}
function nestedPlan(
	parent: ResolvedIncludeStrategy,
	child: ResolvedIncludeStrategy,
) {
	const intent = {
		type: 'select' as const,
		from: 'users',
		include: [{ relation: 'posts', include: [{ relation: 'comments' }] }],
	};
	if (parent === child && parent !== 'cte')
		return plan(intent, db.model, { defaultIncludeStrategy: parent });
	const p = plan(intent, db.model);
	return {
		...p,
		decisions: p.decisions.map((d) =>
			d.type === 'include-strategy'
				? {
						...d,
						choice: d.context.intentPath === 'include[0]' ? parent : child,
					}
				: d,
		),
	} as PlanReport;
}
describe('#894 nested strategy refusal', () => {
	for (const parent of strategies)
		for (const child of strategies) {
			if (parent === child && parent !== 'cte') continue;
			it(`refuses external ${parent}→${child} before returning SQL`, () =>
				expect(() => adapter.compile(nestedPlan(parent, child))).toThrow(
					new Error(
						'Includes compile only from a report planned in this process',
					),
				));
		}
	for (const [parent, child] of [
		['join', 'json_agg'],
		['json_agg', 'join'],
		['cte', 'cte'],
	] as const) {
		it(`refuses public ${parent}→${child} before returning SQL`, () =>
			refuses(
				() =>
					orm
						.select('users')
						.withPlanOptions({
							defaultIncludeStrategy: parent === 'join' ? child : parent,
						})
						.include('posts', {
							...(parent === 'join' && { join: 'inner' }),
							include: [
								{
									relation: 'comments',
									...(child === 'join' && { join: 'inner' }),
								},
							],
						})
						.dump(),
				parent,
				child,
			));
	}
	it('refuses recursive + join before returning SQL', () => {
		let returned: unknown;
		expect(() => {
			returned = orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					join: 'inner',
				})
				.dump();
		}).toThrow(
			/include\[0\]\(children\).*recursive includes compile as a CTE.*#894/,
		);
		expect(returned).toBeUndefined();
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'categories',
					include: [
						{
							relation: 'children',
							recursive: {},
							join: 'inner',
						},
					],
				},
				db.model,
			),
		).toThrow(
			/include\[0\]\(children\).*recursive includes compile as a CTE.*#894/,
		);
	});
});
const sameSql: Record<string, string> = {
	join: 'SELECT users.*, posts.id AS "posts.id", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts, comments.id AS "posts.comments.id", comments."postId" AS "posts.comments.postId", comments.id AS "__dbsp_presence_posts.comments" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" LEFT JOIN comments AS comments ON posts.id = comments."postId"',
	json_agg:
		"SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'authorId', __t__.\"authorId\") || jsonb_build_object('comments', COALESCE((SELECT json_agg(jsonb_build_object('id', __t1__.id, 'postId', __t1__.\"postId\") ORDER BY __t1__.id ASC NULLS LAST) FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	lateral:
		'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.__dbsp_presence_posts AS __dbsp_presence_posts, comments_lat_1.id AS "posts.comments.id", comments_lat_1."postId" AS "posts.comments.postId", comments_lat_1."__dbsp_presence_posts.comments" AS "__dbsp_presence_posts.comments" FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0."authorId", posts_inner_0.id AS __dbsp_presence_posts FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.id, comments_inner_1."postId", comments_inner_1.id AS "__dbsp_presence_posts.comments" FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id) AS comments_lat_1 ON true',
};
describe('#894 supported SQL', () => {
	for (const strategy of ['join', 'json_agg', 'lateral'] as const) {
		it(`${strategy}→${strategy} preserves SQL and params`, () => {
			const result = adapter.compile(nestedPlan(strategy, strategy));
			expect(result.sql).toBe(sameSql[strategy]);
			expect(result.parameters).toEqual([]);
		});
	}
	it('object-form join→join preserves both inner joins', () => {
		const result = orm
			.select('users')
			.include('posts', {
				join: 'inner',
				include: [{ relation: 'comments', join: 'inner' }],
			})
			.dump();
		expect(result.sql).toBe(
			'SELECT users.*, posts.id AS "posts.id", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts, comments.id AS "posts.comments.id", comments."postId" AS "posts.comments.postId", comments.id AS "__dbsp_presence_posts.comments" FROM users JOIN posts AS posts ON users.id = posts."authorId" JOIN comments AS comments ON posts.id = comments."postId"',
		);
		expect(result.params).toEqual([]);
	});
});
it.each([10, 20])(
	'#895 external refusal does not read %s decision choices',
	(count) => {
		const issued = plan(
			{
				type: 'select',
				from: 'users',
				include: Array.from({ length: count }, () => ({ relation: 'posts' })),
			},
			db.model,
		);
		let reads = 0;
		const external = {
			...issued,
			decisions: issued.decisions.map((decision) => ({
				...decision,
				get choice() {
					reads++;
					return decision.choice;
				},
			})),
		};
		expect(() => adapter.compile(external)).toThrow(
			new Error('Includes compile only from a report planned in this process'),
		);
		expect(reads).toBe(0);
	},
);

describe('#894 pathless include assignments', () => {
	const pathless = (p: PlanReport): PlanReport => ({
		...p,
		decisions: p.decisions.map((d) => {
			if (d.type !== 'include-strategy') return d;
			const context = { ...d.context };
			delete context.intentPath;
			return { ...d, context };
		}),
	});
	it('refuses nested same-name json_agg→join before extraction', () => {
		const repeated = schema({
			users: { id: { type: 'integer', primaryKey: true } },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('users', {
					unique: true,
					as: 'author',
					inverse: 'children',
				}),
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				postId: ref('posts', { unique: true, as: 'post', inverse: 'children' }),
			},
		} as const);
		const p = plan(
			{
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'children',
						include: [{ relation: 'children', join: 'inner' }],
					},
				],
			},
			repeated.model,
			{ defaultIncludeStrategy: 'json_agg' },
		);
		expect(
			p.decisions
				.filter((d) => d.type === 'include-strategy')
				.map((d) => d.choice),
		).toEqual(['json_agg', 'join']);
		expect(() =>
			createPgCompileOnlyAdapter({ model: repeated.model }).compile(
				pathless(p),
			),
		).toThrow('Includes compile only from a report planned in this process');
	});
	it('refuses sibling same-name includes sharing one pathless decision', () => {
		const p = pathless(nestedPlan('join', 'join'));
		const decision = p.decisions.find((d) => d.type === 'include-strategy');
		expect(decision).toBeDefined();
		expect(() =>
			adapter.compile({
				...p,
				intent: {
					type: 'select',
					from: 'users',
					include: [{ relation: 'posts' }, { relation: 'posts' }],
				},
				decisions: [decision!],
			}),
		).toThrow('Includes compile only from a report planned in this process');
	});
	it('refuses reusing one decision through its relation and alias', () => {
		const p = pathless(nestedPlan('join', 'join'));
		const decision = p.decisions.find((d) => d.type === 'include-strategy');
		expect(decision).toBeDefined();
		expect(() =>
			adapter.compile({
				...p,
				decisions: [
					{
						...decision!,
						context: { ...decision!.context, includeAlias: 'comments' },
					},
				],
			}),
		).toThrow('Includes compile only from a report planned in this process');
	});
	it('refuses unique pathless external assignments', () => {
		expect(() => adapter.compile(pathless(nestedPlan('join', 'join')))).toThrow(
			new Error('Includes compile only from a report planned in this process'),
		);
	});
});

describe('#900 flat strategy precedence', () => {
	it('compiles lateral default throughout a limit-free nested flat chain', () => {
		const p = plan(
			{
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'posts',
						strategy: 'flat',
						include: [{ relation: 'comments', strategy: 'flat' }],
					},
				],
			},
			db.model,
			{
				defaultIncludeStrategy: 'lateral',
				dialectCapabilities: adapter.dialectCapabilities,
			},
		);
		const result = adapter.compile(p);
		expect(result.sql).toBe(
			'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0."authorId" AS "posts.authorId", comments_lat_1.id AS "posts.comments.id", comments_lat_1."postId" AS "posts.comments.postId" FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0."authorId" FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.id, comments_inner_1."postId" FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id) AS comments_lat_1 ON true',
		);
		expect(result.parameters).toEqual([]);
	});
	it('preserves include.where refusal with applicable lateral default', () => {
		const p = plan(
			{
				type: 'select',
				from: 'users',
				include: [{ relation: 'posts', strategy: 'flat', where: or() }],
			},
			db.model,
			{
				defaultIncludeStrategy: 'lateral',
				dialectCapabilities: adapter.dialectCapabilities,
			},
		);
		expect(() => adapter.compile(p)).toThrow(
			new Error(
				'Include where is not supported for strategy lateral at include[0](posts).where (oorabona/db-semantic-planner#892).',
			),
		);
	});
});
