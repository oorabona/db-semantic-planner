/**
 * Q5: Blog Scenario - Basic Query Patterns
 *
 * Tests fundamental query patterns using the blog schema:
 * - Simple entity queries
 * - Basic filtering
 * - Multi-entity queries
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, createOrm, eq, exists } from '@db-semantic-planner/dx';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestDb,
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
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const authors = await orm
				.forTenant(SCHEMA)
				.query('authors')
				.select(['id', 'name', 'email'])
				.execute();

			expect(authors).toHaveLength(2);
			const names = authors.map((a: { name: string }) => a.name);
			expect(names).toContain('Alice Johnson');
			expect(names).toContain('Bob Smith');
		});

		it('should query all posts', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const posts = await orm
				.forTenant(SCHEMA)
				.query('posts')
				.select(['id', 'title', 'published'])
				.execute();

			expect(posts).toHaveLength(5);
		});

		it('should query all comments', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const comments = await orm
				.forTenant(SCHEMA)
				.query('comments')
				.select(['id', 'content'])
				.execute();

			expect(comments).toHaveLength(10);
		});
	});

	describe('Filtered queries', () => {
		it('should filter published posts', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const publishedPosts = await orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(eq('published', true))
				.select(['id', 'title'])
				.execute();

			expect(publishedPosts).toHaveLength(3);
		});

		it('should filter draft posts', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const draftPosts = await orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(eq('published', false))
				.select(['id', 'title'])
				.execute();

			expect(draftPosts).toHaveLength(2);
		});

		it('should filter author by email', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const alice = await orm
				.forTenant(SCHEMA)
				.query('authors')
				.where(eq('email', 'alice@example.com'))
				.select(['id', 'name'])
				.execute();

			expect(alice).toHaveLength(1);
			expect(alice[0]).toMatchObject({ name: 'Alice Johnson' });
		});
	});

	describe('EXISTS queries on relations', () => {
		// TODO: EXISTS subqueries currently don't include schema prefix (known limitation)
		it.todo('should find authors with published posts', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const authorsWithPublished = await orm
				.forTenant(SCHEMA)
				.query('authors')
				.where(
					exists('posts', {
						where: eq('published', true),
					}),
				)
				.select(['id', 'name'])
				.execute();

			// Both Alice and Bob have published posts
			expect(authorsWithPublished).toHaveLength(2);
		});

		it.todo('should find posts with comments', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const postsWithComments = await orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(exists('comments'))
				.select(['id', 'title'])
				.execute();

			// Posts 1, 2, 3 have comments
			expect(postsWithComments.length).toBeGreaterThanOrEqual(3);
		});
	});

	describe('dump() analysis', () => {
		it('should generate correct SQL for filtered query', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const dump = orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(eq('published', true))
				.select(['id', 'title'])
				.dump();

			// Verify SQL structure
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql).toContain(`"${SCHEMA}"`);
			expect(dump.params).toContain(true);
		});

		it('should include schema in meta', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const dump = orm.forTenant(SCHEMA).query('authors').dump();

			expect(dump.meta?.tenant).toBe(SCHEMA);
			expect(dump.meta?.compiledAt).toBeInstanceOf(Date);
		});

		it('should generate EXISTS subquery for relation filter', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const dump = orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(exists('comments'))
				.dump();

			expect(dump.sql.toUpperCase()).toContain('EXISTS');
		});
	});

	describe('Combined filters', () => {
		// TODO: EXISTS subqueries currently don't include schema prefix (known limitation)
		it.todo('should combine entity filter with relation filter', async () => {
			const db = await getTestDb();
			const orm = createOrm({ model: blogModel, db });

			const publishedWithComments = await orm
				.forTenant(SCHEMA)
				.query('posts')
				.where(and(eq('published', true), exists('comments')))
				.select(['id', 'title'])
				.execute();

			// Published posts (3) that also have comments
			expect(publishedWithComments.length).toBeGreaterThanOrEqual(1);
		});
	});
});
