import { createOrm, eq } from '@dbsp/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	sql,
} from './testkit/index.js';

const SCHEMA = 'include_subquery_e2e';
beforeAll(async () => {
	await dropBlogSchema(SCHEMA);
	await createBlogSchema(SCHEMA);
});
afterAll(async () => {
	await dropBlogSchema(SCHEMA);
	await closeTestDb();
});

it('subquery includes return exactly selected columns at top and nested levels', async () => {
	const pool = await getTestPool();
	await sql`
		INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
		VALUES (961001, 'Subquery Probe', 'subquery@example.com')
	`.execute(pool);
	await sql`
		INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
		VALUES (961101, 'Selected title', 'Unselected content', 961001, true)
	`.execute(pool);
	await sql`
		INSERT INTO ${sql.ref(SCHEMA)}.comments (id, post_id, author_name, content)
		VALUES (961201, 961101, 'Unselected author', 'Selected comment')
	`.execute(pool);
	const adapter = await getTestAdapter();
	const orm = createOrm({ model: blogModel, adapter }).withSchema(SCHEMA);
	const top = orm
		.select('authors')
		.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
		.columns(['id'])
		.where(eq('id', 961001))
		.include('posts', { select: { type: 'fields', fields: ['title'] } });
	expect(top.dump().sql).toBe(
		'SELECT authors.id FROM include_subquery_e2e.authors WHERE authors.id = $1',
	);
	expect(top.dump().params).toEqual([961001]);
	expect(await top.all()).toEqual([
		{ id: 961001, posts: [{ title: 'Selected title' }] },
	]);
	const nested = orm
		.select('authors')
		.withPlanOptions({ defaultIncludeStrategy: 'subquery' })
		.columns(['id'])
		.where(eq('id', 961001))
		.include('posts', {
			select: { type: 'fields', fields: ['title'] },
			include: [
				{
					relation: 'comments',
					select: { type: 'fields', fields: ['content'] },
				},
			],
		});
	expect(nested.dump().sql).toBe(top.dump().sql);
	expect(nested.dump().params).toEqual([961001]);
	expect(await nested.all()).toEqual([
		{
			id: 961001,
			posts: [
				{
					title: 'Selected title',
					comments: [{ content: 'Selected comment' }],
				},
			],
		},
	]);
});
