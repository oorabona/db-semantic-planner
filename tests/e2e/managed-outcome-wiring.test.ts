import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
	createPgsqlAdapter,
	DBSP_LEDGER_EVENT_TABLE,
	DBSP_LEDGER_IDENTITY_TABLE,
	DBSP_LEDGER_MARKER_TABLE,
	DBSP_LEDGER_RESERVATION_TABLE,
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
import { runInspect } from '../../packages/cli/src/commands/inspect.js';
import { runPlan } from '../../packages/cli/src/commands/plan.js';
import { runReconcile } from '../../packages/cli/src/commands/reconcile.js';
import { runRecover } from '../../packages/cli/src/commands/recover.js';
import { runRelease } from '../../packages/cli/src/commands/release.js';
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
const cliSchemaFiles: string[] = [];
const cliRoles: string[] = [];
const cliEventTriggers: string[] = [];

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

type CliDocument = Record<string, unknown>;

function spawnCli(args: readonly string[]) {
	const cliPath = fileURLToPath(
		new URL('../../packages/cli/src/index.ts', import.meta.url),
	);
	const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
	return spawnSync(process.execPath, ['--import', 'tsx', cliPath, ...args], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: undefined },
	});
}

/** Parse the entire stdout stream and validate the command's declared envelope. */
function cliDocument(
	completed: ReturnType<typeof spawnCli>,
	command: 'apply' | 'inspect' | 'plan' | 'recover' | 'reconcile' | 'release',
): CliDocument {
	expect(completed.stderr).toBe('');
	const document = JSON.parse(completed.stdout) as CliDocument;
	// JSON.parse accepts surrounding whitespace only; this canonical check rejects
	// a second document and validates the serializer contract at the process edge.
	expect(completed.stdout.trim()).toBe(JSON.stringify(document, null, 2));
	switch (command) {
		case 'apply':
		case 'recover':
			expect(document).toMatchObject({
				outcome: expect.any(String),
				exitCode: expect.any(Number),
			});
			break;
		case 'inspect':
			expect(document).toMatchObject({
				ledger: expect.any(Object),
				marker: expect.any(Object),
				live: expect.any(Object),
			});
			break;
		case 'plan':
			expect(document).toMatchObject({
				compareKind: expect.any(String),
				proveKind: expect.any(String),
				assessment: expect.any(Object),
				persisted: expect.any(Boolean),
			});
			break;
		case 'reconcile':
			expect(document).toMatchObject({
				outcome: expect.any(String),
				runId: expect.any(String),
				addresses: expect.any(Array),
			});
			break;
		case 'release':
			expect(document).toMatchObject({ outcome: expect.any(String) });
			break;
	}
	return document;
}

function cliFailureDocument(
	completed: ReturnType<typeof spawnCli>,
): CliDocument {
	expect(completed.stderr).toBe('');
	const document = JSON.parse(completed.stdout) as CliDocument;
	expect(completed.stdout.trim()).toBe(JSON.stringify(document, null, 2));
	return document;
}

async function cliSchemaFile(source = 'schema({})'): Promise<string> {
	const path = `${process.cwd()}/.dbsp-cli-obligation-${randomUUID()}.mjs`;
	await writeFile(
		path,
		`import { schema } from '@dbsp/core';\nexport default ${source};\n`,
	);
	cliSchemaFiles.push(path);
	return path;
}

function controlPayload(): string {
	return `pg-control-${randomUUID().slice(0, 8)}\u001b\u0007`;
}

async function installPgControlInsertTrigger(input: {
	readonly schema: string;
	readonly tableSchema: string;
	readonly table: string;
	readonly payload: string;
}): Promise<void> {
	const pool = await getTestPool();
	const functionName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	const triggerName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	await pool.query(
		`CREATE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION '%', '${input.payload.replaceAll("'", "''")}'; END; $body$`,
	);
	await pool.query(
		`CREATE TRIGGER ${quoteIdent(triggerName)} BEFORE INSERT ON ${quoteIdent(input.tableSchema)}.${quoteIdent(input.table)} FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}()`,
	);
}

async function cliReadRole(input: {
	readonly db: string;
	readonly schema: string;
	readonly writeLedgerEvent?: boolean;
}): Promise<string> {
	const pool = await getTestPool();
	const role = `dbsp_cli_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
	const password = randomUUID();
	cliRoles.push(role);
	await pool.query(
		`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${password.replaceAll("'", "''")}'`,
	);
	await pool.query(
		`GRANT USAGE ON SCHEMA ${quoteIdent('dbsp_meta')}, ${quoteIdent(input.schema)} TO ${quoteIdent(role)}`,
	);
	await pool.query(
		`GRANT SELECT ON TABLE ${[
			'dbsp_transition_run',
			'dbsp_transition_run_plan',
			'dbsp_transition_journal',
			'dbsp_transition_authorization',
		]
			.map((table) => `${quoteIdent('dbsp_meta')}.${quoteIdent(table)}`)
			.join(', ')} TO ${quoteIdent(role)}`,
	);
	if (input.writeLedgerEvent)
		await pool.query(
			`GRANT INSERT ON TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} TO ${quoteIdent(role)}; GRANT DELETE ON TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_RESERVATION_TABLE)} TO ${quoteIdent(role)}`,
		);
	await pool.query(
		`GRANT SELECT ON TABLE ${[
			DBSP_LEDGER_EVENT_TABLE,
			DBSP_LEDGER_IDENTITY_TABLE,
			DBSP_LEDGER_MARKER_TABLE,
			DBSP_LEDGER_RESERVATION_TABLE,
		]
			.map((table) => `${quoteIdent(input.schema)}.${quoteIdent(table)}`)
			.join(', ')} TO ${quoteIdent(role)}`,
	);
	await pool.query(
		`GRANT SELECT ON TABLE ${[
			DBSP_LEDGER_EVENT_TABLE,
			DBSP_LEDGER_IDENTITY_TABLE,
			DBSP_LEDGER_MARKER_TABLE,
			DBSP_LEDGER_RESERVATION_TABLE,
		]
			.map((table) => `${quoteIdent('dbsp_meta')}.${quoteIdent(table)}`)
			.join(', ')} TO ${quoteIdent(role)}`,
	);
	const url = new URL(input.db);
	url.username = role;
	url.password = password;
	return url.toString();
}

async function installPgControlResolutionPolicy(input: {
	readonly schema: string;
	readonly payload: string;
}): Promise<void> {
	const pool = await getTestPool();
	const functionName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	const reservationPolicy = `allow_pg_control_${randomUUID().replaceAll('-', '')}`;
	const eventSelectPolicy = `allow_pg_control_${randomUUID().replaceAll('-', '')}`;
	const eventInsertPolicy = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	await pool.query(
		`CREATE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}() RETURNS boolean LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION '%', '${input.payload.replaceAll("'", "''")}'; END; $body$`,
	);
	await pool.query(
		`ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_RESERVATION_TABLE)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_RESERVATION_TABLE)} FORCE ROW LEVEL SECURITY; CREATE POLICY ${quoteIdent(reservationPolicy)} ON ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_RESERVATION_TABLE)} FOR SELECT USING (true); ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} FORCE ROW LEVEL SECURITY; CREATE POLICY ${quoteIdent(eventSelectPolicy)} ON ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} FOR SELECT USING (true); CREATE POLICY ${quoteIdent(eventInsertPolicy)} ON ${quoteIdent(input.schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)} FOR INSERT WITH CHECK (${quoteIdent(input.schema)}.${quoteIdent(functionName)}())`,
	);
}

async function installPgControlReadPolicy(input: {
	readonly schema: string;
	readonly table: string;
	readonly payload: string;
}): Promise<void> {
	const pool = await getTestPool();
	const functionName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	const policyName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	await pool.query(
		`CREATE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}() RETURNS boolean LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION '%', '${input.payload.replaceAll("'", "''")}'; END; $body$`,
	);
	await pool.query(
		`ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(input.table)} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${quoteIdent(input.schema)}.${quoteIdent(input.table)} FORCE ROW LEVEL SECURITY; CREATE POLICY ${quoteIdent(policyName)} ON ${quoteIdent(input.schema)}.${quoteIdent(input.table)} FOR SELECT USING (${quoteIdent(input.schema)}.${quoteIdent(functionName)}())`,
	);
}

async function installPgControlDdlTrigger(input: {
	readonly schema: string;
	readonly payload: string;
}): Promise<void> {
	const pool = await getTestPool();
	const functionName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	const triggerName = `raise_pg_control_${randomUUID().replaceAll('-', '')}`;
	cliEventTriggers.push(triggerName);
	await pool.query(
		`CREATE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}() RETURNS event_trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION '%', '${input.payload.replaceAll("'", "''")}'; END; $body$`,
	);
	await pool.query(
		`CREATE EVENT TRIGGER ${quoteIdent(triggerName)} ON ddl_command_start WHEN TAG IN ('CREATE SCHEMA') EXECUTE FUNCTION ${quoteIdent(input.schema)}.${quoteIdent(functionName)}()`,
	);
}

function expectEscapedPgControl(
	completed: ReturnType<typeof spawnCli>,
	document: CliDocument,
	payload: string,
): void {
	expect(completed.stdout).not.toContain('\u001b');
	expect(completed.stdout).not.toContain('\u0007');
	expect(completed.stdout).toContain('\\u001b');
	expect(completed.stdout).toContain('\\u0007');
	const containsPayload = (value: unknown): boolean => {
		if (typeof value === 'string') return value.includes(payload);
		if (Array.isArray(value)) return value.some(containsPayload);
		return (
			typeof value === 'object' &&
			value !== null &&
			Object.values(value).some(containsPayload)
		);
	};
	expect(containsPayload(document)).toBe(true);
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
					// The admitted facade owns journal and ledger infrastructure on the
					// ordinary leased-session channel.  Its physical-shape reader uses
					// SET LOCAL search_path inside its transaction; routing that setup
					// through the plan-operation channel would make the lease invariant
					// mistake adapter infrastructure for reviewed plan SQL.
					const executor = lease.session;
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

async function copyPersistedRun(
	sourceRunId: string,
	copyRunId: string,
	removeSource = false,
): Promise<void> {
	const pool = await getTestPool();
	await pool.query(
		`INSERT INTO dbsp_meta.dbsp_transition_run (run_id, plan_digest, target_context_digest, database_id, core_version, replayability, started_at) ` +
			`SELECT $1, plan_digest, target_context_digest, database_id, core_version, replayability, started_at FROM dbsp_meta.dbsp_transition_run WHERE run_id = $2`,
		[copyRunId, sourceRunId],
	);
	await pool.query(
		`INSERT INTO dbsp_meta.dbsp_transition_run_plan (run_id, bound_run_id, plan) ` +
			`SELECT $1, bound_run_id, plan FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $2`,
		[copyRunId, sourceRunId],
	);
	if (removeSource) {
		await pool.query(
			'DELETE FROM dbsp_meta.dbsp_transition_run_plan WHERE run_id = $1',
			[sourceRunId],
		);
		await pool.query(
			'DELETE FROM dbsp_meta.dbsp_transition_run WHERE run_id = $1',
			[sourceRunId],
		);
	}
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
	const pool = await getTestPool();
	for (const trigger of cliEventTriggers.splice(0))
		await pool.query(`DROP EVENT TRIGGER IF EXISTS ${quoteIdent(trigger)}`);
	for (const schema of schemas.splice(0).reverse()) await dropSchema(schema);
	for (const path of cliSchemaFiles.splice(0)) await rm(path, { force: true });
	for (const role of cliRoles.splice(0)) {
		await pool.query(`DROP OWNED BY ${quoteIdent(role)}`);
		await pool.query(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
	}
	await resetDbspMeta();
});

describe.sequential('SC-43 #481 managed-outcome wiring', () => {
	describe.sequential('transactional managed outcomes', () => {
		it('OBL-RUN1: public apply refuses an intact durable plan when the reviewed digest is wrong before authorization or DDL', async () => {
			const schema = testSchema('run_wrong_review_digest');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);

			await expect(
				runApply(
					planned.runId,
					{ db: planned.db, planDigest: `${planned.planDigest}-substituted` },
					pool,
				),
			).resolves.toMatchObject({ outcome: 'plan-digest-mismatch' });
			await expect(
				pool.query(
					'SELECT count(*)::integer AS count FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
					[planned.runId],
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });
			await expect(
				pool.query(
					`SELECT enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'status' ORDER BY enumsortorder`,
					[schema],
				),
			).resolves.toMatchObject({ rows: [{ enumlabel: 'active' }] });
		});

		it('OBL-RUN5: a durable pre-admission refusal leaves the run re-applicable and its real ledger chain readable', async () => {
			const schema = testSchema('run_pre_admission_retry');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			const claim = onlyManagedClaim(planned.plan);

			await expect(
				runApply(
					planned.runId,
					{ db: planned.db, planDigest: planned.planDigest },
					pool,
				),
			).resolves.toMatchObject({ outcome: 'assumption-not-accepted' });
			await expect(
				pool.query(
					'SELECT count(*)::integer AS count FROM dbsp_meta.dbsp_transition_journal WHERE run_id = $1',
					[planned.runId],
				),
			).resolves.toMatchObject({ rows: [{ count: 0 }] });

			await expect(
				runApply(
					planned.runId,
					{
						db: planned.db,
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					pool,
				),
			).resolves.toMatchObject({ outcome: 'completed' });
			expect(
				(await ledgerChain(schema, claim.address.name)).map(
					(member) => member.eventKind,
				),
			).toEqual(['intent', 'observed']);
		});

		it('OBL-RUN1: a direct-SQL persisted-plan mutation is refused by public apply and recover before DDL', async () => {
			const schema = testSchema('run_plan_tamper');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			await pool.query(
				"UPDATE dbsp_meta.dbsp_transition_run_plan SET plan = jsonb_set(plan, '{steps,0,order}', '99'::jsonb) WHERE run_id = $1",
				[planned.runId],
			);

			await expect(
				runApply(
					planned.runId,
					{ db: planned.db, planDigest: planned.planDigest },
					pool,
				),
			).resolves.toMatchObject({ outcome: 'plan-digest-mismatch' });
			await expect(
				runRecover(
					planned.runId,
					{ db: planned.db, planDigest: planned.planDigest },
					pool,
				),
			).resolves.toMatchObject({ outcome: 'recovery-plan-digest-mismatch' });
			await expect(
				pool.query(
					`SELECT enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'status' ORDER BY enumsortorder`,
					[schema],
				),
			).resolves.toMatchObject({ rows: [{ enumlabel: 'active' }] });
		});

		it.each([
			[
				'tampered',
				"UPDATE dbsp_meta.dbsp_transition_authorization SET actor = 'attacker' WHERE run_id = $1",
				'recovery-authorization-invalid',
			],
			[
				'deleted',
				'DELETE FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
				'recovery-authorization-missing',
			],
		] as const)('OBL-RUN8: public recover refuses a %s persisted authorization without another ledger append', async (_variant, corruption, expectedOutcome) => {
			const schema = testSchema('run_auth_corrupt');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			await expect(
				runApply(
					planned.runId,
					{
						db: planned.db,
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					pool,
				),
			).resolves.toMatchObject({ outcome: 'completed' });
			const before = await ledgerChain(
				schema,
				onlyManagedClaim(planned.plan).address.name,
			);
			await pool.query(corruption, [planned.runId]);
			await expect(
				runRecover(
					planned.runId,
					{ db: planned.db, planDigest: planned.planDigest },
					pool,
				),
			).resolves.toMatchObject({ outcome: expectedOutcome });
			expect(
				await ledgerChain(schema, onlyManagedClaim(planned.plan).address.name),
			).toEqual(before);
		});

		it('OBL-RUN3: a persisted durable run with an unsupported execution epoch is refused by public apply before DDL', async () => {
			const schema = testSchema('run_epoch_tamper');
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			await pool.query(
				"UPDATE dbsp_meta.dbsp_transition_run SET core_version = '9.9.9' WHERE run_id = $1",
				[planned.runId],
			);
			const refused = await runApply(
				planned.runId,
				{ db: planned.db, planDigest: planned.planDigest },
				pool,
			);
			expect(refused).toMatchObject({
				outcome: 'compatibility-refusal',
				result: {
					assessment: {
						reasons: [
							expect.objectContaining({
								detail: expect.stringContaining(
									'execution compatibility epoch',
								),
							}),
						],
					},
				},
			});
			await expect(
				pool.query(
					`SELECT enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'status' ORDER BY enumsortorder`,
					[schema],
				),
			).resolves.toMatchObject({ rows: [{ enumlabel: 'active' }] });
		});

		it.each([
			['copied', false],
			['renamed', true],
		] as const)('OBL-RUN3: public apply refuses a %s durable run row before authorization or DDL', async (variant, removeSource) => {
			const schema = testSchema(`run_identity_${variant}`);
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			const copiedRunId = `${planned.runId}:${variant}`;
			await copyPersistedRun(planned.runId, copiedRunId, removeSource);

			await expect(
				runApply(
					copiedRunId,
					{ db: planned.db, planDigest: planned.planDigest },
					pool,
				),
			).resolves.toMatchObject({
				outcome: 'run-id-mismatch',
				result: {
					assessment: {
						reasons: [
							expect.objectContaining({
								detail: expect.stringContaining('bound id'),
							}),
						],
					},
				},
			});
			await expect(
				pool.query(
					'SELECT count(*)::text AS count FROM dbsp_meta.dbsp_transition_authorization WHERE run_id = $1',
					[copiedRunId],
				),
			).resolves.toMatchObject({ rows: [{ count: '0' }] });
			await expect(
				pool.query(
					`SELECT enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname = 'status' ORDER BY enumsortorder`,
					[schema],
				),
			).resolves.toMatchObject({ rows: [{ enumlabel: 'active' }] });
		});

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
		it('requires recovery for only the killed run at the committed executing-to-send gate and leaves a concurrent claim open', async () => {
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
				kind: 'outcome-recovery-required',
				claimId: interruptedExecutionClaim.claimId,
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

	describe.sequential('OBL-REC12 corrupted ledger storage', () => {
		/**
		 * The normal ledger constraints make these three states impossible.  Each
		 * construction deliberately relaxes only the constraint that prevents the
		 * corruption, then drives the public surface.  The per-test schema is
		 * discarded afterwards, so the test never leaves weakened infrastructure
		 * behind for another cell.
		 */
		async function corruptedRun(
			corruption:
				| 'unknown-kind'
				| 'broken-predecessor'
				| 'divergent-resolution',
		): Promise<{ readonly planned: PlannedRun; readonly schema: string }> {
			const schema = testSchema(`rec12_${corruption.replaceAll('-', '_')}`);
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			const claim = executionClaim(
				onlyManagedClaim(planned.plan),
				planned.runId,
			);
			const opened = await openPgOutcomeClaim(pool, {
				plan: claim,
				reservations: [reservation(claim, planned.runId)],
			});
			expect(opened.kind).toBe('admitted-outcome-claim');
			const event = `${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`;
			const executingEventId = `${claim.claimId}:executing`;
			await pool.query(
				`INSERT INTO ${event} (event_id, address_engine, address_database, address_schema, address_parent, address_kind, address_name, execution_id, planned_claim_key, claim_group_id, root_claim_id, event_kind, predecessor) VALUES ($1, $2, $3, $4, 'null'::jsonb, $5, $6, $7, $8, $9, $10, 'executing', $10)`,
				[
					executingEventId,
					claim.address.engine,
					claim.address.database,
					claim.address.schema ?? '',
					claim.address.kind,
					claim.address.name,
					claim.executionId,
					claim.plannedClaimKey,
					claim.claimGroupId,
					claim.claimId,
				],
			);
			if (corruption === 'unknown-kind') {
				await pool.query(
					`ALTER TABLE ${event} DISABLE TRIGGER ${quoteIdent('dbsp_ledger_event_immutable')}`,
				);
				await pool.query(
					`ALTER TABLE ${event} DROP CONSTRAINT ${quoteIdent('dbsp_ledger_event_kind_closed')}`,
				);
				await pool.query(
					`UPDATE ${event} SET event_kind = 'unknown-e2e-kind' WHERE event_id = $1`,
					[executingEventId],
				);
			} else if (corruption === 'broken-predecessor') {
				await pool.query(
					`ALTER TABLE ${event} DISABLE TRIGGER ${quoteIdent('dbsp_ledger_event_immutable')}`,
				);
				await pool.query(
					`ALTER TABLE ${event} DROP CONSTRAINT ${quoteIdent('dbsp_ledger_event_same_address_predecessor')}`,
				);
				await pool.query(
					`UPDATE ${event} SET predecessor = 'missing-e2e-predecessor' WHERE event_id = $1`,
					[executingEventId],
				);
			} else {
				await pool.query(
					`ALTER TABLE ${event} DROP CONSTRAINT ${quoteIdent('dbsp_ledger_event_one_child')}`,
				);
				for (const [eventId, cause] of [
					['rec12-first-resolution', 'first resolution'],
					['rec12-divergent-resolution', 'different resolution payload'],
				] as const)
					await pool.query(
						`INSERT INTO ${event} (event_id, address_engine, address_database, address_schema, address_parent, address_kind, address_name, execution_id, planned_claim_key, claim_group_id, root_claim_id, event_kind, predecessor, refusal_code, refusal_cause, refusal_state, refusal_withheld_authority, refusal_resolving_command) VALUES ($1, $2, $3, $4, 'null'::jsonb, $5, $6, $7, $8, $9, $10, 'refused', $10, 'ERR-08', $11, 'unknown', 'malformed journal evidence', 'dbsp reconcile')`,
						[
							eventId,
							claim.address.engine,
							claim.address.database,
							claim.address.schema ?? '',
							claim.address.kind,
							claim.address.name,
							claim.executionId,
							claim.plannedClaimKey,
							claim.claimGroupId,
							executingEventId,
							cause,
						],
					);
			}
			return { planned, schema };
		}

		it.each([
			['unknown kind', 'unknown-kind'],
			['broken predecessor', 'broken-predecessor'],
			['divergent resolution payload', 'divergent-resolution'],
		] as const)('OBL-REC12 reconcile: %s refuses selection and appends no recovery event', async (_name, corruption) => {
			const { planned } = await corruptedRun(corruption);
			const pool = await getTestPool();
			const before = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(planned.plan.steps[0]!.managedClaim!.address.schema!)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			await expect(
				runReconcile(planned.runId, { db: planned.db }, pool),
			).resolves.toMatchObject({
				outcome: 'reconcile-claim-selection-unavailable',
			});
			const after = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(planned.plan.steps[0]!.managedClaim!.address.schema!)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			expect(after.rows).toEqual(before.rows);
		});

		it.each([
			['unknown kind', 'unknown-kind'],
			['broken predecessor', 'broken-predecessor'],
			['divergent resolution payload', 'divergent-resolution'],
		] as const)('OBL-REC12 inspect: %s stays readable as a typed malformed projection', async (_name, corruption) => {
			const { planned, schema } = await corruptedRun(corruption);
			await expect(
				runInspect('enum:status', { db: planned.db, schema }),
			).resolves.toMatchObject({
				projection: { kind: 'unprojectable-ledger-chain' },
			});
		});

		it.each([
			['unknown kind', 'unknown-kind'],
			['broken predecessor', 'broken-predecessor'],
			['divergent resolution payload', 'divergent-resolution'],
		] as const)('OBL-REC12 release: %s refuses without a release append', async (_name, corruption) => {
			const { planned, schema } = await corruptedRun(corruption);
			const pool = await getTestPool();
			const before = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			await expect(
				runRelease('enum:status', { db: planned.db, schema }),
			).resolves.toMatchObject({
				outcome: 'release-refused',
				refusal: { code: 'ERR-08' },
			});
			const after = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			expect(after.rows).toEqual(before.rows);
		});

		it.each([
			['unknown kind', 'unknown-kind'],
			['broken predecessor', 'broken-predecessor'],
			['divergent resolution payload', 'divergent-resolution'],
		] as const)('OBL-REC12 apply: %s refuses before a new lifecycle append', async (_name, corruption) => {
			const { planned, schema } = await corruptedRun(corruption);
			const pool = await getTestPool();
			const before = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			const result = await runApply(
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
			expect(result.outcome).not.toBe('applied');
			const after = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			expect(after.rows).toEqual(before.rows);
		});

		it.each([
			['unknown kind', 'unknown-kind'],
			['broken predecessor', 'broken-predecessor'],
			['divergent resolution payload', 'divergent-resolution'],
		] as const)('OBL-REC12 recover: %s refuses before recovery append', async (_name, corruption) => {
			const { planned, schema } = await corruptedRun(corruption);
			const pool = await getTestPool();
			const before = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			const result = await runRecover(
				planned.runId,
				{ db: planned.db, planDigest: planned.planDigest },
				pool,
			);
			expect(result.outcome).not.toBe('completed');
			const after = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);
			expect(after.rows).toEqual(before.rows);
		});
	});

	describe.sequential('OBL-REC3 public reconcile diagnostic causes', () => {
		it.each([
			[
				'authentication',
				async () => {
					const pool = await getTestPool();
					const role = `dbsp_rec3_auth_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
					const password = randomUUID();
					cliRoles.push(role);
					await pool.query(
						`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${password.replaceAll("'", "''")}'`,
					);
					const db = process.env.DATABASE_URL;
					if (!db)
						throw new Error('DATABASE_URL is required for managed-outcome E2E');
					const badCredentials = new URL(db);
					badCredentials.username = role;
					badCredentials.password = `${password}-wrong`;
					return runReconcile('rec3-authentication', {
						db: badCredentials.toString(),
					});
				},
			],
			[
				'transport',
				async () =>
					runReconcile('rec3-transport', {
						db: 'postgres://dbsp:dbsp@127.0.0.1:1/dbsp',
					}),
			],
			[
				'malformed-journal',
				async () => {
					const schema = testSchema('rec3_malformed_journal');
					await provision(schema);
					const pool = await getTestPool();
					await pool.query(
						`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
					);
					const planned = await planEnumAdd(schema);
					await pool.query(
						"UPDATE dbsp_meta.dbsp_transition_run_plan SET plan = 'null'::jsonb WHERE run_id = $1",
						[planned.runId],
					);
					return runReconcile(planned.runId, { db: planned.db }, pool);
				},
			],
			[
				'catalogue',
				async () => {
					const schema = testSchema('rec3_catalogue');
					await provision(schema);
					const pool = await getTestPool();
					await pool.query(
						`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
					);
					const planned = await planEnumAdd(schema);
					const claim = executionClaim(
						onlyManagedClaim(planned.plan),
						planned.runId,
					);
					const opened = await openPgOutcomeClaim(pool, {
						plan: claim,
						reservations: [reservation(claim, planned.runId)],
					});
					expect(opened.kind).toBe('admitted-outcome-claim');
					await pool.query(
						`DROP TABLE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
					);
					return runReconcile(planned.runId, { db: planned.db }, pool);
				},
			],
		] as const)('OBL-REC3: public reconcile preserves the %s cause from its real failing stage', async (cause, invoke) => {
			await expect(invoke()).resolves.toMatchObject({
				outcome: 'reconcile-run-unavailable',
				failureCause: cause,
			});
		});
	});

	describe.sequential('non-current marker refusal', () => {
		const markerAttacks = [
			[
				'older',
				async (schema: string) => {
					const pool = await getTestPool();
					await pool.query(
						`ALTER TABLE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} DROP CONSTRAINT dbsp_ledger_marker_version_check`,
					);
					await pool.query(
						`UPDATE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} SET version = $1`,
						[PG_LEDGER_SHAPE_VERSION - 1],
					);
				},
			],
			[
				'future',
				async (schema: string) => {
					const pool = await getTestPool();
					await pool.query(
						`UPDATE ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)} SET version = $1`,
						[PG_LEDGER_SHAPE_VERSION + 1],
					);
				},
			],
			[
				'mixed',
				async (schema: string) => {
					const pool = await getTestPool();
					const marker = `${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)}`;
					await pool.query(
						`ALTER TABLE ${marker} DROP CONSTRAINT dbsp_ledger_marker_version_check`,
					);
					await pool.query(
						`ALTER TABLE ${marker} DROP CONSTRAINT dbsp_ledger_marker_pkey, DROP CONSTRAINT dbsp_ledger_marker_id_check`,
					);
					await pool.query(
						`INSERT INTO ${marker} (id, version) VALUES (false, $1)`,
						[PG_LEDGER_SHAPE_VERSION + 1],
					);
				},
			],
			[
				'unreadable',
				async (schema: string) => {
					const pool = await getTestPool();
					const marker = `${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_MARKER_TABLE)}`;
					await pool.query(
						`ALTER TABLE ${marker} DROP CONSTRAINT dbsp_ledger_marker_version_check`,
					);
					await pool.query(
						`ALTER TABLE ${marker} ALTER COLUMN version TYPE text USING 'not-a-version'`,
					);
				},
			],
		] as const;

		it.each(
			markerAttacks,
		)('OBL-CLI10: recover refuses a %s marker before recovery selection or append', async (kind, corruptMarker) => {
			const schema = testSchema(`recover_marker_${kind}`);
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			await corruptMarker(schema);
			const eventCount = await pool.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
			);

			const recovered = await runRecover(
				planned.runId,
				{ db: planned.db, planDigest: planned.planDigest },
				pool,
			);
			expect(recovered).toMatchObject({
				outcome: 'recovery-context-mismatch',
				detail: expect.stringContaining(`ledger marker ${kind}`),
				refusal: {
					address: onlyManagedClaim(planned.plan).address,
					refusal: {
						code: 'ERR-03',
						resolvingCommand: 'dbsp preflight --reinitialize',
					},
				},
			});
			expect(JSON.parse(JSON.stringify(recovered))).toMatchObject({
				refusal: { refusal: { code: 'ERR-03' } },
			});
			await expect(
				pool.query<{ count: string }>(
					`SELECT count(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(DBSP_LEDGER_EVENT_TABLE)}`,
				),
			).resolves.toEqual(eventCount);
		});

		it.each(
			markerAttacks,
		)('OBL-CLI10: apply and reconcile refuse a %s marker before ledger append', async (kind, corruptMarker) => {
			const schema = testSchema(`ar_marker_${kind}`);
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
			await corruptMarker(schema);
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
			expect(JSON.stringify(applied)).toContain(`ledger marker ${kind}`);
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

	describe.sequential('OBL-CLI1 spawned JSON success envelopes', () => {
		async function plannedEnumRun(label: string) {
			const schema = testSchema(`cli1_${label}`);
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			return { schema, planned: await planEnumAdd(schema) };
		}

		it('OBL-CLI1 apply: spawned success is one schema-valid completed document', async () => {
			const { planned } = await plannedEnumRun('apply');
			const completed = spawnCli([
				'apply',
				planned.runId,
				'--db',
				planned.db,
				'--plan-digest',
				planned.planDigest,
				...planned.plan.assumptions.flatMap((assumption) => [
					'--accept',
					assumption.class,
				]),
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'apply').outcome).toBe('completed');
		});

		it('OBL-CLI1 inspect: spawned success is one schema-valid readable document', async () => {
			const schema = testSchema('cli1_inspect');
			await provision(schema);
			const db = process.env.DATABASE_URL;
			if (!db) throw new Error('DATABASE_URL is required for CLI E2E');
			const completed = spawnCli([
				'inspect',
				'--db',
				db,
				'--schema',
				schema,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'inspect').live).toEqual({
				kind: 'not-requested',
			});
		});

		it('OBL-CLI1 plan: spawned success is one schema-valid no-drift document', async () => {
			const schema = testSchema('cli1_plan');
			await provision(schema);
			const db = process.env.DATABASE_URL;
			if (!db) throw new Error('DATABASE_URL is required for CLI E2E');
			const completed = spawnCli([
				'plan',
				await cliSchemaFile(),
				'--db',
				db,
				'--schema',
				schema,
				'--dry-run',
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'plan').proveKind).toBe('no-drift');
		});

		it('OBL-CLI1 recover: spawned success is one schema-valid completed document', async () => {
			const { planned } = await plannedEnumRun('recover');
			await expect(
				runApply(
					planned.runId,
					{
						db: planned.db,
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					await getTestPool(),
				),
			).resolves.toMatchObject({ outcome: 'completed' });
			const completed = spawnCli([
				'recover',
				planned.runId,
				'--db',
				planned.db,
				'--plan-digest',
				planned.planDigest,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'recover').outcome).toBe('completed');
		});

		it('OBL-CLI1 reconcile: spawned success is one schema-valid completed document', async () => {
			const { planned } = await plannedEnumRun('reconcile');
			const claim = executionClaim(
				onlyManagedClaim(planned.plan),
				planned.runId,
			);
			await expect(
				openPgOutcomeClaim(await getTestPool(), {
					plan: claim,
					reservations: [reservation(claim, planned.runId)],
				}),
			).resolves.toMatchObject({ kind: 'admitted-outcome-claim' });
			const completed = spawnCli([
				'reconcile',
				planned.runId,
				'--db',
				planned.db,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'reconcile').outcome).toBe(
				'reconcile-completed',
			);
		});

		it('OBL-CLI1 release: spawned success is one schema-valid released document', async () => {
			const { schema, planned } = await plannedEnumRun('release');
			await expect(
				runApply(
					planned.runId,
					{
						db: planned.db,
						planDigest: planned.planDigest,
						accept: planned.plan.assumptions.map(
							(assumption) => assumption.class,
						),
					},
					await getTestPool(),
				),
			).resolves.toMatchObject({ outcome: 'completed' });
			const completed = spawnCli([
				'release',
				'enum:status',
				'--db',
				planned.db,
				'--schema',
				schema,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			expect(cliDocument(completed, 'release').outcome).toBe('released');
		});
	});

	describe.sequential('OBL-REC3/REC5 spawned reconcile evidence', () => {
		async function openedCliReconcile(label: string) {
			const schema = testSchema(`cli_reconcile_${label}`);
			await provision(schema);
			const pool = await getTestPool();
			await pool.query(
				`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
			);
			const planned = await planEnumAdd(schema);
			const claim = executionClaim(
				onlyManagedClaim(planned.plan),
				planned.runId,
			);
			await expect(
				openPgOutcomeClaim(pool, {
					plan: claim,
					reservations: [reservation(claim, planned.runId)],
				}),
			).resolves.toMatchObject({ kind: 'admitted-outcome-claim' });
			return { claim, planned, schema };
		}

		it('OBL-REC3: CLI reconcile classifies a revoked catalogue reservation read as catalogue', async () => {
			const { planned, schema } = await openedCliReconcile('rec3');
			const pool = await getTestPool();
			const role = `dbsp_rec3_reader_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
			const password = randomUUID();
			cliRoles.push(role);
			await pool.query(
				`CREATE ROLE ${quoteIdent(role)} LOGIN PASSWORD '${password.replaceAll("'", "''")}'`,
			);
			const database = await pool.query<{ database: string }>(
				'SELECT current_database() AS database',
			);
			await pool.query(
				`GRANT CONNECT ON DATABASE ${quoteIdent(database.rows[0]!.database)} TO ${quoteIdent(role)}`,
			);
			await pool.query(
				`GRANT USAGE ON SCHEMA ${quoteIdent('dbsp_meta')}, ${quoteIdent(schema)} TO ${quoteIdent(role)}`,
			);
			await pool.query(
				`GRANT SELECT ON TABLE ${[
					'dbsp_transition_run',
					'dbsp_transition_run_plan',
					'dbsp_transition_journal',
					'dbsp_transition_authorization',
				]
					.map((table) => `${quoteIdent('dbsp_meta')}.${quoteIdent(table)}`)
					.join(', ')} TO ${quoteIdent(role)}`,
			);
			await pool.query(
				`GRANT SELECT ON TABLE ${[
					DBSP_LEDGER_EVENT_TABLE,
					DBSP_LEDGER_IDENTITY_TABLE,
					DBSP_LEDGER_MARKER_TABLE,
				]
					.map((table) => `${quoteIdent(schema)}.${quoteIdent(table)}`)
					.join(', ')} TO ${quoteIdent(role)}`,
			);
			// Deliberately omit SELECT on dbsp_ledger_reservation: it is the real
			// catalogue-read target selected by reconcile after journal loading.
			const roleDb = new URL(planned.db);
			roleDb.username = role;
			roleDb.password = password;
			const completed = spawnCli([
				'reconcile',
				planned.runId,
				'--db',
				roleDb.toString(),
				'--format',
				'json',
			]);
			expect(completed.status).toBe(1);
			const document = cliDocument(completed, 'reconcile');
			expect(document).toMatchObject({
				outcome: 'reconcile-run-unavailable',
				failureCause: 'catalogue',
			});
		});

		it('OBL-REC5 plan-address comparison: CLI reconcile accepts a re-parsed value-equal reservation address', async () => {
			const { claim, planned } = await openedCliReconcile('rec5_plan');
			const completed = spawnCli([
				'reconcile',
				planned.runId,
				'--db',
				planned.db,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			const document = cliDocument(completed, 'reconcile');
			expect(document).toMatchObject({
				outcome: 'reconcile-completed',
				addresses: [structuredClone(claim.address)],
			});
		});

		it('OBL-REC5 root-address comparison: CLI reconcile accepts re-parsed value-equal root/member addresses', async () => {
			const { claim, planned } = await openedCliReconcile('rec5_root');
			const completed = spawnCli([
				'reconcile',
				planned.runId,
				'--db',
				planned.db,
				'--format',
				'json',
			]);
			expect(completed.status).toBe(0);
			const document = cliDocument(completed, 'reconcile');
			expect(document).toMatchObject({
				outcome: 'reconcile-completed',
				recovery: [
					expect.objectContaining({ address: structuredClone(claim.address) }),
				],
			});
		});

		describe.sequential('OBL-CLI2 PostgreSQL control-byte exception payloads', () => {
			it('OBL-CLI2 apply: escapes a PostgreSQL trigger payload on its command exception path', async () => {
				const { planned, schema } = await openedCliReconcile('cli2_apply');
				const payload = controlPayload();
				await installPgControlInsertTrigger({
					schema,
					tableSchema: 'dbsp_meta',
					table: 'dbsp_transition_authorization',
					payload,
				});
				const completed = spawnCli([
					'apply',
					planned.runId,
					'--db',
					planned.db,
					'--plan-digest',
					planned.planDigest,
					...planned.plan.assumptions.flatMap((assumption) => [
						'--accept',
						assumption.class,
					]),
					'--format',
					'json',
				]);
				expect(completed.status).not.toBe(0);
				const document = cliFailureDocument(completed);
				expect(document.outcome).toBe('authorization-write-failed');
				expectEscapedPgControl(completed, document, payload);
			});

			it('OBL-CLI2 inspect: escapes a PostgreSQL RLS payload on its command exception path', async () => {
				const { planned, schema } = await openedCliReconcile('cli2_inspect');
				const payload = controlPayload();
				await installPgControlReadPolicy({
					schema,
					table: DBSP_LEDGER_EVENT_TABLE,
					payload,
				});
				const completed = spawnCli([
					'inspect',
					'enum:status',
					'--db',
					await cliReadRole({ db: planned.db, schema }),
					'--schema',
					schema,
					'--format',
					'json',
				]);
				expect(completed.status).toBe(0);
				const document = cliFailureDocument(completed);
				expect(document).toMatchObject({
					failedSubsystem: { subsystem: 'ledger', reason: expect.any(String) },
				});
				expectEscapedPgControl(completed, document, payload);
			});

			it('OBL-CLI2 plan: escapes a PostgreSQL persistence trigger payload on its command exception path', async () => {
				const schema = testSchema('cli2_plan');
				await provision(schema);
				const db = process.env.DATABASE_URL;
				if (!db) throw new Error('DATABASE_URL is required for CLI E2E');
				const payload = controlPayload();
				await installPgControlDdlTrigger({ schema, payload });
				const completed = spawnCli([
					'plan',
					await cliSchemaFile(),
					'--db',
					db,
					'--schema',
					schema,
					'--format',
					'json',
				]);
				expect(completed.status).toBe(1);
				const document = cliFailureDocument(completed);
				expect(document).toMatchObject({ error: expect.any(String) });
				expectEscapedPgControl(completed, document, payload);
			});

			it('OBL-CLI2 recover: escapes a PostgreSQL marker-read RLS payload on its command exception path', async () => {
				const { planned, schema } = await openedCliReconcile('cli2_recover');
				const payload = controlPayload();
				await installPgControlReadPolicy({
					schema,
					table: DBSP_LEDGER_MARKER_TABLE,
					payload,
				});
				const completed = spawnCli([
					'recover',
					planned.runId,
					'--db',
					await cliReadRole({ db: planned.db, schema }),
					'--plan-digest',
					planned.planDigest,
					'--format',
					'json',
				]);
				expect(completed.status).not.toBe(0);
				const document = cliFailureDocument(completed);
				expect(document.outcome).toBe('recovery-failed');
				expectEscapedPgControl(completed, document, payload);
			});

			it('OBL-CLI2 reconcile: escapes a PostgreSQL resolution trigger payload on its command exception path', async () => {
				const { planned, schema } = await openedCliReconcile('cli2_rec');
				const payload = controlPayload();
				await installPgControlResolutionPolicy({
					schema,
					payload,
				});
				const completed = spawnCli([
					'reconcile',
					planned.runId,
					'--db',
					await cliReadRole({
						db: planned.db,
						schema,
						writeLedgerEvent: true,
					}),
					'--format',
					'json',
				]);
				expect(completed.status).toBe(1);
				const document = cliFailureDocument(completed);
				expect(document).toMatchObject({
					outcome: 'reconcile-unresolved',
					detail: expect.any(String),
				});
				expectEscapedPgControl(completed, document, payload);
			});

			it('OBL-CLI2 release: escapes a PostgreSQL release trigger payload on its command exception path', async () => {
				const schema = testSchema('cli2_release');
				await provision(schema);
				const pool = await getTestPool();
				await pool.query(
					`CREATE TYPE ${quoteIdent(schema)}.${quoteIdent('status')} AS ENUM ('active')`,
				);
				const planned = await planEnumAdd(schema);
				await expect(
					runApply(
						planned.runId,
						{
							db: planned.db,
							planDigest: planned.planDigest,
							accept: planned.plan.assumptions.map(
								(assumption) => assumption.class,
							),
						},
						pool,
					),
				).resolves.toMatchObject({ outcome: 'completed' });
				const payload = controlPayload();
				await installPgControlInsertTrigger({
					schema,
					tableSchema: schema,
					table: DBSP_LEDGER_EVENT_TABLE,
					payload,
				});
				const completed = spawnCli([
					'release',
					'enum:status',
					'--db',
					planned.db,
					'--schema',
					schema,
					'--format',
					'json',
				]);
				expect(completed.status).toBe(1);
				const document = cliFailureDocument(completed);
				expect(document.outcome).toBe('release-unavailable');
				expectEscapedPgControl(completed, document, payload);
			});
		});
	});
});
