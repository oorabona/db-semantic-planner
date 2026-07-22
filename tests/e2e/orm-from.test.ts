import { any, createOrm, eq, normalizeSQL, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogModel,
	blogSchema,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	seedBlogData,
} from './testkit/index.js';

describe('orm.from() table-ref API', () => {
	const SCHEMA = 'orm_from_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	it('executes from(orm.tables.authors).where(...).all() against real rows', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { authors } = orm.tables;

		const rows = await orm
			.from(authors)
			.where(eq(authors.name, 'Alice Johnson'))
			.all();

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: 1,
			name: 'Alice Johnson',
			email: 'alice@example.com',
			companyId: 1,
		});
	});

	it('matches select() SQL and execution results for the same query', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { authors } = orm.tables;

		const fromQuery = orm
			.from(authors)
			.where(eq(authors.email, 'bob@example.com'))
			.columns(['id', 'name', 'email']);
		const selectQuery = orm
			.select('authors')
			.where(eq('email', 'bob@example.com'))
			.columns(['id', 'name', 'email']);

		const fromDump = fromQuery.dump();
		const selectDump = selectQuery.dump();
		const fromRows = await fromQuery.all();
		const selectRows = await selectQuery.all();

		expect(normalizeSQL(fromDump.sql)).toBe(normalizeSQL(selectDump.sql));
		expect(fromDump.params).toEqual(selectDump.params);
		expect(fromRows).toEqual(selectRows);
		expect(fromRows).toEqual([
			{ id: 2, name: 'Bob Smith', email: 'bob@example.com' },
		]);
	});

	it('applies column-ref where conditions and projected columns', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { posts } = orm.tables;

		const rows = await orm
			.from(posts)
			.where(eq(posts.published, true))
			.columns(['id', 'title'])
			.orderBy('id')
			.limit(2)
			.all();

		expect(rows).toEqual([
			{ id: 1, title: 'Getting Started with TypeScript' },
			{ id: 2, title: 'Advanced TypeScript Patterns' },
		]);
	});

	it('populates orm.tables and executes from() for model-created ORMs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: blogModel, adapter }).withSchema(SCHEMA);
		const { authors } = orm.tables;

		const rows = await orm
			.from(authors)
			.where(eq(authors.email, 'bob@example.com'))
			.columns(['id', 'name'])
			.all();

		expect(rows).toEqual([{ id: 2, name: 'Bob Smith' }]);
	});

	it('executes from(posts).where(any("id", string ids)) against integer ids', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { posts } = orm.tables;
		const ids = ['1', '2'];

		const query = orm
			.from(posts)
			.where(any('id', ids))
			.columns(['id'])
			.orderBy('id');
		const dump = query.dump();
		const rows = (await query.all()) as Array<{ id: number }>;

		expect(dump.sql).toContain('CAST($1 AS integer[])');
		expect(dump.sql).not.toContain('text[]');
		expect(dump.params).toEqual([ids]);
		expect(rows.map((row) => row.id)).toEqual([1, 2]);
	});

	it('executes any("id", string ids) on a manually defined schema without dbType', async () => {
		const adapter = await getTestAdapter();
		// A hand-written schema declares `type` but NOT `dbType`, so no originalDbType is
		// populated — the array element type must come from the declared ColumnType.
		// Before the fix this emitted CAST($1 AS text[]) → "operator does not exist:
		// integer = text" against the integer posts.id column.
		const manualSchema = schema({
			posts: { id: { type: 'integer', primaryKey: true } },
		});
		const orm = createOrm({ schema: manualSchema, adapter }).withSchema(SCHEMA);
		const { posts } = orm.tables;
		const ids = ['1', '2'];

		const query = orm
			.from(posts)
			.where(any('id', ids))
			.columns(['id'])
			.orderBy('id');
		const dump = query.dump();
		const rows = (await query.all()) as Array<{ id: number }>;

		expect(dump.sql).toContain('CAST($1 AS int4[])');
		expect(dump.sql).not.toContain('text[]');
		expect(dump.params).toEqual([ids]);
		expect(rows.map((row) => row.id)).toEqual([1, 2]);
	});

	it('composes from() with include() relation hydration', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { authors } = orm.tables;

		const rows = (await orm
			.from(authors)
			.include('posts')
			.columns(['id', 'name'])
			.orderBy('id')
			.all()) as Array<{ id: number; name: string; posts: unknown[] }>;

		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.name)).toEqual(['Alice Johnson', 'Bob Smith']);
		expect(rows.every((row) => Array.isArray(row.posts))).toBe(true);
		expect(rows.reduce((sum, row) => sum + row.posts.length, 0)).toBe(5);
	});

	it('keeps withSchema() scoping on from() dumps and execution', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const { authors } = orm.tables;
		const query = orm
			.from(authors)
			.where(eq(authors.id, 1))
			.columns(['id', 'email']);

		const dump = query.dump();
		const rows = await query.all();

		expect(dump.meta?.schema).toBe(SCHEMA);
		expect(dump.sql).toContain(SCHEMA);
		expect(rows).toEqual([{ id: 1, email: 'alice@example.com' }]);
	});
});
