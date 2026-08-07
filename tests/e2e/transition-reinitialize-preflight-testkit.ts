import { randomUUID } from 'node:crypto';
import {
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_META_SCHEMA,
	type PgReinitializePreflightOptions,
	runPgReinitializePreflight,
} from '@dbsp/adapter-pgsql';
import type {
	DeclarableResourceAddress,
	DeclarationSet,
	LedgerAddress,
} from '@dbsp/types';
import pg from 'pg';
import { createSchema, getTestPool } from './testkit/index.js';

export function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function uniqueName(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * A role fixture must not pass DATABASE_URL through to pg: URL credentials
 * take precedence over `user` and would silently run these checks as the
 * deployment superuser.
 */
export async function rolePool(
	role: string,
	password: string,
): Promise<pg.Pool> {
	const connectionString = process.env.DATABASE_URL;
	if (!connectionString)
		throw new Error('DATABASE_URL is required for role fixture');
	const url = new URL(connectionString);
	const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
	if (!url.hostname || !database)
		throw new Error(
			'DATABASE_URL must include a host and database for role fixture',
		);
	const pool = new pg.Pool({
		host: url.hostname,
		...(url.port === '' ? {} : { port: Number(url.port) }),
		database,
		user: role,
		password,
		max: 2,
	});
	try {
		const identity = await pool.query<{ current_user: string }>(
			'SELECT current_user',
		);
		if (identity.rows[0]?.current_user !== role)
			throw new Error(
				`role fixture connected as ${String(identity.rows[0]?.current_user)}, expected ${role}`,
			);
		return pool;
	} catch (error) {
		await pool.end();
		throw error;
	}
}

/** dbsp_meta is database-global, so each describe owns a fresh instance. */
export async function resetDbspMeta(): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`DROP SCHEMA IF EXISTS ${quoteIdent(DBSP_META_SCHEMA)} CASCADE`,
	);
}

export function reinitializePreflightChildApplicationName(pid: number): string {
	return `dbsp-reinitialize-preflight-child-${pid}`;
}

/** SIGKILL does not close PostgreSQL sockets; clear the named orphan explicitly. */
export async function terminateReinitializePreflightChildBackends(
	pid: number,
): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		'SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name = $1 AND pid <> pg_catalog.pg_backend_pid()',
		[reinitializePreflightChildApplicationName(pid)],
	);
}

export function emptyDeclarations(): DeclarationSet {
	return { version: 1, digest: 'e2e-empty-declaration-set', declarations: [] };
}

export function tableAddress(schema: string, name: string): LedgerAddress {
	return {
		scope: 'schema',
		engine: 'postgresql',
		database: 'e2e_test',
		schema,
		kind: 'table',
		name,
	};
}

export function tableDeclarations(
	schema: string,
	names: readonly string[],
): DeclarationSet {
	return {
		version: 1,
		digest: `e2e-declarations-${schema}`,
		declarations: names.map((name) => {
			const { scope: _scope, ...address } = tableAddress(schema, name);
			return {
				address: address as DeclarableResourceAddress<'table'>,
				fragment: { name },
				digest: `e2e-${name}`,
			};
		}),
	};
}

export async function runPreflight(
	schemas: readonly string[],
	options: {
		readonly declarations?: DeclarationSet;
		readonly observer?: PgReinitializePreflightOptions['observer'];
		readonly writeAdoptionFile: PgReinitializePreflightOptions['writeAdoptionFile'];
		readonly pool?: pg.Pool;
	} = {
		writeAdoptionFile: async () => {},
	},
) {
	const pool = options.pool ?? (await getTestPool());
	return await runPgReinitializePreflight({
		pool,
		schemas,
		declarations: options.declarations ?? emptyDeclarations(),
		writeAdoptionFile: options.writeAdoptionFile,
		...(options.observer === undefined ? {} : { observer: options.observer }),
	});
}

export async function createPreflightSchema(schema: string): Promise<void> {
	await createSchema(schema);
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('application_table')} (id integer PRIMARY KEY)`,
	);
}

export async function markerVersions(
	schema: string,
): Promise<readonly number[]> {
	const pool = await getTestPool();
	const result = await pool.query<{ version: number }>(
		`SELECT version FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} ORDER BY version`,
	);
	return result.rows.map((row) => Number(row.version));
}

export async function ledgerEventCount(schema: string): Promise<number> {
	const pool = await getTestPool();
	const result = await pool.query<{ count: string }>(
		`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
	);
	return Number(result.rows[0]?.count);
}

export async function seedCoveredChain(
	schema: string,
	address: LedgerAddress,
): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`INSERT INTO ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} (event_id, address_engine, address_database, address_schema, address_parent, address_kind, address_name, event_kind) VALUES ($1, $2, $3, $4, 'null'::jsonb, $5, $6, 'observed')`,
		[
			`e2e-covered-${randomUUID()}`,
			address.engine,
			address.database,
			address.schema ?? '',
			address.kind,
			address.name,
		],
	);
}

export async function corruptLedgerIdentity(schema: string): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`UPDATE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_IDENTITY_TABLE)} SET database_oid = 'e2e-mismatched-database'`,
	);
}

export { DBSP_META_SCHEMA };
