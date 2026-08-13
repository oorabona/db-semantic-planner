import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import { describe, expect, it } from 'vitest';
import { PG_LEDGER_SPEC } from '../../packages/adapter-pgsql/src/transition/ledger-spec.js';
import { dropSchema, getTestPool } from './testkit/index.js';

type CatalogueRow = { table_name: string; columns: string[] };

describe('ledger manifest catalogue matrix', () => {
	it('matches every manifest table and ordered column fingerprint in PostgreSQL', async () => {
		const pool = await getTestPool();
		const schema = `ledger_matrix_${randomUUID().replaceAll('-', '')}`;
		try {
			await pool.query(`CREATE SCHEMA "${schema}"`);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			const actual = await pool.query<CatalogueRow>(
				`SELECT c.relname AS table_name, ARRAY(SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum)::text[] AS columns FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY c.relname`,
				[schema],
			);
			for (const table of PG_LEDGER_SPEC) {
				const row = actual.rows.find(
					(value) => value.table_name === table.name,
				);
				expect(row?.columns).toEqual(
					table.columns.map((column) => column.name),
				);
			}
		} finally {
			await dropSchema(schema);
		}
	});
});
