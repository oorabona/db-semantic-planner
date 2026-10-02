import { and, createOrm, eq, gt, or, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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
const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
const orm = createOrm({
	schema: testSchema,
	adapter,
});
const strategies = [
	'json_agg',
	'subquery',
	'lateral',
	'cte',
	'inner',
	'left',
] as const;
describe('#888 include where strategies', () => {
	for (const strategy of strategies) {
		const query = () =>
			orm.select('users').withPlanOptions({
				defaultIncludeStrategy:
					strategy === 'inner' || strategy === 'left' ? 'join' : strategy,
			});
		const join =
			strategy === 'inner' || strategy === 'left' ? { join: strategy } : {};
		const cases = {
			published: () =>
				query()
					.include('posts', { ...join, where: eq('published', true) })
					.dump(),
			'score with root parameter': () =>
				query()
					.where(eq('tenantId', 1))
					.include('posts', { ...join, where: gt('score', 3) })
					.dump(),
			'empty and': () =>
				query()
					.include('posts', { ...join, where: and() })
					.dump(),
			'empty or': () =>
				query()
					.include('posts', { ...join, where: or() })
					.dump(),
			nested: () =>
				query()
					.include('posts', {
						...join,
						include: [
							{ relation: 'comments', ...join, where: eq('published', true) },
						],
					})
					.dump(),
		};
		for (const [name, run] of Object.entries(cases))
			it(`${strategy} ${name}`, () => {
				const result = run();
				const expected = fixtures[`${strategy} ${name}`]!;
				expect(result.sql).toBe(expected.sql);
				expect(result.params).toEqual(expected.params);
			});
	}
});

const fixtures: Record<string, { sql: string; params: unknown[] }> = {
	'json_agg published': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__.published = $1), \'[]\'::json) AS posts_json FROM users',
		params: [true],
	},
	'json_agg score with root parameter': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__.score > $2), \'[]\'::json) AS posts_json FROM users WHERE users."tenantId" = $1',
		params: [1, 3],
	},
	'json_agg empty and': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND true), \'[]\'::json) AS posts_json FROM users',
		params: [],
	},
	'json_agg empty or': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND false), \'[]\'::json) AS posts_json FROM users',
		params: [],
	},
	'json_agg nested': {
		sql: "SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('comments', COALESCE((SELECT json_agg(to_jsonb(__t1__) ORDER BY __t1__.id ASC NULLS LAST) FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id AND __t1__.published = $1), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
		params: [true],
	},
	'subquery published': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__.published = $1), \'[]\'::json) AS posts_json FROM users',
		params: [true],
	},
	'subquery score with root parameter': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__.score > $2), \'[]\'::json) AS posts_json FROM users WHERE users."tenantId" = $1',
		params: [1, 3],
	},
	'subquery empty and': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND true), \'[]\'::json) AS posts_json FROM users',
		params: [],
	},
	'subquery empty or': {
		sql: 'SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND false), \'[]\'::json) AS posts_json FROM users',
		params: [],
	},
	'subquery nested': {
		sql: "SELECT users.*, COALESCE((SELECT json_agg(to_jsonb(__t__) || jsonb_build_object('comments', COALESCE((SELECT json_agg(to_jsonb(__t1__) ORDER BY __t1__.id ASC NULLS LAST) FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id AND __t1__.published = $1), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
		params: [true],
	},
	'lateral published': {
		sql: 'SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id AND posts_inner_0.published = $1) AS posts_lat_0 ON true',
		params: [true],
	},
	'lateral score with root parameter': {
		sql: 'SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id AND posts_inner_0.score > $2) AS posts_lat_0 ON true WHERE users."tenantId" = $1',
		params: [1, 3],
	},
	'lateral empty and': {
		sql: 'SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id AND true) AS posts_lat_0 ON true',
		params: [],
	},
	'lateral empty or': {
		sql: 'SELECT users.*, posts_lat_0.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id AND false) AS posts_lat_0 ON true',
		params: [],
	},
	'lateral nested': {
		sql: 'SELECT users.*, posts_lat_0.*, comments_lat_1.* FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0."authorId" = users.id) AS posts_lat_0 ON true LEFT JOIN LATERAL (SELECT comments_inner_1.* FROM comments AS comments_inner_1 WHERE comments_inner_1."postId" = posts_lat_0.id AND comments_inner_1.published = $1) AS comments_lat_1 ON true',
		params: [true],
	},
	'cte published': {
		sql: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0.published = $1) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId"',
		params: [true],
	},
	'cte score with root parameter': {
		sql: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0.score > $2) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId" WHERE users."tenantId" = $1',
		params: [1, 3],
	},
	'cte empty and': {
		sql: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE true) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId"',
		params: [],
	},
	'cte empty or': {
		sql: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE false) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId"',
		params: [],
	},
	'cte nested': {
		sql: 'WITH posts_cte AS (SELECT posts_inner_0.* FROM posts AS posts_inner_0), comments_cte AS (SELECT comments_inner_0.* FROM comments AS comments_inner_0 WHERE comments_inner_0.published = $1) SELECT users.* FROM users LEFT JOIN posts_cte AS posts_ref_0 ON users.id = posts_ref_0."authorId" LEFT JOIN comments_cte AS comments_ref_0 ON posts_ref_0.id = comments_ref_0."postId"',
		params: [true],
	},
	'inner published': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'inner score with root parameter': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE users."tenantId" = $1 AND posts.score > $2',
		params: [1, 3],
	},
	'inner empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'inner empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
	'inner nested': {
		sql: 'SELECT users.*, posts.id AS "posts.id", comments.id AS "comments.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" JOIN comments AS comments ON posts.id = comments."postId" WHERE comments.published = $1',
		params: [true],
	},
	'left published': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.published = $1',
		params: [true],
	},
	'left score with root parameter': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE users."tenantId" = $1 AND posts.score > $2',
		params: [1, 3],
	},
	'left empty and': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE true',
		params: [],
	},
	'left empty or': {
		sql: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE false',
		params: [],
	},
	'left nested': {
		sql: 'SELECT users.*, posts.id AS "posts.id", comments.id AS "comments.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" LEFT JOIN comments AS comments ON posts.id = comments."postId" WHERE comments.published = $1',
		params: [true],
	},
};

describe('#888 batch subquery include where', () => {
	for (const [name, where, predicate, params] of [
		['published', eq('published', true), 'posts.published = $3', [1, 2, true]],
		['score', gt('score', 3), 'posts.score > $3', [1, 2, 3]],
		['empty and', and(), 'true', [1, 2]],
		['empty or', or(), 'false', [1, 2]],
	] as const)
		it(name, () => {
			const plan = orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
				.include('posts', { where })
				.plan();
			const { subqueryIncludes } = adapter.compileWithIncludes(plan);
			expect(subqueryIncludes).toHaveLength(1);
			const result = adapter.compileSubqueryInclude(
				subqueryIncludes[0]!,
				[1, 2],
			);
			expect(result.sql).toBe(
				`SELECT * FROM posts WHERE "authorId" IN ($1, $2) AND ${predicate}`,
			);
			expect(result.parameters).toEqual(params);
		});
	it('nested where survives subquery info extraction', () => {
		const plan = orm
			.select('users')
			.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
			.include('posts', {
				include: [{ relation: 'comments', where: eq('published', true) }],
			})
			.plan();
		const { subqueryIncludes } = adapter.compileWithIncludes(plan);
		expect(subqueryIncludes).toHaveLength(1);
		const comments = subqueryIncludes[0]?.nestedIncludes?.[0];
		expect(comments?.where).toEqual(eq('published', true));
		const result = adapter.compileSubqueryInclude(comments!, [11]);
		expect(result.sql).toBe(
			'SELECT * FROM comments WHERE "postId" IN ($1) AND comments.published = $2',
		);
		expect(result.parameters).toEqual([11, true]);
	});
});

describe('#888 many-to-many batch subquery include where', () => {
	for (const [name, where, predicate, params] of [
		['published', eq('published', true), 't.published = $3', [1, 2, true]],
		['score', gt('score', 3), 't.score > $3', [1, 2, 3]],
		['empty and', and(), 'true', [1, 2]],
		['empty or', or(), 'false', [1, 2]],
	] as const)
		it(name, () => {
			const result = adapter.compileSubqueryInclude(
				{
					relationName: 'posts',
					targetTable: 'posts',
					sourceKey: 'id',
					foreignKey: 'id',
					through: 'postLinks',
					throughSourceKey: 'userId',
					throughTargetKey: 'postId',
					where,
				},
				[1, 2],
			);
			expect(result.sql).toBe(
				`SELECT t.* FROM posts AS t JOIN "postLinks" AS j ON t.id = j."postId" WHERE j."userId" IN ($1, $2) AND ${predicate}`,
			);
			expect(result.parameters).toEqual(params);
		});
});
