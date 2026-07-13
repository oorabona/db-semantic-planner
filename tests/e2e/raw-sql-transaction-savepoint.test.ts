import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'raw_sql_transaction_savepoint_e2e';
const TRANSACTION_CONTROL_BOUNDARY =
	'Transaction control through raw SQL inside a scope dbsp is managing is unsupported. ' +
	'`COMMIT` and `ROLLBACK` end the transaction dbsp is working inside — dbsp detects that and fails loudly, but the data is already whatever your statement made it. ' +
	'A `SAVEPOINT` you establish inside a dbsp call is released when dbsp releases its own, and dbsp cannot tell you that happened. ' +
	"Manage your transaction outside dbsp's calls.";

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

function expectTransactionControlError(error: unknown): void {
	expect(error).toBeInstanceOf(Error);
	expect(error).not.toBeInstanceOf(AggregateError);
	expect((error as Error).name).toBe('PgsqlRawSqlTransactionControlError');
	expect((error as Error).message).toBe(TRANSACTION_CONTROL_BOUNDARY);
	expect((error as Error).message).toContain('A `SAVEPOINT` you establish');
	expect((error as Error).message).not.toContain('cleanup failed');
	expect(
		(error as { readonly dbspRawSqlTransactionControl?: unknown })
			.dbspRawSqlTransactionControl,
	).toBe(true);
}

function collectReachableStrings(
	value: unknown,
	seen = new Set<object>(),
): string[] {
	if (typeof value === 'string') return [value];
	if (typeof value !== 'object' || value === null) return [];
	if (seen.has(value)) return [];
	seen.add(value);

	const strings: string[] = [];
	for (const key of [
		...Object.getOwnPropertyNames(value),
		...Object.getOwnPropertySymbols(value),
	]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) {
			strings.push(...collectReachableStrings(descriptor.value, seen));
		}
	}
	return strings;
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

	beforeEach(async () => {
		const pool = await getTestPool();
		await pool.query(`DELETE FROM "${SCHEMA}".items`);
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
			expect((error as Error).name).not.toBe(
				'PgsqlRawSqlTransactionControlError',
			);
			expect(
				(error as { readonly dbspRawSqlTransactionControl?: unknown })
					.dbspRawSqlTransactionControl,
			).not.toBe(true);
			expect((error as Error).message).toContain('CREATE INDEX CONCURRENTLY');
			expect((error as Error).message).toContain(
				'rolled back the failed raw SQL to a savepoint',
			);
			expect((error as Error).message).not.toContain(
				'Transaction control through raw SQL',
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

	it('reports transaction control when raw COMMIT ends the caller transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let transactionGone = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[20, 'committed by raw commit'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			const error = await captureRejection(() => adapter.executeRaw('COMMIT'));
			transactionGone = true;

			expectTransactionControlError(error);
		} finally {
			if (!transactionGone) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds([20])).toEqual([20]);
		await pool.query(`DELETE FROM "${SCHEMA}".items WHERE id = $1`, [20]);
	});

	it('reports transaction control when raw ROLLBACK ends the caller transaction', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		let transactionGone = false;
		try {
			await client.query('BEGIN');
			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[21, 'rolled back by raw rollback'],
			);
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			const error = await captureRejection(() =>
				adapter.executeRaw('ROLLBACK'),
			);
			transactionGone = true;

			expectTransactionControlError(error);
		} finally {
			if (!transactionGone) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds([21])).toEqual([]);
	});

	it('does not echo failing raw SQL text into the surfaced error', async () => {
		const pool = await getTestPool();
		const client = await pool.connect();
		const literal = 'dbsp_secret_literal_322_round4_e2e';
		const rawSql = `SELECT dbsp_missing_function('${literal}')`;
		let committed = false;
		try {
			await client.query('BEGIN');
			const adapter = createPgsqlAdapter(client, { borrowedClient: true });

			const error = await captureRejection(() => adapter.executeRaw(rawSql));

			expect((error as Error).message).toContain(
				'rolled back the failed raw SQL to a savepoint',
			);
			const reachable = collectReachableStrings(error).join('\n');
			expect(reachable).not.toContain(literal);
			expect(reachable).not.toContain(rawSql);

			await client.query(
				`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2)`,
				[22, 'after literal failure'],
			);
			await client.query('COMMIT');
			committed = true;
		} finally {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => undefined);
			}
			client.release();
		}

		expect(await itemIds([22])).toEqual([22]);
		await pool.query(`DELETE FROM "${SCHEMA}".items WHERE id = $1`, [22]);
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
		await pool.query(
			`INSERT INTO "${SCHEMA}".items (id, label) VALUES ($1, $2), ($3, $4)`,
			[30, 'before outside reindex', 31, 'after outside reindex'],
		);

		await adapter.executeRaw(
			`REINDEX INDEX CONCURRENTLY "${SCHEMA}"."idx_raw_sql_tx_items_label"`,
		);

		expect(await itemIds([30, 31])).toEqual([30, 31]);
	});
});
