import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'raw_sql_transaction_savepoint_e2e';

async function captureRejection(
	action: () => Promise<unknown>,
): Promise<unknown> {
	try {
		await action();
	} catch (error) {
		return error;
	}
	throw new Error('Expected promise to reject');
}

async function itemIds(ids: readonly number[]): Promise<number[]> {
	const pool = await getTestPool();
	const result = await pool.query<{ id: number }>(
		`SELECT id FROM "${SCHEMA}".items WHERE id = ANY($1::int[]) ORDER BY id`,
		[ids],
	);
	return result.rows.map((row) => row.id);
}

describe('raw SQL inside caller transactions', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await pool.query(`
			CREATE TABLE "${SCHEMA}".items (
				id integer PRIMARY KEY,
				label text NOT NULL
			)
		`);
		await pool.query(
			`CREATE INDEX "idx_raw_sql_tx_items_label" ON "${SCHEMA}".items (label)`,
		);
	});

	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it('keeps the caller transaction usable after CREATE INDEX CONCURRENTLY is rejected', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[1, 'before create concurrently'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			const error = await captureRejection(() =>
				adapter.executeRaw(
					`CREATE INDEX CONCURRENTLY "idx_raw_sql_tx_create_inside" ON "${SCHEMA}".items (label)`,
				),
			);

			expect((error as { code?: string }).code).toBe('25001');
			expect((error as Error).message).toContain('CREATE INDEX CONCURRENTLY');
			expect((error as Error).message).toContain(
				'rolled back the failed raw SQL to a savepoint',
			);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[2, 'after create concurrently'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds([1, 2])).toEqual([1, 2]);
	});

	it('keeps the caller transaction usable after REINDEX INDEX CONCURRENTLY is rejected', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let committed = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[3, 'before reindex concurrently'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			const error = await captureRejection(() =>
				adapter.executeRaw(
					`REINDEX INDEX CONCURRENTLY "${SCHEMA}"."idx_raw_sql_tx_items_label"`,
				),
			);

			expect((error as { code?: string }).code).toBe('25001');
			expect((error as Error).message).toContain('REINDEX');
			expect((error as Error).message).toContain(
				'rolled back the failed raw SQL to a savepoint',
			);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[4, 'after reindex concurrently'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds([3, 4])).toEqual([3, 4]);
	});

	it('runs CREATE INDEX CONCURRENTLY normally outside any transaction', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);

		await adapter.executeRaw(
			`CREATE INDEX CONCURRENTLY "idx_raw_sql_tx_create_outside" ON "${SCHEMA}".items (label)`,
		);

		const result = await pool.query<{ exists: boolean }>(
			`SELECT to_regclass($1) IS NOT NULL AS exists`,
			[`${SCHEMA}.idx_raw_sql_tx_create_outside`],
		);
		expect(result.rows[0]?.exists).toBe(true);
	});

	it('runs REINDEX INDEX CONCURRENTLY normally outside any transaction', async () => {
		const pool = await getTestPool();
		const adapter = createPgsqlAdapter(pool);

		await adapter.executeRaw(
			`REINDEX INDEX CONCURRENTLY "${SCHEMA}"."idx_raw_sql_tx_items_label"`,
		);

		expect(await itemIds([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
	});
});
