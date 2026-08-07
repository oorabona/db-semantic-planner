import pg from 'pg';
import {
	exitCodeForApplyOutcome,
	runApply,
} from '../../packages/cli/src/commands/apply.js';
import { checkpoint } from './harness/index.js';

const [runId, planDigest, schema] = process.argv.slice(2);
const db = process.env.DATABASE_URL;
const accepts = (process.env.DBSP_E2E_NON_TRANSACTIONAL_ACCEPTS ?? '')
	.split(',')
	.filter((value) => value.length > 0);
const WAIT_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 100;
const OBSERVER_QUERY_TIMEOUT_MS = 2_000;

function queryTimeoutError(label: string): Error {
	return new Error(
		`timed out waiting for ${label}; observer client was destroyed and the query may still be running server-side`,
	);
}

async function queryWithTimeout<Row extends Record<string, unknown>>(
	pool: pg.Pool,
	label: string,
	text: string,
	values: readonly unknown[],
	timeoutMs: number,
): Promise<{ readonly rows: readonly Row[] }> {
	const client = await pool.connect();
	let released = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			client.query<Row>(text, [...values]),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					client.release(true);
					released = true;
					reject(queryTimeoutError(label));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (!released) client.release();
	}
}

if (!runId || !planDigest || !schema || !db) {
	throw new Error(
		'non-transactional apply child requires run id, plan digest, schema, and DATABASE_URL',
	);
}

async function statementIsInFlight(
	pool: pg.Pool,
	schemaName: string,
): Promise<boolean> {
	const result = await queryWithTimeout<{ in_flight: boolean }>(
		pool,
		'the concurrent index observation query',
		'SELECT EXISTS (' +
			'SELECT 1 FROM pg_catalog.pg_stat_progress_create_index progress ' +
			'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
			'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
			'WHERE namespace.nspname = $1 AND index_relation.relname = $2' +
			') AS in_flight',
		[schemaName, 'idx_users_email'],
		OBSERVER_QUERY_TIMEOUT_MS,
	);
	return result.rows[0]?.in_flight === true;
}

async function waitForStatementToBeSent(
	pool: pg.Pool,
	schemaName: string,
	applying: Promise<Awaited<ReturnType<typeof runApply>>>,
): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	const applyCompletion = applying.then(
		(result) => ({ kind: 'apply' as const, result }),
		(error: unknown) => ({ kind: 'apply-error' as const, error }),
	);
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error('timed out waiting for the concurrent index statement');
		}
		const observed = await Promise.race([
			statementIsInFlight(pool, schemaName).then((inFlight) => ({
				kind: 'statement' as const,
				inFlight,
			})),
			applyCompletion,
		]);
		if (observed.kind === 'apply') {
			throw new Error(
				`apply completed before the server-observation checkpoint with outcome "${observed.result.outcome}"`,
			);
		}
		if (observed.kind === 'apply-error') throw observed.error;
		if (observed.inFlight) return;
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

async function main(): Promise<void> {
	if (!runId || !planDigest || !schema || !db) {
		throw new Error(
			'non-transactional apply child requires run id, plan digest, schema, and DATABASE_URL',
		);
	}
	const observer = new pg.Pool({
		connectionString: db,
		max: 1,
		connectionTimeoutMillis: OBSERVER_QUERY_TIMEOUT_MS,
	});
	try {
		await checkpoint('before-statement-sent');
		const applying = runApply(runId, { db, planDigest, accept: accepts });
		await waitForStatementToBeSent(observer, schema, applying);
		await checkpoint('after-statement-sent');
		const result = await applying;
		if (result.outcome !== 'completed') {
			process.stderr.write(
				`non-transactional apply child observed durable outcome "${result.outcome}"\n`,
			);
			process.exitCode = exitCodeForApplyOutcome(result.outcome);
		}
	} finally {
		await observer.end();
	}
}

void main().catch((error: unknown) => {
	process.stderr.write(
		`non-transactional apply child failed before observing a durable outcome: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
	process.exitCode = exitCodeForApplyOutcome('apply-failed');
});
