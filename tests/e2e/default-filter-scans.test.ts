import {
	createOrm,
	eq,
	exists,
	gt,
	isNull,
	outerRef,
	type QueryIntent,
	ref,
	SubqueryExpression,
	schema,
	subquery,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
	getTestPool,
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
	it('counts only visible rows in a selectExpression body (#891)', async () => {
		const orm = await makeOrm();
		const count = subquery('posts').count().asExpr('n');
		const rows = await orm.selectExpression(count).execute();
		expect(rows).toHaveLength(1);
		expect(Object.values(rows[0] as object)).toEqual(['2']);
		const unfiltered = await orm
			.withoutDefaultFilters()
			.selectExpression(count)
			.execute();
		expect(Object.values(unfiltered[0] as object)).toEqual(['4']);
	});
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

describe('scalar subquery bodies select the rows a hand-written query selects (#891 slice 5b)', () => {
	type Orm = Awaited<ReturnType<typeof makeOrm>>;
	// buildIntent() is a builder internal, absent from the public QueryBuilder type.
	const body = (q: unknown) =>
		new SubqueryExpression((q as { buildIntent(): QueryIntent }).buildIntent());
	const authored = (o: Orm) =>
		o.select('posts').where(eq('authorId', outerRef('id')));
	const rowsOf = async (o: Orm, b: SubqueryExpression) =>
		(
			await o
				.select('users')
				.columns(['id', b.asExpr('v')])
				.orderBy('id')
				.all()
		).map((row) => ({ ...row }));
	const oracle = async (text: string) =>
		(await (await getTestPool()).query(text)).rows.map((row) => ({ ...row }));
	const grouped = (o: Orm) =>
		body(
			authored(o)
				.columns([])
				.groupBy(['authorId'])
				.count('id', 'n')
				.having(gt('n', 0)),
		);

	it('AC8 e2e-groupby: a correlated GROUP BY body', async () => {
		const orm = (await makeOrm()).withoutDefaultFilters();
		const expected = await oracle(
			`SELECT u.id, (SELECT count(p.id) FROM ${SCHEMA}.posts p WHERE p.author_id = u.id GROUP BY p.author_id HAVING count(p.id) > 0) AS v FROM ${SCHEMA}.users u ORDER BY u.id`,
		);
		expect(expected).toEqual([
			{ id: 1, v: '2' },
			{ id: 2, v: '1' },
			{ id: 3, v: '1' },
			{ id: 4, v: null },
		]);
		expect(await rowsOf(orm, grouped(orm))).toEqual(expected);
	});

	it('AC8 e2e-offset: the n-th item of each parent', async () => {
		const orm = (await makeOrm()).withoutDefaultFilters();
		const nth = body(
			authored(orm).columns(['id']).orderBy('id').limit(1).offset(1),
		);
		const expected = await oracle(
			`SELECT u.id, (SELECT p.id FROM ${SCHEMA}.posts p WHERE p.author_id = u.id ORDER BY p.id LIMIT 1 OFFSET 1) AS v FROM ${SCHEMA}.users u ORDER BY u.id`,
		);
		expect(expected).toEqual([
			{ id: 1, v: 11 },
			{ id: 2, v: null },
			{ id: 3, v: null },
			{ id: 4, v: null },
		]);
		expect(await rowsOf(orm, nth)).toEqual(expected);
	});

	it('AC8 e2e-groupby-filtered: the GROUP BY body under default filters', async () => {
		const orm = await makeOrm();
		const expected = await oracle(
			`SELECT u.id, (SELECT count(p.id) FROM ${SCHEMA}.posts p WHERE p.deleted_at IS NULL AND p.author_id = u.id GROUP BY p.author_id HAVING count(p.id) > 0) AS v FROM ${SCHEMA}.users u WHERE u.deleted_at IS NULL ORDER BY u.id`,
		);
		expect(expected).toEqual([
			{ id: 1, v: '1' },
			{ id: 3, v: null },
			{ id: 4, v: null },
		]);
		expect(await rowsOf(orm, grouped(orm))).toEqual(expected);
	});
});
