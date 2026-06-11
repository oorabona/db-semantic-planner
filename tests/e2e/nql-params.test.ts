/**
 * FEAT-134 E2E: NQL tag interpolation binds values as PostgreSQL params.
 */

import { createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	blogSchema,
	closeTestDb,
	createBlogSchema,
	dropBlogSchema,
	getTestAdapter,
	seedBlogData,
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
});
