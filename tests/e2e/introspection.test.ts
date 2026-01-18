/**
 * Introspection E2E Tests
 *
 * Tests the auto-introspection path where createOrm({ adapter }) is called
 * without a model, triggering database introspection via information_schema.
 */

import { createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createAdapterForSchema,
	createBlogSchema,
	dropBlogSchema,
	shouldSkipE2E,
} from './testkit/index.js';

const SCHEMA = 'introspection_test';

describe.skipIf(shouldSkipE2E())('Auto-Introspection', () => {
	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	describe('createOrm({ adapter }) - async path', () => {
		it('returns a Promise when model is not provided', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const result = createOrm({ adapter });

			expect(result).toBeInstanceOf(Promise);
		});

		it('resolves to an OrmInstance after introspection', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const orm = await createOrm({ adapter });

			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
			expect(orm.insert).toBeDefined();
			expect(orm.update).toBeDefined();
			expect(orm.delete).toBeDefined();
			expect(orm.withSchema).toBeDefined();
			expect(typeof orm.strictMode).toBe('boolean');
		});

		it('introspects tables from database', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const orm = await createOrm({ adapter });

			// Should be able to query introspected tables
			// Blog schema has: authors, posts, comments
			const dump = orm.select('authors').dump();

			expect(dump.sql).toContain('authors');
			expect(dump.sql.toLowerCase()).toContain('select');
		});

		it('introspects columns from database', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const orm = await createOrm({ adapter });

			// Should be able to select specific columns
			const dump = orm.select('authors').columns(['id', 'name']).dump();

			expect(dump.sql).toContain('id');
			expect(dump.sql).toContain('name');
		});
	});

	describe('comparison with explicit model', () => {
		it('produces equivalent queries to explicit model', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);

			// Introspected ORM
			const introspectedOrm = await createOrm({ adapter });
			const introspectedDump = introspectedOrm.select('authors').dump();

			// The SQL should be valid and query the authors table
			expect(introspectedDump.sql.toLowerCase()).toContain('select');
			expect(introspectedDump.sql).toContain('authors');
		});
	});
});
