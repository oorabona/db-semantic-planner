import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	sql,
} from './testkit/index.js';

const SCHEMA = 'include_ordering_e2e';

beforeAll(async () => {
	await dropBlogSchema(SCHEMA);
	await createBlogSchema(SCHEMA);
});

afterAll(async () => {
	await dropBlogSchema(SCHEMA);
	await closeTestDb();
});

describe('include json_agg ordering', () => {
	it('returns hasMany include arrays in target primary-key order', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: blogModel, adapter }).withSchema(SCHEMA);
		const authorId = 960_001;
		const laterPostId = 960_102;
		const earlierPostId = 960_101;

		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${authorId}, ${'Order Probe'}, ${'include-order@example.com'})
		`.execute(pool);
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts
				(id, title, content, author_id, published, created_at)
			VALUES
				(${laterPostId}, ${'Inserted first'}, ${'later id'}, ${authorId}, ${true}, NOW()),
				(${earlierPostId}, ${'Inserted second'}, ${'earlier id'}, ${authorId}, ${true}, NOW())
		`.execute(pool);

		const query = orm
			.select('authors')
			.include('posts')
			.where(eq('id', authorId))
			.columns(['id', 'name']);
		const dump = query.dump();
		const rows = (await query.execute()) as Array<{
			id: number;
			name: string;
			posts: Array<{ id: number; title: string }>;
		}>;

		expect(dump.sql).toContain('ORDER BY __t__.id ASC NULLS LAST');
		expect(rows).toHaveLength(1);
		expect(rows[0]?.posts.map((post) => post.id)).toEqual([
			earlierPostId,
			laterPostId,
		]);
	});
});
