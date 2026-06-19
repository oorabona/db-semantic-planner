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

	it('executes binding-final relation filters through projected source FKs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number; title: string }>`posts
			| select id, title, authorId
			| bind projected_posts
projected_posts
			| where some(author).name = ${'Alice Johnson'}
			| select id, title
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "projected_posts" as \(/);
		expect(dump.sql).toContain(`${SCHEMA}.authors`);
		expect(dump.sql).toContain('FROM projected_posts');
		expect(dump.sql).not.toContain(`${SCHEMA}.projected_posts`);
		expect(dump.params).toEqual(['Alice Johnson']);
		expect(rows).toEqual([
			{ id: 1, title: 'Getting Started with TypeScript' },
			{ id: 2, title: 'Advanced TypeScript Patterns' },
			{ id: 4, title: 'Draft: React Best Practices' },
		]);
	});

	it('executes binding-final scalar relation columns through projected source FKs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const query = orm.nql<{ id: number; authorName: string }>`posts
			| select id, authorId
			| bind projected_posts
projected_posts
			| select id, author.name as authorName
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "projected_posts" as \(/);
		expect(dump.sql).toContain(`FROM ${SCHEMA}.authors AS rc_`);
		expect(dump.sql).toContain('FROM projected_posts');
		expect(dump.sql).not.toContain(`${SCHEMA}.projected_posts`);
		expect(rows).toEqual([
			{ id: 1, authorName: 'Alice Johnson' },
			{ id: 2, authorName: 'Alice Johnson' },
			{ id: 3, authorName: 'Bob Smith' },
			{ id: 4, authorName: 'Alice Johnson' },
			{ id: 5, authorName: 'Bob Smith' },
		]);
	});

	it('executes binding-final hasMany relation columns as deterministic JSON arrays', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const emptyAuthorId = 900_001;

		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${emptyAuthorId}, ${'No Posts'}, ${'no-posts@example.com'})
		`.execute(pool);

		const query = orm.nql<{ id: number; titles: string[] }>`authors
			| select id
			| bind projected_authors
projected_authors
			| select id, author_posts.title as titles
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "projected_authors" as \(/);
		expect(dump.sql).toContain('COALESCE(json_agg');
		expect(dump.sql).toContain('ORDER BY');
		expect(dump.sql).toContain('NULLS LAST');
		expect(dump.sql).not.toMatch(/\bJOIN\s+"?posts"?/i);
		expect(rows.find((row) => row.id === 1)?.titles).toEqual([
			'Advanced TypeScript Patterns',
			'Draft: React Best Practices',
			'Getting Started with TypeScript',
		]);
		expect(rows.find((row) => row.id === 2)?.titles).toEqual([
			'Draft: Database Optimization',
			'Introduction to PostgreSQL',
		]);
		expect(rows.find((row) => row.id === emptyAuthorId)?.titles).toEqual([]);
	});

	it('keeps null elements and duplicate values in binding-final hasMany arrays', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const authorId = 900_002;

		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${authorId}, ${'Nullable Posts'}, ${'nullable-posts@example.com'})
		`.execute(pool);
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES
				(${910_001}, ${'Null content'}, ${null}, ${authorId}, ${true}),
				(${910_002}, ${'Duplicate content A'}, ${'repeat'}, ${authorId}, ${true}),
				(${910_003}, ${'Duplicate content B'}, ${'repeat'}, ${authorId}, ${false})
		`.execute(pool);

		const rows = await orm.nql<{
			id: number;
			contents: Array<string | null>;
		}>`authors
			| where id = ${authorId}
			| select id
			| bind projected_authors
projected_authors
			| select id, author_posts.content as contents`.all();

		// Duplicate content ordering is intentional: deterministic identity/PK ordering
		// is deferred to #192 increment 2 (include hydration), so this loose array
		// assertion is not an oversight.
		expect(rows).toEqual([
			{
				id: authorId,
				contents: ['repeat', 'repeat', null],
			},
		]);
	});

	it('executes binding-final hasMany includes as nested arrays', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const emptyAuthorId = 920_001;

		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.authors (id, name, email)
			VALUES (${emptyAuthorId}, ${'No Include Posts'}, ${'no-include-posts@example.com'})
		`.execute(pool);

		const query = orm.nql<{
			id: number;
			name: string;
			author_posts: Array<{ id: number; title: string; authorId: number }>;
		}>`authors
			| where id = ${1} or id = ${emptyAuthorId}
			| select id, name
			| bind projected_authors
projected_authors
			| select *, author_posts.*
			| order by id`;
		const dump = query.dump();
		const rows = await query.all();

		expect(dump.sql).toMatch(/^WITH "projected_authors" as \(/);
		expect(dump.sql).toContain('json_agg(to_jsonb(__t__))');
		expect(dump.sql).toContain('AS author_posts_json');
		const alice = rows.find((row) => row.id === 1);
		expect(alice?.author_posts).toHaveLength(3);
		expect(alice?.author_posts.map((post) => post.title).sort()).toEqual([
			'Advanced TypeScript Patterns',
			'Draft: React Best Practices',
			'Getting Started with TypeScript',
		]);
		expect(rows.find((row) => row.id === emptyAuthorId)?.author_posts).toEqual(
			[],
		);
		expect(rows[0]).not.toHaveProperty('author_posts_json');
	});

	it('executes binding-final belongsTo includes as nested objects and nulls', async () => {
		const pool = await getTestPool();
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);
		const nullAuthorPostId = 920_101;

		await sql`
			ALTER TABLE ${sql.ref(SCHEMA)}.posts
			ALTER COLUMN author_id DROP NOT NULL
		`.execute(pool);
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts
				(id, title, content, author_id, published, created_at)
			VALUES
				(${nullAuthorPostId}, ${'No Author Include'}, ${'orphan'}, ${null}, ${false}, NOW())
		`.execute(pool);

		const rows = await orm.nql<{
			id: number;
			authorId: number | null;
			author: { id: number; name: string } | null;
		}>`posts
			| where id = ${1} or id = ${nullAuthorPostId}
			| select id, authorId
			| bind projected_posts
projected_posts
			| select *, author.*
			| order by id`.all();

		expect(rows).toHaveLength(2);
		expect(rows[0]?.author).toMatchObject({
			id: 1,
			name: 'Alice Johnson',
		});
		expect(rows[1]).toEqual({
			id: nullAuthorPostId,
			authorId: null,
			author: null,
		});
		expect(rows[0]).not.toHaveProperty('author_json');
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
