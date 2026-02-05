/**
 * AdapterLogger E2E Tests
 *
 * Tests that the logger option is accepted and that the adapter functions
 * correctly with a logger configured. The adapter currently logs sparingly
 * (only cleanup errors during streaming transactions).
 */

import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { type AdapterLogger, createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	blogModel,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestPool,
	seedBlogData,
} from './testkit/index.js';

describe('AdapterLogger', () => {
	const SCHEMA = 'adapter_logger_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	it('should accept a logger in adapter options', async () => {
		const pool = await getTestPool();
		const logger: AdapterLogger = {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};

		const adapter = createPgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			logger,
		});

		// Adapter should function normally with logger configured
		const orm = createOrm({ model: blogModel, adapter });
		const posts = await orm.withSchema(SCHEMA).select('posts').all();

		expect(posts.length).toBeGreaterThan(0);
	});

	it('should accept a partial logger (only some methods)', async () => {
		const pool = await getTestPool();
		const logger: AdapterLogger = {
			error: vi.fn(),
			// debug and warn intentionally omitted
		};

		const adapter = createPgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			logger,
		});

		const orm = createOrm({ model: blogModel, adapter });
		const posts = await orm.withSchema(SCHEMA).select('posts').all();

		expect(posts.length).toBeGreaterThan(0);
	});

	it('should function without a logger', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool, {
			dbCasing: 'snake_case',
			// no logger
		});

		const orm = createOrm({ model: blogModel, adapter });
		const posts = await orm.withSchema(SCHEMA).select('posts').all();

		expect(posts.length).toBeGreaterThan(0);
	});
});
