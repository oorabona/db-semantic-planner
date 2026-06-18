/**
 * FEAT-134 E2E: NQL tag interpolation binds values as PostgreSQL params.
 */

import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { createHookManager, createOrm, nqlRaw } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogSchema,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	getTestPool,
	seedBlogData,
	sql,
} from './testkit/index.js';

describe('FEAT-134 NQL params E2E', () => {
	const SCHEMA = 'nql_params_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	it('binds scalar tag interpolations and filters rows by bound values', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number; title: string }>`posts
			| where id = ${3} and title = ${'Introduction to PostgreSQL'}
			| select id, title`;

		const dump = query.dump();
		const rows = await query.all();

		expect(dump.params).toEqual([3, 'Introduction to PostgreSQL']);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(dump.sql).toMatch(/\$2\b/);
		expect(dump.sql).not.toContain('Introduction to PostgreSQL');
		expect(rows).toEqual([{ id: 3, title: 'Introduction to PostgreSQL' }]);
	});

	it('binds tag arrays through ANY and filters rows by the array value', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const ids = [1, 3, 5];
		const query = orm.nql<{ id: number; title: string }>`posts
			| where id = ANY(${ids})
			| select id, title
			| order by id`;

		const dump = query.dump();
		const rows = await query.all();

		expect(dump.params).toEqual([ids]);
		expect(dump.sql).toMatch(/ANY\s*\(/i);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(rows.map((row) => row.id)).toEqual([1, 3, 5]);
	});

	it('binds tag interpolation inside SELECT coalesce() and returns real rows', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const fallback = 'Unknown author';
		const query = orm.nql<{ id: number; label: string }>`authors
			| select id, coalesce(name, ${fallback}) as label
			| order by id`;

		const dump = query.dump();
		const rows = await query.all();

		expect(dump.params).toEqual([fallback]);
		expect(dump.sql).toMatch(/coalesce/i);
		expect(dump.sql).toMatch(/\$1\b/);
		expect(rows).toEqual([
			{ id: 1, label: 'Alice Johnson' },
			{ id: 2, label: 'Bob Smith' },
		]);
	});

	it('keeps nqlRaw trusted fragments reachable from NQL tag origin', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number }>`posts
			| select id
			| ${nqlRaw('order by id desc')}
			| limit 1`;

		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/order by/i);
		expect(dump.params).toEqual([]);
		expect(rows).toEqual([{ id: 5 }]);
	});

	it('executes query-final read-only bindings through WITH CTEs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number }>`posts
			| where id >= ${3}
			| select id
			| bind recent_posts
posts
			| where published = ${true}
			| select id
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "recent_posts" as \(/);
		expect(dump.params).toEqual([3, true]);
		expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
	});

	it('executes binding-final read-only queries through WITH CTEs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number; title: string }>`posts
			| where id >= ${3}
			| select id, title
			| bind recent_posts
recent_posts
			| where id < ${5}
			| select id, title
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "recent_posts" as \(/);
		expect(dump.sql).toContain(`${SCHEMA}.posts`);
		expect(dump.sql).toContain('FROM recent_posts');
		expect(dump.sql).not.toContain(`${SCHEMA}.recent_posts`);
		expect(dump.params).toEqual([3, 5]);
		expect(dump.plan.rootTable).toBe('recent_posts');
		expect(dump.plan.decisions).toEqual([]);
		expect(rows).toEqual([
			{ id: 3, title: 'Introduction to PostgreSQL' },
			{ id: 4, title: 'Draft: React Best Practices' },
		]);
	});

	it('executes mutation binding bodies before the final query', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const authorId = 999_001 + Math.floor(Date.now() % 1_000_000);
		const email = `mutation-bind-${authorId}@example.com`;

		const program = orm.nql<{
			id: number;
		}>`insert into authors set id = ${authorId}, name = ${'Mutation Bind'}, email = ${email} | select id | bind new_author
authors | where id in (new_author) | select id`;
		const dump = program.dump();
		const rows = await program.all();

		expect(dump.sequence).toHaveLength(2);
		expect(dump.sql).toContain(
			`WITH "new_author" ("id") as (SELECT "id" FROM "${SCHEMA}"."authors" WHERE false)`,
		);
		expect(rows).toEqual([{ id: authorId }]);
	});

	it('runs mutation hooks around NQL tag mutations', async () => {
		const adapter = await getTestAdapter();
		const events: string[] = [];
		const hooks = createHookManager()
			.beforeMutation((ctx) => {
				events.push(`before:${ctx.table}:${ctx.operation}:${ctx.cardinality}`);
				expect(ctx.sql).toBeUndefined();
				return ctx;
			})
			.afterMutation((ctx, rows) => {
				events.push(`after:${ctx.table}:${ctx.operation}:${rows.length}`);
				expect(ctx.sql).toMatch(/insert/i);
				expect(ctx.parameters).toHaveLength(3);
				return rows;
			});
		const orm = createOrm({ schema: blogSchema, adapter, hooks }).withSchema(
			SCHEMA,
		);
		const authorId = 100_000 + Math.floor(Date.now() % 1_000_000);
		const email = `nql-hook-${authorId}@example.com`;

		const rows = await orm.nql<{
			id: number;
			email: string;
		}>`insert into authors set id = ${authorId}, name = ${'NQL Hook'}, email = ${email} | select id, email`.all();

		expect(events).toEqual([
			'before:authors:insert:single',
			'after:authors:insert:1',
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.email).toBe(email);
	});

	it('executes bound mutation pipelines through WITH CTEs', async () => {
		const pool = await getTestPool();
		const suffix = 200_000 + Math.floor(Date.now() % 1_000_000);
		const authorId = suffix;
		const postId = suffix + 1_000_000;
		const email = `nql-bound-${suffix}@example.com`;
		const author = await sql<{ id: number }>`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${authorId}, ${'NQL Bound'}, ${email})
			RETURNING id
		`.execute(pool);
		const post = await sql<{ id: number }>`
			INSERT INTO ${sql.ref(SCHEMA)}.posts
				(id, title, content, author_id, published, created_at)
			VALUES (${postId}, ${'NQL Bound Draft'}, ${'draft'}, ${author.rows[0]!.id}, ${false}, NOW())
			RETURNING id
		`.execute(pool);
		const client = await pool.connect();

		try {
			const searchPath = sql`SET search_path TO ${sql.ref(SCHEMA)}`.compile();
			await client.query(searchPath.sql, searchPath.parameters as unknown[]);
			const adapter = createPgsqlAdapter(client, { dbCasing: 'snake_case' });
			const orm = createOrm({ schema: blogSchema, adapter });
			const mutation = orm.nql<{
				id: number;
				published: boolean;
			}>`authors | where email = ${email} | select id | bind target_author
update posts set published = ${true} where authorId in (target_author) | select id, published`;
			const dump = mutation.dump();
			const rows = await mutation.all();

			expect(dump.sql).toMatch(/^WITH "target_author" as \(/);
			expect((dump as { parameters: readonly unknown[] }).parameters).toEqual([
				email,
				true,
			]);
			expect(rows).toEqual([{ id: post.rows[0]!.id, published: true }]);
		} finally {
			await client.query('RESET search_path');
			client.release();
		}
	});

	it('executes schema-scoped bound mutation pipelines through WITH CTEs', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const suffix = 300_000 + Math.floor(Date.now() % 1_000_000);
		const authorId = suffix;
		const postId = suffix + 1_000_000;
		const email = `nql-bound-schema-${suffix}@example.com`;
		const author = await sql<{ id: number }>`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${authorId}, ${'NQL Bound Schema'}, ${email})
			RETURNING id
		`.execute(pool);
		const post = await sql<{ id: number }>`
			INSERT INTO ${sql.ref(SCHEMA)}.posts
				(id, title, content, author_id, published, created_at)
			VALUES (${postId}, ${'NQL Bound Schema Draft'}, ${'draft'}, ${author.rows[0]!.id}, ${false}, NOW())
			RETURNING id
		`.execute(pool);

		const mutation = orm.nql<{
			id: number;
			published: boolean;
		}>`authors | where email = ${email} | select id | bind target_author
update posts set published = ${true} where authorId in (target_author) | select id, published`;
		const dump = mutation.dump();
		const rows = await mutation.all();

		expect(dump.sql).toMatch(/^WITH "target_author" as \(/);
		expect(dump.sql).toContain(`${SCHEMA}.authors`);
		expect(dump.sql).toMatch(new RegExp(`\\bUPDATE\\s+${SCHEMA}\\.posts\\b`));
		expect(dump.sql).not.toContain(`"${SCHEMA}".target_author`);
		expect(dump.sql).not.toContain(`${SCHEMA}.target_author`);
		expect((dump as { parameters: readonly unknown[] }).parameters).toEqual([
			email,
			true,
		]);
		expect(rows).toEqual([{ id: post.rows[0]!.id, published: true }]);
	});
});
