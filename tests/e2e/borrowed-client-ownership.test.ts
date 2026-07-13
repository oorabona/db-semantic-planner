import {
	createPgsqlAdapter,
	PgsqlRawSqlTransactionControlError,
} from '@dbsp/adapter-pgsql';
import { createOrm, schema } from '@dbsp/core';
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { sql } from './testkit/sql.js';

const SCHEMA = 'borrowed_client_ownership_e2e';

const ormSchema = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		label: 'string',
	},
});

async function itemIds(): Promise<number[]> {
	const pool = await getTestPool();
	const result = await pool.query<{ id: number }>(
		`SELECT id FROM "${SCHEMA}".items ORDER BY id`,
	);
	return result.rows.map((row) => row.id);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const rows: T[] = [];
	for await (const row of iterable) {
		rows.push(row);
	}
	return rows;
}

function pgTransactionStatus(client: unknown): unknown {
	return (client as { readonly _txStatus?: unknown })._txStatus;
}

describe('PgsqlAdapter borrowed client ownership', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await sql`
			CREATE TABLE ${sql.ref(SCHEMA)}.items (
				id integer PRIMARY KEY,
				label text NOT NULL
			)
		`.execute(pool);
	});

	beforeEach(async () => {
		const pool = await getTestPool();
		await pool.query(`DELETE FROM "${SCHEMA}".items`);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('locks pg PoolClient _txStatus values used by adapter.inTransaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			expect(pgTransactionStatus(client)).toBe('I');
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });
			expect(adapter.inTransaction).toBe(false);

			await client.query('BEGIN');
			expect(pgTransactionStatus(client)).toBe('T');
			expect(adapter.inTransaction).toBe(true);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}
	});

	it('uses a savepoint inside the caller transaction and preserves caller work after callback failure', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[1, 'caller before dbsp'],
			);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await expect(
				adapter.transaction(async (tx) => {
					await tx.executeRaw(
						`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
						[2, 'dbsp rolled back'],
					);
					throw new Error('dbsp failure');
				}),
			).rejects.toThrow('dbsp failure');

			const inside = await client.query<{ id: number }>(
				`SELECT id FROM "${SCHEMA}".items ORDER BY id`,
			);
			expect(inside.rows.map((row) => row.id)).toEqual([1]);

			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([1]);
	});

	it('does not make successful dbsp work survive the caller rollback', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[3, 'dbsp caller rollback'],
				);
			});

			const inside = await client.query<{ id: number }>(
				`SELECT id FROM "${SCHEMA}".items WHERE id = $1`,
				[3],
			);
			expect(inside.rows.map((row) => row.id)).toEqual([3]);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([]);
	});

	it('opens its own transaction on a borrowed client when none is active', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		try {
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[4, 'dbsp committed'],
				);
			});

			await expect(
				adapter.transaction(async (tx) => {
					await tx.executeRaw(
						`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
						[5, 'dbsp rolled back'],
					);
					throw new Error('rollback standalone');
				}),
			).rejects.toThrow('rollback standalone');
		} finally {
			client.release();
		}

		expect(await itemIds()).toEqual([4]);
	});

	it('throws when raw COMMIT ends a dbsp-owned transaction before later statements run', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);

		await expect(
			adapter.transaction(async (tx) => {
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[15, 'committed by raw commit'],
				);
				await tx.executeRaw('COMMIT');
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[16, 'must not run after raw commit'],
				);
			}),
		).rejects.toThrow(/Transaction control through raw SQL/);

		expect(await itemIds()).toEqual([15]);
		await pool.query(`DELETE FROM "${SCHEMA}".items WHERE id = $1`, [15]);
	});

	it('reports SELECT plus COMMIT as transaction control in a managed borrowed transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let transactionGone = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});
			let error: unknown;

			try {
				await adapter.transaction(async (tx) => {
					await tx.executeRaw('SELECT 1; COMMIT');
				});
			} catch (caught) {
				error = caught;
			}
			transactionGone = true;

			expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
			expect(error).not.toBeInstanceOf(AggregateError);
			expect((error as Error).message).not.toContain(
				'dbsp cannot reason about a multi-command raw call',
			);
			expect((error as Error).message).not.toContain('cleanup failed');
		} finally {
			if (!transactionGone) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}
	});

	it('serializes concurrent raw statements so raw COMMIT poisons the sibling before it is sent', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);

		await expect(
			orm.transaction(async (tx) => {
				await Promise.all([
					tx.raw('COMMIT'),
					tx.raw(
						`INSERT INTO "${SCHEMA}".items (id, label) VALUES (18, 'must not reach PostgreSQL')`,
					),
				]);
			}),
		).rejects.toBeInstanceOf(PgsqlRawSqlTransactionControlError);

		expect(await itemIds()).toEqual([]);
	});

	it('rolls back an unawaited ORM insert queued before a throwing callback returns', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);
		const callbackError = new Error('rollback unawaited insert');
		let sleeper: Promise<unknown> | undefined;
		let insert: Promise<unknown> | undefined;

		await expect(
			orm.transaction(async (tx) => {
				sleeper = tx.raw('SELECT pg_sleep(0.1)');
				void sleeper.catch(() => undefined);
				insert = tx
					.into(tx.tables.items)
					.values({ id: 19, label: 'must be rolled back' })
					.execute();
				void insert.catch(() => undefined);
				throw callbackError;
			}),
		).rejects.toBe(callbackError);

		await sleeper?.catch(() => undefined);
		await insert?.catch(() => undefined);
		expect(await itemIds()).toEqual([]);
	});

	it('rejects after a caught raw COMMIT and never sends the post-COMMIT ORM statement', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);
		let rawCommitError: unknown;
		let postCommitError: unknown;
		let transactionError: unknown;

		try {
			await orm.transaction(async (tx) => {
				await tx
					.into(tx.tables.items)
					.values({ id: 40, label: 'committed by swallowed raw commit' })
					.execute();
				try {
					await tx.raw('COMMIT');
				} catch (error) {
					rawCommitError = error;
				}
				try {
					await tx
						.into(tx.tables.items)
						.values({ id: 41, label: 'must not reach PostgreSQL' })
						.execute();
				} catch (error) {
					postCommitError = error;
				}
				return 'callback returned normally';
			});
		} catch (error) {
			transactionError = error;
		}

		expect(rawCommitError).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect(postCommitError).toBe(rawCommitError);
		expect(transactionError).toBe(rawCommitError);
		expect(await itemIds()).toEqual([40]);
		await pool.query(`DELETE FROM "${SCHEMA}".items WHERE id = $1`, [40]);

		await orm.transaction(async (tx) => {
			await tx
				.into(tx.tables.items)
				.values({ id: 42, label: 'next pooled transaction works' })
				.execute();
		});

		expect(await itemIds()).toEqual([42]);
	});

	// A plain PREPARE is not transaction control, so dbsp lets it through — the
	// command tag alone could not tell it apart from PREPARE TRANSACTION, and dbsp
	// asks the engine whether its transaction survived rather than guessing.
	//
	// It is NOT a blessing of the leak underneath. The statement the CALLER prepared
	// is session-duration state on a connection that goes back to the pool, and dbsp
	// deallocates only what dbsp created. That holds for an advisory lock, a SET, a
	// LISTEN and a temp table too: raw SQL creates session state, and no savepoint
	// rollback undoes it. The contract is written down in #327; this test deallocates
	// by hand because it is the caller here, and the caller is who owes it.
	it('allows server-side PREPARE inside a borrowed-client dbsp transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		const statementName = 'dbsp_prepare_statement_e2e';
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await tx.executeRaw(`PREPARE ${statementName} AS SELECT 1 AS value`);
				const rows = await tx.executeRaw<{ value: number }>(
					`EXECUTE ${statementName}`,
				);
				expect(rows).toEqual([{ value: 1 }]);
			});

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			await client.query(`DEALLOCATE ${statementName}`).catch(() => undefined);
			client.release();
		}
	});

	it('throws when PREPARE TRANSACTION ends a borrowed-client dbsp transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		const transactionId = `dbsp_prepare_tx_${process.pid}_${Date.now()}`;
		let transactionGone = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			let error: unknown;
			try {
				await adapter.transaction(async (tx) => {
					await tx.executeRaw(`PREPARE TRANSACTION '${transactionId}'`);
				});
			} catch (caught) {
				error = caught;
			}
			transactionGone = true;

			expect(error).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		} finally {
			if (!transactionGone) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
			await pool
				.query(`ROLLBACK PREPARED '${transactionId}'`)
				.catch(() => undefined);
		}
	});

	it('returns a clean pooled connection after raw SAVEPOINT in orm.transaction throws', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);

		await expect(
			orm.transaction(async (tx) => {
				await tx
					.into(tx.tables.items)
					.values({ id: 38, label: 'must be rolled back' })
					.execute();
				await tx.raw('SAVEPOINT s');
			}),
		).rejects.toThrow(/Transaction control through raw SQL/);

		expect(await itemIds()).toEqual([]);

		await orm.transaction(async (tx) => {
			await tx
				.into(tx.tables.items)
				.values({ id: 39, label: 'next transaction works' })
				.execute();
		});

		expect(await itemIds()).toEqual([39]);
	});

	it('runs nested managed transactions on a borrowed client', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[20, 'outer nested success'],
				);
				await tx.transaction(async (inner) => {
					await inner.executeRaw(
						`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
						[21, 'inner nested success'],
					);
				});
			});

			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([20, 21]);
	});

	it('poisons a parent scope when raw COMMIT inside a nested transaction ends the physical transaction', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);
		let innerError: unknown;
		let parentStatementError: unknown;
		let transactionError: unknown;

		try {
			await orm.transaction(async (tx) => {
				await tx
					.into(tx.tables.items)
					.values({ id: 43, label: 'committed before nested raw commit' })
					.execute();
				try {
					await tx.transaction(async (inner) => {
						await inner.raw('COMMIT');
					});
				} catch (error) {
					innerError = error;
				}
				try {
					await tx
						.into(tx.tables.items)
						.values({ id: 44, label: 'must not reach PostgreSQL' })
						.execute();
				} catch (error) {
					parentStatementError = error;
				}
				return 'callback returned normally';
			});
		} catch (error) {
			transactionError = error;
		}

		expect(innerError).toBeInstanceOf(PgsqlRawSqlTransactionControlError);
		expect(parentStatementError).toBe(innerError);
		expect(transactionError).toBe(innerError);
		expect(await itemIds()).toEqual([43]);
		await pool.query(`DELETE FROM "${SCHEMA}".items WHERE id = $1`, [43]);
	});

	it('rolls back a caught nested managed transaction and keeps the outer transaction usable', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[22, 'outer before nested failure'],
				);
				await expect(
					tx.transaction(async (inner) => {
						await inner.executeRaw(
							`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
							[23, 'inner rolled back'],
						);
						throw new Error('nested failure');
					}),
				).rejects.toThrow('nested failure');
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[24, 'outer after nested failure'],
				);
			});

			const inside = await client.query<{ id: number }>(
				`SELECT id FROM "${SCHEMA}".items ORDER BY id`,
			);
			expect(inside.rows.map((row) => row.id)).toEqual([22, 24]);

			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([22, 24]);
	});

	it('contains a failing borrowed-client statement with a savepoint outside a dbsp-owned transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[25, 'caller before failing statement'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			await expect(
				adapter.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[26, null],
				),
			).rejects.toThrow(/rolled back the failed raw SQL to a savepoint/);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[27, 'caller after failing statement'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([25, 27]);
	});

	it('rolls back only dbsp savepoint when borrowed-client raw SAVEPOINT is detected', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[28, 'caller before raw savepoint'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			await expect(adapter.executeRaw('SAVEPOINT s')).rejects.toThrow(
				/Transaction control through raw SQL/,
			);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[29, 'caller after raw savepoint'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([28, 29]);
	});

	it('rolls back the managed scope when one concurrent statement fails and preserves the caller transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[7, 'caller before failed siblings'],
			);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await expect(
				adapter.transaction(async (tx) => {
					await Promise.all([
						tx.executeRaw(
							`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
							[8, 'sibling success rolled back'],
						),
						tx.executeRaw(
							`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
							[9, null],
						),
					]);
				}),
			).rejects.toThrow();

			const inside = await client.query<{ id: number }>(
				`SELECT id FROM "${SCHEMA}".items ORDER BY id`,
			);
			expect(inside.rows.map((row) => row.id)).toEqual([7]);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[10, 'caller after failed siblings'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([7, 10]);
	});

	it('runs concurrent managed streams inside a borrowed transaction without cross-cancellation', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2), ($3, $4), ($5, $6), ($7, $8)`,
				[
					11,
					'stream first a',
					12,
					'stream first b',
					13,
					'stream second a',
					14,
					'stream second b',
				],
			);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			const [first, second] = await adapter.transaction(async (tx) => {
				return Promise.all([
					collect(
						tx.stream<{ id: number }>(
							{
								sql: `SELECT id FROM "${SCHEMA}".items WHERE id IN ($1, $2) ORDER BY id`,
								parameters: [11, 12],
							},
							{ chunkSize: 1 },
						),
					),
					collect(
						tx.stream<{ id: number }>(
							{
								sql: `SELECT id FROM "${SCHEMA}".items WHERE id IN ($1, $2) ORDER BY id`,
								parameters: [13, 14],
							},
							{ chunkSize: 1 },
						),
					),
				]);
			});

			expect(first.map((row) => row.id)).toEqual([11, 12]);
			expect(second.map((row) => row.id)).toEqual([13, 14]);

			await client.query('ROLLBACK');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([]);
	});

	it('refuses orm.transaction on an unmanaged borrowed client at the ORM boundary', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		try {
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });
			const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);
			const callback = vi.fn(async () => 'should not run');

			let thrown: unknown;
			try {
				await orm.transaction(callback);
			} catch (error) {
				thrown = error;
			}

			expect(thrown).toBeInstanceOf(Error);
			const message = (thrown as Error).message;
			expect(message).toContain('supportsTransactions: false');
			expect(message).toContain(
				'adapter configuration that supports transactions',
			);
			expect(message).not.toContain('managedTransactions');
			expect(message).not.toContain('PoolClient');
			expect(callback).not.toHaveBeenCalled();
		} finally {
			client.release();
		}
	});

	it('runs orm.transaction on a borrowed client when managedTransactions is true', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});
			const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);

			await orm.transaction(async (tx) => {
				await tx
					.into(tx.tables.items)
					.values({ id: 6, label: 'orm managed transaction' })
					.execute();
			});

			const inside = await client.query<{ label: string }>(
				`SELECT label FROM "${SCHEMA}".items WHERE id = $1`,
				[6],
			);
			expect(inside.rows.map((row) => row.label)).toEqual([
				'orm managed transaction',
			]);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).not.toContain(6);
	});

	it('runs withSchema inside orm.transaction on a managed borrowed client', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[32, 'schema scoped select'],
			);
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});
			const orm = createOrm({ schema: ormSchema, adapter });

			const rows = await orm.transaction(async (tx) => {
				return tx
					.withSchema(SCHEMA)
					.select('items')
					.columns(['id', 'label'])
					.execute();
			});

			expect(rows.map((row) => row.id)).toEqual([32]);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}
	});

	it('runs a nested transaction from a schema-scoped transaction ORM', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});
			const orm = createOrm({ schema: ormSchema, adapter });

			await orm.transaction(async (tx) => {
				const scoped = tx.withSchema(SCHEMA);
				await scoped.transaction(async (inner) => {
					await inner
						.into(inner.tables.items)
						.values({ id: 33, label: 'nested schema scoped insert' })
						.execute();
				});
			});

			const inside = await client.query<{ label: string }>(
				`SELECT label FROM "${SCHEMA}".items WHERE id = $1`,
				[33],
			);
			expect(inside.rows.map((row) => row.label)).toEqual([
				'nested schema scoped insert',
			]);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}
	});

	it('still refuses an adapter from outside the active dbsp scope', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let rolledBack = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, {
				borrowedClient: true,
				managedTransactions: true,
			});

			await adapter.transaction(async (tx) => {
				await expect(
					adapter.executeRaw(
						`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
						[34, 'ancestor should be refused'],
					),
				).rejects.toThrow(/transaction adapter passed to the callback/);
				await tx.executeRaw(
					`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
					[35, 'transaction adapter still works'],
				);
			});

			const inside = await client.query<{ id: number }>(
				`SELECT id FROM "${SCHEMA}".items ORDER BY id`,
			);
			expect(inside.rows.map((row) => row.id)).toEqual([35]);

			await client.query('ROLLBACK');
			rolledBack = true;
		} finally {
			if (!rolledBack) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}
	});

	it('keeps a caller transaction usable after a failing borrowed-client listIndexes call', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[36, 'before failing catalog read'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			await expect(
				adapter.listIndexes('items', 'bad\u0000schema'),
			).rejects.toThrow();

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[37, 'after failing catalog read'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([36, 37]);
	});

	// The standalone introspect() does NOT take a PoolClient: it cannot know whose
	// transaction the client is sitting in, and guessing that from the object's shape
	// is the defect this adapter was rewritten to remove. A caller holding a client
	// declares it, and that declaration is what buys the savepoint protection.
	it('keeps a caller transaction usable after a failing introspect() on a borrowed client', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[45, 'before exported introspect failure'],
			);

			const adapter = createPgsqlAdapter(client, { borrowedClient: true });
			await expect(
				adapter.introspect({ schema: 'bad\u0000schema' }),
			).rejects.toThrow();

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[46, 'after exported introspect failure'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds()).toEqual([45, 46]);
	});

	it('rolls back an unawaited nested transaction failure before the parent unwinds', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);
		const orm = createOrm({ schema: ormSchema, adapter }).withSchema(SCHEMA);
		let child: Promise<unknown> | undefined;

		await expect(
			orm.transaction(async (tx) => {
				await tx
					.into(tx.tables.items)
					.values({ id: 48, label: 'parent rolled back by child failure' })
					.execute();
				child = tx.transaction(async (inner) => {
					await inner
						.into(inner.tables.items)
						.values({ id: 47, label: 'unawaited nested rollback' })
						.execute();
					throw new Error('unawaited nested failure');
				});
				void child.catch(() => undefined);
			}),
		).rejects.toThrow('unawaited nested failure');

		if (child === undefined) {
			throw new Error('expected child transaction to be captured');
		}
		await expect(child).rejects.toThrow('unawaited nested failure');
		expect(await itemIds()).toEqual([]);
	});
});
