import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createPgsqlAdapter } from '@dbsp/adapter-pgsql';
import type { ModelIR } from '@dbsp/core';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { runRecover } from '../../packages/cli/src/commands/recover.js';
import {
	CHECKPOINT_ACK,
	CHECKPOINT_REACHED,
	describeWithE2eCapabilities,
} from './harness/index.js';
import { createSchema, getTestPool } from './testkit/index.js';

const indexName = 'idx_users_email';
const POLL_INTERVAL_MS = 20;
const WAIT_TIMEOUT_MS = 45_000;
const CLEANUP_TIMEOUT_MS = 4_000;
const CHILD_TERM_TIMEOUT_MS = 1_500;

interface CheckpointChildExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

interface ScenarioChild {
	readonly process: ChildProcess;
	readonly exited: Promise<CheckpointChildExit>;
	waitForCheckpoint(expected: string): Promise<void>;
	acknowledge(checkpoint: string): void;
	killNow(signal: NodeJS.Signals): Promise<CheckpointChildExit>;
}

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
				() => reject(new Error(`timed out waiting for ${label}`)),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timeout !== undefined) clearTimeout(timeout);
	});
}

async function pollUntil<T>(
	label: string,
	read: () => Promise<T>,
	matched: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		const value = await read();
		if (matched(value)) return value;
		if (Date.now() >= deadline) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await new Promise<void>((resolvePoll) => {
			setTimeout(resolvePoll, POLL_INTERVAL_MS);
		});
	}
}

class ResourceStack {
	readonly #resources: Array<{
		readonly name: string;
		readonly dispose: () => Promise<void>;
	}> = [];

	register(name: string, dispose: () => Promise<void>): ManagedResource {
		let disposed = false;
		const disposeOnce = async (): Promise<void> => {
			if (disposed) return;
			disposed = true;
			await dispose();
		};
		this.#resources.push({ name, dispose: disposeOnce });
		return { dispose: disposeOnce };
	}

	async dispose(): Promise<Error | undefined> {
		const failures: Error[] = [];
		for (const resource of [...this.#resources].reverse()) {
			try {
				await waitFor(
					`disposal of ${resource.name}`,
					resource.dispose(),
					CLEANUP_TIMEOUT_MS,
				);
			} catch (error) {
				failures.push(
					new Error(
						`failed to dispose ${resource.name}: ${errorDetail(error)}`,
					),
				);
			}
		}
		if (failures.length === 0) return undefined;
		return new AggregateError(failures, 'non-transactional E2E cleanup failed');
	}
}

function isCheckpointReached(
	message: unknown,
): message is { checkpoint: string } {
	return (
		typeof message === 'object' &&
		message !== null &&
		(message as { type?: unknown }).type === CHECKPOINT_REACHED &&
		typeof (message as { checkpoint?: unknown }).checkpoint === 'string'
	);
}

function spawnScenarioChild(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): ScenarioChild {
	const child = fork(
		resolve(
			new URL('./transition-non-transactional-apply-child.ts', import.meta.url)
				.pathname,
		),
		[...args],
		{
			detached: true,
			env,
			execArgv: ['--import', 'tsx'],
			stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
		},
	);
	let activeCheckpoint: string | undefined;
	let waiter:
		| {
				readonly expected: string;
				readonly resolve: () => void;
				readonly reject: (error: Error) => void;
		  }
		| undefined;
	let resolveExit: ((exit: CheckpointChildExit) => void) | undefined;
	const exited = new Promise<CheckpointChildExit>((resolve) => {
		resolveExit = resolve;
	});

	child.on('message', (message: unknown) => {
		if (!isCheckpointReached(message)) return;
		if (activeCheckpoint !== undefined) {
			waiter?.reject(
				new Error(
					`child reached "${message.checkpoint}" while blocked at "${activeCheckpoint}"`,
				),
			);
			return;
		}
		activeCheckpoint = message.checkpoint;
		if (waiter === undefined) return;
		if (waiter.expected === activeCheckpoint) waiter.resolve();
		else {
			waiter.reject(
				new Error(
					`expected child checkpoint "${waiter.expected}", received "${activeCheckpoint}"`,
				),
			);
		}
		waiter = undefined;
	});
	child.once('exit', (code, signal) => {
		waiter?.reject(new Error(`child exited before "${waiter.expected}"`));
		waiter = undefined;
		resolveExit?.({ code, signal });
	});

	const waitForCheckpoint = async (expected: string): Promise<void> => {
		if (activeCheckpoint === expected) return;
		if (activeCheckpoint !== undefined) {
			throw new Error(
				`expected child checkpoint "${expected}", found "${activeCheckpoint}"`,
			);
		}
		if (waiter !== undefined) {
			throw new Error(
				`already waiting for child checkpoint "${waiter.expected}"`,
			);
		}
		await waitFor(
			`child checkpoint "${expected}"`,
			new Promise<void>((resolveWait, rejectWait) => {
				waiter = { expected, resolve: resolveWait, reject: rejectWait };
			}),
		);
	};

	const acknowledge = (checkpoint: string): void => {
		if (activeCheckpoint !== checkpoint) {
			throw new Error(
				`cannot acknowledge "${checkpoint}" while child is at "${activeCheckpoint ?? 'no checkpoint'}"`,
			);
		}
		child.send({ type: CHECKPOINT_ACK, checkpoint });
		activeCheckpoint = undefined;
	};

	const killNow = async (
		signal: NodeJS.Signals,
	): Promise<CheckpointChildExit> => {
		if (child.pid !== undefined && child.exitCode === null) {
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
			}
		}
		return waitFor(
			`child process group exit after ${signal}`,
			exited,
			CHILD_TERM_TIMEOUT_MS,
		);
	};

	return { process: child, exited, waitForCheckpoint, acknowledge, killNow };
}

async function disposeChild(child: ScenarioChild): Promise<void> {
	if (child.process.exitCode !== null) return;
	try {
		await child.killNow('SIGTERM');
	} catch (error) {
		if (!String(error).includes('timed out')) throw error;
		await child.killNow('SIGKILL');
	}
}

async function terminateBackend(pid: number): Promise<void> {
	const pool = await getTestPool();
	const terminated = await pool.query<{ terminated: boolean }>(
		'SELECT pg_catalog.pg_terminate_backend($1::integer, $2::bigint) AS terminated',
		[pid, CHILD_TERM_TIMEOUT_MS],
	);
	if (terminated.rows[0]?.terminated === true) return;
	const stillActive = await pool.query<{ active: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND datname = current_database()) AS active',
		[pid],
	);
	if (stillActive.rows[0]?.active === true) {
		throw new Error(`pg_terminate_backend(${pid}) returned false`);
	}
}

async function terminateSchemaLockBackends(schema: string): Promise<void> {
	const pool = await getTestPool();
	const candidates = await pool.query<{ pid: number }>(
		'WITH schema_relations AS (' +
			'SELECT relation.oid FROM pg_catalog.pg_class relation ' +
			'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace ' +
			'WHERE namespace.nspname = $1' +
			') SELECT DISTINCT activity.pid FROM pg_catalog.pg_locks lock ' +
			'JOIN schema_relations ON schema_relations.oid = lock.relation ' +
			'JOIN pg_catalog.pg_stat_activity activity ON activity.pid = lock.pid ' +
			'WHERE lock.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) ' +
			"AND activity.datname = current_database() AND activity.backend_type = 'client backend' " +
			'AND activity.pid <> pg_catalog.pg_backend_pid()',
		[schema],
	);
	for (const { pid } of candidates.rows) await terminateBackend(pid);
}

async function dropSchemaWithTimeout(schema: string): Promise<void> {
	const pool = await getTestPool();
	const resources = new ResourceStack();
	let client: PoolClient | undefined;
	let primaryError: unknown;
	let cleanupError: Error | undefined;
	try {
		client = await pool.connect();
		resources.register('short-timeout schema-drop client', async () => {
			client?.release();
		});
		await client.query('BEGIN');
		await client.query("SET LOCAL lock_timeout = '750ms'");
		await client.query("SET LOCAL statement_timeout = '2s'");
		await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
		await client.query('COMMIT');
	} catch (error) {
		primaryError = error;
		await client?.query('ROLLBACK').catch(() => undefined);
	} finally {
		cleanupError = await resources.dispose();
	}
	if (primaryError !== undefined) throw primaryError;
	if (cleanupError !== undefined) throw cleanupError;
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

	private constructor(schema: string) {
		this.schema = schema;
	}

	static async create(label: string): Promise<Scenario> {
		const scenario = new Scenario(testSchemaName(label));
		await createSchema(scenario.schema);
		scenario.#resources.register(`schema ${scenario.schema}`, () =>
			cleanupSchema(scenario.schema),
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
				await client.query('ROLLBACK').catch(() => undefined);
				client.release();
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
			client.release();
		});
		return { client, resource };
	}

	spawnApplyChild(
		plan: Awaited<ReturnType<typeof planConcurrentIndex>>,
	): ScenarioChild {
		const child = spawnScenarioChild(
			[plan.runId, plan.planDigest, this.schema],
			{
				...process.env,
				DATABASE_URL: plan.db,
				DBSP_E2E_NON_TRANSACTIONAL_ACCEPTS: plan.plan.assumptions
					.map((assumption) => assumption.class)
					.join(','),
			},
		);
		this.#resources.register('checkpoint child process group', () =>
			disposeChild(child),
		);
		return child;
	}

	registerBackend(pid: number): ManagedResource {
		return this.#resources.register(`PostgreSQL backend ${pid}`, () =>
			terminateBackend(pid),
		);
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

async function concurrentIndexBackendPid(schema: string): Promise<number> {
	const pool = await getTestPool();
	const pid = await pollUntil(
		'concurrent index backend PID',
		async () => {
			const result = await pool.query<{ pid: number }>(
				'SELECT progress.pid FROM pg_catalog.pg_stat_progress_create_index progress ' +
					'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
					'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
					'WHERE namespace.nspname = $1 AND index_relation.relname = $2',
				[schema, indexName],
			);
			return result.rows[0]?.pid;
		},
		(candidate) => candidate !== undefined,
	);
	if (pid === undefined) {
		throw new Error('concurrent index backend was not observable');
	}
	return pid;
}

async function planConcurrentIndex(schema: string) {
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
			const plan = await planConcurrentIndex(scenario.schema);
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
	[],
	'SC-02, SC-04, SC-05 and SC-06 #481 non-transactional recovery',
	() => {
		it('SC-02: accepts a 200k-row segment while a writer commits in its witnessed window', async () => {
			await inScenario('sc02', async (scenario) => {
				await createUsers(scenario.schema, 200_000);
				const plan = await planConcurrentIndex(scenario.schema);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await child.waitForCheckpoint('before-statement-sent');
				child.acknowledge('before-statement-sent');
				await child.waitForCheckpoint('after-statement-sent');
				await waitForWitnessPhase(scenario.schema);
				scenario.registerBackend(
					await concurrentIndexBackendPid(scenario.schema),
				);
				const writer = await scenario.acquireWriter();
				await writer.client.query(
					`INSERT INTO ${quoteIdent(scenario.schema)}.${quoteIdent('users')} (id, email) VALUES (200001, 'writer@example.com')`,
				);
				await writer.resource.dispose();
				child.acknowledge('after-statement-sent');
				await blocker.resource.dispose();
				expect(
					await waitFor('successful apply child exit', child.exited),
				).toMatchObject({
					code: 0,
					signal: null,
				});
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
				const plan = await planConcurrentIndex(scenario.schema);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await child.waitForCheckpoint('before-statement-sent');
				child.acknowledge('before-statement-sent');
				await child.waitForCheckpoint('after-statement-sent');
				scenario.registerBackend(
					await concurrentIndexBackendPid(scenario.schema),
				);
				expect(await child.killNow('SIGKILL')).toMatchObject({
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
				const plan = await planConcurrentIndex(scenario.schema);
				const blocker = await scenario.startSnapshotBlocker();
				const child = scenario.spawnApplyChild(plan);
				await child.waitForCheckpoint('before-statement-sent');
				child.acknowledge('before-statement-sent');
				await child.waitForCheckpoint('after-statement-sent');
				await waitForIndex(scenario.schema, (row) => !row.indisvalid);
				const backend = scenario.registerBackend(
					await concurrentIndexBackendPid(scenario.schema),
				);
				await child.killNow('SIGKILL');
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
				const plan = await planConcurrentIndex(scenario.schema);
				const child = scenario.spawnApplyChild(plan);
				await child.waitForCheckpoint('before-statement-sent');
				expect(await child.killNow('SIGKILL')).toMatchObject({
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
);
