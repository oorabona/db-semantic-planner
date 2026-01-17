/**
 * Q5: Blog Scenario - Basic Query Patterns
 *
 * Tests fundamental query patterns using the blog schema:
 * - Simple entity queries
 * - Basic filtering
 * - Multi-entity queries
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, createOrm, eq, exists } from '@dbsp/core';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	seedBlogData,
	shouldSkipE2E,
} from './testkit/index.js';

describe.skipIf(shouldSkipE2E())('Q5: Blog Scenario', () => {
	const SCHEMA = 'blog_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Simple entity queries', () => {
		it('should query all authors', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const authors = await orm
				.withSchema(SCHEMA)
				.select('authors')
				.columns(['id', 'name', 'email'])
				.execute();

			expect(authors).toHaveLength(2);
			const names = authors.map((a: { name: string }) => a.name);
			expect(names).toContain('Alice Johnson');
			expect(names).toContain('Bob Smith');
		});

		it('should query all posts', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const posts = await orm
				.withSchema(SCHEMA)
				.select('posts')
				.columns(['id', 'title', 'published'])
				.execute();

			expect(posts).toHaveLength(5);
		});

		it('should query all comments', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const comments = await orm
				.withSchema(SCHEMA)
				.select('comments')
				.columns(['id', 'content'])
				.execute();

			expect(comments).toHaveLength(10);
		});
	});

	describe('Filtered queries', () => {
		it('should filter published posts', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const publishedPosts = await orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(eq('published', true))
				.columns(['id', 'title'])
				.execute();

			expect(publishedPosts).toHaveLength(3);
		});

		it('should filter draft posts', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const draftPosts = await orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(eq('published', false))
				.columns(['id', 'title'])
				.execute();

			expect(draftPosts).toHaveLength(2);
		});

		it('should filter author by email', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const alice = await orm
				.withSchema(SCHEMA)
				.select('authors')
				.where(eq('email', 'alice@example.com'))
				.columns(['id', 'name'])
				.execute();

			expect(alice).toHaveLength(1);
			expect(alice[0]).toMatchObject({ name: 'Alice Johnson' });
		});
	});

	describe('EXISTS queries on relations', () => {
		it('should find authors with published posts', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const authorsWithPublished = await orm
				.withSchema(SCHEMA)
				.select('authors')
				.where(
					exists('posts', {
						where: eq('published', true),
					}),
				)
				.columns(['id', 'name'])
				.execute();

			// Both Alice and Bob have published posts
			expect(authorsWithPublished).toHaveLength(2);
		});

		it('should find posts with comments', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const postsWithComments = await orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(exists('comments'))
				.columns(['id', 'title'])
				.execute();

			// Posts 1, 2, 3 have comments
			expect(postsWithComments.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('dump() analysis', () => {
		it('should generate correct SQL for filtered query', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const dump = orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(eq('published', true))
				.columns(['id', 'title'])
				.dump();

			// Verify SQL structure
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql).toContain(`"${SCHEMA}"`);
			expect(dump.params).toContain(true);
		});

		it('should include schema in meta', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const dump = orm.withSchema(SCHEMA).select('authors').dump();

			expect(dump.meta?.schema).toBe(SCHEMA);
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should generate EXISTS subquery for relation filter', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const dump = orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(exists('comments'))
				.dump();

			expect(dump.sql.toUpperCase()).toContain('EXISTS');
		});
	});

	describe('Combined filters', () => {
		it('should combine entity filter with relation filter', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const publishedWithComments = await orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(and(eq('published', true), exists('comments')))
				.columns(['id', 'title'])
				.execute();

			// Published posts (3) that also have comments
			expect(publishedWithComments.length).toBeGreaterThanOrEqual(1);
		});
	});
});
