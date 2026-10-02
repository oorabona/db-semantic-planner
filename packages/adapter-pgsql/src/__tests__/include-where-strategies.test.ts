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
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	postLinks: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users'),
		postId: ref('posts'),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
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
				`SELECT users.*, posts.id AS "posts.id" FROM users ${join === 'inner' ? 'JOIN' : 'LEFT JOIN'} posts AS posts ON users.id = posts."authorId" WHERE users."tenantId" = $1 AND false`,
			);
			expect(result.params).toEqual([1]);
		});
	}
});
const fixtures: Record<string, { sql: string; params: unknown[] }> = {
	'inner published': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'inner empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'inner empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
	'left published': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'left empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'left empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
};

describe('#888 non-join include refusal', () => {
	for (const strategy of ['json_agg', 'subquery', 'lateral', 'cte'] as const) {
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
	for (const through of [undefined, 'postLinks']) {
		for (const ids of [[], [1, 2]]) {
			it(`refuses direct ${through ? 'M:N' : 'batch'} where with ${ids.length} parents`, () => {
				expect(() =>
					adapter.compileSubqueryInclude(
						{
							relationName: 'posts',
							targetTable: 'posts',
							sourceKey: 'id',
							foreignKey: 'authorId',
							...(through && {
								through,
								throughSourceKey: 'userId',
								throughTargetKey: 'postId',
							}),
							where: or(),
						},
						ids,
					),
				).toThrow(/strategy subquery.*include\(posts\).*#892/);
			});
		}
	}
});

// Captured by compiling these same inputs with the source at 1ff4fb15.
const mainSql = {
	json_agg:
		'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), \'[]\'::json) AS posts_json FROM users',
	subquery: 'SELECT users.* FROM users',
	lateral:
		'SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true',
	cte: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId"',
	join: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
	batch: 'SELECT * FROM posts WHERE "authorId" IN ($1, $2)',
	'M:N':
		'SELECT t.* FROM posts AS t JOIN "postLinks" AS j ON t.id = j."postId" WHERE j."userId" IN ($1, $2)',
};
describe('#888 includes without where preserve main SQL', () => {
	for (const strategy of [
		'json_agg',
		'subquery',
		'lateral',
		'cte',
		'join',
	] as const) {
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
	for (const through of [undefined, 'postLinks']) {
		it(`${through ? 'M:N' : 'batch'} without where matches main`, () => {
			const result = adapter.compileSubqueryInclude(
				{
					relationName: 'posts',
					targetTable: 'posts',
					sourceKey: 'id',
					foreignKey: 'authorId',
					...(through && {
						through,
						throughSourceKey: 'userId',
						throughTargetKey: 'postId',
					}),
				},
				[1, 2],
			);
			expect(result.sql).toBe(mainSql[through ? 'M:N' : 'batch']);
			expect(result.parameters).toEqual([1, 2]);
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
			userId: ref('users', { inverse: 'posts', through: true }),
			postId: ref('posts', { inverse: 'users', through: true }),
		},
	} as const);
	const manyOrm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(() =>
		manyOrm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
			.include('posts', { where: eq('published', true) })
			.dump(),
	).toThrow(/strategy subquery.*include\[0\]\(posts\).*#892/);
});
