import { randomUUID } from 'node:crypto';
import { ensurePgLedger } from '@dbsp/adapter-pgsql';
import { classifyPgLedgerPhysicalShape } from '@dbsp/adapter-pgsql/internal';
import { afterEach, describe, expect, it } from 'vitest';
import { dropSchema, getTestPool } from './testkit/index.js';

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
});
