import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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
	try {
		const client = await pool.connect();
		return {
			client,
			async close() {
				try {
					client.release();
				} finally {
					await pool.end();
				}
			},
		};
	} catch (error) {
		await pool.end();
		throw error;
	}
}

describe('adapter prepared statements', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await pool.query(`CREATE TABLE "${SCHEMA}".items (id integer PRIMARY KEY)`);
	});

	afterAll(async () => {
		try {
			await dropSchema(SCHEMA);
		} finally {
			await closeTestDb();
		}
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

	it('uses digest-derived names safely through a pool and borrowed client on one connection', async () => {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
		});
		try {
			const poolAdapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
			});
			const poolSql = 'SELECT $1::int AS value';
			const clientSql = 'SELECT $1::int + 1 AS value';

			await expect(
				poolAdapter.execute(compiled(poolSql, [5])),
			).resolves.toEqual([{ value: 5 }]);
			await expect(
				poolAdapter.execute(compiled(poolSql, [6])),
			).resolves.toEqual([{ value: 6 }]);

			const client = await pool.connect();
			try {
				const clientAdapter = createPgsqlAdapter(client, {
					borrowedClient: true,
					preparedStatements: true,
				});
				await expect(
					clientAdapter.execute(compiled(clientSql, [5])),
				).resolves.toEqual([{ value: 6 }]);
				await expect(
					clientAdapter.execute(compiled(clientSql, [6])),
				).resolves.toEqual([{ value: 7 }]);
				expect(await preparedCount(client, poolSql)).toBe(1);
				expect(await preparedCount(client, clientSql)).toBe(1);
			} finally {
				client.release();
			}
		} finally {
			await pool.end();
		}
	});

	it('uses unnamed execution after result-shape DDL invalidates a named plan', async () => {
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

			await expect(adapter.execute(query)).rejects.toMatchObject({
				code: '0A000',
			});
			await expect(adapter.execute(query)).resolves.toEqual([
				{ id: 1, added: null },
			]);
			expect(await preparedCount(client, sql)).toBe(1);
		} finally {
			await close();
		}
	});

	it('uses unnamed execution after result-shape DDL invalidates a named plan in a caller-owned transaction', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const table = `"${SCHEMA}".invalidated_plan_in_transaction`;
			const sql = `SELECT * FROM ${table} WHERE id = $1`;
			const query = compiled<{ id: number; added?: string }>(sql, [1]);

			await adapter.executeDDL(
				`CREATE TABLE ${table} (id integer PRIMARY KEY)`,
			);
			await adapter.executeRaw(`INSERT INTO ${table} (id) VALUES ($1)`, [1]);
			await adapter.execute(query);
			await adapter.execute(query);
			await client.query('BEGIN');
			try {
				await adapter.executeDDL(`ALTER TABLE ${table} ADD COLUMN added text`);

				await expect(adapter.execute(query)).rejects.toMatchObject({
					code: '0A000',
				});
				await expect(adapter.execute(query)).resolves.toEqual([
					{ id: 1, added: null },
				]);
			} finally {
				await client.query('ROLLBACK');
			}
		} finally {
			await close();
		}
	});

	it.each([
		'DEALLOCATE ALL',
		'DISCARD ALL',
	])('uses unnamed execution after %s clears node-postgres server plans', async (reset) => {
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

			await expect(adapter.execute(query)).rejects.toMatchObject({
				code: '26000',
			});
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 9 }]);
			expect(await preparedCount(client, sql)).toBe(0);
		} finally {
			await close();
		}
	});

	it('does not replay a named execution that raises a recognized SQLSTATE', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sequence = `"${SCHEMA}".no_replay_sequence`;
			const fn = `"${SCHEMA}".raise_0a000_after_nextval`;
			const sql = `SELECT ${fn}($1) AS value`;
			const query = compiled<{ value: number }>(sql, [0]);

			await adapter.executeDDL(`CREATE SEQUENCE ${sequence}`);
			await adapter.executeDDL(`
				CREATE FUNCTION ${fn}(should_fail integer) RETURNS integer
				LANGUAGE plpgsql AS $$
				BEGIN
					IF should_fail = 1 THEN
						PERFORM nextval('${SCHEMA}.no_replay_sequence');
						RAISE EXCEPTION 'expected named execution failure' USING ERRCODE = '0A000';
					END IF;
					RETURN should_fail;
				END;
				$$`);

			await expect(adapter.execute(query)).resolves.toEqual([{ value: 0 }]);
			await expect(
				adapter.execute(compiled<{ value: number }>(sql, [1])),
			).rejects.toMatchObject({ code: '0A000' });
			expect(
				(
					await client.query<{ last_value: string; is_called: boolean }>(
						`SELECT last_value::text, is_called FROM ${sequence}`,
					)
				).rows,
			).toEqual([{ last_value: '1', is_called: true }]);
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 0 }]);
		} finally {
			await close();
		}
	});

	it('tombstones a duplicate external prepared statement name on its client', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sql = 'SELECT $1::int AS value';
			const name = `dbsp_ps_${createHash('sha256')
				.update(sql)
				.digest('hex')
				.slice(0, 32)}`;
			const query = compiled<{ value: number }>(sql, [11]);

			await client.query(`PREPARE ${name}(integer) AS ${sql}`);
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 11 }]);
			await expect(adapter.execute(query)).rejects.toMatchObject({
				code: '42P05',
			});
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 11 }]);
		} finally {
			await close();
		}
	});

	it('disables naming pool-wide after one client resets while another pool stays eligible', async () => {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 2,
		});
		let first: PoolClient | undefined;
		let second: PoolClient | undefined;
		try {
			first = await pool.connect();
			second = await pool.connect();
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const sql = 'SELECT $1::int AS value';

			await (adapter as any).issueConnectionQuery(first, sql, [13], true);
			await (adapter as any).issueConnectionQuery(first, sql, [13], true);
			await (adapter as any).issueConnectionQuery(second, sql, [13], true);
			expect(await preparedCount(first, sql)).toBe(1);
			expect(await preparedCount(second, sql)).toBe(1);

			await first.query('DISCARD ALL');
			await expect(
				(adapter as any).issueConnectionQuery(first, sql, [13], true),
			).rejects.toMatchObject({ code: '26000' });
			await expect(
				(adapter as any).issueConnectionQuery(first, sql, [13], true),
			).resolves.toMatchObject({ rows: [{ value: 13 }] });
			expect(await preparedCount(first, sql)).toBe(0);
			expect(await preparedCount(second, sql)).toBe(1);
			await expect(
				(adapter as any).issueConnectionQuery(second, sql, [13], true),
			).resolves.toMatchObject({ rows: [{ value: 13 }] });
			const otherPool = new Pool({
				connectionString: process.env.DATABASE_URL,
				max: 1,
			});
			try {
				const otherAdapter = createPgsqlAdapter(otherPool, {
					preparedStatements: true,
				});
				await otherAdapter.execute(compiled(sql, [13]));
				await otherAdapter.execute(compiled(sql, [13]));
				const otherClient = await otherPool.connect();
				try {
					expect(await preparedCount(otherClient, sql)).toBe(1);
				} finally {
					otherClient.release();
				}
			} finally {
				await otherPool.end();
			}
		} finally {
			first?.release();
			second?.release();
			await pool.end();
		}
	});

	it('rejects a pending named pool query after backend termination without terminating the child process', async () => {
		const applicationName = `dbsp-prepared-${randomUUID()}`;
		const childSource = `
			import { Pool } from 'pg';
			import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
			import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
			const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: process.env.DBSP_APPLICATION_NAME });
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const compiled = (value) => projectionlessCompiledQuery({ sql: 'SELECT pg_sleep(30) WHERE $1::boolean', parameters: [value] }, 'prepared-statements-transport-child');
			await adapter.execute(compiled(false));
			await adapter.execute(compiled(false));
			try {
				await adapter.execute(compiled(true));
				console.error('pending named query unexpectedly resolved');
				process.exitCode = 1;
			} catch (error) {
				console.log('named-query-rejected:' + (error && typeof error === 'object' && 'code' in error ? error.code : 'unknown'));
			} finally {
				await pool.end();
			}
		`;
		const child = spawn(
			process.execPath,
			['--import', 'tsx', '--input-type=module', '--eval', childSource],
			{
				env: {
					...process.env,
					DBSP_APPLICATION_NAME: applicationName,
				},
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
		const childExit = new Promise<
			| { readonly kind: 'error'; readonly error: Error }
			| {
					readonly kind: 'exit';
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
			  }
		>((resolve) => {
			child.once('error', (error) => resolve({ kind: 'error', error }));
			child.once('exit', (code, signal) =>
				resolve({ kind: 'exit', code, signal }),
			);
		});
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		try {
			const pool = await getTestPool();
			let pid: number | undefined;
			for (let attempt = 0; attempt < 100 && pid === undefined; attempt += 1) {
				const result = await pool.query<{ pid: number }>(
					`SELECT pid FROM pg_catalog.pg_stat_activity
					 WHERE application_name = $1 AND state = 'active'
					 ORDER BY backend_start DESC LIMIT 1`,
					[applicationName],
				);
				pid = result.rows[0]?.pid;
				if (pid === undefined)
					await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(pid).toBeTypeOf('number');
			await pool.query('SELECT pg_catalog.pg_terminate_backend($1::int)', [
				pid,
			]);
			const exited = await childExit;
			expect(exited).toEqual({ kind: 'exit', code: 0, signal: null });
			expect(stdout.trim()).toBe('named-query-rejected:57P01');
			expect(stderr).not.toMatch(/Unhandled 'error'|unhandled error event/i);
		} finally {
			if (child.exitCode === null) {
				child.kill('SIGKILL');
				await childExit;
			}
		}
	});
});
