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
