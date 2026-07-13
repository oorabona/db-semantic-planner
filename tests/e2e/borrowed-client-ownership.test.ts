import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { createOrm, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

		expect(await itemIds()).toEqual([1]);
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

		expect(await itemIds()).toEqual([1, 4]);
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
