/**
 * Transactions E2E Tests
 *
 * Tests transaction support: basic commit/rollback, nested, and schema-scoped.
 */

import { createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogSchema,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	seedBlogData,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

describe('Transactions', () => {
	const SCHEMA = 'transactions_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);

		// Advance sequences past seed data to avoid PK conflicts
		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);
		await sql`SELECT setval(pg_get_serial_sequence('${s}.posts', 'id'), (SELECT MAX(id) FROM ${s}.posts))`.execute(
			pool,
		);
		await sql`SELECT setval(pg_get_serial_sequence('${s}.authors', 'id'), (SELECT MAX(id) FROM ${s}.authors))`.execute(
			pool,
		);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Basic transaction', () => {
		it('should commit on success', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);

			// Arrange
			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Act
			await scoped.transaction(async (tx) => {
				await tx
					.into(tx.tables.posts)
					.values({
						title: 'Tx Post',
						content: 'Created in transaction',
						published: false,
						authorId: 1,
					})
					.execute();
			});

			// Assert
			const after = await scoped.select('posts').all();
			expect(after.length).toBe(countBefore + 1);
		});

		it('should rollback on error', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);

			// Arrange
			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Act
			await expect(
				scoped.transaction(async (tx) => {
					await tx
						.into(tx.tables.posts)
						.values({
							title: 'Rollback Post',
							content: 'Should not persist',
							published: false,
							authorId: 1,
						})
						.execute();
					throw new Error('Intentional failure');
				}),
			).rejects.toThrow('Intentional failure');

			// Assert — row NOT persisted
			const after = await scoped.select('posts').all();
			expect(after.length).toBe(countBefore);
		});

		it('should return callback result on commit', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const result = await scoped.transaction(async (tx) => {
				const posts = await tx.select('posts').all();
				return { count: posts.length };
			});

			expect(result).toHaveProperty('count');
			expect(typeof result.count).toBe('number');
		});

		it('repeatable read read-only transaction keeps a stable snapshot', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);
			const pool = await getTestPool();
			const s = sql.ref(SCHEMA);
			const marker = `Snapshot Post ${Date.now()}`;

			const [before, after] = await scoped.transaction(
				async (tx) => {
					const beforeRows = await tx.raw<{ count_value: number }>(
						`SELECT count(*)::integer AS count_value FROM "${SCHEMA}".posts WHERE title LIKE 'Snapshot Post%'`,
					);
					await sql`
						INSERT INTO ${s}.posts (title, content, published, author_id)
						VALUES (${marker}, 'Concurrent commit', false, 1)
					`.execute(pool);
					const afterRows = await tx.raw<{ count_value: number }>(
						`SELECT count(*)::integer AS count_value FROM "${SCHEMA}".posts WHERE title LIKE 'Snapshot Post%'`,
					);
					return [
						beforeRows[0]?.count_value ?? 0,
						afterRows[0]?.count_value ?? 0,
					] as const;
				},
				{ isolationLevel: 'repeatable read', readOnly: true },
			);

			expect(after).toBe(before);

			const committed = await sql`
				SELECT count(*)::integer AS count_value
				FROM ${s}.posts
				WHERE title = ${marker}
			`.execute(pool);
			expect(committed.rows[0]?.count_value).toBe(1);
		});
	});

	describe('Nested transaction', () => {
		it('should reuse parent transaction context', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Outer with nested inner
			await scoped.transaction(async (outer) => {
				await outer
					.into(outer.tables.posts)
					.values({
						title: 'Outer Post',
						content: 'From outer tx',
						published: false,
						authorId: 1,
					})
					.execute();

				await outer.transaction(async (inner) => {
					await inner
						.into(inner.tables.posts)
						.values({
							title: 'Inner Post',
							content: 'From inner tx',
							published: false,
							authorId: 1,
						})
						.execute();
				});
			});

			// Assert — both rows persisted
			const after = await scoped.select('posts').all();
			expect(after.length).toBe(countBefore + 2);
		});

		it('should rollback all on inner error', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ schema: blogSchema, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			await expect(
				scoped.transaction(async (outer) => {
					await outer
						.into(outer.tables.posts)
						.values({
							title: 'Will Rollback',
							content: 'Neither should persist',
							published: false,
							authorId: 1,
						})
						.execute();

					await outer.transaction(async (inner) => {
						await inner
							.into(inner.tables.posts)
							.values({
								title: 'Inner Will Rollback',
								content: 'Neither should persist',
								published: false,
								authorId: 1,
							})
							.execute();
						throw new Error('Inner failure');
					});
				}),
			).rejects.toThrow('Inner failure');

			// Assert — neither row persisted
			const after = await scoped.select('posts').all();
			expect(after.length).toBe(countBefore);
		});
	});
});
