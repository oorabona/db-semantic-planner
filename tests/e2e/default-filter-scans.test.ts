import { createOrm, eq, exists, isNull, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const SCHEMA = 'default_filter_scans_e2e';
const db = schema(
	{
		users: {
			id: { type: 'integer', primaryKey: true },
			deletedAt: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			authorId: ref('users', { as: 'author', inverse: 'authored' }),
		},
	},
	undefined,
	{
		defaultFilters: { users: isNull('deletedAt'), posts: isNull('deletedAt') },
	},
);

beforeAll(async () => {
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await execInSchema(
		SCHEMA,
		`CREATE TABLE users (id integer PRIMARY KEY, deleted_at timestamp);
 CREATE TABLE posts (id integer PRIMARY KEY, title text, deleted_at timestamp, author_id integer REFERENCES users(id));
 INSERT INTO users (id, deleted_at) VALUES (1,NULL),(2,'2026-01-01'),(3,NULL),(4,NULL);
 INSERT INTO posts (id, title, deleted_at, author_id) VALUES (10,'hidden','2026-01-01',1),(11,'live',NULL,1),(12,'live',NULL,2),(13,'hidden','2026-01-01',3);`,
	);
});
afterAll(async () => {
	await dropSchema(SCHEMA);
	await closeTestDb();
});

async function makeOrm() {
	return createOrm({ schema: db, adapter: await getTestAdapter() }).withSchema(
		SCHEMA,
	);
}

describe('default filters on physical read scans', () => {
	it('preserves a left-joined parent when its author is filtered out', async () => {
		const orm = await makeOrm();
		const rows = await orm
			.select('posts')
			.include('author', { join: 'left' })
			.orderBy('id')
			.all();
		expect(rows).toEqual([
			expect.objectContaining({ id: 11, author: { id: 1, deletedAt: null } }),
			expect.objectContaining({ id: 12, author: null }),
		]);
		const unfiltered = await orm
			.withoutDefaultFilters()
			.select('posts')
			.include('author', { join: 'left' })
			.orderBy('id')
			.all();
		expect(unfiltered.map((row) => row.id)).toEqual([10, 11, 12, 13]);
	});
	for (const strategy of ['json_agg', 'lateral'] as const) {
		it(`omits filtered children and preserves empty parents with ${strategy}`, async () => {
			const orm = await makeOrm();
			const rows = await orm
				.select('users')
				.include('authored')
				.withPlanOptions({ defaultIncludeStrategy: strategy })
				.orderBy('id')
				.all();
			if (strategy === 'json_agg') {
				expect(rows).toEqual([
					expect.objectContaining({
						id: 1,
						authored: [expect.objectContaining({ id: 11 })],
					}),
					expect.objectContaining({ id: 3, authored: [] }),
					expect.objectContaining({ id: 4, authored: [] }),
				]);
			} else {
				expect(rows).toEqual([
					expect.objectContaining({
						id: 1,
						authored: { id: 11, authorId: 1, deletedAt: null, title: 'live' },
					}),
					expect.objectContaining({ id: 3, authored: null }),
					expect.objectContaining({ id: 4, authored: null }),
				]);
			}
		});
	}
	it('makes exists false and every true when all children are filtered out', async () => {
		const orm = await makeOrm();
		const some = await orm
			.select('users')
			.where(exists('authored'))
			.orderBy('id')
			.all();
		expect(some.map((row) => row.id)).toEqual([1]);
		const all = await orm
			.select('users')
			.where({
				kind: 'relationFilter',
				relation: 'authored',
				mode: 'every',
				where: eq('title', 'live'),
			})
			.orderBy('id')
			.all();
		expect(all.map((row) => row.id)).toEqual([1, 3, 4]);
		const unfiltered = await orm
			.withoutDefaultFilters()
			.select('users')
			.where(exists('authored'))
			.orderBy('id')
			.all();
		expect(unfiltered.map((row) => row.id)).toEqual([1, 2, 3]);
	});
});
