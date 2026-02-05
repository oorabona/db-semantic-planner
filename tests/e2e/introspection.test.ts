/**
 * Introspection E2E Tests
 *
 * Tests the ARCH-006 introspection workflow:
 * 1. getSchemaFromDb() introspects database and returns Schema<T>
 * 2. createOrm({ schema, adapter }) creates ORM instance
 *
 * The old async path (createOrm({ adapter })) was removed in ARCH-006.
 */

import { createOrm, getSchemaFromDb } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createBlogSchema,
	createPgsqlAdapterForSchema,
	dropBlogSchema,
} from './testkit/index.js';

const SCHEMA = 'introspection_test';

describe('Auto-Introspection (ARCH-006)', () => {
	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	describe('getSchemaFromDb + createOrm (ARCH-006)', () => {
		it('creates ORM instance from introspected schema', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
			const orm = createOrm({ schema, adapter });

			expect(orm).toBeDefined();
			expect(orm.select).toBeDefined();
			expect(orm.insert).toBeDefined();
			expect(orm.update).toBeDefined();
			expect(orm.delete).toBeDefined();
			expect(orm.withSchema).toBeDefined();
			expect(typeof orm.strictMode).toBe('boolean');
		});

		it('introspects tables from database', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
			const orm = createOrm({ schema, adapter });

			// Should be able to query introspected tables
			// Blog schema has: authors, posts, comments
			const dump = orm.select('authors').dump();

			expect(dump.sql).toContain('authors');
			expect(dump.sql.toLowerCase()).toContain('select');
		});

		it('introspects columns from database', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
			const orm = createOrm({ schema, adapter });

			// Should be able to select specific columns
			const dump = orm.select('authors').columns(['id', 'name']).dump();

			expect(dump.sql).toContain('id');
			expect(dump.sql).toContain('name');
		});

		it('produces valid queries for introspected schema', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
			const orm = createOrm({ schema, adapter });

			// The SQL should be valid and query the authors table
			const dump = orm.select('authors').dump();
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql).toContain('authors');
		});
	});

	describe('getSchemaFromDb (ARCH-006)', () => {
		it('returns a Schema with definition from database', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			expect(schema).toBeDefined();
			expect(schema.definition).toBeDefined();
			// Blog schema has: authors, posts, comments
			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeDefined();
			expect(schema.definition.comments).toBeDefined();
		});

		it('introspects column types correctly', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// authors table has: id (serial → number), name (varchar → string), bio (text), email (varchar)
			// Note: Introspection maps to JS runtime types, so 'serial/integer' → 'number'
			const authors = schema.definition.authors;
			expect(authors).toBeDefined();
			expect(authors!.id).toBe('number');
			expect(authors!.name).toBe('string');
		});

		it('converts foreign keys to ref definitions', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// posts table has author_id FK to authors
			const posts = schema.definition.posts;
			expect(posts).toBeDefined();

			// author_id should be a ref definition (using actual DB column name)
			const authorIdDef = posts!.author_id;
			expect(authorIdDef).toMatchObject({
				__brand: 'ref',
				target: 'authors',
			});
		});

		it('can be used to create an ORM instance', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// Create ORM with introspected schema
			const orm = createOrm({ schema, adapter });

			// Should be able to query
			const dump = orm.select('authors').dump();
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql).toContain('authors');
		});

		it('respects tables whitelist option', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, {
				schema: SCHEMA,
				tables: ['authors'],
			});

			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeUndefined();
			expect(schema.definition.comments).toBeUndefined();
		});

		it('respects exclude patterns option', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, {
				schema: SCHEMA,
				exclude: ['comments'],
			});

			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeDefined();
			expect(schema.definition.comments).toBeUndefined();
		});

		it('includes dbCasing from adapter (F-003)', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// Schema should have dbCasing from adapter
			expect(schema.dbCasing).toBeDefined();
			expect(schema.dbCasing).toBe(adapter.dbCasing);
		});

		it('includes introspectedAt timestamp (F-004)', async () => {
			const adapter = await createPgsqlAdapterForSchema(SCHEMA);
			const before = new Date();
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });
			const after = new Date();

			// Schema should have introspectedAt
			expect(schema.introspectedAt).toBeDefined();
			expect(schema.introspectedAt).toBeInstanceOf(Date);
			// Timestamp should be within test execution window
			expect(schema.introspectedAt!.getTime()).toBeGreaterThanOrEqual(
				before.getTime(),
			);
			expect(schema.introspectedAt!.getTime()).toBeLessThanOrEqual(
				after.getTime(),
			);
		});
	});
});
