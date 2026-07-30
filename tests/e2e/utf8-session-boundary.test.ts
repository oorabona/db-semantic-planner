import { randomUUID } from 'node:crypto';
import { readPgExecutionTargetFromClient } from '@dbsp/adapter-pgsql';
import type { TransitionSessionClient } from '@dbsp/types';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { getTestPool } from './testkit/index.js';

const database = `dbsp_latin1_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const schema = 'schéma';
let latin1Pool: pg.Pool | undefined;

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

describe('PostgreSQL UTF-8 lease boundary', () => {
	it('mutation: reading a non-ASCII namespace before pinning UTF-8 corrupts a LATIN1 session parameter', async () => {
		const admin = await getTestPool();
		await admin.query(
			`CREATE DATABASE ${quoteIdent(database)} WITH TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C'`,
		);
		const url = new URL(process.env.DATABASE_URL!);
		url.pathname = `/${database}`;
		latin1Pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
		await latin1Pool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
		const client = await latin1Pool.connect();
		try {
			await client.query("SET client_encoding TO 'LATIN1'");
			await expect(
				readPgExecutionTargetFromClient(
					client as unknown as TransitionSessionClient,
					[schema],
				),
			).resolves.toMatchObject({
				identity: { namespaces: [{ name: schema }] },
			});
			await expect(client.query('SHOW client_encoding')).resolves.toMatchObject(
				{
					rows: [{ client_encoding: 'UTF8' }],
				},
			);
		} finally {
			client.release();
		}
	});

	afterAll(async () => {
		await latin1Pool?.end();
		const admin = await getTestPool();
		await admin.query(
			`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`,
		);
	});
});
