import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import {
	classifyPgLedgerPhysicalShape,
	readPgLedgerReservationsForPair,
} from '@dbsp/adapter-pgsql/internal';
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
});
