import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	createPgsqlAdapter,
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	executePgAdmittedOperation,
	PG_LEDGER_SHAPE_VERSION,
	readPgLedgerReservationsForExecution,
	readTransitionJournal,
	withPgTransitionRunLock,
} from '@dbsp/adapter-pgsql';
import {
	lockPgJournalRun,
	openPgOutcomeClaim,
} from '@dbsp/adapter-pgsql/internal';
import {
	acquireExclusiveTransitionLease,
	type ModelIR,
	outcomeClaimEventId,
	outcomeClaimId,
	planOperationSession,
	transitionPlanDigest,
	validateNormalizedManagedStepManifest,
} from '@dbsp/core';
import { mintDurablyLoadedRun } from '@dbsp/core/internal';
import type {
	LedgerReservationRow,
	ManagedStepClaimMaterial,
	OutcomeClaimPlan,
} from '@dbsp/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApply } from '../../packages/cli/src/commands/apply.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { runReconcile } from '../../packages/cli/src/commands/reconcile.js';
import { type CheckpointChild, spawnCheckpointChild } from './harness/index.js';
import { createSchema, dropSchema, getTestPool } from './testkit/index.js';
import {
	quoteIdent,
	resetDbspMeta,
	runPreflight,
} from './transition-reinitialize-preflight-testkit.js';

const WAIT_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 100;
const CHILD_TERM_TIMEOUT_MS = 1_500;
const schemas: string[] = [];

interface PlannedRun {
	readonly db: string;
	readonly runId: string;
	readonly planDigest: string;
	readonly plan: NonNullable<Awaited<ReturnType<typeof runPlan>>['plan']>;
}

interface LedgerMember {
	readonly eventId: string;
	readonly eventKind: string;
	readonly predecessor: string | null;
	readonly observedDigest: string | null;
}

interface BackendIdentity {
	readonly pid: number;
	readonly backendStart: string;
}

function testSchema(label: string): string {
	return `managed_outcome_wiring_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function waitFor<T>(label: string, promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out waiting for ${label}`)),
				WAIT_TIMEOUT_MS,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function pollUntil<T>(
	label: string,
	read: () => Promise<T>,
	matches: (value: T) => boolean,
): Promise<T> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error(`timed out waiting for ${label}`);
		const value = await waitFor(label, read());
		if (matches(value)) return value;
		await waitFor(
			`the next ${label} poll`,
			new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
		);
	}
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

function desiredWithConcurrentIndex(
	current: ModelIR,
	indexName: string,
): ModelIR {
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
	return { ...current, tables, getTable: (name) => tables.get(name) };
}

function onlyManagedClaim(plan: PlannedRun['plan']): ManagedStepClaimMaterial {
	const claims = plan.steps
		.map((step) => step.managedClaim)
		.filter((claim): claim is ManagedStepClaimMaterial => claim !== undefined);
	expect(claims).toHaveLength(1);
	const claim = claims[0];
	if (!claim) throw new Error('expected exactly one managed claim');
	return claim;
}

/** Materialize the plan-local claim position for one durable execution scope. */
function executionClaim(
	claim: ManagedStepClaimMaterial,
	executionId: string,
): OutcomeClaimPlan {
	const claimId = outcomeClaimId(
		executionId,
		claim.plannedClaimKey,
		claim.address,
	);
	return {
		...claim,
		claimId,
		claimSpecies: 'sql-bearing',
		executionId,
		claimGroupId: claimId,
		rootClaimId: claimId,
	};
}

function reservation(
	claim: OutcomeClaimPlan,
	runId: string,
): LedgerReservationRow {
	if (claim.address.scope === 'database') {
		return {
			address: claim.address,
			claimKind: claim.claimKind,
			executionId: runId,
			rootClaimId: claim.claimId,
			homeLedger: { scope: 'database' },
		};
	}
	if (!claim.address.schema)
		throw new Error(`managed schema claim ${claim.claimId} has no schema`);
	return {
		address: claim.address,
		claimKind: claim.claimKind,
		executionId: runId,
		rootClaimId: claim.claimId,
		homeLedger: { scope: 'schema', schema: claim.address.schema },
	};
}

/**
 * Re-enter a reviewed, persisted run at the admitted facade's observable
 * executing-to-send boundary.  This keeps the PID assertion on the actual
 * durable execution session without calling the removed raw runner.
 */
async function runPersistedNonTransactionalAtGate(input: {
	readonly pool: Awaited<ReturnType<typeof getTestPool>>;
	readonly planned: PlannedRun;
	readonly claim: OutcomeClaimPlan;
	readonly reservations: readonly LedgerReservationRow[];
	readonly onExecutingCommitted: (pid: number) => Promise<void>;
}) {
	// The checkpoint deliberately kills the run-lock connection. Mirror the old
	// direct-driver harness's error listener even though this re-entry reaches
	// that connection through the durable lock helper.
	const runLockPool = Object.create(input.pool) as typeof input.pool;
	runLockPool.connect = async () => {
		const client = await input.pool.connect();
		client.on('error', () => undefined);
		return client;
	};
	let operationResult:
		| Awaited<ReturnType<typeof executePgAdmittedOperation>>
		| undefined;
	try {
		const locked = await withPgTransitionRunLock(
			runLockPool,
			input.planned.runId,
			async (target) => {
				const lease = await acquireExclusiveTransitionLease(target);
				try {
					const executor = planOperationSession(lease.session);
					const persisted = await readTransitionJournal(
						executor,
						input.planned.runId,
						{ ensure: false },
					);
					const classification =
						input.claim.claimKind === 'retire-intent'
							? 'removal'
							: 'non-destructive';
					const manifest = validateNormalizedManagedStepManifest([
						{
							stepKey: input.claim.plannedClaimKey ?? input.claim.claimId,
							order: 0,
							segmentId: input.claim.claimId,
							dependencyOrder: [],
							address: input.claim.address as never,
							claimKind: input.claim.claimKind,
							plannedClaimKeys: [
								input.claim.plannedClaimKey ?? input.claim.claimId,
							],
							statementBundle: input.claim.statementBundle,
							classification,
							requiresVacancy: input.claim.requiresVacancy ?? false,
							replayPolicy:
								classification === 'removal' ? 'fresh-live-only' : 'recorded',
						},
					]);
					if (!manifest.ok)
						throw new Error(
							`persisted generator manifest is invalid: ${manifest.detail}`,
						);
					const planDigest = transitionPlanDigest(persisted.plan);
					if (
						planDigest !== persisted.run.planDigest ||
						planDigest !== input.planned.planDigest
					)
						throw new Error(
							'persisted generator plan digest does not match review',
						);
					operationResult = await executePgAdmittedOperation(executor, {
						run: lockPgJournalRun(mintDurablyLoadedRun(persisted.run)),
						approval: {
							approvals: input.planned.plan.assumptions.map((assumption) => ({
								class: assumption.class,
							})),
						},
						manifest: manifest.manifest,
						recomputedPlanDigest: planDigest,
						operation: {
							kind: 'single-outcome',
							request: {
								plan: input.claim,
								reservations: input.reservations,
								executingEventId: outcomeClaimEventId(
									input.claim.claimId,
									'executing',
								),
								resolution: {
									eventId: outcomeClaimEventId(input.claim.claimId, 'observed'),
									eventKind: 'observed',
								},
								vacancy: async () => ({ kind: 'vacant' }),
								onExecutingCommitted: async () => {
									const result = (await lease.session.query(
										'SELECT pg_backend_pid() AS pid',
									)) as { readonly rows: readonly { readonly pid?: number }[] };
									const pid = result.rows[0]?.pid;
									if (!pid)
										throw new Error(
											'executing gate session has no backend pid',
										);
									await input.onExecutingCommitted(pid);
								},
							},
						},
					});
					return operationResult;
				} finally {
					await lease.release();
				}
			},
		);
		if (locked.kind === 'busy') throw new Error('persisted run lock is busy');
		return locked.value;
	} catch (error) {
		if (
			operationResult?.kind === 'outcome-protocol-refused' &&
			errorDetail(error).startsWith(
				'PostgreSQL transition run lock cleanup failed:',
			)
		)
			return operationResult;
		throw error;
	}
}

async function provision(schema: string): Promise<void> {
	schemas.push(schema);
	await createSchema(schema);
	await runPreflight([schema]);
}

async function planEnumAdd(schema: string): Promise<PlannedRun> {
	const pool = await getTestPool();
	const db = process.env.DATABASE_URL;
	if (!db) throw new Error('DATABASE_URL is required for managed-outcome E2E');
	const planned = await runPlan(
		{ db, schemaFile: 'managed-outcome-wiring-enum.ts', schema },
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
	expect(planned.proveKind).toBe('proven');
	if (!planned.runId || !planned.planDigest || !planned.plan)
		throw new Error('expected a durable enum managed-outcome plan');
	return {
		db,
		runId: planned.runId,
		planDigest: planned.planDigest,
		plan: planned.plan,
	};
}

async function planConcurrentIndex(
	schema: string,
	indexName: string,
): Promise<PlannedRun> {
	const pool = await getTestPool();
	const db = process.env.DATABASE_URL;
	if (!db) throw new Error('DATABASE_URL is required for managed-outcome E2E');
	const adapter = createPgsqlAdapter(pool, { schemaName: schema });
	const current = await adapter.introspect({ schema });
	const planned = await runPlan(
		{ db, schemaFile: 'managed-outcome-wiring-index.ts', schema },
		{
			createDbConnection: async () => ({
				pool,
				release: async () => undefined,
			}),
			loadSchema: async () => ({
				model: desiredWithConcurrentIndex(current, indexName),
				definition: {},
				tableNames: ['users'],
			}),
		},
	);
	expect(planned.proveKind).toBe('proven');
	expect(planned.plan?.assumptions).toContainEqual(
		expect.objectContaining({ class: 'non-transactional-segment' }),
	);
	if (!planned.runId || !planned.planDigest || !planned.plan)
		throw new Error('expected a durable concurrent-index managed-outcome plan');
	return {
		db,
		runId: planned.runId,
		planDigest: planned.planDigest,
		plan: planned.plan,
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

async function ledgerChain(schema: string, addressName: string) {
	const pool = await getTestPool();
	const rows = (
		await pool.query<LedgerMember>(
			`SELECT event_id AS "eventId", event_kind AS "eventKind", predecessor, observed_digest AS "observedDigest" FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} WHERE address_name = $1`,
			[addressName],
		)
	).rows;
	const root = rows.filter((member) => member.predecessor === null);
	expect(root).toHaveLength(1);
	const members: LedgerMember[] = [];
	let current = root[0];
	while (current) {
		members.push(current);
		const children = rows.filter(
			(member) => member.predecessor === current?.eventId,
		);
		expect(children.length).toBeLessThanOrEqual(1);
		current = children[0];
	}
	expect(members).toHaveLength(rows.length);
	return members;
}

async function startSnapshotBlocker(schema: string) {
	const pool = await getTestPool();
	const client = await pool.connect();
	await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
	await client.query(
		`SELECT count(*) FROM ${quoteIdent(schema)}.${quoteIdent('users')}`,
	);
	return client;
}

async function indexBackend(
	schema: string,
	indexName: string,
): Promise<BackendIdentity> {
	const pool = await getTestPool();
	const backend = await pollUntil(
		'the concurrent index backend',
		async () =>
			(
				await pool.query<BackendIdentity>(
					'SELECT progress.pid, activity.backend_start::text AS "backendStart" FROM pg_catalog.pg_stat_progress_create_index progress ' +
						'JOIN pg_catalog.pg_class index_relation ON index_relation.oid = progress.index_relid ' +
						'JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace ' +
						'JOIN pg_catalog.pg_stat_activity activity ON activity.pid = progress.pid ' +
						'WHERE namespace.nspname = $1 AND index_relation.relname = $2',
					[schema, indexName],
				)
			).rows[0],
		(candidate) => candidate !== undefined,
	);
	if (!backend) throw new Error('concurrent index backend was not observable');
	return backend;
}

async function terminateBackend(backend: BackendIdentity): Promise<void> {
	const pool = await getTestPool();
	const terminated = await pool.query<{ terminated: boolean }>(
		'SELECT pg_catalog.pg_terminate_backend(pid) AS terminated FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz',
		[backend.pid, backend.backendStart],
	);
	if (terminated.rows[0]?.terminated === true) return;
	const active = await pool.query<{ active: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS active',
		[backend.pid, backend.backendStart],
	);
	if (active.rows[0]?.active === true)
		throw new Error(`pg_terminate_backend(${backend.pid}) returned false`);
}

async function disposeChild(child: CheckpointChild): Promise<void> {
	try {
		await waitFor(
			'checkpoint child exit after SIGTERM',
			child.terminate('SIGTERM'),
		);
	} catch (error) {
		if (!errorDetail(error).includes('timed out')) throw error;
		await waitFor(
			'checkpoint child exit after SIGKILL',
			child.terminate('SIGKILL'),
		);
	}
}

beforeEach(resetDbspMeta);

afterEach(async () => {
	for (const schema of schemas.splice(0).reverse()) await dropSchema(schema);
	await resetDbspMeta();
});

describe.sequential('SC-43 #481 managed-outcome wiring', () => {
	describe.sequential('transactional managed outcomes', () => {
		it('keeps one applied enum run ledger-complete while its delivery-1 journal stays on that run', async () => {
			const schema = testSchema('transactional');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			const claim = onlyManagedClaim(planned.plan);
			const applied = await runApply(
				planned.runId,
				{
					db: planned.db,
					planDigest: planned.planDigest,
					accept: planned.plan.assumptions.map(
						(assumption) => assumption.class,
					),
				},
				pool,
			);
			expect(applied.outcome).toBe('completed');

			const members = await ledgerChain(schema, claim.address.name);
			const executed = members[0];
			if (!executed) throw new Error('expected admitted enum claim');
			expect(members.map((member) => member.eventKind)).toEqual([
				'intent',
				'observed',
			]);
			expect(members[1]).toMatchObject({
				predecessor: executed.eventId,
				observedDigest: expect.any(String),
			});
			expect(
				await readPgLedgerReservationsForExecution(
					pool,
					{ scope: 'schema', schema },
					planned.runId,
				),
			).toEqual([]);

			const journal = await readTransitionJournal(pool, planned.runId, {
				ensure: false,
			});
			expect(journal.run).toMatchObject({
				runId: planned.runId,
				planDigest: planned.planDigest,
			});
			expect(journal.plan).toEqual(planned.plan);
			expect(journal.events.map((event) => event.event)).toEqual([
				'intent',
				'completion',
				'observed',
			]);
		});
	});

	describe.sequential('non-transactional managed outcomes', () => {
		it('commits claim then executing before the first concurrent-index statement', async () => {
			const schema = testSchema('nontransactional');
			await provision(schema);
			await createUsers(schema, 10);
			const planned = await planConcurrentIndex(schema, 'idx_users_email');
			const claim = onlyManagedClaim(planned.plan);
			const pool = await getTestPool();
			const applied = await runApply(
				planned.runId,
				{
					db: planned.db,
					planDigest: planned.planDigest,
					accept: planned.plan.assumptions.map(
						(assumption) => assumption.class,
					),
				},
				pool,
			);
			expect(applied.outcome).toBe('completed');
			expect(claim.statementBundle.statements).toHaveLength(1);
			const members = await ledgerChain(schema, claim.address.name);
			const executed = members[0];
			if (!executed)
				throw new Error('expected admitted concurrent-index claim');
			expect(members.map((member) => member.eventKind)).toEqual([
				'intent',
				'executing',
				'observed',
			]);
			expect(members[1]).toMatchObject({ predecessor: executed.eventId });
			expect(members[2]).toMatchObject({
				predecessor: outcomeClaimEventId(executed.eventId, 'executing'),
				observedDigest: expect.any(String),
			});
		});
	});

	describe.sequential('run-scoped reconciliation', () => {
		it('refuses only the killed run at the committed executing-to-send gate and leaves a concurrent claim open', async () => {
			const schema = testSchema('reconcile');
			await provision(schema);
			await createUsers(schema, 10);
			const interrupted = await planConcurrentIndex(schema, 'idx_users_email');
			const untouched = await planConcurrentIndex(
				schema,
				'idx_users_email_untouched',
			);
			const interruptedClaim = onlyManagedClaim(interrupted.plan);
			const untouchedClaim = onlyManagedClaim(untouched.plan);
			const interruptedExecutionClaim = executionClaim(
				interruptedClaim,
				interrupted.runId,
			);
			const untouchedExecutionClaim = executionClaim(
				untouchedClaim,
				untouched.runId,
			);
			const pool = await getTestPool();
			let releaseSend!: () => void;
			const send = new Promise<void>((resolve) => {
				releaseSend = resolve;
			});
			let atExecutingGate!: (pid: number) => void;
			const executingGate = new Promise<number>((resolve) => {
				atExecutingGate = resolve;
			});
			const running = runPersistedNonTransactionalAtGate({
				pool,
				planned: interrupted,
				claim: interruptedExecutionClaim,
				reservations: [
					reservation(interruptedExecutionClaim, interrupted.runId),
				],
				onExecutingCommitted: async (pid) => {
					atExecutingGate(pid);
					await send;
				},
			});
			const pid = await waitFor(
				'the committed executing-to-send gate',
				executingGate,
			);
			await pool.query('SELECT pg_catalog.pg_terminate_backend($1::int)', [
				pid,
			]);
			releaseSend();
			await expect(running).resolves.toMatchObject({
				kind: 'outcome-protocol-refused',
			});
			expect(
				(
					await pool.query(
						"SELECT to_regclass(format('%I.%I', $1::text, $2::text)) AS index_name",
						[schema, interruptedClaim.address.name],
					)
				).rows[0]?.index_name,
			).toBeNull();

			await pollUntil(
				'the interrupted claim to remain open at executing',
				() => ledgerChain(schema, interruptedClaim.address.name),
				(members) =>
					members.map((member) => member.eventKind).join(',') ===
					'intent,executing',
			);
			const admitted = await openPgOutcomeClaim(pool, {
				plan: untouchedExecutionClaim,
				reservations: [reservation(untouchedExecutionClaim, untouched.runId)],
			});
			expect(admitted.kind).toBe('admitted-outcome-claim');

			const reconciled = await runReconcile(interrupted.runId, {
				db: interrupted.db,
			});
			expect(reconciled).toMatchObject({
				outcome: 'reconcile-completed',
				runId: interrupted.runId,
				addresses: [
					expect.objectContaining({ name: interruptedClaim.address.name }),
				],
			});
			expect(
				(await ledgerChain(schema, interruptedClaim.address.name)).map(
					(member) => member.eventKind,
				),
			).toEqual(['intent', 'executing', 'refused']);
			expect(
				await readPgLedgerReservationsForExecution(
					pool,
					{ scope: 'schema', schema },
					interrupted.runId,
				),
			).toEqual([]);
			expect(
				(await ledgerChain(schema, untouchedClaim.address.name)).map(
					(member) => member.eventKind,
				),
			).toEqual(['intent']);
			expect(
				await readPgLedgerReservationsForExecution(
					pool,
					{ scope: 'schema', schema },
					untouched.runId,
				),
			).toHaveLength(1);
		});

		it('reports reconcile-unresolved when the child is killed after send and PostgreSQL retains an invalid index', async () => {
			const schema = testSchema('reconcile_unresolved');
			await provision(schema);
			await createUsers(schema, 200_000);
			const interrupted = await planConcurrentIndex(schema, 'idx_users_email');
			const interruptedClaim = onlyManagedClaim(interrupted.plan);
			const blocker = await startSnapshotBlocker(schema);
			const child = spawnCheckpointChild(
				fileURLToPath(
					new URL(
						'./transition-non-transactional-apply-child.ts',
						import.meta.url,
					),
				),
				{
					args: [interrupted.runId, interrupted.planDigest, schema],
					env: {
						...process.env,
						DATABASE_URL: interrupted.db,
						DBSP_E2E_NON_TRANSACTIONAL_ACCEPTS: interrupted.plan.assumptions
							.map((assumption) => assumption.class)
							.join(','),
					},
				},
			);
			let backend: BackendIdentity | undefined;
			try {
				await waitFor(
					'the child before it sends the statement',
					child.waitForCheckpoint('before-statement-sent'),
				);
				await child.acknowledge('before-statement-sent');
				await waitFor(
					'the child after it sends the statement',
					child.waitForCheckpoint('after-statement-sent'),
				);
				backend = await indexBackend(schema, 'idx_users_email');
				expect(await child.kill('SIGKILL')).toMatchObject({
					signal: 'SIGKILL',
				});
				await terminateBackend(backend);
				backend = undefined;
			} finally {
				blocker.release(true);
				if (backend) await terminateBackend(backend);
				await disposeChild(child);
			}

			const reconciled = await runReconcile(interrupted.runId, {
				db: interrupted.db,
			});
			expect(reconciled).toMatchObject({
				outcome: 'reconcile-unresolved',
				runId: interrupted.runId,
				detail: expect.stringContaining('target index name is already present'),
				recovery: [
					expect.objectContaining({
						address: expect.objectContaining({
							name: interruptedClaim.address.name,
						}),
						outcome: 'pending',
						reason: 'target index name is already present',
					}),
				],
			});
		});
	});

	describe.sequential('non-current marker refusal', () => {
		it('refuses apply and reconcile with the reinitialize preflight reason without ledger appends', async () => {
			const schema = testSchema('marker');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const reconcileRun = await planEnumAdd(schema);
			const reconcileClaim = executionClaim(
				onlyManagedClaim(reconcileRun.plan),
				reconcileRun.runId,
			);
			const admitted = await openPgOutcomeClaim(pool, {
				plan: reconcileClaim,
				reservations: [reservation(reconcileClaim, reconcileRun.runId)],
			});
			expect(admitted.kind).toBe('admitted-outcome-claim');
			const applyRun = await planEnumAdd(schema);
			await pool.query(
				`UPDATE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} SET version = $1`,
				[PG_LEDGER_SHAPE_VERSION + 1],
			);
			const before = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			const applied = await runApply(
				applyRun.runId,
				{
					db: applyRun.db,
					planDigest: applyRun.planDigest,
					accept: applyRun.plan.assumptions.map(
						(assumption) => assumption.class,
					),
				},
				pool,
			);
			expect(applied.outcome).not.toBe('completed');
			expect(JSON.stringify(applied)).toContain(
				'run dbsp preflight --reinitialize',
			);
			const reconciled = await runReconcile(reconcileRun.runId, {
				db: reconcileRun.db,
			});
			expect(reconciled).toMatchObject({
				outcome: 'reconcile-unresolved',
				detail: expect.stringContaining('run dbsp preflight --reinitialize'),
				recovery: [expect.objectContaining({ outcome: 'blocked' })],
			});
			const after = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			expect(after.rows).toEqual(before.rows);
			expect(
				await readPgLedgerReservationsForExecution(
					pool,
					{ scope: 'schema', schema },
					reconcileRun.runId,
				),
			).toHaveLength(1);
			expect(
				(await ledgerChain(schema, reconcileClaim.address.name)).map(
					(member) => member.eventKind,
				),
			).toEqual(['intent']);
		});
	});
});
