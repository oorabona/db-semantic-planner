/**
 * ADR 0011 delivery 4 on real PostgreSQL: mutation values store the same rows
 * whether an INSERT takes VALUES (2 rows) or the unnest strategy (51 rows,
 * above the default batchThreshold of 50), and expression values compile.
 */

import {
	createOrm,
	eq,
	exprRef,
	fn,
	op,
	param,
	sql as rawSql,
	schema,
} from '@dbsp/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const SCHEMA = 'mutation_value_leaves_e2e';

const db = schema({
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text', nullable: true },
		score: { type: 'integer', nullable: true },
		meta: { type: 'jsonb', nullable: true },
		created: { type: 'timestamp', nullable: true },
		data: { type: 'text', dbType: 'bytea', nullable: true },
		tags: { type: 'text', dbType: 'integer[]', nullable: true },
	},
	ev2: {
		id: { type: 'integer', primaryKey: true },
		ts: { type: 'timestamp', dbType: 'timestamp', nullable: true },
		j: { type: 'json', dbType: 'json', nullable: true },
	},
	nt: {
		id: { type: 'integer', primaryKey: true },
		n: { type: 'number', nullable: true },
	},
});

type Rows = Record<string, unknown>[];
const rows = (n: number, cell: (id: number) => Record<string, unknown>): Rows =>
	Array.from({ length: n }, (_, i) => ({ id: i + 1, ...cell(i + 1) }));

const makeOrm = (pool: Awaited<ReturnType<typeof getTestPool>>) =>
	createOrm({
		schema: db,
		adapter: createPgAdapter(pool, { model: db.model, schemaName: SCHEMA }),
		suppressDxWarnings: true,
	});

describe('ADR 0011 delivery 4: mutation values on PostgreSQL', () => {
	let orm: ReturnType<typeof makeOrm>;
	const query = async (text: string) =>
		(await (await getTestPool()).query(text)).rows;
	const insert = (table: 'posts' | 'ev2' | 'nt', values: Rows) =>
		orm
			.insert(table)
			.values(values as never)
			.execute();

	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		const s = sql.ref(SCHEMA);
		await sql`
			CREATE TABLE ${s}.posts (
				id int4 PRIMARY KEY, title text, score int4, meta jsonb,
				created timestamptz, data bytea, tags int4[]
			)
		`.execute(pool);
		await sql`CREATE TABLE ${s}.ev2 (id int4 PRIMARY KEY, ts timestamp, j json)`.execute(
			pool,
		);
		await sql`CREATE TABLE ${s}.nt (id int4 PRIMARY KEY, n integer)`.execute(
			pool,
		);
		orm = makeOrm(pool);
	});

	beforeEach(async () => {
		await query(`TRUNCATE ${SCHEMA}.posts, ${SCHEMA}.ev2, ${SCHEMA}.nt`);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('param: param(5) cells store 5 on both strategies', async () => {
		for (const n of [2, 51]) {
			await query(`TRUNCATE ${SCHEMA}.posts`);
			await insert(
				'posts',
				rows(n, () => ({ score: param(5) })),
			);
			expect(
				await query(
					`SELECT score, count(*)::int AS n FROM ${SCHEMA}.posts GROUP BY score`,
				),
			).toEqual([{ score: 5, n }]);
		}
	});

	it('expression: an fn() cell in a 51-row batch is evaluated', async () => {
		await insert(
			'posts',
			rows(51, (id) => ({ created: id === 1 ? fn('now') : new Date(0) })),
		);
		expect(
			await query(
				`SELECT count(*)::int AS n, bool_and(id = 1 OR created = 'epoch') AS others,
				 bool_or(id = 1 AND abs(extract(epoch FROM now() - created)) < 60) AS first
				 FROM ${SCHEMA}.posts`,
			),
		).toEqual([{ n: 51, others: true, first: true }]);
	});

	it('sql: sql() cells in a 51-row batch are evaluated', async () => {
		await insert(
			'posts',
			rows(51, () => ({ created: rawSql('now()') })),
		);
		expect(
			await query(
				`SELECT count(*)::int AS n, count(created)::int AS filled FROM ${SCHEMA}.posts`,
			),
		).toEqual([{ n: 51, filled: 51 }]);
	});

	it('jsonb-array: array cells in a jsonb column are refused on both strategies', async () => {
		for (const n of [2, 51])
			await expect(
				insert(
					'posts',
					rows(n, (id) => ({ meta: [id, 1] })),
				),
			).rejects.toThrow('invalid input syntax for type json');
		expect(
			await query(`SELECT count(*)::int AS n FROM ${SCHEMA}.posts`),
		).toEqual([{ n: 0 }]);
	});

	it('binary: Buffer cells store the same bytes on both strategies', async () => {
		for (const n of [2, 51]) {
			await query(`TRUNCATE ${SCHEMA}.posts`);
			await insert(
				'posts',
				rows(n, () => ({ data: Buffer.from([0x61, 0x00, 0xff]) })),
			);
			expect(
				await query(
					`SELECT encode(data, 'hex') AS h, count(*)::int AS n FROM ${SCHEMA}.posts GROUP BY 1`,
				),
			).toEqual([{ h: '6100ff', n }]);
		}
	});

	it('physical-types: timestamp and json columns store the same text on both strategies', async () => {
		const previous = process.env.TZ;
		process.env.TZ = 'Asia/Karachi';
		try {
			for (const n of [2, 51]) {
				await query(`TRUNCATE ${SCHEMA}.ev2`);
				await insert(
					'ev2',
					rows(n, () => ({
						ts: new Date(Date.UTC(2026, 10, 27, 12)),
						j: { b: 1, a: 2 },
					})),
				);
				expect(
					await query(
						`SELECT ts::text AS ts, j::text AS j, count(*)::int AS n FROM ${SCHEMA}.ev2 GROUP BY 1, 2`,
					),
				).toEqual([{ ts: '2026-11-27 17:00:00', j: '{"b":1,"a":2}', n }]);
			}
		} finally {
			if (previous === undefined) delete process.env.TZ;
			else process.env.TZ = previous;
		}
	});

	it('number: 1.5 into a number column is refused on both strategies', async () => {
		for (const n of [2, 51])
			await expect(
				insert(
					'nt',
					rows(n, () => ({ n: 1.5 })),
				),
			).rejects.toThrow('invalid input syntax for type integer: "1.5"');
		expect(await query(`SELECT count(*)::int AS n FROM ${SCHEMA}.nt`)).toEqual([
			{ n: 0 },
		]);
	});

	it('int-array: array cells in an int4[] column store each array above the threshold', async () => {
		await insert(
			'posts',
			rows(51, (id) => ({ tags: [id, 1] })),
		);
		expect(
			await query(
				`SELECT count(*)::int AS n, bool_and(tags = ARRAY[id, 1]) AS each FROM ${SCHEMA}.posts`,
			),
		).toEqual([{ n: 51, each: true }]);
	});

	it('set: an expression SET value updates from the current row', async () => {
		await insert('posts', [{ id: 1, score: 2 }]);
		await orm
			.update('posts')
			.set({ score: op('+', exprRef('score'), 1) as never })
			.where(eq('id', 1))
			.execute();
		expect(await query(`SELECT score FROM ${SCHEMA}.posts`)).toEqual([
			{ score: 3 },
		]);
	});

	it('doUpdate: an expression doUpdate value reads the existing row', async () => {
		await insert('posts', [{ id: 1, score: 3 }]);
		await orm
			.upsert('posts')
			.values({ id: 1, score: 10 })
			.onConflict(['id'])
			.doUpdate({ score: op('+', exprRef('score'), 1) as never })
			.execute();
		expect(await query(`SELECT score FROM ${SCHEMA}.posts`)).toEqual([
			{ score: 4 },
		]);
	});
});
