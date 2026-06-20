/**
 * E2E coverage for NQL multi-mutation tag programs.
 *
 * These tests require the PostgreSQL Testcontainers setup used by test:e2e.
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
	sql,
} from './testkit/index.js';

describe('NQL multi-mutation tag programs', () => {
	const SCHEMA = 'nql_multi_mutation_e2e';

	beforeAll(async () => {
		await dropBlogSchema(SCHEMA);
		await createBlogSchema(SCHEMA);
		await seedBlogData(SCHEMA);
	});

	afterAll(async () => {
		await dropBlogSchema(SCHEMA);
		await closeTestDb();
	});

	it('runs mutation bindings and final mutation atomically with data-flow through typed CTEs', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const program = orm.nql<{
			id: number;
		}>`insert into posts set id = ${9100}, title = ${'NQL multi mutation'}, content = ${'created by #173 e2e'}, authorId = ${1}, published = ${false} | select id | bind new_post
update posts set published = ${true} where id in (new_post) | select id`;
		const dump = program.dump();
		const rows = await program.all();

		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[1]?.sql).toContain(
			`WITH "new_post" ("id") as (SELECT "id" FROM "${SCHEMA}"."posts" WHERE false)`,
		);
		expect(dump.sequence?.[1]?.sql).not.toMatch(
			/WITH "new_post"\s+as\s+\(\s*insert/i,
		);
		expect(rows).toEqual([{ id: 9100 }]);

		const pool = await getTestPool();
		const persisted = await sql<{ published: boolean }>`
			SELECT published
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9100}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ published: true }]);
	});

	it('executes an empty table-derived mutation binding predicate without losing column type', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const program = orm.nql<{
			id: number;
		}>`update posts set published = ${true} where id = ${-9200} | select id | bind touched_posts
update posts set title = ${'empty binding should not update'} where id in (touched_posts) | select id`;
		const dump = program.dump();
		const rows = await program.all();

		expect(dump.sequence).toHaveLength(2);
		expect(dump.sequence?.[1]?.sql).toContain(
			`WITH "touched_posts" ("id") as (SELECT "id" FROM "${SCHEMA}"."posts" WHERE false)`,
		);
		expect(dump.sequence?.[1]?.sql).not.toContain('NULL::');
		expect(dump.sequence?.[1]?.sql).not.toContain('VALUES (NULL)');
		expect(rows).toEqual([]);
	});

	it('snapshots a read binding before an intervening mutation changes matching data', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9300}, ${'snapshot before'}, ${'read bind drift fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{
			id: number;
			title: string;
		}>`posts | where id = ${9300} | select id, title | bind original_post
update posts set title = ${'snapshot after'} where id = ${9300} | select id | bind changed
original_post | select id, title`.all();

		expect(rows).toEqual([{ id: 9300, title: 'snapshot before' }]);

		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9300}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'snapshot after' }]);
	});

	it('keeps an empty read snapshot empty after a mutation creates matching state', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9301}, ${'empty snapshot before'}, ${'empty drift fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{ id: number }>`posts
			| where title = ${'empty snapshot after'}
			| select id
			| bind matching_posts
update posts set title = ${'empty snapshot after'} where id = ${9301} | select id | bind changed
matching_posts | select id`.all();

		expect(rows).toEqual([]);

		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9301}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'empty snapshot after' }]);
	});

	it('preserves multi-row read snapshot order from ORDER BY', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES
				(${9302}, ${'ordered first'}, ${'ordered drift fixture'}, ${1}, ${false}),
				(${9303}, ${'ordered second'}, ${'ordered drift fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{ id: number }>`posts
			| where id >= ${9302} and id <= ${9303}
			| select id
			| order by id desc
			| bind ordered_posts
update posts set title = ${'ordered mutated'} where id = ${9302} | select id | bind changed
ordered_posts | select id`.all();

		expect(rows).toEqual([{ id: 9303 }, { id: 9302 }]);
	});

	it('uses the same pre-mutation read snapshot before and after a later mutation', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9304}, ${'before-and-after original'}, ${'before-and-after fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{
			id: number;
			title: string;
		}>`posts | where id = ${9304} | select id, title | bind original_post
update posts set content = ${'touched through original snapshot'} where id in (original_post | select id) | select id | bind before_touch
update posts set title = ${'before-and-after mutated'} where id = ${9304} | select id | bind changed
original_post | where id in (before_touch | select id) | select id, title`.all();

		expect(rows).toEqual([{ id: 9304, title: 'before-and-after original' }]);

		const persisted = await sql<{ title: string; content: string }>`
			SELECT title, content
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9304}
		`.execute(pool);
		expect(persisted.rows).toEqual([
			{
				title: 'before-and-after mutated',
				content: 'touched through original snapshot',
			},
		]);
	});

	it('rolls back the whole program when a later mutation fails', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		await expect(
			orm.nql`insert into posts set id = ${9101}, title = ${'NQL rollback'}, content = ${'should not persist'}, authorId = ${1}, published = ${false} | select id | bind new_post
update posts set authorId = ${999999} where id in (new_post) | select id`.all(),
		).rejects.toThrow();

		const pool = await getTestPool();
		const persisted = await sql<{ count: string }>`
			SELECT count(*)::text AS count
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9101}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ count: '0' }]);
	});
});
