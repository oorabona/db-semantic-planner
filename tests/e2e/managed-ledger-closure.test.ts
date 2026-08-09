import { randomUUID } from 'node:crypto';
import {
	acquirePgLedgerLocks,
	ensureDbspMetaLedger,
	ensurePgLedger,
} from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerClaim,
	appendPgLedgerResolution,
} from '@dbsp/adapter-pgsql/internal';
import type { LedgerAddress } from '@dbsp/types';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureRefusedResolutionMember } from './outcome-claim-fixture.js';

const pools: pg.Pool[] = [];

function address(
	scope: 'schema' | 'database',
	schema: string | undefined,
	kind: string,
	name: string,
): LedgerAddress {
	return schema === undefined
		? {
				scope,
				engine: 'postgresql',
				database: 'managed_ledger_e2e',
				kind,
				name,
			}
		: {
				scope,
				engine: 'postgresql',
				database: 'managed_ledger_e2e',
				schema,
				kind,
				name,
			};
}

afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('managed ledger effects closures (SC-11, SC-14)', () => {
	it('SC-11: records every cross-ledger closure row under one root and serializes in global order', async () => {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL not set');
		const pool = new pg.Pool({ connectionString, max: 3 });
		pools.push(pool);
		const schema = `ledger_tenant_${randomUUID().replaceAll('-', '')}`;
		await pool.query(`CREATE SCHEMA "${schema}"`);
		try {
			await ensureDbspMetaLedger(pool);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			const rootAddress = address(
				'database',
				undefined,
				'extension',
				`ext_${schema}`,
			);
			const childAddress = address(
				'schema',
				schema,
				'table',
				`table_${schema}`,
			);
			const rootClaimId = `claim_${schema}`;
			await appendPgLedgerClaim(
				pool,
				{ scope: 'database' },
				{ eventId: rootClaimId, address: rootAddress, eventKind: 'intent' },
				[
					{
						address: rootAddress,
						claimKind: 'intent',
						executionId: `execution_${schema}`,
						rootClaimId,
						homeLedger: { scope: 'database' },
					},
					{
						address: childAddress,
						claimKind: 'intent',
						executionId: `execution_${schema}`,
						rootClaimId,
						homeLedger: { scope: 'database' },
					},
				],
			);
			const schemaReservations = await pool.query(
				`SELECT root_claim_id, home_ledger_scope FROM "${schema}"."dbsp_ledger_reservation"`,
			);
			expect(schemaReservations.rows).toEqual([
				{ root_claim_id: rootClaimId, home_ledger_scope: 'database' },
			]);

			const first = await pool.connect();
			try {
				await first.query('BEGIN');
				expect(
					await acquirePgLedgerLocks(first, [
						{ scope: 'schema', schema },
						{ scope: 'database' },
					]),
				).toEqual({ kind: 'acquired' });
				expect(
					await acquirePgLedgerLocks(pool, [
						{ scope: 'database' },
						{ scope: 'schema', schema },
					]),
				).toEqual({ kind: 'busy', ledger: { scope: 'database' } });
			} finally {
				await first.query('ROLLBACK');
				first.release();
			}
		} finally {
			await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
		}
	});

	it('SC-14: sends a table event only to its schema ledger and an extension event only to dbsp_meta', async () => {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) throw new Error('DATABASE_URL not set');
		const pool = new pg.Pool({ connectionString, max: 2 });
		pools.push(pool);
		const schema = `ledger_scope_${randomUUID().replaceAll('-', '')}`;
		await pool.query(`CREATE SCHEMA "${schema}"`);
		try {
			await ensureDbspMetaLedger(pool);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			const tableAddress = address(
				'schema',
				schema,
				'table',
				`table_${schema}`,
			);
			const extensionAddress = address(
				'database',
				undefined,
				'extension',
				`extension_${schema}`,
			);
			await appendPgLedgerClaim(
				pool,
				{ scope: 'schema', schema },
				{
					eventId: `table_claim_${schema}`,
					address: tableAddress,
					eventKind: 'intent',
				},
				[
					{
						address: tableAddress,
						claimKind: 'intent',
						executionId: `table_execution_${schema}`,
						rootClaimId: `table_claim_${schema}`,
						homeLedger: { scope: 'schema', schema },
					},
				],
			);
			await appendPgLedgerClaim(
				pool,
				{ scope: 'database' },
				{
					eventId: `extension_claim_${schema}`,
					address: extensionAddress,
					eventKind: 'intent',
				},
				[
					{
						address: extensionAddress,
						claimKind: 'intent',
						executionId: `extension_execution_${schema}`,
						rootClaimId: `extension_claim_${schema}`,
						homeLedger: { scope: 'database' },
					},
				],
			);
			const schemaEvents = await pool.query(
				`SELECT address_kind FROM "${schema}"."dbsp_ledger_event" ORDER BY event_id`,
			);
			const databaseEvents = await pool.query(
				`SELECT address_kind FROM "dbsp_meta"."dbsp_ledger_event" WHERE address_name = $1`,
				[extensionAddress.name],
			);
			expect(schemaEvents.rows).toEqual([{ address_kind: 'table' }]);
			expect(databaseEvents.rows).toEqual([{ address_kind: 'extension' }]);

			await appendPgLedgerResolution(
				pool,
				{ scope: 'schema', schema },
				fixtureRefusedResolutionMember({
					eventId: `table_refused_${schema}`,
					address: tableAddress,
					predecessor: `table_claim_${schema}`,
					code: 'ERR-11',
				}),
				`table_claim_${schema}`,
				[{ address: tableAddress }],
			);
			expect(
				await pool.query(`SELECT * FROM "${schema}"."dbsp_ledger_reservation"`),
			).toMatchObject({ rows: [] });
		} finally {
			await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
		}
	});
});
