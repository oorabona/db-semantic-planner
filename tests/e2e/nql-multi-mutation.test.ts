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
			'WITH "new_post" ("id") as (SELECT CAST(NULL AS integer) AS "id" WHERE false)',
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
			'WITH "touched_posts" ("id") as (SELECT CAST(NULL AS integer) AS "id" WHERE false)',
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

	it('snapshots an aliased column across an intervening mutation (#213 S1)', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9400}, ${'aliased before'}, ${'S1 fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{
			n: string;
		}>`posts | where id = ${9400} | select title as n | bind b
update posts set title = ${'CHANGED'} where id = ${9400} | select id | bind changed
b | select n`.all();

		expect(rows).toEqual([{ n: 'aliased before' }]);

		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9400}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'CHANGED' }]);
	});

	it('materializes an empty synthetic anchor for a zero-row aliased read-bind snapshot (#213 S9)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const rows = await orm.nql<{
			n: string;
		}>`posts | where id = ${-9401} | select title as n | bind b
update posts set title = ${'noop'} where id = ${-9401} | select id | bind changed
b | select n`.all();

		expect(rows).toEqual([]);
	});

	it('keeps the snapshot capture query schema-qualified and the CTE name unqualified under withSchema (#213 S8)', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9402}, ${'withSchema before'}, ${'S8 fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const program = orm.nql<{
			n: string;
		}>`posts | where id = ${9402} | select title as n | bind b
update posts set title = ${'withSchema after'} where id = ${9402} | select id | bind changed
b | select n`;
		const dump = program.dump();
		const rows = await program.all();

		// The snapshot capture query (compiled before any mutation runs) is a
		// plain physical-table SELECT, unaffected by the typed-anchor CTE path
		// — it must stay schema-qualified like every other physical query.
		expect(dump.sequence?.[0]?.sql).toContain(`FROM ${SCHEMA}.posts`);
		// The CTE/binding name 'b' must never be schema-qualified (existing
		// convention — proven here by successful execution: a wrongly
		// schema-qualified CTE reference would fail to resolve at all).
		expect(rows).toEqual([{ n: 'withSchema before' }]);

		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9402}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'withSchema after' }]);
	});

	it('keeps a computed-expression read binding fail-loud across a mutation (#213 S5)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		await expect(
			orm.nql`posts | select id * 2 as double | bind b
update posts set title = ${'noop'} where id = ${1} | select id | bind changed
b | select double`.all(),
		).rejects.toThrow(
			/unsupported snapshot shape \(#186\).*computed-expression column 'double'/,
		);
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

	it('snapshots a transitive read-bind chained from another read-bind across a mutation (#213 S2)', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9500}, ${'S2 before'}, ${'S2 fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const program = orm.nql<{
			title: string;
		}>`posts | where id = ${9500} | select id, title | bind b1
b1 | select title | bind b2
update posts set title = ${'CHANGED'} where id = ${9500} | select id | bind changed
b2 | select title`;
		const dump = program.dump();
		const rows = await program.all();

		expect(rows).toEqual([{ title: 'S2 before' }]);
		// b2's snapshot-capture statement embeds b1's CTE (read-bind CTEs
		// always emit — #173) — b2 is chained FROM b1, never re-derived from
		// the physical `posts` table directly.
		const b2Step = dump.sequence?.find((step) => step.bindName === 'b2');
		expect(b2Step?.sql).toContain('"b1"');

		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9500}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'CHANGED' }]);
	});

	it('keeps a transitive read-bind chain inline when it never crosses a mutation (#213 S2 sibling)', async () => {
		const pool = await getTestPool();
		await sql`
			INSERT INTO ${sql.ref(SCHEMA)}.posts (id, title, content, author_id, published)
			VALUES (${9501}, ${'S2 sibling inline'}, ${'S2 sibling fixture'}, ${1}, ${false})
		`.execute(pool);
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		// Same b1 -> b2 read-bind chain as S2, but with NO trailing cross-
		// mutation reference to b2 — the conditional snapshot path stays
		// OFF, and the chain compiles/executes inline (never a typed empty
		// anchor CTE).
		const program = orm.nql<{
			title: string;
		}>`posts | where id = ${9501} | select id, title | bind b1
b1 | select title | bind b2
b2 | select title | bind b2_check
update posts set title = ${'noop'} where id = ${9501} | select id`;
		const dump = program.dump();
		const rows = await program.all();

		const allSql = (dump.sequence ?? []).map((step) => step.sql).join('\n');
		expect(allSql).not.toContain('CAST(NULL AS');
		expect(rows).toEqual([{ id: 9501 }]);
	});

	it('snapshots a transitive read-bind chained from a mutation-RETURNING bind across a mutation (#213 S3)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		const program = orm.nql<{
			title: string;
		}>`insert into posts set id = ${9600}, title = ${'S3 first'}, content = ${'S3 fixture'}, authorId = ${1}, published = ${false} | select id, title | bind m
m | select title | bind b
update posts set title = ${'S3 second'} where id = ${9600} | select id | bind changed
b | select title`;
		const rows = await program.all();

		// b reflects the FIRST mutation's RETURNING rows, not the second
		// mutation's effect.
		expect(rows).toEqual([{ title: 'S3 first' }]);

		const pool = await getTestPool();
		const persisted = await sql<{ title: string }>`
			SELECT title
			FROM ${sql.ref(SCHEMA)}.posts
			WHERE id = ${9600}
		`.execute(pool);
		expect(persisted.rows).toEqual([{ title: 'S3 second' }]);
	});

	it('rejects a transitive snapshot sourced from an aliased mutation-RETURNING binding (#213 S11)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ schema: blogSchema, adapter }).withSchema(SCHEMA);

		// #217: executing a reference to an ALIASED mutation-RETURNING bind is
		// broken upstream — this never reaches execution because the SNAPSHOT
		// GATE rejects 'b' at NQL-compile time (before any adapter/execute
		// call), naming the propagated 'aliased-returning' reason.
		await expect(
			orm.nql`insert into posts set id = ${9700}, title = ${'S11'}, content = ${'S11 fixture'}, authorId = ${1}, published = ${false} | select title as who | bind m
m | select who | bind b
update posts set title = ${'S11 changed'} where id = ${9700} | select id | bind changed
b | select who`.all(),
		).rejects.toThrow(
			/unsupported snapshot shape \(#186\).*binding 'b' has aliased-returning column 'who'/,
		);
	});
});
