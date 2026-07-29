/**
 * dbsp plan — prove a transition and, unless previewing, retain it for a later
 * apply command.  This command intentionally stops before execution.
 */

import {
	createPgsqlAdapter,
	createPgTransitionLessor,
	createPgTransitionPack,
	createPgTransitionRunPersister,
	ensureTransitionJournal,
	escapeDiagnosticText,
	readPgObservationContextFromLessor,
} from '@dbsp/adapter-pgsql';
import {
	createComparator,
	createPackRegistry,
	createProver,
	createTransitionRunMetadata,
	type InProcessProvenPlan,
	type PackRegistry,
} from '@dbsp/core';
import type {
	CompareOutcome,
	ModelIR,
	ObservationContext,
	PlanAssessment,
	TransitionRunMetadata,
} from '@dbsp/types';
import { Command } from 'commander';
import type { Pool } from 'pg';
import { createDbConnection } from '../utils/db-utils.js';
import { type LoadedSchema, loadSchema } from '../utils/schema-loader.js';

export type PlanFormat = 'sql' | 'json';
export type PlanPersistenceState = boolean | 'indeterminate';

export interface PlanOptions {
	readonly db: string;
	readonly schemaFile: string;
	readonly schema?: string;
	readonly dryRun?: boolean;
	readonly format?: PlanFormat;
}

export interface PlanResult {
	readonly compareKind: CompareOutcome['kind'];
	readonly proveKind: 'proven' | 'no-drift' | 'blocked' | 'inapplicable';
	readonly assessment: PlanAssessment;
	/** true is durable, false was not attempted, and indeterminate may have committed. */
	readonly persisted: PlanPersistenceState;
	readonly runId: string | null;
	readonly planDigest: string | null;
	readonly plan?: InProcessProvenPlan;
	readonly sql?: string;
}

export class PlanPersistenceIndeterminateError extends Error {
	readonly runId: string;
	readonly result: PlanResult;
	readonly persistenceError: unknown;
	readonly cleanup: CleanupFailure;

	constructor(
		result: PlanResult,
		persistenceError: unknown,
		cleanup: CleanupFailure = noCleanupFailure,
	) {
		const cause =
			cleanup.kind === 'failed'
				? new AggregateError(
						[persistenceError, cleanup.error],
						'persistence and connection release both failed',
					)
				: persistenceError;
		super(
			`persistence indeterminate; inspect run ${result.runId}: ${escapeDiagnosticText(describeThrown(persistenceError))}`,
			{ cause },
		);
		this.name = 'PlanPersistenceIndeterminateError';
		this.runId = result.runId ?? '';
		this.result = result;
		this.persistenceError = persistenceError;
		this.cleanup = cleanup;
	}
}

/** A completed plan outcome whose connection release failed afterwards. */
export class PlanCleanupError extends Error {
	constructor(
		readonly result: PlanResult,
		readonly cleanupError: unknown,
	) {
		super(
			`connection release failed after the plan outcome was determined: ${escapeDiagnosticText(describeThrown(cleanupError))}`,
			{ cause: cleanupError },
		);
		this.name = 'PlanCleanupError';
	}
}

/** A planning failure whose declared connection release also failed. */
class PlanOperationAndCleanupError extends AggregateError {
	constructor(
		readonly operationError: unknown,
		readonly cleanupError: unknown,
	) {
		super(
			[operationError, cleanupError],
			'planning and connection release both failed',
			{ cause: operationError },
		);
		this.name = 'PlanOperationAndCleanupError';
	}
}

type PlanPool = Pool;

/** A release rejection is distinct from its rejection value, including undefined. */
type CleanupFailure =
	| { readonly kind: 'not-failed' }
	| { readonly kind: 'failed'; readonly error: unknown };

const noCleanupFailure: CleanupFailure = { kind: 'not-failed' };

/**
 * A planning connection together with the action that returns its resource.
 *
 * The caller that supplies the pool decides whether it is owned, shared, or
 * otherwise managed; runPlan only invokes this declared release path.
 */
export interface PlanConnection {
	readonly pool: PlanPool;
	readonly release: () => Promise<void>;
}

export interface PlanDeps {
	readonly createDbConnection: (db: string) => Promise<PlanConnection>;
	readonly loadSchema: (path: string) => Promise<LoadedSchema>;
	readonly ensureTransitionJournal: (pool: PlanPool) => Promise<void>;
	readonly loadCurrent: (pool: PlanPool, schema?: string) => Promise<ModelIR>;
	readonly readContext: (
		pool: PlanPool,
		schema?: string,
	) => Promise<ObservationContext>;
	readonly createPlanner: (loaded: LoadedSchema) => PlanPlanner;
	readonly persist: (
		pool: PlanPool,
		run: TransitionRunMetadata,
		plan: InProcessProvenPlan,
	) => Promise<void>;
}

export interface PlanPlanner {
	readonly compare: (
		desired: ModelIR,
		current: ModelIR,
		context: ObservationContext,
	) => CompareOutcome;
	readonly prove: (
		compare: CompareOutcome,
		pool: PlanPool,
		context: ObservationContext,
	) => ReturnType<ReturnType<typeof createProver>['prove']>;
	readonly render: (
		plan: InProcessProvenPlan,
		context: ObservationContext,
	) => string;
}

function equivalenceContext(context: ObservationContext) {
	return {
		engine: context.engine,
		...(context.databaseId ? { databaseId: context.databaseId } : {}),
		...(context.targetSchema ? { targetSchema: context.targetSchema } : {}),
		...(context.searchPath ? { searchPath: context.searchPath } : {}),
		proofObservationContext: context,
	};
}

const defaultPlanDeps: PlanDeps = {
	async createDbConnection(db) {
		const { pool } = await createDbConnection(db);
		return { pool, release: () => pool.end() };
	},
	loadSchema,
	ensureTransitionJournal,
	async loadCurrent(pool, schema) {
		return createPgsqlAdapter(pool).introspect(
			schema === undefined ? {} : { schema },
		);
	},
	async readContext(pool, schema) {
		return readPgObservationContextFromLessor(
			createPgTransitionLessor(pool),
			schema,
		);
	},
	createPlanner(loaded) {
		const registry = createPackRegistry([
			createPgTransitionPack({
				...(loaded.dbCasing ? { dbCasing: loaded.dbCasing } : {}),
			}),
		]);
		const comparator = createComparator(registry);
		const prover = createProver(registry);
		return {
			compare: (desired, current, context) =>
				comparator.compare(desired, current, equivalenceContext(context)),
			prove: (compare, pool, context) =>
				prover.prove(compare, createPgTransitionLessor(pool), context),
			render: (plan, context) => renderProvenPlanSql(registry, plan, context),
		};
	},
	async persist(pool, run, plan) {
		await createPgTransitionRunPersister(pool).persist(run, plan);
	},
};

function resolvedDeps(overrides?: Partial<PlanDeps>): PlanDeps {
	return { ...defaultPlanDeps, ...overrides };
}

function describeThrown(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Render only a complete proven plan. This is an inspection view, never apply input. */
export function renderProvenPlanSql(
	registry: PackRegistry,
	plan: InProcessProvenPlan,
	context: ObservationContext,
): string {
	const statements = plan.steps.map((step) => {
		const resolution = registry.resolveOperation(step.operation);
		if (!resolution.ok || !resolution.semantics.renderPlanSql) {
			throw new Error(
				`no SQL renderer is registered for proven operation ${step.operation.operationKind.name}`,
			);
		}
		return resolution.semantics.renderPlanSql(step.operation, context);
	});
	return [
		'-- dbsp transition plan view; apply accepts a persisted run id, never this SQL.',
		...statements.map((statement) => `${statement};`),
	].join('\n');
}

export async function runPlan(
	options: PlanOptions,
	overrides?: Partial<PlanDeps>,
): Promise<PlanResult> {
	const deps = resolvedDeps(overrides);
	const format = options.format ?? 'sql';
	if (format !== 'sql' && format !== 'json') {
		throw new Error(`unsupported plan format ${format}; expected sql or json`);
	}
	const loaded = await deps.loadSchema(options.schemaFile);
	const connection = await deps.createDbConnection(options.db);
	const { pool } = connection;
	let result: PlanResult | undefined;
	let operationError: unknown;
	let failed = false;
	try {
		await deps.ensureTransitionJournal(pool);
		const current = await deps.loadCurrent(pool, options.schema);
		const context = await deps.readContext(pool, options.schema);
		const planner = deps.createPlanner(loaded);
		const compare = planner.compare(loaded.model, current, context);
		const prove = await planner.prove(compare, pool, context);

		if (prove.kind === 'proven') {
			// Order is intentional: an id exists before an indeterminate write, while
			// rendering happens before a durable record can be stranded unseen.
			const run = createTransitionRunMetadata(prove.plan);
			const proofContext = prove.plan.observations.find(
				(observation) => observation.role === 'evidence',
			)?.context;
			if (!proofContext) {
				throw new Error(
					'internal error: minted proven plan has no evidence observation context',
				);
			}
			const sql = planner.render(prove.plan, proofContext);
			if (!options.dryRun) {
				try {
					await deps.persist(pool, run, prove.plan);
				} catch (error) {
					throw new PlanPersistenceIndeterminateError(
						{
							compareKind: compare.kind,
							proveKind: prove.kind,
							assessment: prove.assessment,
							persisted: 'indeterminate',
							runId: run.runId,
							planDigest: run.planDigest,
						},
						error,
					);
				}
			}
			result = {
				compareKind: compare.kind,
				proveKind: prove.kind,
				assessment: prove.assessment,
				persisted: !options.dryRun,
				runId: options.dryRun ? null : run.runId,
				planDigest: run.planDigest,
				plan: prove.plan,
				sql,
			};
		}

		if (prove.kind === 'no-drift') {
			result = {
				compareKind: compare.kind,
				proveKind: prove.kind,
				assessment: prove.assessment,
				persisted: false,
				runId: null,
				planDigest: null,
			};
		} else if (prove.kind !== 'proven') {
			result = {
				compareKind: compare.kind,
				proveKind: prove.kind,
				assessment: prove.assessment,
				persisted: false,
				runId: null,
				planDigest: null,
			};
		}
	} catch (error) {
		failed = true;
		operationError = error;
	}

	let cleanup: CleanupFailure = noCleanupFailure;
	try {
		await connection.release();
	} catch (error) {
		cleanup = { kind: 'failed', error };
	}

	if (failed) {
		if (operationError instanceof PlanPersistenceIndeterminateError) {
			throw new PlanPersistenceIndeterminateError(
				operationError.result,
				operationError.persistenceError,
				cleanup,
			);
		}
		if (cleanup.kind === 'failed') {
			throw new PlanOperationAndCleanupError(operationError, cleanup.error);
		}
		throw operationError;
	}
	if (cleanup.kind === 'failed') {
		throw new PlanCleanupError(result as PlanResult, cleanup.error);
	}
	return result as PlanResult;
}

export function formatPlanJson(result: PlanResult, dryRun: boolean) {
	return {
		compareKind: result.compareKind,
		proveKind: result.proveKind,
		assessment: result.assessment,
		persisted: result.persisted,
		runId: result.runId,
		planDigest: result.planDigest,
		...(result.plan ? { plan: result.plan } : {}),
		...(result.sql ? { sql: result.sql } : {}),
		...(dryRun && result.proveKind === 'proven'
			? { preview: 'non-executable; no durable dbsp record' }
			: {}),
	};
}

export function formatPlanHuman(result: PlanResult, dryRun: boolean): string {
	if (result.proveKind === 'proven') {
		return [
			dryRun
				? 'Proven transition preview (non-executable; no durable dbsp record):'
				: 'Proven transition plan:',
			// Every operation renderer converges on result.sql before this human-only
			// view, so database-sourced SQL cannot bypass terminal escaping here.
			...(result.sql === undefined ? [] : [escapeDiagnosticText(result.sql)]),
			dryRun
				? `Preview digest: ${result.planDigest}`
				: `Run id: ${result.runId}\nPlan digest: ${result.planDigest}`,
		]
			.filter((line): line is string => line !== undefined)
			.join('\n');
	}
	if (result.proveKind === 'no-drift') {
		return 'Database already matches the target; nothing was persisted.';
	}
	return `No durable plan was created.\n${escapeDiagnosticText(JSON.stringify(result.assessment, null, 2))}`;
}

function preservedPlanResult(
	error: unknown,
	fallback?: PlanResult,
): PlanResult | undefined {
	if (error instanceof PlanPersistenceIndeterminateError) return error.result;
	if (error instanceof PlanCleanupError) return error.result;
	return fallback;
}

function primaryPlanError(error: unknown): unknown {
	if (error instanceof PlanPersistenceIndeterminateError) {
		return error.persistenceError;
	}
	if (error instanceof PlanCleanupError) return error.cleanupError;
	if (error instanceof PlanOperationAndCleanupError) {
		return error.operationError;
	}
	return error;
}

function cleanupFailure(error: unknown): CleanupFailure {
	if (error instanceof PlanPersistenceIndeterminateError) {
		return error.cleanup;
	}
	if (error instanceof PlanCleanupError) {
		return { kind: 'failed', error: error.cleanupError };
	}
	if (error instanceof PlanOperationAndCleanupError) {
		return { kind: 'failed', error: error.cleanupError };
	}
	return noCleanupFailure;
}

/** The stable error contract for both planning and post-outcome failures. */
export function formatPlanFailureJson(error: unknown, fallback?: PlanResult) {
	const result = preservedPlanResult(error, fallback);
	const cleanupError = cleanupFailure(error);
	return {
		compareKind: result?.compareKind ?? null,
		proveKind: result?.proveKind ?? null,
		assessment: result?.assessment ?? null,
		persisted: result?.persisted ?? false,
		runId: result?.runId ?? null,
		planDigest: result?.planDigest ?? null,
		error: describeThrown(primaryPlanError(error)),
		...(cleanupError.kind === 'not-failed'
			? {}
			: { cleanupError: describeThrown(cleanupError.error) }),
	};
}

function formatPlanFailureHuman(error: unknown, fallback?: PlanResult): string {
	const result = preservedPlanResult(error, fallback);
	const fields = result
		? [
				result.persisted === true
					? 'A durable plan was created before this failure.'
					: result.persisted === 'indeterminate'
						? 'Persistence is indeterminate; inspect the minted run before retrying.'
						: 'No durable plan was created.',
				...(result.runId ? [`Run id: ${result.runId}`] : []),
				...(result.planDigest ? [`Plan digest: ${result.planDigest}`] : []),
			]
		: [];
	const cleanupError = cleanupFailure(error);
	return [
		`❌ ${escapeDiagnosticText(describeThrown(primaryPlanError(error)))}`,
		...fields,
		...(cleanupError.kind === 'not-failed'
			? []
			: [
					`Connection release also failed: ${escapeDiagnosticText(describeThrown(cleanupError.error))}`,
				]),
	].join('\n');
}

function printHumanResult(result: PlanResult, dryRun: boolean): void {
	console.log(formatPlanHuman(result, dryRun));
}

export function exitCodeForPlanResult(result: PlanResult): 0 | 1 {
	return result.proveKind === 'blocked' || result.proveKind === 'inapplicable'
		? 1
		: 0;
}

export const planCommand = new Command('plan')
	.description('Prove and persist a transition plan without applying it')
	.argument('<schema-file>', 'Schema DSL file')
	.requiredOption('-d, --db <url>', 'Database connection URL (required)')
	.option('--schema <name>', 'Database schema name', 'public')
	.option('--dry-run', 'Prove and render without persisting a transition run')
	.option('--format <format>', 'Output format: sql or json', 'sql')
	.exitOverride()
	// The root handler owns parse-error presentation. Suppress Commander's
	// eager stderr write so --format json remains a single JSON document.
	.configureOutput({ writeErr: () => {} })
	.action(
		async (
			schemaFile: string,
			options: {
				db: string;
				schema?: string;
				dryRun?: boolean;
				format?: PlanFormat;
			},
		) => {
			let result: PlanResult | undefined;
			try {
				result = await runPlan({ ...options, schemaFile });
				if (options.format === 'json') {
					console.log(
						JSON.stringify(
							formatPlanJson(result, options.dryRun === true),
							null,
							2,
						),
					);
				} else {
					printHumanResult(result, options.dryRun === true);
				}
				process.exitCode = exitCodeForPlanResult(result);
			} catch (error) {
				if (options.format === 'json') {
					console.log(
						JSON.stringify(formatPlanFailureJson(error, result), null, 2),
					);
				} else {
					console.error(formatPlanFailureHuman(error, result));
				}
				process.exitCode = 1;
			}
		},
	);
