import { randomUUID } from 'node:crypto';
import { runPgReinitializePreflight } from '@dbsp/adapter-pgsql';
import type { ModelIR } from '@dbsp/core';
import pg from 'pg';
import { expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { runReconcile } from '../../packages/cli/src/commands/reconcile.js';
import {
	createStreamingStandbyTopology,
	describeWithE2eCapabilities,
} from './harness/index.js';

const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function unique(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function enumModel(schema: string): ModelIR {
	return {
		tables: new Map(),
		relations: new Map(),
		enums: new Map([
			['status', { name: 'status', schema, values: ['active', 'pending'] }],
		]),
		getTable: () => undefined,
		getRelation: () => undefined,
		getRelationsFrom: () => [],
		getRelationsTo: () => [],
		isAmbiguous: () => ({ ambiguous: false, options: [] }),
	};
}

async function planEnumAdd(
	pool: pg.Pool,
	schema: string,
): Promise<{
	readonly runId: string;
	readonly planDigest: string;
	readonly plan: NonNullable<Awaited<ReturnType<typeof runPlan>>['plan']>;
}> {
	const planned = await runPlan(
		{
			db: 'postgresql://e2e-local',
			schemaFile: 'database-read-only-local.ts',
			schema,
		},
		{
			createDbConnection: async () => ({
				pool,
				release: async () => undefined,
			}),
			loadSchema: async () => ({
				model: enumModel(schema),
				definition: {},
				tableNames: [],
			}),
		},
	);
	if (!planned.runId || !planned.planDigest || !planned.plan)
		throw new Error(
			`expected persisted read-only scenario plan; runPlan returned ${JSON.stringify(planned)}`,
		);
	return {
		runId: planned.runId,
		planDigest: planned.planDigest,
		plan: planned.plan,
	};
}

async function pollUntil(
	label: string,
	read: () => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		if (await read()) return;
		if (Date.now() >= deadline)
			throw new Error(`timed out waiting for ${label}`);
		await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

async function expectReadOnlyCommandOutcomes(
	pool: pg.Pool,
	run: Awaited<ReturnType<typeof planEnumAdd>>,
	schema: string,
): Promise<void> {
	const preflight = await runPgReinitializePreflight({
		pool,
		schemas: [schema],
		declarations: { version: 1, digest: 'read-only', declarations: [] },
		writeAdoptionFile: async () => {},
	});
	expect(
		preflight.scopes,
		'preflight must classify a non-writable target before changing structures',
	).toHaveLength(2);
	for (const scope of preflight.scopes) {
		expect(scope).toEqual(
			expect.objectContaining({
				outcome: 'failed',
				refusal: expect.objectContaining({ code: 'database-read-only' }),
			}),
		);
	}
	const applied = await runApply(
		run.runId,
		{
			db: 'postgresql://e2e-local',
			planDigest: run.planDigest,
			accept: run.plan.assumptions.map((assumption) => assumption.class),
		},
		pool,
	);
	expect(
		applied.outcome,
		'apply must expose the single non-writable target outcome before authorization',
	).toBe('database-read-only');
	const reconciled = await runReconcile(
		run.runId,
		{ db: 'postgresql://e2e-local' },
		pool,
	);
	expect(
		reconciled.outcome,
		'reconcile must expose the same non-writable target outcome before recovery writes',
	).toBe('database-read-only');
}

describeWithE2eCapabilities(
	['standby-topology'],
	'SC-45 #481 database-read-only is one outcome for standby and default-read-only sessions',
	() => {
		it('classifies the streaming standby and a default_transaction_read_only session through the same path', async () => {
			const topology = await createStreamingStandbyTopology();
			const schema = unique('read_only_standby');
			try {
				await topology.primaryPool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
				await topology.primaryPool.query(
					`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
				);
				await runPgReinitializePreflight({
					pool: topology.primaryPool,
					schemas: [schema],
					declarations: { version: 1, digest: 'primary', declarations: [] },
					writeAdoptionFile: async () => {},
				});
				const standbyRun = await planEnumAdd(topology.primaryPool, schema);
				await pollUntil(
					'the durable run to replicate to the streaming standby',
					async () => {
						const replicated = await topology.standbyPool.query<{
							present: boolean;
						}>(
							'SELECT EXISTS (SELECT 1 FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1) AS present',
							[standbyRun.runId],
						);
						return replicated.rows[0]?.present === true;
					},
				);
				const standbyState = await topology.standbyPool.query<{
					recovery: boolean;
				}>('SELECT pg_catalog.pg_is_in_recovery() AS recovery');
				expect(
					standbyState.rows[0]?.recovery,
					'the topology must still be a physical streaming standby',
				).toBe(true);
				await expectReadOnlyCommandOutcomes(
					topology.standbyPool,
					standbyRun,
					schema,
				);
			} finally {
				await topology.stop();
			}

			const pool = new pg.Pool({
				connectionString: process.env.DATABASE_URL,
				max: 1,
			});
			const sessionSchema = unique('read_only_session');
			try {
				await pool.query(`CREATE SCHEMA ${quoteIdent(sessionSchema)}`);
				await pool.query(
					`CREATE TYPE ${quoteIdent(sessionSchema)}.${quoteIdent('status')} AS ENUM ('active')`,
				);
				await runPgReinitializePreflight({
					pool,
					schemas: [sessionSchema],
					declarations: { version: 1, digest: 'ordinary', declarations: [] },
					writeAdoptionFile: async () => {},
				});
				const sessionRun = await planEnumAdd(pool, sessionSchema);
				const client = await pool.connect();
				try {
					await client.query('SET default_transaction_read_only = on');
				} finally {
					client.release();
				}
				await expectReadOnlyCommandOutcomes(pool, sessionRun, sessionSchema);
			} finally {
				await pool
					.query(`DROP SCHEMA IF EXISTS ${quoteIdent(sessionSchema)} CASCADE`)
					.catch(() => undefined);
				await pool.end();
			}
		}, 90_000);
	},
);
