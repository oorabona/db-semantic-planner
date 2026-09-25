import { randomUUID } from 'node:crypto';
import { classifyPgLedgerPhysicalShape } from '@dbsp/adapter-pgsql/internal';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';
import { runPreflight } from './transition-reinitialize-preflight-testkit.js';

const schema = `ledger_shape_settings_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

describe('ledger physical shape session settings', () => {
	beforeAll(async () => {
		await createSchema(schema);
		await runPreflight([schema], { writeAdoptionFile: async () => {} });
	});

	afterAll(async () => {
		await dropSchema(schema);
		await closeTestDb();
	});

	it('restores search_path and quote_all_identifiers on the caller transaction', async () => {
		const client = await (await getTestPool()).connect();
		const searchPath = `"$user", public, "${schema}"`;
		try {
			await client.query('BEGIN');
			await client.query(`SET LOCAL search_path = ${searchPath}`);
			await client.query('SET LOCAL quote_all_identifiers = on');
			const before = await client.query(
				"SELECT current_setting('search_path') AS search_path, current_setting('quote_all_identifiers') AS quote_all_identifiers",
			);

			await expect(
				classifyPgLedgerPhysicalShape(client, { scope: 'schema', schema }),
			).resolves.toEqual({ kind: 'verified' });
			await expect(
				client.query(
					"SELECT current_setting('search_path') AS search_path, current_setting('quote_all_identifiers') AS quote_all_identifiers",
				),
			).resolves.toMatchObject({ rows: before.rows });
		} finally {
			await client.query('ROLLBACK');
			client.release();
		}
	});
});
