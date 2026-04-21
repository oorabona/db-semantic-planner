/**
 * Transactions E2E Tests
 *
 * Tests transaction support: basic commit/rollback, nested, and schema-scoped.
 */

import { createOrm } from '@dbsp/core';
import type { OrmInstanceInternal } from '../../packages/core/src/dx/orm-instance-types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogModel,
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
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);

			// Arrange
			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Act
			await scoped.transaction(async (tx) => {
				await (tx as unknown as OrmInstanceInternal)
					.insert('posts')
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
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);

			// Arrange
			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Act
			await expect(
				scoped.transaction(async (tx) => {
					await (tx as unknown as OrmInstanceInternal)
						.insert('posts')
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
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const result = await scoped.transaction(async (tx) => {
				const posts = await tx.select('posts').all();
				return { count: posts.length };
			});

			expect(result).toHaveProperty('count');
			expect(typeof result.count).toBe('number');
		});
	});

	describe('Nested transaction', () => {
		it('should reuse parent transaction context', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			// Outer with nested inner
			await scoped.transaction(async (outer) => {
				await (outer as unknown as OrmInstanceInternal)
					.insert('posts')
					.values({
						title: 'Outer Post',
						content: 'From outer tx',
						published: false,
						authorId: 1,
					})
					.execute();

				await outer.transaction(async (inner) => {
					await (inner as unknown as OrmInstanceInternal)
						.insert('posts')
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
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);

			const before = await scoped.select('posts').all();
			const countBefore = before.length;

			await expect(
				scoped.transaction(async (outer) => {
					await (outer as unknown as OrmInstanceInternal)
						.insert('posts')
						.values({
							title: 'Will Rollback',
							content: 'Neither should persist',
							published: false,
							authorId: 1,
						})
						.execute();

					await outer.transaction(async (inner) => {
						await (inner as unknown as OrmInstanceInternal)
							.insert('posts')
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
