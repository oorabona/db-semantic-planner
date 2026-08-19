import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'prepared_statements_e2e';

function compiled<T>(sql: string, parameters: readonly unknown[]) {
	return projectionlessCompiledQuery<T>(
		{ sql, parameters },
		'prepared-statements-e2e',
	);
}

async function preparedCount(
	client: PoolClient,
	sql?: string,
): Promise<number> {
	const result = await client.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM pg_prepared_statements
		 WHERE name LIKE 'dbsp_ps_%'${sql === undefined ? '' : ' AND statement = $1'}`,
		sql === undefined ? [] : [sql],
	);
	return Number(result.rows[0]?.count ?? '0');
}

async function getIsolatedClient(): Promise<{
	readonly client: PoolClient;
	readonly close: () => Promise<void>;
}> {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	const client = await pool.connect();
	return {
		client,
		async close() {
			client.release();
			await pool.end();
		},
	};
}

describe('adapter prepared statements', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE "${SCHEMA}".items (id integer PRIMARY KEY)`);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('leaves no server-side statements when disabled', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });
			const query = compiled<{ value: number }>('SELECT $1::int AS value', [1]);

			await expect(adapter.execute(query)).resolves.toEqual([{ value: 1 }]);
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 1 }]);
			expect(await preparedCount(client)).toBe(0);
		} finally {
			await close();
		}
	});

	it('prepares repeated compiled reads and RETURNING mutations once per connection', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const select = compiled<{ value: number }>(
				'SELECT $1::int AS value',
				[2],
			);
			const returningSql = `INSERT INTO "${SCHEMA}".items (id) VALUES ($1) RETURNING id`;

			await expect(adapter.execute(select)).resolves.toEqual([{ value: 2 }]);
			await expect(adapter.execute(select)).resolves.toEqual([{ value: 2 }]);
			await expect(
				adapter.execute(compiled(returningSql, [20])),
			).resolves.toEqual([{ id: 20 }]);
			await expect(
				adapter.execute(compiled(returningSql, [21])),
			).resolves.toEqual([{ id: 21 }]);
			expect(await preparedCount(client, select.sql)).toBe(1);
			expect(await preparedCount(client, returningSql)).toBe(1);
		} finally {
			await close();
		}
	});

	it('never prepares raw SQL, DDL, or multi-command raw SQL', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});

			await adapter.executeRaw('SELECT $1::int AS value', [3]);
			await adapter.executeRaw('SELECT $1::int AS value', [3]);
			await adapter.executeDDL(
				`CREATE TABLE "${SCHEMA}".ddl_item (id integer)`,
			);
			await adapter.executeRaw('SELECT 1; SELECT 2');
			expect(await preparedCount(client)).toBe(0);
		} finally {
			await close();
		}
	});

	it('leaves cap plus one unnamed', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 1 },
			});
			const first = compiled<{ value: number }>('SELECT $1::int AS value', [4]);
			const second = compiled<{ value: number }>(
				'SELECT $1::int + 1 AS value',
				[4],
			);

			await adapter.execute(first);
			await adapter.execute(first);
			await adapter.execute(second);
			await adapter.execute(second);
			expect(await preparedCount(client, first.sql)).toBe(1);
			expect(await preparedCount(client, second.sql)).toBe(0);
		} finally {
			await close();
		}
	});

	it('recovers unnamed after result-shape DDL invalidates a named plan', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const table = `"${SCHEMA}".invalidated_plan`;
			const sql = `SELECT * FROM ${table} WHERE id = $1`;
			const query = compiled<{ id: number; added?: string }>(sql, [1]);

			await adapter.executeDDL(
				`CREATE TABLE ${table} (id integer PRIMARY KEY)`,
			);
			await adapter.executeRaw(`INSERT INTO ${table} (id) VALUES ($1)`, [1]);
			await adapter.execute(query);
			await adapter.execute(query);
			expect(await preparedCount(client, sql)).toBe(1);
			await adapter.executeDDL(`ALTER TABLE ${table} ADD COLUMN added text`);

			await expect(adapter.execute(query)).resolves.toEqual([
				{ id: 1, added: null },
			]);
			await expect(adapter.execute(query)).resolves.toEqual([
				{ id: 1, added: null },
			]);
			expect(await preparedCount(client, sql)).toBe(1);
		} finally {
			await close();
		}
	});

	it.each([
		'DEALLOCATE ALL',
		'DISCARD ALL',
	])('recovers unnamed after %s clears node-postgres server plans', async (reset) => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sql = 'SELECT $1::int AS value';
			const query = compiled<{ value: number }>(sql, [9]);

			await adapter.execute(query);
			await adapter.execute(query);
			expect(await preparedCount(client, sql)).toBe(1);
			await adapter.executeRaw(reset);

			await expect(adapter.execute(query)).resolves.toEqual([{ value: 9 }]);
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 9 }]);
			expect(await preparedCount(client, sql)).toBe(0);
		} finally {
			await close();
		}
	});
});
