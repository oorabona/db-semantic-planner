import {
	ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
	MANUAL_SQL_OPERATION_KIND,
} from '@dbsp/adapter-pgsql';
import type { InProcessProvenPlan, TransitionPack } from '@dbsp/core';
import {
	createPackRegistry,
	observationContextDigest,
	transitionPlanDigest,
} from '@dbsp/core';
import type {
	CompareOutcome,
	ModelIR,
	ObservationContext,
	OperationKindRef,
	PlanAssessment,
} from '@dbsp/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildPgExecutionContract,
	executionTargetNamespaces,
	exitCodeForPlanResult,
	formatPlanFailureJson,
	formatPlanHuman,
	formatPlanJson,
	PlanCleanupError,
	type PlanDeps,
	PlanPersistenceIndeterminateError,
	type PlanResult,
	renderProvenPlanSql,
	runPlan,
} from './plan.js';

const initialContext: ObservationContext = {
	engine: 'postgresql',
	engineVersion: '180000',
	databaseId: 'initial',
	capabilities: [],
	privileges: [],
	sessionConfiguration: {},
	extensions: {},
};

const proofContext: ObservationContext = {
	...initialContext,
	databaseId: 'proof',
};

const model = {
	tables: new Map(),
	relations: new Map(),
	enums: new Map(),
	getTable: () => undefined,
	getRelation: () => undefined,
	getRelationsFrom: () => [],
	getRelationsTo: () => [],
	isAmbiguous: () => ({ ambiguous: false, options: [] }),
} as unknown as ModelIR;

const applicable: PlanAssessment = {
	decision: 'applicable',
	assurance: 'established',
	lifecycle: 'planned',
	continuation: 'none',
	reasons: [],
};

const blocked: PlanAssessment = {
	decision: 'blocked',
	assurance: 'unproven',
	lifecycle: 'planned',
	continuation: 'replan-required',
	reasons: [],
};

function provenPlan(operation?: {
	readonly ref: string;
	readonly name: string;
	readonly operationKind?: OperationKindRef;
	readonly payload?: unknown;
}): InProcessProvenPlan {
	return {
		observations: [
			{
				id: 'evidence:proof',
				role: 'evidence',
				request: { kind: 'test', scope: [] },
				context: proofContext,
				conclusion: { kind: 'test' },
			},
		],
		claims: [],
		assumptions: [],
		preconditions: [],
		segments: [],
		steps:
			operation === undefined
				? []
				: [
						{
							stepId: `step:${operation.name}`,
							operation: {
								ref: operation.ref,
								operationKind: operation.operationKind ?? {
									artifact: { id: 'postgresql.test', version: '1.0.0' },
									name: operation.name,
								},
								payload: operation.payload ?? {},
							},
						},
					],
		postconditions: [],
	} as unknown as InProcessProvenPlan;
}

function dependencies(compare: CompareOutcome, prove: unknown) {
	const pool = { end: vi.fn().mockResolvedValue(undefined) };
	const persist = vi.fn().mockResolvedValue(undefined);
	const render = vi
		.fn()
		.mockReturnValue('ALTER TYPE "public"."status" ADD VALUE \'pending\';');
	const planner = {
		compare: vi.fn().mockReturnValue(compare),
		prove: vi.fn().mockResolvedValue(prove),
		render,
	};
	const createPlanner = vi.fn().mockReturnValue(planner);
	const release = vi.fn().mockResolvedValue(undefined);
	return {
		createPlanner,
		createDbConnection: vi.fn().mockResolvedValue({ pool, release }),
		loadSchema: vi.fn().mockResolvedValue({
			model,
			definition: {},
			tableNames: [],
		}),
		ensureTransitionJournal: vi.fn().mockResolvedValue(undefined),
		loadCurrent: vi.fn().mockResolvedValue(model),
		readContext: vi.fn().mockResolvedValue(initialContext),
		captureTargetIdentity: vi.fn().mockResolvedValue({
			systemIdentifier: 'test-system',
			databaseOid: '1',
			namespaces: [{ name: 'public', oid: '2200' }],
		}),
		persist,
		buildExecutionContract: vi.fn().mockResolvedValue({
			version: 1,
			requirements: [
				{
					kind: 'postgresql.physical-target',
					mode: 'must-match',
					systemIdentifier: 'test-system',
					databaseOid: '1',
					namespaces: [{ name: 'public', oid: '2200' }],
				},
			],
		}),
		planner,
		render,
	};
}

async function run(
	compare: CompareOutcome,
	prove: unknown,
	overrides: Partial<PlanDeps> = {},
) {
	const deps = dependencies(compare, prove);
	Object.assign(deps, overrides);
	const result = await runPlan(
		{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
		deps,
	);
	return { deps, result };
}

afterEach(() => vi.restoreAllMocks());

describe('dbsp plan outcomes', () => {
	it('mutation: capturing identity after introspection can bind evidence to a replacement target', async () => {
		const deps = dependencies(
			{ kind: 'no-drift', claimedInvariant: { kind: 'test', scope: [] } },
			{ kind: 'no-drift', claim: {}, assessment: applicable },
		);
		const events: string[] = [];
		deps.captureTargetIdentity.mockImplementation(async () => {
			events.push('capture');
			return {
				systemIdentifier: 'test-system',
				databaseOid: '1',
				namespaces: [{ name: 'public', oid: '2200' }],
			};
		});
		deps.loadCurrent.mockImplementation(async () => {
			events.push('introspect');
			return model;
		});
		deps.readContext.mockImplementation(async () => {
			events.push('context');
			return initialContext;
		});
		await runPlan(
			{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
			deps,
		);
		expect(events).toEqual(['capture', 'introspect', 'context']);
	});
	it('mutation: omitting the requested schema when a plan has no step-derived namespace changes the persisted target', () => {
		expect(executionTargetNamespaces(provenPlan(), 'tenant')).toEqual([
			'tenant',
		]);
	});

	it.each([
		[
			'unsupported',
			{ kind: 'unsupported', changes: [] },
			{ kind: 'blocked', assessment: blocked },
		],
		[
			'unknown after the prover evidence retry',
			{ kind: 'unknown', recognitions: [], obligations: [] },
			{ kind: 'blocked', assessment: blocked },
		],
		[
			'uncomposable',
			{
				kind: 'uncomposable',
				candidates: [],
				recognitions: [],
				obligations: [],
				detail: 'fragments conflict',
			},
			{ kind: 'blocked', assessment: blocked },
		],
		[
			'ambiguous',
			{ kind: 'ambiguous', candidates: [] },
			{ kind: 'blocked', assessment: blocked },
		],
		[
			'inapplicable',
			{ kind: 'transitions', candidates: [], obligations: [] },
			{
				kind: 'inapplicable',
				assessment: {
					...blocked,
					decision: 'inapplicable',
					assurance: 'established',
					continuation: 'none',
				},
			},
		],
	] as const)('%s is non-persistent and reports a typed refusal', async (_name, compare, prove) => {
		const { deps, result } = await run(compare, prove);
		expect(result.persisted).toBe(false);
		expect(result.runId).toBeNull();
		expect(result.planDigest).toBeNull();
		expect(deps.persist).not.toHaveBeenCalled();
		expect(['blocked', 'inapplicable']).toContain(result.proveKind);
		expect(exitCodeForPlanResult(result)).toBe(1);
		expect(formatPlanHuman(result, false)).toContain(
			'No durable plan was created.',
		);
	});

	it('no-drift exits without a run or plan row and says nothing was persisted', async () => {
		const { deps, result } = await run(
			{ kind: 'no-drift', claimedInvariant: { kind: 'test', scope: [] } },
			{ kind: 'no-drift', claim: {}, assessment: applicable },
		);
		expect(result.proveKind).toBe('no-drift');
		expect(result.persisted).toBe(false);
		expect(deps.persist).not.toHaveBeenCalled();
		expect(exitCodeForPlanResult(result)).toBe(0);
		expect(formatPlanHuman(result, false)).toBe(
			'Database already matches the target; nothing was persisted.',
		);
	});

	it('persists only a proven plan and binds its run to the plan evidence context', async () => {
		const plan = provenPlan();
		const { deps, result } = await run(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan, assessment: applicable },
		);
		expect(result.persisted).toBe(true);
		expect(result.runId).toMatch(/^dbsp-/u);
		expect(deps.persist).toHaveBeenCalledOnce();
		expect(exitCodeForPlanResult(result)).toBe(0);
		expect(formatPlanHuman(result, false)).toContain(`Run id: ${result.runId}`);
		const runMetadata = deps.persist.mock.calls[0]?.[1];
		expect(runMetadata.targetContextDigest).toBe(
			observationContextDigest(proofContext),
		);
		expect(runMetadata.targetContextDigest).not.toBe(
			observationContextDigest(initialContext),
		);
		expect(result.plan?.declarations).toMatchObject({
			version: 1,
			declarations: [],
			digest: expect.any(String),
		});
		expect(runMetadata.planDigest).toBe(transitionPlanDigest(result.plan!));
	});

	it('SC-25: rejects a non-canonicalizable declaration before comparison or persistence', async () => {
		const deps = dependencies(
			{ kind: 'no-drift', claimedInvariant: { kind: 'test', scope: [] } },
			{ kind: 'no-drift', claim: {}, assessment: applicable },
		);
		deps.loadSchema.mockResolvedValue({
			model: {
				...model,
				tables: new Map([
					[
						'users',
						{
							name: 'users',
							columns: [
								{
									name: 'createdAt',
									type: 'datetime',
									nullable: false,
									default: () => 'now()',
								},
							],
							foreignKeys: [],
							indexes: [],
						},
					],
				]),
			},
			definition: {},
			tableNames: ['users'],
		});
		await expect(
			runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			),
		).rejects.toThrow(/schema\.tables\["users"\]\.columns\[0\]\.default/);
		expect(deps.createPlanner).not.toHaveBeenCalled();
		expect(deps.persist).not.toHaveBeenCalled();
	});

	it('mutation: printing a digest other than the one durable apply recomputes disconnects review from execution', async () => {
		const { result } = await run(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		expect(result.plan).toBeDefined();
		expect(result.planDigest).toBe(transitionPlanDigest(result.plan!));
		expect(formatPlanHuman(result, false)).toContain(
			`Plan digest: ${result.planDigest}`,
		);
	});

	it('uses one planner seam for compare, prove, and render', async () => {
		const { deps } = await run(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		expect(deps.createPlanner).toHaveBeenCalledOnce();
		expect(deps.planner.compare).toHaveBeenCalledOnce();
		expect(deps.planner.prove).toHaveBeenCalledOnce();
		expect(deps.planner.render).toHaveBeenCalledOnce();
	});

	it('releases an injected connection without closing its pool', async () => {
		const pool = { end: vi.fn().mockResolvedValue(undefined) };
		const release = vi.fn().mockResolvedValue(undefined);
		const { result } = await run(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
			{
				createDbConnection: vi.fn().mockResolvedValue({ pool, release }),
			},
		);

		expect(result.proveKind).toBe('proven');
		expect(release).toHaveBeenCalledOnce();
		expect(pool.end).not.toHaveBeenCalled();
	});

	it('dry-run still proves and renders but writes no dbsp_meta run row', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const result = await runPlan(
			{
				db: 'postgres://localhost/test',
				schemaFile: 'schema.ts',
				dryRun: true,
			},
			deps,
		);
		expect(deps.planner.prove).toHaveBeenCalledOnce();
		expect(deps.render).toHaveBeenCalledOnce();
		expect(deps.persist).not.toHaveBeenCalled();
		expect(result.persisted).toBe(false);
		expect(result.runId).toBeNull();
		expect(result.planDigest).not.toBeNull();
		expect(formatPlanHuman(result, true)).toContain('non-executable');
	});

	it.each([
		[
			'ManualSql',
			'postgresql:manual-sql:users',
			MANUAL_SQL_OPERATION_KIND,
			{
				statement: { text: 'ALTER TABLE public.users ADD COLUMN flag boolean' },
			},
			false,
		],
		[
			'ManualSql',
			'postgresql:manual-sql:users',
			MANUAL_SQL_OPERATION_KIND,
			{
				statement: { text: 'ALTER TABLE public.users ADD COLUMN flag boolean' },
			},
			true,
		],
		[
			'AttachLogicalIdentity',
			'postgresql:logical-identity-adopt:users',
			ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
			{ schema: 'public', table: 'users', logicalId: 'logical.table.users' },
			false,
		],
		[
			'AttachLogicalIdentity',
			'postgresql:logical-identity-adopt:users',
			ATTACH_LOGICAL_IDENTITY_OPERATION_KIND,
			{ schema: 'public', table: 'users', logicalId: 'logical.table.users' },
			true,
		],
	] as const)('mutation: resolving an ineligible %s namespace before the typed contract refusal makes plan fail uncaught (dry-run: %s)', async (operationName, operationRef, operationKind, payload, dryRun) => {
		const plan = provenPlan({
			ref: operationRef,
			name: operationName,
			operationKind,
			payload,
		});
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan, assessment: applicable },
		);
		const release = vi.fn();
		const client = {
			release,
			query: vi.fn(async (sql: string) => {
				if (sql === "SET client_encoding TO 'UTF8'") return { rows: [] };
				if (sql === 'SHOW client_encoding')
					return { rows: [{ client_encoding: 'UTF8' }] };
				if (sql.startsWith('SELECT (pg_catalog.pg_control_system())'))
					return { rows: [{ system_identifier: 'test-system' }] };
				if (sql.startsWith('SELECT d.oid::text'))
					return { rows: [{ database_oid: '1' }] };
				if (sql.startsWith('SELECT n.nspname'))
					return { rows: [{ name: 'public', oid: '2200' }] };
				if (sql.startsWith("SELECT current_setting('search_path')"))
					return {
						rows: [
							{
								search_path: 'public',
								client_encoding: 'UTF8',
								timezone: 'UTC',
							},
						],
					};
				throw new Error(`unexpected query ${sql}`);
			}),
		};
		const pool = { connect: vi.fn().mockResolvedValue(client) };
		deps.createDbConnection.mockResolvedValue({
			pool: pool as never,
			release: vi.fn().mockResolvedValue(undefined),
		});
		deps.buildExecutionContract.mockImplementation(buildPgExecutionContract);
		const result = await runPlan(
			{
				db: 'postgres://localhost/test',
				schemaFile: 'schema.ts',
				dryRun,
			},
			deps,
		);

		expect(result).toMatchObject({
			proveKind: 'blocked',
			persisted: false,
			runId: null,
			planDigest: null,
		});
		expect(result.assessment.reasons[0]).toMatchObject({
			code: 'unsupported-transition',
			detail: expect.stringContaining(operationName),
		});
		expect(formatPlanHuman(result, dryRun)).toContain(operationName);
		expect(exitCodeForPlanResult(result)).toBe(1);
		expect(deps.planner.render).not.toHaveBeenCalled();
		expect(deps.persist).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});

	it('a rendering failure happens before persistence and leaves no run behind', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		deps.planner.render.mockImplementation(() => {
			throw new Error('renderer failed');
		});
		await expect(
			runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			),
		).rejects.toThrow('renderer failed');
		expect(deps.persist).not.toHaveBeenCalled();
	});

	it('refuses a proven operation whose runtime has no plan renderer', () => {
		const artifact = { id: 'test.plan-view', version: '1.0.0' };
		const operationKind = { artifact, name: 'NoPlanRenderer' };
		const registry = createPackRegistry([
			{
				rules: [],
				operationSemantics: [
					{
						artifact,
						operationKind,
						buildFingerprints: vi.fn(),
					},
				],
				issuer: { artifact },
			} as unknown as TransitionPack,
		]);
		const plan = {
			...provenPlan(),
			steps: [
				{
					operation: {
						ref: 'step:missing-renderer',
						operationKind,
						payload: {},
					},
				},
			],
		} as unknown as InProcessProvenPlan;

		expect(() => renderProvenPlanSql(registry, plan, proofContext)).toThrow(
			'no SQL renderer is registered for proven operation NoPlanRenderer',
		);
	});

	it('reports an indeterminate persistence with the already-minted run id', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const persistenceError = Object.assign(new Error('connection lost'), {
			code: '08006',
		});
		deps.persist.mockRejectedValue(persistenceError);
		let caught: unknown;
		try {
			await runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PlanPersistenceIndeterminateError);
		const indeterminate = caught as PlanPersistenceIndeterminateError;
		expect(indeterminate.cause).toBe(persistenceError);
		expect(indeterminate.persistenceError).toBe(persistenceError);
		expect(persistenceError.code).toBe('08006');
		expect(formatPlanFailureJson(indeterminate)).toMatchObject({
			compareKind: 'transitions',
			proveKind: 'proven',
			assessment: applicable,
			persisted: 'indeterminate',
			runId: indeterminate.runId,
			planDigest: indeterminate.result.planDigest,
			error: 'connection lost',
		});
		expect(indeterminate.result.runId).toMatch(/^dbsp-/u);
	});

	it('preserves a successful persistence outcome when release rejects [mutation: replace it with persisted false]', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const releaseError = new Error('release failed');
		Object.assign(deps, {
			createDbConnection: vi.fn().mockResolvedValue({
				pool: {},
				release: vi.fn().mockRejectedValue(releaseError),
			}),
		});

		let caught: unknown;
		try {
			await runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PlanCleanupError);
		const cleanup = caught as PlanCleanupError;
		expect(cleanup.cause).toBe(releaseError);
		expect(cleanup.result).toMatchObject({
			persisted: true,
			proveKind: 'proven',
		});
		expect(cleanup.result.runId).toMatch(/^dbsp-/u);
		expect(cleanup.result.planDigest).not.toBeNull();
		expect(formatPlanFailureJson(cleanup)).toMatchObject({
			persisted: true,
			runId: cleanup.result.runId,
			planDigest: cleanup.result.planDigest,
			error: 'release failed',
			cleanupError: 'release failed',
		});
	});

	it('preserves the indeterminate outcome when release also rejects [mutation: replace it with release error]', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const persistenceError = new Error('connection lost');
		const releaseError = new Error('release failed');
		deps.persist.mockRejectedValue(persistenceError);
		Object.assign(deps, {
			createDbConnection: vi.fn().mockResolvedValue({
				pool: {},
				release: vi.fn().mockRejectedValue(releaseError),
			}),
		});

		let caught: unknown;
		try {
			await runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PlanPersistenceIndeterminateError);
		const indeterminate = caught as PlanPersistenceIndeterminateError;
		expect(indeterminate.cause).toBeInstanceOf(AggregateError);
		expect((indeterminate.cause as AggregateError).errors).toEqual([
			persistenceError,
			releaseError,
		]);
		expect(formatPlanFailureJson(indeterminate)).toMatchObject({
			persisted: 'indeterminate',
			runId: indeterminate.runId,
			error: 'connection lost',
			cleanupError: 'release failed',
		});
	});

	it('retains an undefined release rejection as a cleanup failure [mutation: use undefined as no-cleanup sentinel]', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const persistenceError = new Error('connection lost');
		deps.persist.mockRejectedValue(persistenceError);
		Object.assign(deps, {
			createDbConnection: vi.fn().mockResolvedValue({
				pool: {},
				release: vi.fn().mockRejectedValue(undefined),
			}),
		});

		let caught: unknown;
		try {
			await runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(PlanPersistenceIndeterminateError);
		const indeterminate = caught as PlanPersistenceIndeterminateError;
		expect(indeterminate.cause).toBeInstanceOf(AggregateError);
		expect((indeterminate.cause as AggregateError).errors).toEqual([
			persistenceError,
			undefined,
		]);
		expect(formatPlanFailureJson(indeterminate)).toMatchObject({
			error: 'connection lost',
			cleanupError: 'undefined',
		});
	});

	it('does not report a foreign AggregateError as a cleanup failure [mutation: unwrap every AggregateError]', async () => {
		const deps = dependencies(
			{ kind: 'transitions', candidates: [], obligations: [] },
			{ kind: 'proven', plan: provenPlan(), assessment: applicable },
		);
		const release = vi.fn().mockResolvedValue(undefined);
		const connectionError = new AggregateError(
			[new Error('IPv6 refused'), new Error('IPv4 refused')],
			'all addresses failed',
		);
		deps.ensureTransitionJournal.mockRejectedValue(connectionError);
		Object.assign(deps, {
			createDbConnection: vi.fn().mockResolvedValue({ pool: {}, release }),
		});

		let caught: unknown;
		try {
			await runPlan(
				{ db: 'postgres://localhost/test', schemaFile: 'schema.ts' },
				deps,
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(connectionError);
		expect(release).toHaveBeenCalledOnce();
		const failure = formatPlanFailureJson(connectionError);
		expect(failure.error).toBe('all addresses failed');
		expect(failure).not.toHaveProperty('cleanupError');
	});

	it('escapes database diagnostic text for human output but not JSON [mutation: print raw diagnostic]', () => {
		const databaseError = new Error('bad\u001b[2J\u202Ename');
		const indeterminate = new PlanPersistenceIndeterminateError(
			{
				compareKind: 'transitions',
				proveKind: 'proven',
				assessment: applicable,
				persisted: 'indeterminate',
				runId: 'dbsp-test',
				planDigest: 'digest',
			},
			databaseError,
		);
		expect(indeterminate.message).toContain('bad\\u001b[2J\\u202ename');
		expect(indeterminate.message).not.toContain('\u001b');
		expect(formatPlanFailureJson(indeterminate).error).toBe(
			'bad\u001b[2J\u202Ename',
		);
		const human = formatPlanHuman(
			{
				compareKind: 'unsupported',
				proveKind: 'blocked',
				assessment: {
					...blocked,
					reasons: [
						{
							code: 'unsupported-transition',
							detail: 'refusal\u202Ereason',
							scope: [],
							changes: [],
						},
					],
				},
				persisted: false,
				runId: null,
				planDigest: null,
			},
			false,
		);
		expect(human).toContain('refusal\\u202ereason');
	});

	it('escapes a vendor-deparsed CHECK literal in the human SQL view but not JSON [mutation: print result.sql raw]', () => {
		const deparsedExpression = "CHECK ((status <> '\u001b[2J'))";
		const sql = `ALTER TABLE "tenant"."users" ADD CONSTRAINT "users_status_check" ${deparsedExpression}`;
		const result = {
			compareKind: 'transitions',
			proveKind: 'proven',
			assessment: applicable,
			persisted: false,
			runId: null,
			planDigest: 'digest',
			sql,
		} satisfies PlanResult;

		const human = formatPlanHuman(result, true);
		expect(human).toContain('\\u001b[2J');
		expect(human).not.toContain('\u001b');
		expect(JSON.parse(JSON.stringify(formatPlanJson(result, true))).sql).toBe(
			sql,
		);
	});

	it('retains a completed outcome if output formatting then fails [mutation: discard fallback result]', () => {
		const result = {
			compareKind: 'transitions' as const,
			proveKind: 'proven' as const,
			assessment: applicable,
			persisted: true as const,
			runId: 'dbsp-complete',
			planDigest: 'digest',
		};
		expect(
			formatPlanFailureJson(new Error('format failed'), result),
		).toMatchObject({
			persisted: true,
			runId: 'dbsp-complete',
			planDigest: 'digest',
			error: 'format failed',
		});
	});

	it('formats a refusal as parseable JSON with the stable fields', async () => {
		const { result } = await run(
			{ kind: 'unsupported', changes: [] },
			{ kind: 'blocked', assessment: blocked },
		);
		const parsed = JSON.parse(
			JSON.stringify(formatPlanJson(result, false)),
		) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			compareKind: 'unsupported',
			proveKind: 'blocked',
			persisted: false,
			runId: null,
			planDigest: null,
		});
		expect(parsed.assessment).toEqual(blocked);
	});
});
