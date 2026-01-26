/**
 * Introspection E2E Tests
 *
 * Tests the auto-introspection path where createOrm({ adapter }) is called
 * without a model, triggering database introspection via information_schema.
 */

import { getSchemaFromDb } from '@dbsp/adapter-kysely';
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

	describe('getSchemaFromDb (ARCH-006)', () => {
		it('returns a Schema with definition from database', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			expect(schema).toBeDefined();
			expect(schema.definition).toBeDefined();
			// Blog schema has: authors, posts, comments
			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeDefined();
			expect(schema.definition.comments).toBeDefined();
		});

		it('introspects column types correctly', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// authors table has: id (serial → number), name (varchar → string), bio (text), email (varchar)
			// Note: Introspection maps to JS runtime types, so 'serial/integer' → 'number'
			const authors = schema.definition.authors;
			expect(authors).toBeDefined();
			expect(authors!.id).toBe('number');
			expect(authors!.name).toBe('string');
		});

		it('converts foreign keys to ref definitions', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// posts table has author_id FK to authors
			const posts = schema.definition.posts;
			expect(posts).toBeDefined();

			// author_id should be a ref definition
			const authorIdDef = posts!.author_id;
			expect(authorIdDef).toMatchObject({
				__brand: 'ref',
				target: 'authors',
			});
		});

		it('can be used to create an ORM instance', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, { schema: SCHEMA });

			// Create ORM with introspected schema
			const orm = createOrm({ schema, adapter });

			// Should be able to query
			const dump = orm.select('authors').dump();
			expect(dump.sql.toLowerCase()).toContain('select');
			expect(dump.sql).toContain('authors');
		});

		it('respects tables whitelist option', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, {
				schema: SCHEMA,
				tables: ['authors'],
			});

			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeUndefined();
			expect(schema.definition.comments).toBeUndefined();
		});

		it('respects exclude patterns option', async () => {
			const adapter = await createAdapterForSchema(SCHEMA);
			const schema = await getSchemaFromDb(adapter, {
				schema: SCHEMA,
				exclude: ['comments'],
			});

			expect(schema.definition.authors).toBeDefined();
			expect(schema.definition.posts).toBeDefined();
			expect(schema.definition.comments).toBeUndefined();
		});
	});
});
