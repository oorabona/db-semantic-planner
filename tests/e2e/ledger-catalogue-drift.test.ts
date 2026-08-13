import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import { classifyPgLedgerPhysicalShape } from '@dbsp/adapter-pgsql/internal';
import { describe, expect, it } from 'vitest';
import { dropSchema, getTestPool } from './testkit/index.js';

describe('ledger catalogue drift', () => {
	it.each([
		[
			'relation',
			'ALTER TABLE "dbsp_ledger_marker" RENAME TO "dbsp_ledger_marker_drift"',
		],
		['column', 'ALTER TABLE "dbsp_ledger_event" DROP COLUMN recorded_at'],
		[
			'constraint',
			'ALTER TABLE "dbsp_ledger_event" DROP CONSTRAINT dbsp_ledger_event_one_child',
		],
		['index', 'DROP INDEX "dbsp_ledger_event_terminal_member"'],
	] as const)('classifies %s drift as non-verified', async (_artefact, ddl) => {
		const pool = await getTestPool();
		const schema = `ledger_drift_${randomUUID().replaceAll('-', '')}`;
		try {
			await pool.query(`CREATE SCHEMA "${schema}"`);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			await pool.query(`SET search_path = "${schema}"`);
			await pool.query(ddl);
			const outcome = await classifyPgLedgerPhysicalShape(pool, {
				scope: 'schema',
				schema,
			});
			expect(outcome).toMatchObject({ kind: 'shape-wrong' });
		} finally {
			await dropSchema(schema);
		}
	});
});
