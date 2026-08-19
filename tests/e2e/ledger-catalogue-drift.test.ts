import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import { classifyPgLedgerPhysicalShape } from '@dbsp/adapter-pgsql/internal';
import { describe, expect, it } from 'vitest';
import { dropSchema, getTestPool } from './testkit/index.js';

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

describe('ledger catalogue drift', () => {
	it('accepts the pristine bootstrap shape', async () => {
		const pool = await getTestPool();
		const schema = `ledger_pristine_${randomUUID().replaceAll('-', '')}`;
		try {
			await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			await expect(
				classifyPgLedgerPhysicalShape(pool, { scope: 'schema', schema }),
			).resolves.toEqual({ kind: 'verified' });
		} finally {
			await dropSchema(schema);
		}
	});

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

	it.each([
		[
			'unexpected default',
			async (schema: string) => {
				const pool = await getTestPool();
				await pool.query(
					`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_reservation')} ALTER COLUMN root_claim_id SET DEFAULT 'counterfeit'`,
				);
			},
		],
		[
			'trigger on a non-event ledger table',
			async (schema: string) => {
				const pool = await getTestPool();
				await pool.query(
					`CREATE FUNCTION ${quoteIdent(schema)}.ledger_drift_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
				);
				await pool.query(
					`CREATE TRIGGER ledger_drift_trigger AFTER INSERT ON ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_reservation')} FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(schema)}.ledger_drift_trigger()`,
				);
			},
		],
		[
			'non-constraint index on a non-event ledger table',
			async (schema: string) => {
				const pool = await getTestPool();
				await pool.query(
					`CREATE INDEX ledger_drift_reservation_claim_kind ON ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_reservation')} (claim_kind)`,
				);
			},
		],
		[
			'foreign key to a same-named relation in another namespace',
			async (schema: string) => {
				const pool = await getTestPool();
				const foreignSchema = `${schema}_foreign`;
				await pool.query(`CREATE SCHEMA ${quoteIdent(foreignSchema)}`);
				await pool.query(
					`CREATE TABLE ${quoteIdent(foreignSchema)}.${quoteIdent('dbsp_ledger_event')} (address_engine text NOT NULL, address_database text NOT NULL, address_schema text NOT NULL, address_parent jsonb NOT NULL, address_kind text NOT NULL, address_name text NOT NULL, event_id text NOT NULL, PRIMARY KEY (address_engine, address_database, address_schema, address_parent, address_kind, address_name, event_id))`,
				);
				await pool.query(
					`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_event')} DROP CONSTRAINT dbsp_ledger_event_same_address_predecessor`,
				);
				await pool.query(
					`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_event')} ADD CONSTRAINT dbsp_ledger_event_same_address_predecessor FOREIGN KEY (address_engine, address_database, address_schema, address_parent, address_kind, address_name, predecessor) REFERENCES ${quoteIdent(foreignSchema)}.${quoteIdent('dbsp_ledger_event')} (address_engine, address_database, address_schema, address_parent, address_kind, address_name, event_id)`,
				);
			},
		],
	] as const)('refuses %s', async (_artefact, mutate) => {
		const pool = await getTestPool();
		const schema = `ledger_drift_${randomUUID().replaceAll('-', '')}`;
		try {
			await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			await mutate(schema);
			await expect(
				classifyPgLedgerPhysicalShape(pool, { scope: 'schema', schema }),
			).resolves.toMatchObject({ kind: 'shape-wrong' });
		} finally {
			await dropSchema(schema);
			await dropSchema(`${schema}_foreign`);
		}
	});
});
