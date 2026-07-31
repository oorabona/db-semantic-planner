/**
 * #420 — the GUI preview must use PostgreSQL's live expression canonicalizer.
 *
 * This is intentionally DB-backed: a fake comparison cannot prove that the
 * sidecar preview converges on PostgreSQL's spelling of a column default.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	type ConnectParams,
	connect,
	disconnect,
	type SslMode,
} from '../../packages/gui/sidecar/connection-manager.js';
import { parsePostgresUrl } from '../../packages/gui/sidecar/profile-resolver.js';
import { handleSchemaDiff } from '../../packages/gui/sidecar/schema-diff-handler.js';
import { LOCAL_CONTAINER_ENV } from './globalSetup.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

const SCHEMA = 'gui_live_comparator_test';
// Keep this under the workspace so Node can walk up to the workspace
// node_modules when the fixture imports @dbsp/core. `.tmp/` is already ignored.
const FIXTURE_ROOT = join(process.cwd(), '.tmp');

let connectionId: string | undefined;
let schemaDir: string | undefined;

const supportedSslModes: readonly SslMode[] = [
	'disable',
	'allow',
	'prefer',
	'require',
	'verify-full',
];

function isSupportedSslMode(mode: string): mode is SslMode {
	return supportedSslModes.includes(mode as SslMode);
}

function supportedSslMode(mode: string | undefined): SslMode | undefined {
	if (mode === undefined || isSupportedSslMode(mode)) return mode;
	throw new Error(
		`Unsupported sslmode "${mode}" in DATABASE_URL for GUI live comparator`,
	);
}

function quoteIdent(identifier: string): string {
	return `"${identifier.replace(/"/gu, '""')}"`;
}

function connectionParams(): ConnectParams {
	const databaseUrl = process.env.DATABASE_URL;
	if (databaseUrl === undefined) {
		throw new Error('DATABASE_URL not set. Did globalSetup run successfully?');
	}
	const parsed = parsePostgresUrl(databaseUrl);
	const { sslMode, ...params } = parsed;
	const isLocalContainer = process.env[LOCAL_CONTAINER_ENV] === '1';
	const externalSslMode = isLocalContainer
		? undefined
		: supportedSslMode(sslMode);
	return {
		...params,
		// Only the setup-created fixture is known not to serve TLS. An external
		// DATABASE_URL owns its requested sslmode and must be preserved.
		...(isLocalContainer
			? { sslMode: 'disable' as const }
			: externalSslMode === undefined
				? {}
				: { sslMode: externalSslMode }),
		schema: SCHEMA,
	};
}

beforeAll(async () => {
	const pool = await getTestPool();
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await pool.query(`
		CREATE TABLE ${quoteIdent(SCHEMA)}.job_runs (
			id integer PRIMARY KEY,
			created_at text NOT NULL DEFAULT 'pending'::text
		)
	`);

	mkdirSync(FIXTURE_ROOT, { recursive: true });
	schemaDir = mkdtempSync(join(FIXTURE_ROOT, 'gui-live-comparator-'));
	writeFileSync(
		join(schemaDir, 'dbsp.schema.js'),
		[
			"import { schema } from '@dbsp/core';",
			"export const dbCasing = 'snake_case';",
			"export default schema({ jobRuns: { id: { type: 'integer', primaryKey: true }, createdAt: { type: 'text', default: 'pending' } } });",
		].join('\n'),
		'utf8',
	);

	connectionId = (await connect(connectionParams())).connectionId;
});

afterAll(async () => {
	const cleanup = await Promise.allSettled([
		...(connectionId === undefined ? [] : [disconnect(connectionId)]),
		Promise.resolve().then(() => {
			if (schemaDir !== undefined)
				rmSync(schemaDir, { recursive: true, force: true });
		}),
		dropSchema(SCHEMA),
	]);
	const close = await Promise.allSettled([closeTestDb()]);
	const failed = [...cleanup, ...close].find(
		(result): result is PromiseRejectedResult => result.status === 'rejected',
	);
	if (failed) throw failed.reason;
});

describe('#420 GUI live comparator', () => {
	it('plans no statement for equivalent scalar default spellings', async () => {
		const pool = await getTestPool();
		const storedDefault = await pool.query<{ expression: string }>(
			`SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid, false) AS expression
			   FROM pg_catalog.pg_attrdef d
			   JOIN pg_catalog.pg_attribute a
			     ON a.attrelid = d.adrelid AND a.attnum = d.adnum
			  WHERE d.adrelid = $1::regclass AND a.attname = 'created_at'`,
			[`${SCHEMA}.job_runs`],
		);
		expect(storedDefault.rows[0]?.expression).toBe(`'pending'::text`);

		const result = await handleSchemaDiff({
			connectionId: connectionId!,
			schemaPath: schemaDir!,
		});

		expect(result.warnings).toEqual([]);
		expect(
			result.changes.filter((change) => change.table === 'jobRuns'),
		).toEqual([]);
		expect(
			result.upSQL.filter((statement) => statement.includes('"job_runs"')),
		).toEqual([]);
	});
});
