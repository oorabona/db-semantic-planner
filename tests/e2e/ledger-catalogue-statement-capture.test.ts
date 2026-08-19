import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import {
	appendPgLedgerClaim,
	classifyPgLedgerPhysicalShape,
	readPgLedgerReservationsForPair,
} from '@dbsp/adapter-pgsql/internal';
import type { LedgerReservationRow } from '@dbsp/types';
import { afterEach, describe, expect, it } from 'vitest';
import { dropSchema, getTestPool } from './testkit/index.js';
import { rolePool } from './transition-reinitialize-preflight-testkit.js';

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

const schemas: string[] = [];
afterEach(async () => {
	for (const schema of schemas.splice(0)) await dropSchema(schema);
});

describe('ledger catalogue statement capture', () => {
	it('uses the catalogue whitelist for the three-candidate set without CREATE', async () => {
		const pool = await getTestPool();
		const schemasForRun = [
			'ledger_real',
			'ledger_counterfeit',
			'ledger_drift',
		].map((prefix) => `${prefix}_${randomUUID().replaceAll('-', '')}`);
		schemas.push(...schemasForRun);
		for (const schema of schemasForRun)
			await pool.query(`CREATE SCHEMA "${schema}"`);
		await ensurePgLedger(pool, { scope: 'schema', schema: schemasForRun[0]! });
		const statements: string[] = [];
		const outcome = await classifyPgLedgerPhysicalShape(
			{
				query: async (sql, params) => {
					statements.push(sql);
					return pool.query(sql, params as unknown[]);
				},
			},
			{ scope: 'schema', schema: schemasForRun[0]! },
		);
		expect(typeof outcome.kind).toBe('string');
		expect(statements.some((sql) => /\bCREATE\b/i.test(sql))).toBe(false);
	});

	it('OBL-REC4 names a same-named ledger candidate as unverifiable when reservation SELECT is revoked', async () => {
		const pool = await getTestPool();
		const schema = `ledger_unverifiable_${randomUUID().replaceAll('-', '')}`;
		const role = `ledger_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const password = `password_${randomUUID()}`;
		schemas.push(schema);
		let reader: Awaited<ReturnType<typeof rolePool>> | undefined;
		try {
			await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
			await ensurePgLedger(pool, { scope: 'schema', schema });
			await pool.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
			);
			await pool.query(
				`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
			);
			for (const table of [
				'dbsp_ledger_event',
				'dbsp_ledger_identity',
				'dbsp_ledger_marker',
			])
				await pool.query(
					`GRANT SELECT ON TABLE ${quoteIdent(schema)}.${quoteIdent(table)} TO ${quoteIdent(role)}`,
				);
			reader = await rolePool(role, password);
			const discovered = await readPgLedgerReservationsForPair(
				reader,
				'OBL-REC4-revoked-select',
			);
			expect(discovered.candidates).toContainEqual({
				target: { scope: 'schema', schema },
				kind: 'unverifiable',
				cause: '42501',
			});
		} finally {
			await reader?.end();
			await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
			await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
		}
	});

	it('keeps discovery usable after an unreadable early candidate and finds a later reservation home', async () => {
		const pool = await getTestPool();
		const unreadable = `a_ledger_unreadable_${randomUUID().replaceAll('-', '')}`;
		const readable = `z_ledger_readable_${randomUUID().replaceAll('-', '')}`;
		const role = `ledger_discovery_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
		const password = `password_${randomUUID()}`;
		schemas.push(unreadable, readable);
		let reader: Awaited<ReturnType<typeof rolePool>> | undefined;
		try {
			for (const schema of [unreadable, readable]) {
				await pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
				await ensurePgLedger(pool, { scope: 'schema', schema });
			}
			const pairId = 'OBL-REC4-savepoint-discovery';
			const reservation: LedgerReservationRow = {
				address: {
					scope: 'schema',
					engine: 'postgresql',
					database: 'ledger_catalogue_e2e',
					schema: readable,
					kind: 'table',
					name: 'discoverable',
				},
				claimKind: 'readdress-intent',
				executionId: 'savepoint-discovery-execution',
				pairId,
				rootClaimId: 'savepoint-discovery-claim',
				homeLedger: { scope: 'schema', schema: readable },
			};
			await appendPgLedgerClaim(
				pool,
				{ scope: 'schema', schema: readable },
				{
					eventId: reservation.rootClaimId,
					address: reservation.address,
					eventKind: 'readdress-intent',
					pairId,
				},
				[reservation],
			);
			await pool.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
			);
			for (const schema of [unreadable, readable])
				await pool.query(
					`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
				);
			for (const table of [
				'dbsp_ledger_event',
				'dbsp_ledger_reservation',
				'dbsp_ledger_identity',
				'dbsp_ledger_marker',
			])
				await pool.query(
					`GRANT SELECT ON TABLE ${quoteIdent(readable)}.${quoteIdent(table)} TO ${quoteIdent(role)}`,
				);
			reader = await rolePool(role, password);
			const discovered = await readPgLedgerReservationsForPair(reader, pairId);
			expect(discovered.candidates).toContainEqual({
				target: { scope: 'schema', schema: unreadable },
				kind: 'unverifiable',
				cause: '42501',
			});
			expect(discovered).toContainEqual(reservation);
		} finally {
			await reader?.end();
			await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
			await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
		}
	});
});
