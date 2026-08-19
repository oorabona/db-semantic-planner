import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { ensurePgLedger } from '../src/transition/ledger.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
	throw new Error('DATABASE_URL is required to capture ledger fixtures');

const schema = `dbsp_ledger_fixture_${randomBytes(12).toString('hex')}`;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
	await client.query(`CREATE SCHEMA "${schema}"`);
	await ensurePgLedger(client, { scope: 'schema', schema });
	await client.query('SET search_path = pg_catalog');
	await client.query('SET quote_all_identifiers = off');
	const version = await client.query<{ server_version_num: string }>(
		"SELECT current_setting('server_version_num') AS server_version_num",
	);
	const major = Math.floor(Number(version.rows[0]?.server_version_num) / 10000);
	if (!Number.isSafeInteger(major))
		throw new Error('PostgreSQL major is unreadable');
	const checks = await client.query<{
		table_name: string;
		constraint_name: string;
		expression: string;
	}>(
		`SELECT relation.relname AS table_name, constraint_item.conname AS constraint_name, pg_catalog.pg_get_expr(constraint_item.conbin, constraint_item.conrelid, false) AS expression FROM pg_catalog.pg_constraint constraint_item JOIN pg_catalog.pg_class relation ON relation.oid = constraint_item.conrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND constraint_item.contype = 'c' ORDER BY relation.relname, constraint_item.conname`,
		[schema],
	);
	const defaults = await client.query<{
		table_name: string;
		column_name: string;
		expression: string;
	}>(
		`SELECT relation.relname AS table_name, attribute.attname AS column_name, pg_catalog.pg_get_expr(default_item.adbin, default_item.adrelid, false) AS expression FROM pg_catalog.pg_attrdef default_item JOIN pg_catalog.pg_class relation ON relation.oid = default_item.adrelid JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid AND attribute.attnum = default_item.adnum WHERE namespace.nspname = $1 ORDER BY relation.relname, attribute.attname`,
		[schema],
	);
	const fixture = {
		checks: Object.fromEntries(
			checks.rows.map((row) => [
				`${row.table_name}.${row.constraint_name}`,
				row.expression,
			]),
		),
		defaults: Object.fromEntries(
			defaults.rows.map((row) => [
				`${row.table_name}.${row.column_name}`,
				row.expression,
			]),
		),
	};
	const output = resolve(
		dirname(fileURLToPath(import.meta.url)),
		'../src/transition/ledger-deparse-fixtures',
		`pg-${major}.json`,
	);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, `${JSON.stringify(fixture, null, '\t')}\n`, 'utf8');
} finally {
	await client
		.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
		.catch(() => undefined);
	await client.end();
}
