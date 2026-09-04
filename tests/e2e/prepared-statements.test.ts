import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPgsqlAdapter, PgsqlAdapter } from '@dbsp/adapter-pgsql';
import { projectionlessCompiledQuery } from '@dbsp/types/adapter-sdk';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = `prepared_statements_e2e_${randomUUID().replaceAll('-', '')}`;

function compiled<T>(sql: string, parameters: readonly unknown[]) {
	return projectionlessCompiledQuery<T>(
		{ sql, parameters },
		'prepared-statements-e2e',
	);
}

function preparedName(sql: string): string {
	return `dbsp_ps_${createHash('sha256')
		.update(sql)
		.digest('hex')
		.slice(0, 32)}`;
}

function hasValues(
	actual: unknown,
	expected: readonly unknown[],
): actual is readonly unknown[] {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((value, index) => Object.is(value, expected[index]))
	);
}

function hasCachedPlanInvalidationInCauseChain(error: unknown): boolean {
	const seen = new Set<unknown>();
	let current = error;

	while (
		typeof current === 'object' &&
		current !== null &&
		!seen.has(current)
	) {
		seen.add(current);
		if (
			'code' in current &&
			current.code === '0A000' &&
			'routine' in current &&
			current.routine === 'RevalidateCachedQuery'
		) {
			return true;
		}
		current = 'cause' in current ? current.cause : undefined;
	}

	return false;
}

function isNamedQuery(
	argument: unknown,
	name: string,
	sql: string,
	values: readonly unknown[],
): boolean {
	return (
		typeof argument === 'object' &&
		argument !== null &&
		'name' in argument &&
		'text' in argument &&
		'values' in argument &&
		argument.name === name &&
		argument.text === sql &&
		hasValues(argument.values, values)
	);
}

function expectNamedReplayThenUnnamed(
	calls: readonly (readonly unknown[])[],
	name: string,
	sql: string,
	values: readonly unknown[],
): void {
	const targetCalls = calls.filter(([argument]) =>
		typeof argument === 'string'
			? argument === sql
			: typeof argument === 'object' &&
				argument !== null &&
				'text' in argument &&
				argument.text === sql,
	);
	let namedObserved = false;
	let unnamedObservedAfterNamed = false;

	for (const [argument, parameters] of targetCalls) {
		if (isNamedQuery(argument, name, sql, values)) {
			namedObserved = true;
		} else if (
			namedObserved &&
			argument === sql &&
			hasValues(parameters, values)
		) {
			unnamedObservedAfterNamed = true;
		}
	}

	expect(namedObserved).toBe(true);
	expect(unnamedObservedAfterNamed).toBe(true);
}

async function preparedCount(
	executor: PoolClient | PgsqlAdapter,
	sql?: string,
): Promise<number> {
	const statement = `SELECT count(*)::text AS count FROM pg_prepared_statements
		 WHERE name LIKE 'dbsp_ps_%'${sql === undefined ? '' : ' AND statement = $1'}`;
	const parameters = sql === undefined ? [] : [sql];
	const rows =
		executor instanceof PgsqlAdapter
			? await executor.executeRaw<{ count: string }>(statement, parameters)
			: (await executor.query<{ count: string }>(statement, parameters)).rows;
	return Number(rows[0]?.count ?? '0');
}

function requirePgsqlAdapter(adapter: unknown): PgsqlAdapter {
	if (!(adapter instanceof PgsqlAdapter)) {
		throw new TypeError('Expected a PgsqlAdapter pinned connection.');
	}
	return adapter;
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

async function expectPoolOwnedScopeToReplaceQuarantinedClient(
	runScope: (
		adapter: any,
		callback: (scope: any) => Promise<void>,
	) => Promise<void>,
	replaysInsideScope = false,
): Promise<void> {
	const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
	try {
		const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
		const sql = 'SELECT pg_backend_pid()::int AS pid, $1::int AS value';
		const name = `dbsp_ps_${createHash('sha256')
			.update(sql)
			.digest('hex')
			.slice(0, 32)}`;
		const query = compiled<{ pid: number; value: number }>(sql, [17]);
		let quarantinedPid: number | undefined;

		const scope = runScope(adapter, async (scope) => {
			quarantinedPid = (await scope.execute(query))[0]?.pid;
			await scope.execute(query);
			await scope.executeRaw(`DEALLOCATE ${name}`);
			if (replaysInsideScope) {
				const querySpy = vi.spyOn(scope.client, 'query');
				try {
					await expect(scope.execute(query)).resolves.toEqual([
						expect.objectContaining({
							pid: quarantinedPid,
							value: 17,
						}),
					]);
					expectNamedReplayThenUnnamed(querySpy.mock.calls, name, sql, [17]);
				} finally {
					querySpy.mockRestore();
				}
				return;
			}
			await expect(scope.execute(query)).rejects.toMatchObject({
				code: '26000',
				routine: 'FetchPreparedStatement',
			});
		});
		if (replaysInsideScope) {
			await expect(scope).resolves.toBeUndefined();
		} else {
			await expect(scope).rejects.toThrow(
				/PostgreSQL transaction is aborted because a statement failed inside a dbsp-managed scope/,
			);
		}
		expect(quarantinedPid).toEqual(expect.any(Number));

		const replacement = await adapter.execute(query);
		expect(replacement).toEqual([expect.objectContaining({ value: 17 })]);
		expect(replacement[0]?.pid).not.toBe(quarantinedPid);
		const replacementClient = await pool.connect();
		try {
			expect(await preparedCount(replacementClient, sql)).toBe(1);
		} finally {
			replacementClient.release();
		}
	} finally {
		await pool.end();
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

	it('frees failed Parse reservations so a later hot query can prepare', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: { maxStatements: 2 },
			});
			const failedSql = [
				'SELECT $1::dbsp_missing_type_one AS value',
				'SELECT $1::dbsp_missing_type_two AS value',
			];

			for (const sql of failedSql) {
				const query = compiled<{ value: number }>(sql, [1]);
				await expect(adapter.execute(query)).rejects.toMatchObject({
					code: '42704',
				});
				await expect(adapter.execute(query)).rejects.toMatchObject({
					code: '42704',
				});
				expect(await preparedCount(client, sql)).toBe(0);
			}

			const hotSql = 'SELECT $1::int AS value';
			const hotQuery = compiled<{ value: number }>(hotSql, [19]);
			await expect(adapter.execute(hotQuery)).resolves.toEqual([{ value: 19 }]);
			await expect(adapter.execute(hotQuery)).resolves.toEqual([{ value: 19 }]);
			expect(await preparedCount(client, hotSql)).toBe(1);
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
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
		});
		try {
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
				replayInvalidatedPlans: true,
			});
			await adapter.withPinnedConnection(async (pinned) => {
				const pgPinned = requirePgsqlAdapter(pinned);
				const table = `"${SCHEMA}".invalidated_plan`;
				const sql = `SELECT * FROM ${table} WHERE id = $1`;
				const query = compiled<{ id: number; added?: string }>(sql, [1]);

				await pgPinned.executeDDL(
					`CREATE TABLE ${table} (id integer PRIMARY KEY)`,
				);
				await pgPinned.executeRaw(`INSERT INTO ${table} (id) VALUES ($1)`, [1]);
				await pgPinned.execute(query);
				await pgPinned.execute(query);
				expect(await preparedCount(pgPinned, sql)).toBe(1);
				await pgPinned.executeDDL(`ALTER TABLE ${table} ADD COLUMN added text`);

				await expect(pgPinned.execute(query)).resolves.toEqual([
					{ id: 1, added: null },
				]);
				expect(await preparedCount(pgPinned, sql)).toBe(1);
			});
		} finally {
			await pool.end();
		}
	});

	it('rejects after result-shape DDL invalidates a named plan without replay', async () => {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
		});
		try {
			const adapter = createPgsqlAdapter(pool, {
				preparedStatements: true,
			});
			await expect(
				adapter.withPinnedConnection(async (pinned) => {
					const pgPinned = requirePgsqlAdapter(pinned);
					const table = `"${SCHEMA}".invalidated_plan_without_replay`;
					const sql = `SELECT * FROM ${table} WHERE id = $1`;
					const query = compiled<{ id: number; added?: string }>(sql, [1]);

					await pgPinned.executeDDL(
						`CREATE TABLE ${table} (id integer PRIMARY KEY)`,
					);
					await pgPinned.executeRaw(
						`INSERT INTO ${table} (id) VALUES ($1)`,
						[1],
					);
					await pgPinned.execute(query);
					await pgPinned.execute(query);
					expect(await preparedCount(pgPinned, sql)).toBe(1);
					await pgPinned.executeDDL(
						`ALTER TABLE ${table} ADD COLUMN added text`,
					);
					await pgPinned.execute(query);
				}),
			).rejects.toSatisfy(hasCachedPlanInvalidationInCauseChain);
		} finally {
			await pool.end();
		}
	});

	it('does not replay a borrowed client after BEGIN is queued behind a failed named query', async () => {
		const { client, close } = await getIsolatedClient();
		let transactionOpen = false;
		let queuedBegin: Promise<unknown> | undefined;
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const table = `"${SCHEMA}".queued_begin_after_named_failure`;
			const sql = `SELECT * FROM ${table} WHERE id = $1`;

			await adapter.executeDDL(
				`CREATE TABLE ${table} (id integer PRIMARY KEY)`,
			);
			await adapter.executeRaw(`INSERT INTO ${table} (id) VALUES ($1)`, [1]);
			await (adapter as any).issueConnectionQuery(client, sql, [1], true);
			await (adapter as any).issueConnectionQuery(client, sql, [1], true);
			await client.query(`ALTER TABLE ${table} ADD COLUMN added text`);

			const querySpy = vi.spyOn(client, 'query');
			try {
				const failed = (adapter as any).issueConnectionQuery(
					client,
					sql,
					[1],
					true,
				);
				queuedBegin = client.query('BEGIN');

				await expect(failed).rejects.toMatchObject({
					code: '0A000',
					routine: 'RevalidateCachedQuery',
				});
				await queuedBegin;
				transactionOpen = true;
				expect(querySpy).not.toHaveBeenCalledWith(sql, [1]);
			} finally {
				querySpy.mockRestore();
			}

			await expect(
				(adapter as any).issueConnectionQuery(client, sql, [1], true),
			).resolves.toMatchObject({ rows: [{ id: 1, added: null }] });
		} finally {
			if (!transactionOpen && queuedBegin !== undefined) {
				await queuedBegin.then(
					() => {
						transactionOpen = true;
					},
					() => undefined,
				);
			}
			if (transactionOpen) await client.query('ROLLBACK');
			await close();
		}
	});

	it('rejects the invalidated call but quarantines subsequent execution in a caller-owned transaction', async () => {
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
					routine: 'RevalidateCachedQuery',
				});
				const freshUnnamed = await adapter.executeRaw(sql, [1]);
				const querySpy = vi.spyOn(client, 'query');
				await expect(adapter.execute(query)).resolves.toEqual(freshUnnamed);
				expect(querySpy).toHaveBeenCalledWith(sql, [1]);
				expect(querySpy).not.toHaveBeenCalledWith({
					name: `dbsp_ps_${createHash('sha256')
						.update(sql)
						.digest('hex')
						.slice(0, 32)}`,
					text: sql,
					values: [1],
				});
				querySpy.mockRestore();
			} finally {
				await client.query('ROLLBACK');
			}
		} finally {
			await close();
		}
	});

	it.each(['DEALLOCATE ALL', 'DISCARD ALL'])(
		'quarantines %s-cleared server plans after the failed call',
		async (reset) => {
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
					routine: 'FetchPreparedStatement',
				});
				await expect(adapter.execute(query)).resolves.toEqual([{ value: 9 }]);
				expect(await preparedCount(client, sql)).toBe(0);
			} finally {
				await close();
			}
		},
	);

	it('runs every admitted SQL unnamed after one verified client-wide reset failure', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const firstSql = 'SELECT $1::int AS value';
			const secondSql = 'SELECT $1::int + 1 AS value';
			const thirdSql = 'SELECT $1::int + 2 AS value';
			const first = compiled<{ value: number }>(firstSql, [9]);
			const second = compiled<{ value: number }>(secondSql, [9]);
			const third = compiled<{ value: number }>(thirdSql, [9]);

			for (const query of [first, second, third]) {
				await adapter.execute(query);
				await adapter.execute(query);
			}
			expect(await preparedCount(client)).toBe(3);
			await adapter.executeRaw('DEALLOCATE ALL');

			await expect(adapter.execute(first)).rejects.toMatchObject({
				code: '26000',
				routine: 'FetchPreparedStatement',
			});
			await expect(adapter.execute(second)).resolves.toEqual([{ value: 10 }]);
			await expect(adapter.execute(third)).resolves.toEqual([{ value: 11 }]);
			expect(await preparedCount(client)).toBe(0);
		} finally {
			await close();
		}
	});

	it.each(['0A000', '26000', '42P05'])(
		'keeps naming after PL/pgSQL raises spoofable SQLSTATE %s exactly once',
		async (code) => {
			const { client, close } = await getIsolatedClient();
			try {
				const adapter = createPgsqlAdapter(client, {
					borrowedClient: true,
					preparedStatements: true,
				});
				const suffix = code.toLowerCase();
				const sequence = `"${SCHEMA}".no_replay_sequence_${suffix}`;
				const fn = `"${SCHEMA}".raise_${suffix}_after_nextval`;
				const sql = `SELECT ${fn}($1, $2) AS value`;
				const query = compiled<{ value: number }>(sql, [0, code]);

				await adapter.executeDDL(`CREATE SEQUENCE ${sequence}`);
				await adapter.executeDDL(`
				CREATE FUNCTION ${fn}(should_fail integer, error_code text) RETURNS integer
				LANGUAGE plpgsql AS $$
				BEGIN
					IF should_fail = 1 THEN
						PERFORM nextval('${SCHEMA}.no_replay_sequence_${suffix}');
						RAISE EXCEPTION 'expected named execution failure' USING ERRCODE = error_code;
					END IF;
					RETURN should_fail;
				END;
				$$`);

				await expect(adapter.execute(query)).resolves.toEqual([{ value: 0 }]);
				await expect(
					adapter.execute(compiled<{ value: number }>(sql, [1, code])),
				).rejects.toMatchObject({ code, routine: 'exec_stmt_raise' });
				expect(
					(
						await client.query<{ last_value: string; is_called: boolean }>(
							`SELECT last_value::text, is_called FROM ${sequence}`,
						)
					).rows,
				).toEqual([{ last_value: '1', is_called: true }]);
				const querySpy = vi.spyOn(client, 'query');
				await expect(adapter.execute(query)).resolves.toEqual([{ value: 0 }]);
				expect(querySpy).toHaveBeenCalledWith({
					name: `dbsp_ps_${createHash('sha256').update(sql).digest('hex').slice(0, 32)}`,
					text: sql,
					values: [0, code],
				});
				querySpy.mockRestore();
				expect(await preparedCount(client, sql)).toBe(1);
			} finally {
				await close();
			}
		},
	);

	it('does not replay a nested missing prepared statement after an effectful function call', async () => {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
		});
		try {
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const sequence = `"${SCHEMA}".nested_missing_statement_sequence`;
			const fn = `"${SCHEMA}".nextval_then_missing_statement`;
			const sql = `SELECT ${fn}($1::boolean) AS value`;
			const failingQuery = compiled<{ value: number }>(sql, [true]);

			await adapter.executeDDL(`CREATE SEQUENCE ${sequence}`);
			await adapter.executeDDL(`
				CREATE FUNCTION ${fn}(should_fail boolean) RETURNS bigint
				LANGUAGE plpgsql AS $$
				BEGIN
					IF should_fail THEN
						PERFORM nextval('${SCHEMA}.nested_missing_statement_sequence');
						EXECUTE 'EXECUTE nested_missing_statement';
					END IF;
					RETURN 0;
				END;
				$$`);

			const scope = adapter.withPinnedConnection(async (pinned) => {
				await pinned.execute(compiled<{ value: number }>(sql, [false]));
				await pinned.execute(compiled<{ value: number }>(sql, [false]));
				await expect(pinned.execute(failingQuery)).rejects.toMatchObject({
					code: '26000',
					routine: 'FetchPreparedStatement',
					message:
						'prepared statement "nested_missing_statement" does not exist',
				});
			});
			await expect(scope).rejects.toThrow(
				/PostgreSQL transaction is aborted because a statement failed inside a dbsp-managed scope/,
			);

			expect(
				await adapter.executeRaw<{
					last_value: string;
					is_called: boolean;
				}>(`SELECT last_value::text, is_called FROM ${sequence}`),
			).toEqual([{ last_value: '1', is_called: true }]);
		} finally {
			await pool.end();
		}
	});

	it('quarantines a duplicate external prepared statement name on its client', async () => {
		const { client, close } = await getIsolatedClient();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				preparedStatements: true,
			});
			const sql = 'SELECT $1::int AS value';
			const name = preparedName(sql);
			const query = compiled<{ value: number }>(sql, [11]);

			await client.query(`PREPARE ${name}(integer) AS ${sql}`);
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 11 }]);
			await expect(adapter.execute(query)).rejects.toMatchObject({
				code: '42P05',
				routine: 'StorePreparedStatement',
			});
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 11 }]);
		} finally {
			await close();
		}
	});

	it('quarantines result-shape DDL on one borrowed client without affecting another client', async () => {
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
			const table = 'prepared_statements_client_local';
			const sql = `SELECT * FROM ${table} WHERE id = $1`;

			for (const client of [first, second]) {
				await client.query(
					`CREATE TEMP TABLE ${table} (id integer PRIMARY KEY)`,
				);
				await client.query(`INSERT INTO ${table} (id) VALUES (13)`);
			}

			await (adapter as any).issueConnectionQuery(first, sql, [13], true);
			await (adapter as any).issueConnectionQuery(first, sql, [13], true);
			await (adapter as any).issueConnectionQuery(second, sql, [13], true);
			expect(await preparedCount(first, sql)).toBe(1);
			expect(await preparedCount(second, sql)).toBe(1);

			await first.query(`ALTER TABLE ${table} ADD COLUMN added text`);
			await expect(
				(adapter as any).issueConnectionQuery(first, sql, [13], true),
			).rejects.toMatchObject({
				code: '0A000',
				routine: 'RevalidateCachedQuery',
			});
			await expect(
				(adapter as any).issueConnectionQuery(first, sql, [13], true),
			).resolves.toMatchObject({ rows: [{ id: 13, added: null }] });
			expect(await preparedCount(first, sql)).toBe(1);
			expect(await preparedCount(second, sql)).toBe(1);
			const secondQuerySpy = vi.spyOn(second, 'query');
			await expect(
				(adapter as any).issueConnectionQuery(second, sql, [13], true),
			).resolves.toMatchObject({ rows: [{ id: 13 }] });
			expect(secondQuerySpy).toHaveBeenCalledWith({
				name: `dbsp_ps_${createHash('sha256').update(sql).digest('hex').slice(0, 32)}`,
				text: sql,
				values: [13],
			});
			secondQuerySpy.mockRestore();
		} finally {
			first?.release();
			second?.release();
			await pool.end();
		}
	});

	it('pool queries recover named execution on a replacement client after DISCARD ALL', async () => {
		const pool = new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 1,
		});
		try {
			const adapter = createPgsqlAdapter(pool, { preparedStatements: true });
			const sql = 'SELECT $1::int AS value';
			const query = compiled<{ value: number }>(sql, [13]);

			await adapter.execute(query);
			await adapter.execute(query);
			const resetClient = await pool.connect();
			try {
				expect(await preparedCount(resetClient, sql)).toBe(1);
				await resetClient.query('DISCARD ALL');
			} finally {
				resetClient.release();
			}

			await expect(adapter.execute(query)).rejects.toMatchObject({
				code: '26000',
				routine: 'FetchPreparedStatement',
			});
			await expect(adapter.execute(query)).resolves.toEqual([{ value: 13 }]);

			const replacementClient = await pool.connect();
			try {
				expect(await preparedCount(replacementClient, sql)).toBe(1);
			} finally {
				replacementClient.release();
			}
		} finally {
			await pool.end();
		}
	});

	it('replays inside a pinned pool-owned scope before replacing its quarantined client', async () => {
		await expectPoolOwnedScopeToReplaceQuarantinedClient(
			(adapter, callback) => adapter.withPinnedConnection(callback),
			true,
		);
	});

	it('replaces a quarantined client after a transaction pool-owned scope', async () => {
		await expectPoolOwnedScopeToReplaceQuarantinedClient((adapter, callback) =>
			adapter.transaction(callback),
		);
	});

	it('replaces a quarantined client after a scratch pool-owned scope', async () => {
		await expectPoolOwnedScopeToReplaceQuarantinedClient((adapter, callback) =>
			adapter.withScratchScope(callback),
		);
	});

	it('rejects a pending named pool query after backend termination without terminating the child process', async () => {
		const applicationName = `dbsp-prepared-${randomUUID()}`;
		const readinessMarker = 'ready-for-termination';
		// Keep all child phases inside this test's explicit 60s Vitest timeout.
		const childDeadline = Date.now() + 52_000;
		const child = fork(
			fileURLToPath(
				new URL('./prepared-statements-transport-child.ts', import.meta.url),
			),
			[],
			{
				env: {
					...process.env,
					DBSP_APPLICATION_NAME: applicationName,
				},
				execArgv: ['--import', 'tsx'],
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			},
		);
		const childClose = new Promise<
			| { readonly kind: 'error'; readonly error: Error }
			| {
					readonly kind: 'exit';
					readonly code: number | null;
					readonly signal: NodeJS.Signals | null;
			  }
		>((resolve) => {
			child.once('error', (error) => resolve({ kind: 'error', error }));
			child.once('close', (code, signal) =>
				resolve({ kind: 'exit', code, signal }),
			);
		});
		let stopPolling = false;
		void childClose.then(() => {
			stopPolling = true;
		});
		let stdout = '';
		let stderr = '';
		const waitForChildCloseDuringCleanup = (label: string) => {
			const cleanupDeadline = Date.now() + 5_000;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			return Promise.race([
				childClose,
				new Promise<Awaited<typeof childClose>>((_resolve, reject) => {
					timeout = setTimeout(
						() =>
							reject(
								new Error(
									`timed out waiting for ${label} during cleanup after 5s\nstdout:\n${stdout}\nstderr:\n${stderr}`,
								),
							),
						Math.max(0, cleanupDeadline - Date.now()),
					);
				}),
			]).finally(() => {
				if (timeout !== undefined) clearTimeout(timeout);
			});
		};
		let resolveReadiness: (() => void) | undefined;
		const readiness = new Promise<void>((resolve) => {
			resolveReadiness = resolve;
		});
		child.stdout?.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.includes(`${readinessMarker}\n`)) resolveReadiness?.();
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		let testFailure: unknown;
		let cleanupFailure: unknown;
		try {
			const childFailure = (exited: Awaited<typeof childClose>) =>
				new Error(
					`child exited before backend termination (${exited.kind === 'exit' ? `code ${exited.code}, signal ${exited.signal}` : exited.error.message})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				);
			const childExitFailure = () =>
				childClose.then((exited) => Promise.reject(childFailure(exited)));
			const waitUntil = <T>(label: string, promise: Promise<T>) => {
				const remaining = childDeadline - Date.now();
				if (remaining <= 0) {
					return Promise.reject(
						new Error(
							`timed out waiting for ${label}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
						),
					);
				}
				let timeout: ReturnType<typeof setTimeout> | undefined;
				return Promise.race([
					promise,
					new Promise<T>((_resolve, reject) => {
						timeout = setTimeout(
							() =>
								reject(
									new Error(
										`timed out waiting for ${label}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
									),
								),
							remaining,
						);
					}),
				]).finally(() => {
					if (timeout !== undefined) clearTimeout(timeout);
				});
			};
			const waitFor = <T>(label: string, promise: Promise<T>) =>
				waitUntil(label, Promise.race([promise, childExitFailure()]));
			const waitForChildClose = (label: string) => waitUntil(label, childClose);

			await waitFor('child readiness marker', readiness);
			const pool = await getTestPool();
			const pid = await waitFor(
				'active child backend',
				(async () => {
					while (!stopPolling) {
						const result = await pool.query<{ pid: number }>(
							`SELECT pid FROM pg_catalog.pg_stat_activity
					 WHERE application_name = $1 AND state = 'active'
					 ORDER BY backend_start DESC LIMIT 1`,
							[applicationName],
						);
						const pid = result.rows[0]?.pid;
						if (pid !== undefined) return pid;
						const remaining = childDeadline - Date.now();
						if (remaining <= 0)
							throw new Error(
								`timed out waiting for active child backend\nstdout:\n${stdout}\nstderr:\n${stderr}`,
							);
						await new Promise((resolve) =>
							setTimeout(resolve, Math.min(100, remaining)),
						);
					}
					throw new Error('stopped polling after child close');
				})(),
			);
			expect(pid).toBeTypeOf('number');
			await pool.query('SELECT pg_catalog.pg_terminate_backend($1::int)', [
				pid,
			]);
			const exited = await waitForChildClose(
				'child close after backend termination',
			);
			stdout = stdout.replace(`${readinessMarker}\n`, '');
			expect(exited).toEqual({ kind: 'exit', code: 0, signal: null });
			expect(stdout.trim()).toBe('named-query-rejected:57P01');
			expect(stderr).not.toMatch(/Unhandled 'error'|unhandled error event/i);
		} catch (error) {
			testFailure = error;
		} finally {
			stopPolling = true;
			if (child.exitCode === null) {
				child.kill('SIGKILL');
				try {
					await waitForChildCloseDuringCleanup('child close after SIGKILL');
				} catch (cleanupError) {
					cleanupFailure = cleanupError;
				}
			}
		}
		if (testFailure !== undefined) {
			if (cleanupFailure !== undefined) {
				throw new AggregateError(
					[testFailure, cleanupFailure],
					'transport test failed and child cleanup also failed',
				);
			}
			throw testFailure;
		}
		if (cleanupFailure !== undefined) throw cleanupFailure;
	}, 60_000);
});
