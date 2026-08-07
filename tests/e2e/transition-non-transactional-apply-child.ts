import pg from 'pg';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { checkpoint } from './harness/index.js';

const [runId, planDigest, schema] = process.argv.slice(2);
const db = process.env.DATABASE_URL;
const accepts = (process.env.DBSP_E2E_NON_TRANSACTIONAL_ACCEPTS ?? '')
	.split(',')
	.filter((value) => value.length > 0);
const WAIT_TIMEOUT_MS = 45_000;

if (!runId || !planDigest || !schema || !db) {
	throw new Error(
		'non-transactional apply child requires run id, plan digest, schema, and DATABASE_URL',
	);
}

async function statementIsInFlight(
	pool: pg.Pool,
	schemaName: string,
): Promise<boolean> {
	const result = await pool.query<{ in_flight: boolean }>(
		'SELECT EXISTS (' +
			'SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress ' +
			'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
			'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
			'WHERE namespace.nspname = $1 AND index_relation.relname = $2' +
			') AS in_flight',
		[schemaName, 'idx_users_email'],
	);
	return result.rows[0]?.in_flight === true;
}

async function waitForStatementToBeSent(
	pool: pg.Pool,
	schemaName: string,
): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		if (await statementIsInFlight(pool, schemaName)) return;
		if (Date.now() >= deadline) {
			throw new Error('timed out waiting for the concurrent index statement');
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
	}
}

async function main(): Promise<void> {
	if (!runId || !planDigest || !schema || !db) {
		throw new Error(
			'non-transactional apply child requires run id, plan digest, schema, and DATABASE_URL',
		);
	}
	const observer = new pg.Pool({ connectionString: db, max: 1 });
	try {
		await checkpoint('before-statement-sent');
		const applying = runApply(runId, { db, planDigest, accept: accepts });
		await waitForStatementToBeSent(observer, schema);
		await checkpoint('after-statement-sent');
		await applying;
	} finally {
		await observer.end();
	}
}

void main();
