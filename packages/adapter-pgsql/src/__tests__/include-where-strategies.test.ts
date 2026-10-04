import { and, createOrm, eq, or, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		tenantId: { type: 'integer' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		score: { type: 'integer' },
		authorId: ref('users', { unique: true, as: 'author', inverse: 'posts' }),
	},
	postLinks: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users'),
		postId: ref('posts'),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		postId: ref('posts', { unique: true, as: 'post', inverse: 'comments' }),
	},
} as const);
const adapter = createPgCompileOnlyAdapter({ model: testSchema.model });
const orm = createOrm({
	schema: testSchema,
	adapter,
});

const strategies = ['inner', 'left'] as const;
describe('#888 join include where strategies', () => {
	for (const join of strategies) {
		for (const [name, where] of [
			['published', eq('published', true)],
			['empty and', and()],
			['empty or', or()],
		] as const) {
			it(`${join} ${name}`, () => {
				const result = orm
					.select('users')
					.include('posts', { join, where })
					.dump();
				expect(result.sql).toBe(fixtures[`${join} ${name}`]!.sql);
				expect(result.params).toEqual(fixtures[`${join} ${name}`]!.params);
			});
		}
		it(`${join} empty OR stays in root WHERE with root parameter`, () => {
			const result = orm
				.select('users')
				.where(eq('tenantId', 1))
				.include('posts', { join, where: or() })
				.dump();
			expect(result.sql).toBe(
				`SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users ${join === 'inner' ? 'JOIN' : 'LEFT JOIN'} posts AS posts ON users.id = posts."authorId" WHERE users."tenantId" = $1 AND false`,
			);
			expect(result.params).toEqual([1]);
		});
	}
});
const fixtures: Record<string, { sql: string; params: unknown[] }> = {
	'inner published': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'inner empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'inner empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
	'left published': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'left empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'left empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
};

describe('#888 non-join include refusal', () => {
	for (const strategy of ['json_agg', 'lateral', 'cte'] as const) {
		for (const [name, where] of [
			['comparison', eq('published', true)],
			['empty OR', or()],
		] as const) {
			it(`refuses ${strategy} ${name} before returning SQL`, () => {
				expect(() =>
					orm
						.select('users')
						.withPlanOptions({ defaultIncludeStrategy: strategy })
						.include('posts', { where })
						.dump(),
				).toThrow(
					new RegExp(`strategy ${strategy}.*include\\[0\\]\\(posts\\).*#892`),
				);
			});
		}
	}
	for (const join of [undefined, 'inner'] as const) {
		it(`refuses nested where under ${join ?? 'json_agg'} parent`, () => {
			expect(() =>
				orm
					.select('users')
					.include('posts', {
						...(join && { join }),
						include: [{ relation: 'comments', where: or() }],
					})
					.dump(),
			).toThrow(
				join
					? /include\[0\]\(posts\).*include\[0\]\(comments\).*parent strategy join.*child strategy json_agg.*#894/
					: /strategy json_agg.*include\[0\]\(posts\).*include\[0\]\(comments\).*#892/,
			);
		});
	}
});

// Captured by compiling these same inputs with the source at 1ff4fb15.
const mainSql = {
	json_agg:
		"SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'published', __t__.published, 'score', __t__.score, 'authorId', __t__.\"authorId\") ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	lateral:
		'SELECT users.*, posts_lat_0.id AS "posts.id", posts_lat_0.published AS "posts.published", posts_lat_0.score AS "posts.score", posts_lat_0."authorId" AS "posts.authorId", posts_lat_0.__dbsp_presence_posts AS __dbsp_presence_posts FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0.published, posts_inner_0.score, posts_inner_0."authorId", posts_inner_0.id AS __dbsp_presence_posts FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true',
	cte: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId"',
	join: 'SELECT users.*, posts.id AS "posts.id", posts.published AS "posts.published", posts.score AS "posts.score", posts."authorId" AS "posts.authorId", posts.id AS __dbsp_presence_posts FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
};
describe('#888 includes without where preserve main SQL', () => {
	for (const strategy of ['json_agg', 'lateral', 'cte', 'join'] as const) {
		it(`${strategy} without where matches main`, () => {
			const result = orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.include('posts')
				.dump();
			expect(result.sql).toBe(mainSql[strategy]);
			expect(result.params).toEqual([]);
		});
	}
});
it('refuses default include where through compile-only all', async () => {
	await expect(
		orm.select('users').include('posts', { where: or() }).all(),
	).rejects.toThrow(/strategy json_agg.*include\[0\]\(posts\).*#892/);
});
it('refuses public M:N include where', () => {
	const db = schema({
		users: { id: { type: 'integer', primaryKey: true } },
		posts: {
			id: { type: 'integer', primaryKey: true },
			published: { type: 'boolean' },
		},
		links: {
			userId: ref('users', { unique: true, inverse: 'posts', through: true }),
			postId: ref('posts', { unique: true, inverse: 'users', through: true }),
		},
	} as const);
	const manyOrm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(() =>
		manyOrm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'json_agg' })
			.include('posts', { where: eq('published', true) })
			.dump(),
	).toThrow(/strategy json_agg.*include\[0\]\(posts\).*#892/);
});
