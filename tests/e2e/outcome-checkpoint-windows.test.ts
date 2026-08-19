import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	DBSP_LEDGER_EVENT_TABLE,
	type PgOutcomeCheckpoint,
} from '@dbsp/adapter-pgsql';
import { afterEach, describe, expect, it } from 'vitest';
import { type CheckpointChild, spawnCheckpointChild } from './harness/index.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';
import {
	quoteIdent,
	resetDbspMeta,
	runPreflight,
} from './transition-reinitialize-preflight-testkit.js';

const schemas: string[] = [];
const WAIT_TIMEOUT_MS = 45_000;

function schemaName(label: string): string {
	return `outcome_checkpoint_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function waitFor<T>(label: string, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out waiting for ${label}`)),
				WAIT_TIMEOUT_MS,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function provision(schema: string): Promise<void> {
	schemas.push(schema);
	await createSchema(schema);
	await runPreflight([schema]);
}

function spawn(
	mode: 'transactional' | 'non-transactional',
	schema: string,
	expectation?: 'integrity-refusal',
): CheckpointChild {
	const db = process.env.DATABASE_URL;
	if (!db)
		throw new Error('DATABASE_URL is required for outcome checkpoint E2E');
	return spawnCheckpointChild(
		fileURLToPath(new URL('./outcome-checkpoint-child.ts', import.meta.url)),
		{
			args: [mode, schema, ...(expectation === undefined ? [] : [expectation])],
			env: { ...process.env, DATABASE_URL: db },
		},
	);
}

const ledgerArtefactDrifts = [
	[
		'relation',
		(schema: string) =>
			`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_marker')} RENAME TO ${quoteIdent('dbsp_ledger_marker_drift')}`,
	],
	[
		'column',
		(schema: string) =>
			`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} DROP COLUMN recorded_at`,
	],
	[
		'constraint',
		(schema: string) =>
			`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} DROP CONSTRAINT dbsp_ledger_event_one_child`,
	],
	[
		'index',
		(schema: string) =>
			`DROP INDEX ${quoteIdent(schema)}.${quoteIdent('dbsp_ledger_event_terminal_member')}`,
	],
] as const;

async function acknowledgeThrough(
	child: CheckpointChild,
	checkpoints: readonly PgOutcomeCheckpoint[],
): Promise<void> {
	for (const point of checkpoints) {
		await waitFor(`checkpoint ${point}`, child.waitForCheckpoint(point));
		await child.acknowledge(point);
	}
}

async function eventKinds(schema: string): Promise<readonly string[]> {
	const pool = await getTestPool();
	return (
		await pool.query<{ event_kind: string }>(
			`SELECT event_kind FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} ORDER BY recorded_at, event_id`,
		)
	).rows.map((row) => row.event_kind);
}

afterEach(async () => {
	for (const schema of schemas.splice(0).reverse()) await dropSchema(schema);
	await resetDbspMeta();
});

describe.sequential('OBL checkpoint windows', () => {
	it('OBL-AUTH5: the transactional post-lock-integrity-to-append checkpoint is IPC-armed', async () => {
		const schema = schemaName('auth5');
		await provision(schema);
		const child = spawn('transactional', schema);
		try {
			await acknowledgeThrough(child, [
				'post-lock-integrity-before-append',
				'ddl-completed-before-read-back',
				'commit-acknowledged',
			]);
			expect(
				await waitFor('transactional checkpoint child exit', child.exited),
			).toMatchObject({ code: 0 });
			expect(await eventKinds(schema)).toEqual(['intent', 'observed']);
		} finally {
			await child.terminate('SIGKILL');
		}
	});

	it.each([
		['transactional completion append', 'transactional', [] as const] as const,
		[
			'non-transactional claim append',
			'non-transactional',
			[] as const,
		] as const,
		[
			'non-transactional executing append',
			'non-transactional',
			['post-lock-integrity-before-append', 'commit-acknowledged'] as const,
		] as const,
		[
			'non-transactional terminal append',
			'non-transactional',
			[
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'ddl-completed-before-read-back',
			] as const,
		] as const,
	] as const)('OBL-AUTH5: every uncovered %s refuses every mutated ledger artefact before its append', async (_path, mode, prefix) => {
		for (const [artefact, mutate] of ledgerArtefactDrifts) {
			const schema = schemaName(`auth5_${artefact}`);
			await provision(schema);
			const child = spawn(mode, schema, 'integrity-refusal');
			try {
				await acknowledgeThrough(child, prefix);
				await waitFor(
					'post-lock integrity checkpoint',
					child.waitForCheckpoint('post-lock-integrity-before-append'),
				);
				const pool = await getTestPool();
				await pool.query(mutate(schema));
				await child.acknowledge('post-lock-integrity-before-append');
				const expectedExitCode =
					_path === 'non-transactional terminal append' ? 1 : 0;
				expect(
					await waitFor('integrity-refusal child exit', child.exited),
				).toMatchObject({
					// Only the terminal checkpoint follows the committed executing append;
					// its drift is outcome-recovery-required, not a refusal.
					code: expectedExitCode,
				});
			} finally {
				await child.terminate('SIGKILL');
			}
		}
	});

	it.each([
		[
			'executing committed',
			[
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'post-lock-integrity-before-append',
				'commit-acknowledged',
			] as const,
		],
		[
			'DDL complete',
			[
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'ddl-completed-before-read-back',
			] as const,
		],
		[
			'terminal committed',
			[
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'post-lock-integrity-before-append',
				'commit-acknowledged',
				'ddl-completed-before-read-back',
				'post-lock-integrity-before-append',
				'commit-acknowledged',
			] as const,
		],
	] as const)('OBL-READ3: killing after executing at the %s stage leaves no unverified refused terminal', async (_stage, prefix) => {
		const schema = schemaName('read3');
		await provision(schema);
		const child = spawn('non-transactional', schema);
		try {
			await acknowledgeThrough(child, prefix.slice(0, -1));
			const last = prefix[prefix.length - 1]!;
			await waitFor(`checkpoint ${last}`, child.waitForCheckpoint(last));
			expect(await child.kill('SIGKILL')).toMatchObject({ signal: 'SIGKILL' });
			expect(await eventKinds(schema)).not.toContain('refused');
		} finally {
			await child.terminate('SIGKILL');
		}
	});
});
