import { createOrm, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogModel,
	blogSchema,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	sql,
} from './testkit/index.js';

const SCHEMA = 'include_limit_e2e';
const rankModel = schema({
	...blogSchema.definition,
	posts: {
		...blogSchema.definition.posts,
		rank: { type: 'integer', nullable: true },
	},
}).model;
beforeAll(async () => {
	await dropBlogSchema(SCHEMA);
	await createBlogSchema(SCHEMA);
	const pool = await getTestPool();
	await sql`ALTER TABLE ${sql.ref(SCHEMA)}.posts ADD COLUMN rank integer`.execute(
		pool,
	);
	await sql`INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email) VALUES (1, 'Empty', 'empty@example.com'), (2, 'One', 'one@example.com'), (3, 'Four', 'four@example.com')`.execute(
		pool,
	);
	await sql`INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, author_id, created_at) VALUES (10, 'Only', 2, '2026-01-01'), (20, 'Old', 3, '2026-01-01'), (21, 'Middle', 3, '2026-01-02'), (23, 'Newest tied second', 3, '2026-01-03'), (22, 'Newest tied first', 3, '2026-01-03')`.execute(
		pool,
	);
	await sql`INSERT INTO ${sql.ref(SCHEMA)}.comments (id, post_id, author_name, content) VALUES (1, 20, 'A', 'Excluded post'), (2, 22, 'A', 'First selected'), (3, 22, 'A', 'Extra child'), (4, 23, 'A', 'Second selected')`.execute(
		pool,
	);
	await sql`UPDATE ${sql.ref(SCHEMA)}.posts SET rank = CASE id WHEN 10 THEN 1 WHEN 20 THEN 2 WHEN 21 THEN NULL WHEN 22 THEN 4 WHEN 23 THEN 3 END`.execute(
		pool,
	);
});
afterAll(async () => {
	await dropBlogSchema(SCHEMA);
	await closeTestDb();
});

describe('json_agg per-parent limit', () => {
	it('hydrates exactly zero, one and two ordered posts', async () => {
		const orm = createOrm({
			model: blogModel,
			adapter: await getTestAdapter(),
		}).withSchema(SCHEMA);
		const rows = await orm
			.select('authors')
			.columns(['id', 'name'])
			.orderBy('id')
			.include('posts', {
				limit: 2,
				orderBy: [{ field: 'createdAt', direction: 'desc' }],
				select: { type: 'fields', fields: ['id', 'title'] },
			})
			.execute();
		expect(rows).toEqual([
			{ id: 1, name: 'Empty', posts: [] },
			{ id: 2, name: 'One', posts: [{ id: 10, title: 'Only' }] },
			{
				id: 3,
				name: 'Four',
				posts: [
					{ id: 22, title: 'Newest tied first' },
					{ id: 23, title: 'Newest tied second' },
				],
			},
		]);
	});
	it('hydrates limited children only beneath selected posts', async () => {
		const orm = createOrm({
			model: blogModel,
			adapter: await getTestAdapter(),
		}).withSchema(SCHEMA);
		const rows = await orm
			.select('authors')
			.columns(['id'])
			.orderBy('id')
			.include('posts', {
				limit: 2,
				orderBy: [{ field: 'createdAt', direction: 'desc' }],
				select: { type: 'fields', fields: ['id'] },
				include: [
					{
						relation: 'comments',
						limit: 1,
						select: { type: 'fields', fields: ['id', 'content'] },
					},
				],
			})
			.execute();
		expect(rows).toEqual([
			{ id: 1, posts: [] },
			{ id: 2, posts: [{ id: 10, comments: [] }] },
			{
				id: 3,
				posts: [
					{ id: 22, comments: [{ id: 2, content: 'First selected' }] },
					{ id: 23, comments: [{ id: 4, content: 'Second selected' }] },
				],
			},
		]);
	});
});

it('DESC limit honours PostgreSQL NULLS FIRST by default', async () => {
	const orm = createOrm({
		model: rankModel,
		adapter: await getTestAdapter(),
	}).withSchema(SCHEMA);
	const rows = await orm
		.select('authors')
		.columns(['id'])
		.orderBy('id')
		.include('posts', {
			limit: 1,
			orderBy: [{ field: 'rank', direction: 'desc' }],
			select: { type: 'fields', fields: ['id'] },
		})
		.execute();
	expect(rows).toEqual([
		{ id: 1, posts: [] },
		{ id: 2, posts: [{ id: 10 }] },
		{ id: 3, posts: [{ id: 21 }] },
	]);
});
it('lateral orders the top row independently per parent', async () => {
	const orm = createOrm({
		model: rankModel,
		adapter: await getTestAdapter(),
	}).withSchema(SCHEMA);
	const dump = orm
		.select('authors')
		.columns(['name'])
		.orderBy('id')
		.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
		.include('posts', {
			limit: 1,
			orderBy: [{ field: 'rank', direction: 'desc' }],
		})
		.dump();
	expect(dump.sql).toBe(
		'SELECT authors.name, posts_lat_0.id AS "posts.id", posts_lat_0.title AS "posts.title", posts_lat_0.content AS "posts.content", posts_lat_0.author_id AS "posts.authorId", posts_lat_0.published AS "posts.published", posts_lat_0.created_at AS "posts.createdAt", posts_lat_0.rank AS "posts.rank", posts_lat_0.__dbsp_presence_posts AS __dbsp_presence_posts FROM include_limit_e2e.authors LEFT JOIN LATERAL (SELECT posts_inner_0.id, posts_inner_0.title, posts_inner_0.content, posts_inner_0.author_id, posts_inner_0.published, posts_inner_0.created_at, posts_inner_0.rank, posts_inner_0.id AS __dbsp_presence_posts FROM include_limit_e2e.posts AS posts_inner_0 WHERE posts_inner_0.author_id = authors.id ORDER BY posts_inner_0.rank DESC, posts_inner_0.id ASC NULLS LAST LIMIT 1) AS posts_lat_0 ON true ORDER BY authors.id ASC',
	);
	const pool = await getTestPool();
	const { rows } = await pool.query(dump.sql, [...dump.params]);
	expect(
		rows.map((row) => ({ name: row.name, postId: row['posts.id'] })),
	).toEqual([
		{ name: 'Empty', postId: null },
		{ name: 'One', postId: 10 },
		{ name: 'Four', postId: 21 },
	]);
});
