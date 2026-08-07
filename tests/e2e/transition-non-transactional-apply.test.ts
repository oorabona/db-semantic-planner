import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import type { ModelIR } from '@dbsp/core';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
	exitCodeForApplyOutcome,
	runApply,
} from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { runRecover } from '../../packages/cli/src/commands/recover.js';
import {
	type CheckpointChild,
	describeWithE2eCapabilities,
	spawnCheckpointChild,
} from './harness/index.js';
import { createSchema, getTestPool } from './testkit/index.js';

const indexName = 'idx_users_email';
const POLL_INTERVAL_MS = 100;
const WAIT_TIMEOUT_MS = 45_000;
const CHILD_TERM_TIMEOUT_MS = 1_500;
// Worst case: four sequential 45 s waits (checkpoints, witness/index polling,
// child exit, and final catalog polling) plus one minute for setup and cleanup.
const SCENARIO_TIMEOUT_MS = 4 * WAIT_TIMEOUT_MS + 60_000;

interface ManagedResource {
	readonly dispose: () => Promise<void>;
}

function quoteIdent(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

function testSchemaName(label: string): string {
	return `transition_non_transactional_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function waitFor<T>(
	label: string,
	promise: Promise<T>,
	timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => {
			timeout = setTimeout(
				() =>
					reject(
						new Error(
							`timed out waiting for ${label}; the operation may still be running`,
						),
					),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
}

function waitForCheckpoint(
	child: CheckpointChild,
	checkpoint: string,
): Promise<void> {
	return waitFor(
		`checkpoint "${checkpoint}"`,
		child.waitForCheckpoint(checkpoint),
		WAIT_TIMEOUT_MS,
	);
}

async function pollUntil<T>(
	label: string,
	read: () => Promise<T>,
	matched: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`timed out waiting for ${label}`);
		const value = await waitFor(label, read(), remaining);
		if (matched(value)) return value;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await waitFor(
			`the next ${label} poll`,
			new Promise<void>((resolvePoll) => {
				setTimeout(resolvePoll, POLL_INTERVAL_MS);
			}),
			deadline - Date.now(),
		);
	}
}

class ResourceStack {
	readonly #resources: Array<{
		readonly name: string;
		readonly dispose: () => Promise<void>;
	}> = [];

	register(name: string, dispose: () => Promise<void>): ManagedResource {
		let disposed = false;
		let disposing: Promise<void> | undefined;
		const disposeOnce = async (): Promise<void> => {
			if (disposed) return;
			if (disposing !== undefined) return disposing;
			disposing = dispose().then(
				() => {
					disposed = true;
				},
				(error: unknown) => {
					throw error;
				},
			);
			try {
				await disposing;
			} finally {
				if (!disposed) disposing = undefined;
			}
		};
		this.#resources.push({ name, dispose: disposeOnce });
		return { dispose: disposeOnce };
	}

	async dispose(): Promise<Error | undefined> {
		const failures: Error[] = [];
		// Each registered disposer owns a separate child process, PostgreSQL backend,
		// client connection, metadata rows, or schema. A failed bounded disposer is
		// recorded, but it must not prevent attempts to clean those independent
		// resources; client/session disposers destroy their connection before schema
		// cleanup can run.
		for (const resource of [...this.#resources].reverse()) {
			try {
				await resource.dispose();
			} catch (error) {
				failures.push(
					new Error(
						`failed to dispose ${resource.name}: ${errorDetail(error)}; resource remains pending`,
					),
				);
			}
		}
		if (failures.length === 0) return undefined;
		return new AggregateError(failures, 'non-transactional E2E cleanup failed');
	}
}
async function disposeChild(child: CheckpointChild): Promise<void> {
	try {
		await waitFor(
			'checkpoint child exit after SIGTERM',
			child.terminate('SIGTERM'),
			CHILD_TERM_TIMEOUT_MS,
		);
	} catch (error) {
		if (!String(error).includes('timed out')) throw error;
		await waitFor(
			'checkpoint child exit after SIGKILL',
			child.terminate('SIGKILL'),
			CHILD_TERM_TIMEOUT_MS,
		);
	}
}

interface BackendIdentity {
	readonly pid: number;
	readonly backendStart: string;
}

async function terminateBackend(backend: BackendIdentity): Promise<void> {
	const pool = await getTestPool();
	const terminated = await waitFor(
		`termination of PostgreSQL backend ${backend.pid}`,
		pool.query<{ terminated: boolean }>(
			'SELECT pg_catalog.pg_terminate_backend(activity.pid, $3::bigint) AS terminated ' +
				'FROM pg_catalog.pg_stat_activity activity ' +
				'WHERE activity.pid = $1 AND activity.backend_start = $2::timestamptz ' +
				"AND activity.datname = current_database() AND activity.backend_type = 'client backend'",
			[backend.pid, backend.backendStart, CHILD_TERM_TIMEOUT_MS],
		),
		CHILD_TERM_TIMEOUT_MS,
	);
	if (terminated.rows[0]?.terminated === true) return;
	const stillActive = await waitFor(
		`PostgreSQL backend ${backend.pid} activity check`,
		pool.query<{ active: boolean }>(
			"SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND datname = current_database() AND backend_type = 'client backend') AS active",
			[backend.pid, backend.backendStart],
		),
		CHILD_TERM_TIMEOUT_MS,
	);
	if (stillActive.rows[0]?.active === true) {
		throw new Error(`pg_terminate_backend(${backend.pid}) returned false`);
	}
}

async function terminateSchemaLockBackends(schema: string): Promise<void> {
	const pool = await getTestPool();
	const candidates = await pool.query<BackendIdentity>(
		'WITH schema_relations AS (' +
			'SELECT relation.oid FROM pg_catalog.pg_class relation ' +
			'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace ' +
			'WHERE namespace.nspname = $1' +
			') SELECT DISTINCT activity.pid, activity.backend_start::text AS "backendStart" FROM pg_catalog.pg_locks lock ' +
			'JOIN schema_relations ON schema_relations.oid = lock.relation ' +
			'JOIN pg_catalog.pg_stat_activity activity ON activity.pid = lock.pid ' +
			'WHERE lock.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) ' +
			"AND activity.datname = current_database() AND activity.backend_type = 'client backend' " +
			'AND activity.pid <> pg_catalog.pg_backend_pid()',
		[schema],
	);
	for (const backend of candidates.rows) await terminateBackend(backend);
}

async function dropSchemaWithTimeout(schema: string): Promise<void> {
	const pool = await getTestPool();
	const client = await pool.connect();
	let released = false;
	try {
		await client.query('BEGIN');
		await client.query("SET LOCAL lock_timeout = '750ms'");
		await client.query("SET LOCAL statement_timeout = '2s'");
		await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
		await client.query('COMMIT');
	} catch (error) {
		// Closing the pinned session aborts any open transaction without an
		// unbounded rollback await.
		client.release(true);
		released = true;
		throw error;
	} finally {
		if (!released) client.release(true);
	}
}

async function schemaBlockingDiagnostics(schema: string): Promise<string> {
	const pool = await getTestPool();
	const result = await pool.query<{
		pid: number;
		state: string | null;
		query: string;
		blocking_pids: readonly number[];
	}>(
		'WITH schema_relations AS (' +
			'SELECT relation.oid FROM pg_catalog.pg_class relation ' +
			'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace ' +
			'WHERE namespace.nspname = $1' +
			') SELECT DISTINCT activity.pid, activity.state, left(activity.query, 500) AS query, ' +
			'pg_catalog.pg_blocking_pids(activity.pid) AS blocking_pids ' +
			'FROM pg_catalog.pg_locks lock JOIN schema_relations ON schema_relations.oid = lock.relation ' +
			'JOIN pg_catalog.pg_stat_activity activity ON activity.pid = lock.pid ' +
			'WHERE lock.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) ' +
			'AND activity.datname = current_database() AND activity.pid <> pg_catalog.pg_backend_pid()',
		[schema],
	);
	return JSON.stringify(result.rows);
}

async function cleanupSchema(schema: string): Promise<void> {
	await terminateSchemaLockBackends(schema);
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			await dropSchemaWithTimeout(schema);
			return;
		} catch (error) {
			lastError = error;
			if (attempt === 0) await terminateSchemaLockBackends(schema);
		}
	}
	throw new Error(
		`failed to drop schema ${schema}: ${errorDetail(lastError)}; pg_blocking_pids diagnostics: ${await schemaBlockingDiagnostics(schema)}`,
	);
}

class Scenario {
	readonly schema: string;
	readonly #resources = new ResourceStack();
	readonly #runIds = new Set<string>();

	private constructor(schema: string) {
		this.schema = schema;
	}

	static async create(label: string): Promise<Scenario> {
		const scenario = new Scenario(testSchemaName(label));
		await createSchema(scenario.schema);
		scenario.#resources.register(`schema ${scenario.schema}`, () =>
			cleanupSchema(scenario.schema),
		);
		scenario.#resources.register(
			'dbsp_meta rows for observed runs',
			async () => {
				const pool = await getTestPool();
				for (const runId of scenario.#runIds) {
					await pool.query(
						'DELETE FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
						[runId],
					);
					await pool.query(
						'DELETE FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1',
						[runId],
					);
					await pool.query(
						'DELETE FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
						[runId],
					);
					await pool.query(
						'DELETE FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
						[runId],
					);
				}
			},
		);
		return scenario;
	}

	async dispose(): Promise<Error | undefined> {
		return this.#resources.dispose();
	}

	async startSnapshotBlocker(): Promise<{
		readonly client: PoolClient;
		readonly resource: ManagedResource;
	}> {
		const pool = await getTestPool();
		const client = await pool.connect();
		const resource = this.#resources.register(
			'snapshot blocker session',
			async () => {
				// Destroying this owned session is a bounded rollback and avoids leaving
				// a lock-bearing query alive if a cleanup await is interrupted.
				client.release(true);
			},
		);
		await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
		await client.query(
			`SELECT count(*) FROM ${quoteIdent(this.schema)}.${quoteIdent('users')}`,
		);
		return { client, resource };
	}

	async acquireWriter(): Promise<{
		readonly client: PoolClient;
		readonly resource: ManagedResource;
	}> {
		const pool = await getTestPool();
		const client = await pool.connect();
		const resource = this.#resources.register('writer client', async () => {
			client.release(true);
		});
		return { client, resource };
	}

	spawnApplyChild(
		plan: Awaited<ReturnType<typeof planConcurrentIndex>>,
	): CheckpointChild {
		this.observeRunId(plan.runId);
		const child = spawnCheckpointChild(
			fileURLToPath(
				new URL(
					'./transition-non-transactional-apply-child.ts',
					import.meta.url,
				),
			),
			{
				args: [plan.runId, plan.planDigest, this.schema],
				env: {
					...process.env,
					DATABASE_URL: plan.db,
					DBSP_E2E_NON_TRANSACTIONAL_ACCEPTS: plan.plan.assumptions
						.map((assumption) => assumption.class)
						.join(','),
				},
			},
		);
		this.#resources.register('checkpoint child', () => disposeChild(child));
		return child;
	}

	registerBackend(backend: BackendIdentity): ManagedResource {
		return this.#resources.register(`PostgreSQL backend ${backend.pid}`, () =>
			terminateBackend(backend),
		);
	}

	observeRunId(runId: string): void {
		this.#runIds.add(runId);
	}
}

async function inScenario<T>(
	label: string,
	body: (scenario: Scenario) => Promise<T>,
): Promise<T> {
	let scenario: Scenario | undefined;
	let primaryError: unknown;
	let cleanupError: Error | undefined;
	let result: T | undefined;
	try {
		scenario = await Scenario.create(label);
		result = await body(scenario);
	} catch (error) {
		primaryError = error;
	} finally {
		cleanupError = await scenario?.dispose();
	}
	if (primaryError !== undefined && cleanupError !== undefined) {
		throw new AggregateError(
			[asError(primaryError), cleanupError],
			'non-transactional E2E scenario and cleanup both failed',
		);
	}
	if (primaryError !== undefined) throw primaryError;
	if (cleanupError !== undefined) throw cleanupError;
	return result as T;
}

function desiredWithConcurrentUniqueIndex(current: ModelIR): ModelIR {
	const users = current.getTable('users');
	if (!users) throw new Error('expected users table to be introspected');
	const tables = new Map(current.tables);
	tables.set('users', {
		...users,
		indexes: [
			...users.indexes,
			{ name: indexName, columns: ['email'], unique: true },
		],
	});
	return {
		...current,
		tables,
		getTable: (name) => tables.get(name),
	};
}

async function createUsers(schema: string, count: number): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('users')} (id integer PRIMARY KEY, email text NOT NULL)`,
	);
	await pool.query(
		`INSERT INTO ${quoteIdent(schema)}.${quoteIdent('users')} (id, email) SELECT series, 'user-' || series || '@example.com' FROM generate_series(1, $1) AS series`,
		[count],
	);
}

async function indexCatalog(schema: string) {
	const pool = await getTestPool();
	return pool.query<{ indisvalid: boolean; indisready: boolean }>(
		'SELECT ix.indisvalid, ix.indisready FROM pg_catalog.pg_class i ' +
			'JOIN pg_catalog.pg_namespace n ON n.oid = i.relnamespace ' +
			'JOIN pg_catalog.pg_index ix ON ix.indexrelid = i.oid ' +
			'WHERE n.nspname = $1 AND i.relname = $2',
		[schema, indexName],
	);
}

async function waitForIndex(
	schema: string,
	predicate: (row: {
		readonly indisvalid: boolean;
		readonly indisready: boolean;
	}) => boolean,
): Promise<void> {
	await pollUntil(
		'concurrent index catalog state',
		async () => (await indexCatalog(schema)).rows[0],
		(row) => row !== undefined && predicate(row),
	);
}

async function waitForWitnessPhase(schema: string): Promise<void> {
	const pool = await getTestPool();
	await pollUntil(
		'concurrent index old-snapshot witness phase',
		async () =>
			pool.query<{ phase: string }>(
				'SELECT progress.phase FROM pg_catalog.pg_stat_progress_create_index progress ' +
					'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
					'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
					'WHERE namespace.nspname = $1 AND index_relation.relname = $2',
				[schema, indexName],
			),
		(result) => result.rows[0]?.phase === 'waiting for old snapshots',
	);
}

async function concurrentIndexBackend(
	schema: string,
): Promise<BackendIdentity> {
	const pool = await getTestPool();
	const backend = await pollUntil(
		'concurrent index backend identity',
		async () => {
			const result = await pool.query<BackendIdentity>(
				'SELECT progress.pid, activity.backend_start::text AS "backendStart" FROM pg_catalog.pg_stat_progress_create_index progress ' +
					'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
					'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
					'JOIN pg_catalog.pg_stat_activity activity ON activity.pid = progress.pid ' +
					'WHERE namespace.nspname = $1 AND index_relation.relname = $2',
				[schema, indexName],
			);
			return result.rows[0];
		},
		(candidate) => candidate !== undefined,
	);
	if (backend === undefined) {
		throw new Error('concurrent index backend was not observable');
	}
	return backend;
}

async function planConcurrentIndex(schema: string, scenario?: Scenario) {
	const pool = await getTestPool();
	const db = process.env.DATABASE_URL;
	if (!db) throw new Error('e2e DATABASE_URL is required');
	const adapter = createPgsqlAdapter(pool, { schemaName: schema });
	const current = await adapter.introspect({ schema });
	const desired = desiredWithConcurrentUniqueIndex(current);
	const planned = await runPlan(
		{ db, schemaFile: 'transition-non-transactional-e2e', schema },
		{
			createDbConnection: async () => ({
				pool,
				release: async () => undefined,
			}),
			loadSchema: async () => ({
				model: desired,
				definition: {},
				tableNames: ['users'],
			}),
		},
	);
	expect(planned.proveKind).toBe('proven');
	expect(planned.plan?.assumptions).toContainEqual(
		expect.objectContaining({ class: 'non-transactional-segment' }),
	);
	if (!planned.runId || !planned.planDigest || !planned.plan) {
		throw new Error('expected a persisted concurrent-index plan');
	}
	scenario?.observeRunId(planned.runId);
	return {
		db,
		runId: planned.runId,
		planDigest: planned.planDigest,
		plan: planned.plan,
	};
}

describe('SC-03 #481 non-transactional durable admission', () => {
	it('refuses an unaccepted segment before any step-attempt event', async () => {
		await inScenario('sc03', async (scenario) => {
			await createUsers(scenario.schema, 10);
			const plan = await planConcurrentIndex(scenario.schema, scenario);
			const pool = await getTestPool();
			const result = await runApply(
				plan.runId,
				{
					db: plan.db,
					planDigest: plan.planDigest,
					accept: plan.plan.assumptions
						.filter(
							(assumption) => assumption.class !== 'non-transactional-segment',
						)
						.map((assumption) => assumption.class),
				},
				pool,
			);
			expect(result.outcome).toBe('transactional-only-refusal');
			const journal = await pool.query<{ count: string }>(
				'SELECT count(*) FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1',
				[plan.runId],
			);
			expect(journal.rows[0]?.count).toBe('0');
		});
	});
});

describeWithE2eCapabilities(
	['backend-termination'],
	'SC-02, SC-04, SC-05 and SC-06 #481 non-transactional recovery',
	() => {
		it('SC-02: accepts a 200k-row segment while a writer commits in its witnessed window', async () => {
			await inScenario('sc02', async (scenario) => {
				await createUsers(scenario.schema, 200_000);
				const plan = await planConcurrentIndex(scenario.schema, scenario);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await waitForCheckpoint(child, 'before-statement-sent');
				await child.acknowledge('before-statement-sent');
				await waitForCheckpoint(child, 'after-statement-sent');
				await waitForWitnessPhase(scenario.schema);
				scenario.registerBackend(await concurrentIndexBackend(scenario.schema));
				const writer = await scenario.acquireWriter();
				await writer.client.query(
					`INSERT INTO ${quoteIdent(scenario.schema)}.${quoteIdent('users')} (id, email) VALUES (200001, 'writer@example.com')`,
				);
				await writer.resource.dispose();
				await child.acknowledge('after-statement-sent');
				await blocker.resource.dispose();
				const childExit = await waitFor(
					'successful apply child exit',
					child.exited,
				);
				expect(childExit).toMatchObject({
					code: 0,
					signal: null,
				});
				// The child maps the durable outcome it observed to the apply contract's
				// exact exit code, so this is evidence of "completed", not merely a
				// process that happened to exit cleanly.
				expect(childExit.code).toBe(exitCodeForApplyOutcome('completed'));
				await waitForIndex(
					scenario.schema,
					(row) => row.indisvalid && row.indisready,
				);
				const pool = await getTestPool();
				expect(
					(
						await pool.query<{ email: string }>(
							`SELECT email FROM ${quoteIdent(scenario.schema)}.${quoteIdent('users')} WHERE id = 200001`,
						)
					).rows,
				).toEqual([{ email: 'writer@example.com' }]);
			});
		});

		it('SC-04: recovers a server-finished build after the client is killed after send', async () => {
			await inScenario('sc04', async (scenario) => {
				await createUsers(scenario.schema, 200_000);
				const plan = await planConcurrentIndex(scenario.schema, scenario);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await waitForCheckpoint(child, 'before-statement-sent');
				await child.acknowledge('before-statement-sent');
				await waitForCheckpoint(child, 'after-statement-sent');
				scenario.registerBackend(await concurrentIndexBackend(scenario.schema));
				expect(await child.kill('SIGKILL')).toMatchObject({
					signal: 'SIGKILL',
				});
				await blocker.resource.dispose();
				await waitForIndex(
					scenario.schema,
					(row) => row.indisvalid && row.indisready,
				);
				const recovered = await runRecover(plan.runId, {
					db: plan.db,
					planDigest: plan.planDigest,
				});
				expect(recovered.outcome).toBe('completed');
			});
		});

		it('SC-05: classifies a server-aborted invalid index as recovery-unknown-step-result', async () => {
			await inScenario('sc05', async (scenario) => {
				await createUsers(scenario.schema, 200_000);
				const plan = await planConcurrentIndex(scenario.schema, scenario);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await waitForCheckpoint(child, 'before-statement-sent');
				await child.acknowledge('before-statement-sent');
				await waitForCheckpoint(child, 'after-statement-sent');
				await waitForIndex(scenario.schema, (row) => !row.indisvalid);
				const backend = scenario.registerBackend(
					await concurrentIndexBackend(scenario.schema),
				);
				await child.kill('SIGKILL');
				await backend.dispose();
				await blocker.resource.dispose();
				await waitForIndex(scenario.schema, (row) => !row.indisvalid);
				const recovered = await runRecover(plan.runId, {
					db: plan.db,
					planDigest: plan.planDigest,
				});
				expect(recovered.outcome).toBe('recovery-unknown-step-result');
			});
		});

		it('SC-06: recovers a kill before send as recovery-resume-required', async () => {
			await inScenario('sc06', async (scenario) => {
				await createUsers(scenario.schema, 10);
				const plan = await planConcurrentIndex(scenario.schema, scenario);
				const child = scenario.spawnApplyChild(plan);
				await waitForCheckpoint(child, 'before-statement-sent');
				expect(await child.kill('SIGKILL')).toMatchObject({
					signal: 'SIGKILL',
				});
				expect((await indexCatalog(scenario.schema)).rows).toEqual([]);
				const recovered = await runRecover(plan.runId, {
					db: plan.db,
					planDigest: plan.planDigest,
				});
				expect(recovered.outcome).toBe('recovery-resume-required');
			});
		});
	},
	SCENARIO_TIMEOUT_MS,
);
