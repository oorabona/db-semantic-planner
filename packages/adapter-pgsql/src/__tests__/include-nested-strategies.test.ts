import { createOrm, or, plan, ref, schema } from '@dbsp/core';
import type {
	IncludeIntent,
	PlanReport,
	ResolvedIncludeStrategy,
} from '@dbsp/types';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	createPgAdapter,
	createPgCompileOnlyAdapter,
} from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
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
const strategies = ['join', 'json_agg', 'subquery', 'lateral', 'cte'] as const;
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
	const p = plan(
		{
			type: 'select',
			from: 'users',
			include: [{ relation: 'posts', include: [{ relation: 'comments' }] }],
		},
		db.model,
	);
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
			it(`refuses planned ${parent}→${child} before returning SQL`, () =>
				refuses(
					() => adapter.compile(nestedPlan(parent, child)),
					parent,
					child,
				));
		}
	for (const [parent, child] of [
		['join', 'json_agg'],
		['json_agg', 'join'],
		['join', 'subquery'],
		['subquery', 'join'],
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
	join: 'SELECT users.*, posts.id AS "posts.id", comments.id AS "comments.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" LEFT JOIN comments AS comments ON posts.id = comments."postId"',
	json_agg:
		"SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('comments', COALESCE((SELECT json_agg(to_jsonb(__t1__) ORDER BY __t1__.id ASC NULLS LAST) FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	subquery:
		"SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('comments', COALESCE((SELECT json_agg(to_jsonb(__t1__) ORDER BY __t1__.id ASC NULLS LAST) FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	lateral:
		'SELECT users.*, posts_lat_0.*, comments_lat_1.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.* FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id) AS comments_lat_1 ON true',
};
describe('#894 supported SQL', () => {
	for (const strategy of ['join', 'json_agg', 'subquery', 'lateral'] as const) {
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
			'SELECT users.*, posts.id AS "posts.id", comments.id AS "comments.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" JOIN comments AS comments ON posts.id = comments."postId"',
		);
		expect(result.params).toEqual([]);
	});
	it('subquery→subquery fetches children by post keys and attaches under posts', async () => {
		const query = vi.fn<
			(
				sql: string,
				params?: unknown[],
			) => Promise<{ rows: Record<string, number>[] }>
		>(async (sql) => ({
			rows: sql.startsWith('SELECT * FROM comments')
				? [{ id: 100, postId: 10 }]
				: sql.startsWith('SELECT * FROM posts')
					? [{ id: 10, authorId: 1 }]
					: [{ id: 1 }],
		}));
		const executionOrm = createOrm({
			schema: db,
			adapter: createPgAdapter({ query } as unknown as Pool, {
				model: db.model,
			}),
		});
		const rows = await executionOrm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
			.include('posts', { include: [{ relation: 'comments' }] })
			.all();
		expect(query.mock.calls[1]).toEqual([
			'SELECT * FROM posts WHERE "authorId" IN ($1)',
			[1],
		]);
		expect(query.mock.calls[2]).toEqual([
			'SELECT * FROM comments WHERE "postId" IN ($1)',
			[10],
		]);
		expect(rows).toEqual([
			{
				id: 1,
				posts: [{ id: 10, authorId: 1, comments: [{ id: 100, postId: 10 }] }],
			},
		]);
	});
});
it('#895 preflight accesses include predicates linearly', () => {
	const accesses = (count: number) => {
		let reads = 0;
		const includes: IncludeIntent[] = Array.from({ length: count }, () => ({
			relation: 'posts',
		}));
		const p = plan(
			{ type: 'select', from: 'users', include: includes },
			db.model,
			{ defaultIncludeStrategy: 'subquery' },
		);
		const decisions = p.decisions.map((d) =>
			d.type === 'include-strategy'
				? {
						...d,
						get choice() {
							reads++;
							return d.choice;
						},
					}
				: d,
		);
		// Refuse at the last include, after all preflight lookups but before SQL lowering.
		const last = includes[count - 1]!;
		Object.defineProperty(last, 'where', { value: or() });
		const lookups = vi.spyOn(Map.prototype, 'get');
		try {
			expect(() => adapter.compile({ ...p, decisions })).toThrow(
				/strategy subquery.*#892/,
			);
			expect(
				lookups.mock.calls.filter(
					([key]) => typeof key === 'string' && /^include\[\d+\]$/.test(key),
				),
			).toHaveLength(count);
		} finally {
			lookups.mockRestore();
		}
		return reads;
	};
	expect(accesses(10)).toBe(10);
	expect(accesses(20)).toBe(20);
});
