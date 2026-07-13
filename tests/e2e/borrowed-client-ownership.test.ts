import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
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
			expect(message).toContain('adapter declares');
			expect(message).toContain('connection is yours');
			expect(message).toContain('managedTransactions: true');
			expect(message).toContain('savepoint');
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
});
