/**
 * STREAMING-001: Cursor/Streaming Support E2E Tests
 *
 * Tests streaming functionality with real PostgreSQL database.
 * Uses the blog schema for comprehensive testing.
 */

import { PgsqlTransactionTimeoutError } from '@dbsp/adapter-pgsql';
import { createOrm, type Dump, eq } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	seedBlogData,
	sql,
} from './testkit/index.js';

describe('STREAMING-001: Cursor/Streaming Support', () => {
	const SCHEMA = 'streaming_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Scenario 1: Basic streaming iteration', () => {
		it('should stream all rows one at a time', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const results: unknown[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.stream()) {
				results.push(row);
			}

			// Blog seed has 2 authors
			expect(results).toHaveLength(2);
			expect(results[0]).toHaveProperty('name');
		});

		it('should yield correct data for each row', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const names: string[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.columns(['name'])
				.stream()) {
				names.push((row as { name: string }).name);
			}

			expect(names).toContain('Alice Johnson');
			expect(names).toContain('Bob Smith');
		});
	});

	describe('Scenario 2: Streaming with chunkSize', () => {
		it('should accept chunkSize option', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const results: unknown[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('posts')
				.stream({ chunkSize: 2 })) {
				results.push(row);
			}

			// Blog seed has 5 posts
			expect(results).toHaveLength(5);
		});
	});

	describe('Scenario 3: Early break releases connection', () => {
		it('should handle early break from iteration', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const results: unknown[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('comments')
				.stream()) {
				results.push(row);
				if (results.length >= 3) {
					break; // Stop after 3 rows
				}
			}

			expect(results).toHaveLength(3);
		});

		it('should allow queries after early break', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			// First query with early break
			for await (const _row of orm
				.withSchema(SCHEMA)
				.select('posts')
				.stream()) {
				break; // Break immediately
			}

			// Second query should work fine
			const posts = await orm.withSchema(SCHEMA).select('posts').execute();
			expect(posts).toHaveLength(5);
		});
	});

	describe('Scenario 4: Streaming with onStart callback', () => {
		it('should invoke onStart before first row', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			const onStart = vi.fn();

			const iterator = orm
				.withSchema(SCHEMA)
				.select('authors')
				.stream({ onStart });

			// onStart should not be called yet
			expect(onStart).not.toHaveBeenCalled();

			// Consume first row
			const { value } = await iterator.next();

			// Now onStart should have been called
			expect(onStart).toHaveBeenCalledOnce();
			expect(value).toBeDefined();

			// Close the iterator to release the connection/cursor
			await iterator.return?.();
		});

		it('should pass dump to onStart with correct schema prefix', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			let receivedDump: Dump | undefined;

			for await (const _row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.stream({
					onStart: (dump) => {
						receivedDump = dump;
					},
				})) {
				break; // Just need first iteration
			}

			expect(receivedDump).toBeDefined();
			expect(receivedDump!.sql).toContain(SCHEMA);
			expect(receivedDump!.plan).toBeDefined();
			expect(receivedDump!.params).toBeDefined();
		});
	});

	describe('Scenario 5: Multi-tenant streaming', () => {
		const TENANT_A = 'tenant_stream_a';
		const TENANT_B = 'tenant_stream_b';

		beforeAll(async () => {
			// Create two tenant schemas
			await dropBlogSchema(TENANT_A);
			await dropBlogSchema(TENANT_B);
			await createBlogSchema(TENANT_A);
			await createBlogSchema(TENANT_B);
			await seedBlogData(TENANT_A);
			await seedBlogData(TENANT_B);
		});

		afterAll(async () => {
			await dropBlogSchema(TENANT_A);
			await dropBlogSchema(TENANT_B);
		});

		it('should isolate streaming to tenant schema', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			// Stream from tenant A
			const tenantAResults: unknown[] = [];
			for await (const row of orm
				.withSchema(TENANT_A)
				.select('authors')
				.stream()) {
				tenantAResults.push(row);
			}

			// Stream from tenant B
			const tenantBResults: unknown[] = [];
			for await (const row of orm
				.withSchema(TENANT_B)
				.select('authors')
				.stream()) {
				tenantBResults.push(row);
			}

			// Both should have same count (same seed)
			expect(tenantAResults).toHaveLength(2);
			expect(tenantBResults).toHaveLength(2);
		});

		it('should include schema prefix in SQL', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			let sql = '';

			for await (const _row of orm
				.withSchema(TENANT_A)
				.select('authors')
				.stream({
					onStart: (dump) => {
						sql = dump.sql;
					},
				})) {
				break;
			}

			expect(sql).toContain(TENANT_A);
		});
	});

	describe('Scenario 6: Streaming with filters', () => {
		it('should stream only filtered rows', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const publishedPosts: unknown[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(eq('published', true))
				.stream()) {
				publishedPosts.push(row);
			}

			// Blog seed has 3 published posts
			expect(publishedPosts).toHaveLength(3);
		});

		it('should pass filter params correctly', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			let params: readonly unknown[] = [];

			for await (const _row of orm
				.withSchema(SCHEMA)
				.select('posts')
				.where(eq('published', true))
				.stream({
					onStart: (dump) => {
						params = dump.params;
					},
				})) {
				break;
			}

			expect(params).toContain(true);
		});
	});

	describe('Scenario 7: Raw SQL streaming', () => {
		it('should stream raw SQL with parameters and chunkSize', async () => {
			const adapter = await getTestAdapter();
			const rows: { name: string }[] = [];

			for await (const row of adapter.streamRaw<{ name: string }>(
				`SELECT name FROM "${SCHEMA}".authors WHERE name = $1 ORDER BY id`,
				['Alice Johnson'],
				{ chunkSize: 1 },
			)) {
				rows.push(row);
			}

			expect(rows).toEqual([{ name: 'Alice Johnson' }]);
		});
	});

	describe('Scenario 8: Streaming transaction begin options', () => {
		it('repeatable read stream keeps a stable snapshot across FETCHes', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			const scoped = orm.withSchema(SCHEMA);
			const pool = await getTestPool();
			const s = sql.ref(SCHEMA);
			const marker = `Stream Snapshot ${Date.now()}`;
			let insertedId: number | undefined;
			let completed = false;
			const iterator = scoped
				.select('posts')
				.columns(['id', 'title'])
				.orderBy('id')
				.stream({
					chunkSize: 1,
					isolationLevel: 'repeatable read',
					readOnly: true,
				});

			try {
				const seenIds: number[] = [];
				const first = await iterator.next();
				expect(first.done).toBe(false);
				if (!first.done) {
					seenIds.push((first.value as { id: number }).id);
				}

				const inserted = await sql`
					INSERT INTO ${s}.posts (title, content, published, author_id)
					VALUES (${marker}, 'Concurrent stream commit', false, 1)
					RETURNING id
				`.execute(pool);
				insertedId = inserted.rows[0]?.id as number | undefined;
				expect(insertedId).toBeDefined();

				for await (const row of iterator) {
					seenIds.push((row as { id: number }).id);
				}
				completed = true;

				expect(seenIds).not.toContain(insertedId);
				const committed = await sql`
					SELECT count(*)::integer AS count_value
					FROM ${s}.posts
					WHERE id = ${insertedId}
				`.execute(pool);
				expect(committed.rows[0]?.count_value).toBe(1);
			} finally {
				if (!completed) {
					await iterator.return?.().catch(() => undefined);
				}
				if (insertedId !== undefined) {
					await sql`DELETE FROM ${s}.posts WHERE id = ${insertedId}`.execute(
						pool,
					);
				}
			}
		});

		it('lockTimeoutMs raises a typed timeout when a streamed row is locked', async () => {
			const pool = await getTestPool();
			const holder = await pool.connect();
			try {
				await holder.query('BEGIN');
				await holder.query(
					`SELECT * FROM "${SCHEMA}".posts WHERE id = 1 FOR UPDATE`,
				);

				const adapter = await getTestAdapter();
				const orm = createOrm({ model: blogModel, adapter });
				const error = await (async (): Promise<unknown> => {
					try {
						for await (const _row of orm
							.withSchema(SCHEMA)
							.select('posts')
							.where(eq('id', 1))
							.forUpdate()
							.stream({ lockTimeoutMs: 50 })) {
							// The DECLARE should time out before yielding.
						}
					} catch (caught) {
						return caught;
					}
					throw new Error('Expected stream lock timeout');
				})();

				expect(error).toBeInstanceOf(PgsqlTransactionTimeoutError);
				expect((error as PgsqlTransactionTimeoutError).timeout).toBe(
					'lock_timeout',
				);
			} finally {
				await holder.query('ROLLBACK').catch(() => undefined);
				holder.release();
			}
		});
	});

	describe('Scenario 9: Empty result set', () => {
		it('should handle empty results gracefully', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const results: unknown[] = [];
			// Filter that matches nothing
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.where(eq('name', 'nonexistent_name_xyz'))
				.stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(0);
		});

		it('should still invoke onStart for empty results', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });
			const onStart = vi.fn();

			for await (const _row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.where(eq('name', 'nonexistent'))
				.stream({ onStart })) {
				// Should never enter this block
			}

			expect(onStart).toHaveBeenCalledOnce();
		});
	});

	describe('Scenario: Streaming preserves query builder chain', () => {
		it('should work with select fields', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: blogModel, adapter });

			const results: unknown[] = [];
			for await (const row of orm
				.withSchema(SCHEMA)
				.select('authors')
				.columns(['id', 'name'])
				.stream()) {
				results.push(row);
			}

			expect(results).toHaveLength(2);
			// Should have selected fields
			expect(results[0]).toHaveProperty('id');
			expect(results[0]).toHaveProperty('name');
		});
	});
});
