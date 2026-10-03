import {
	createOrm,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { inverse: 'posts' }),
		createdAt: 'timestamp',
		title: 'text',
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts', { inverse: 'comments' }),
	},
}).model;
const orm = createOrm({ model, adapter: createPgCompileOnlyAdapter() });
describe('limited json_agg includes', () => {
	for (const select of [
		{ type: 'expressions', columns: [] },
		{ type: 'aggregate', aggregates: [{ function: 'count' }] },
	] as const) {
		for (const limit of [undefined, 2]) {
			it(`refuses ${select.type} select with limit ${limit}`, () => {
				expect(() =>
					orm
						.select('users')
						.include('posts', {
							select,
							...(limit !== undefined && { limit }),
						})
						.dump(),
				).toThrow(
					`JSON_AGG include 'posts' does not support select form '${select.type}'`,
				);
			});
		}
		it(`refuses nested ${select.type} select`, () => {
			expect(() =>
				orm
					.select('users')
					.include('posts', {
						include: [{ relation: 'comments', select }],
					})
					.dump(),
			).toThrow(
				`JSON_AGG include 'posts.comments' does not support select form '${select.type}'`,
			);
		});
	}

	it('projects select without limit', () => {
		const dump = orm
			.select('users')
			.include('posts', { select: { type: 'fields', fields: ['title'] } })
			.dump();
		expect(dump.sql).toBe(
			`SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('title', __t__.title) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), '[]'::json) AS posts_json FROM users`,
		);
		expect(dump.params).toEqual([]);
	});
	it('projects select with limit without exposing ordering keys', () => {
		const dump = orm
			.select('users')
			.include('posts', {
				select: { type: 'fields', fields: ['id', 'title'] },
				limit: 2,
				orderBy: [{ field: 'createdAt', direction: 'desc' }],
			})
			.dump();
		expect(dump.sql).toBe(
			`SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC, __lim.__key1 ASC NULLS LAST) FROM (SELECT jsonb_build_object('id', __t__.id, 'title', __t__.title) AS __row, __t__."createdAt" AS __key0, __t__.id AS __key1 FROM posts AS __t__ WHERE __t__."authorId" = users.id ORDER BY __t__."createdAt" DESC, __t__.id ASC NULLS LAST LIMIT 2) AS __lim), '[]'::json) AS posts_json FROM users`,
		);
		expect(dump.params).toEqual([]);
	});
	it('projects select and nested include independently', () => {
		const dump = orm
			.select('users')
			.include('posts', {
				select: { type: 'fields', fields: ['id'] },
				limit: 2,
				include: [
					{
						relation: 'comments',
						select: { type: 'fields', fields: ['id'] },
						limit: 1,
					},
				],
			})
			.dump();
		expect(dump.sql).toBe(
			`SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 ASC NULLS LAST) FROM (SELECT jsonb_build_object('id', __t__.id) || jsonb_build_object('comments', COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 ASC NULLS LAST) FROM (SELECT jsonb_build_object('id', __t1__.id) AS __row, __t1__.id AS __key0 FROM comments AS __t1__ WHERE __t1__."postId" = __t__.id ORDER BY __t1__.id ASC NULLS LAST LIMIT 1) AS __lim), '[]'::json)) AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__."authorId" = users.id ORDER BY __t__.id ASC NULLS LAST LIMIT 2) AS __lim), '[]'::json) AS posts_json FROM users`,
		);
		expect(dump.params).toEqual([]);
	});
	it('keeps select all identical to an omitted select', () => {
		const all = orm
			.select('users')
			.include('posts', { select: { type: 'all' } })
			.dump();
		expect(all.sql).toBe(orm.select('users').include('posts').dump().sql);
		expect(all.params).toEqual([]);
	});
	it('projects an empty fields selection as empty objects', () => {
		const dump = orm
			.select('users')
			.include('posts', { select: { type: 'fields', fields: [] } })
			.dump();
		expect(dump.sql).toBe(
			`SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object() ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id), '[]'::json) AS posts_json FROM users`,
		);
		expect(dump.params).toEqual([]);
	});
	it('carries limited IncludeIntent ordering through planning and extraction', () => {
		const report = plan(
			{
				type: 'select',
				from: 'users',
				include: [
					{
						relation: 'posts',
						limit: 2,
						orderBy: [{ field: 'createdAt', direction: 'desc', nulls: 'last' }],
					},
				],
			},
			model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const compiled = createPgCompileOnlyAdapter({ model }).compile(report, {
			model,
		});
		expect(compiled.sql).toBe(
			'SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC NULLS LAST, __lim.__key1 ASC NULLS LAST) FROM (SELECT jsonb_build_object(\'id\', __t__.id, \'authorId\', __t__."authorId", \'createdAt\', __t__."createdAt", \'title\', __t__.title) AS __row, __t__."createdAt" AS __key0, __t__.id AS __key1 FROM posts AS __t__ WHERE __t__."authorId" = users.id ORDER BY __t__."createdAt" DESC NULLS LAST, __t__.id ASC NULLS LAST LIMIT 2) AS __lim), \'[]\'::json) AS posts_json FROM users',
		);
		expect(compiled.parameters).toEqual([]);
	});
	it('limits ordered rows before aggregation', () => {
		const dump = orm
			.select('users')
			.include('posts', {
				limit: 2,
				orderBy: [{ field: 'createdAt', direction: 'desc', nulls: 'last' }],
			})
			.dump();
		expect(dump.sql).toBe(
			'SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC NULLS LAST, __lim.__key1 ASC NULLS LAST) FROM (SELECT jsonb_build_object(\'id\', __t__.id, \'authorId\', __t__."authorId", \'createdAt\', __t__."createdAt", \'title\', __t__.title) AS __row, __t__."createdAt" AS __key0, __t__.id AS __key1 FROM posts AS __t__ WHERE __t__."authorId" = users.id ORDER BY __t__."createdAt" DESC NULLS LAST, __t__.id ASC NULLS LAST LIMIT 2) AS __lim), \'[]\'::json) AS posts_json FROM users',
		);
		expect(dump.params).toEqual([]);
	});
	it('limits nested children inside selected rows', () => {
		const dump = orm
			.select('users')
			.include('posts', {
				limit: 2,
				include: [
					{
						relation: 'comments',
						limit: 1,
						orderBy: [{ field: 'id', direction: 'desc' }],
					},
				],
			})
			.dump();
		expect(dump.sql).toBe(
			"SELECT users.*, COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 ASC NULLS LAST) FROM (SELECT jsonb_build_object('id', __t__.id, 'authorId', __t__.\"authorId\", 'createdAt', __t__.\"createdAt\", 'title', __t__.title) || jsonb_build_object('comments', COALESCE((SELECT json_agg(__lim.__row ORDER BY __lim.__key0 DESC) FROM (SELECT jsonb_build_object('id', __t1__.id, 'postId', __t1__.\"postId\") AS __row, __t1__.id AS __key0 FROM comments AS __t1__ WHERE __t1__.\"postId\" = __t__.id ORDER BY __t1__.id DESC LIMIT 1) AS __lim), '[]'::json)) AS __row, __t__.id AS __key0 FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id ORDER BY __t__.id ASC NULLS LAST LIMIT 2) AS __lim), '[]'::json) AS posts_json FROM users",
		);
		expect(dump.params).toEqual([]);
	});
});
