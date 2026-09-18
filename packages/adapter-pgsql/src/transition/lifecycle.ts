import {
	acquireExclusiveTransitionLease,
	acquireTransitionLease,
	bindDeclarationSet,
	bindExecutionContract,
	createApplier,
	createComparator,
	createPackRegistry,
	createProver,
	createTransitionRunMetadata,
	declarationSetFromModel,
	type InProcessProvenPlan,
	validateDeclarationModel,
} from '@dbsp/core';
import type {
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	ExecutionContract,
	ModelIR,
	ObservationContext,
	PlanAssessment,
	PostgreSqlObservationTargetIdentity,
	ProvenPlanShape,
	TransitionRunJournal,
	TransitionRunMetadata,
	TransitionSessionClient,
} from '@dbsp/types';
import type { Pool } from 'pg';
import { getNamingPluginForDbCasing } from '../naming-plugin.js';
import {
	createPgExecutionContract,
	PgExecutionContractDerivationError,
	pgTargetIdentityMismatch,
	preparePgExecutionSession,
	readPgExecutionTargetFromClient,
} from './execution-contract.js';
import {
	createPgTransitionRunPersister,
	ensureTransitionJournal,
	readTransitionJournal,
} from './journal.js';
import {
	acquirePgTransitionClient,
	createPgTransitionLessor,
	withPgTransitionRunLock,
} from './lessor.js';
import { validatePgManagedLedgerCurrency } from './managed-outcome-runtime.js';
import { readPgObservationContextFromLessor } from './observation-issuer.js';
import { createPgTransitionPack } from './pack.js';

/** Reads the live schema from a short-lived adapter-owned PostgreSQL session. */
export type PgLiveSchemaReader = (
	client: TransitionSessionClient,
	schema: string | undefined,
) => Promise<ModelIR>;

export interface PlanPgTransitionRunOptions {
	readonly schema?: string;
	readonly dbCasing?: Parameters<typeof getNamingPluginForDbCasing>[0];
	/** False proves and binds a durable plan but leaves no journal record. */
	readonly persist?: boolean;
	/** Lets a caller prepare an inspection view before durable persistence. */
	readonly beforePersist?: (
		plan: InProcessProvenPlan,
		proofContext: ObservationContext,
	) => void | Promise<void>;
}

export type PgTransitionPlanResult =
	| {
			readonly kind: 'proven';
			readonly compare: CompareOutcome;
			readonly assessment: PlanAssessment;
			readonly plan: InProcessProvenPlan;
			readonly run: TransitionRunMetadata;
			readonly proofContext: ObservationContext;
	  }
	| {
			readonly kind: 'no-drift' | 'blocked' | 'inapplicable';
			readonly compare: CompareOutcome;
			readonly assessment: PlanAssessment;
	  };

/** The run id is available even when PostgreSQL cannot confirm persistence. */
export class PgTransitionRunPersistenceIndeterminateError extends Error {
	constructor(
		readonly run: TransitionRunMetadata,
		readonly compare: CompareOutcome,
		readonly assessment: PlanAssessment,
		readonly persistenceError: unknown,
	) {
		super('PostgreSQL transition-run persistence is indeterminate', {
			cause: persistenceError,
		});
		this.name = 'PgTransitionRunPersistenceIndeterminateError';
	}
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

/** The only planning-time namespace derivation; apply uses the stored clause. */
function executionTargetNamespaces(
	plan: InProcessProvenPlan,
	fallbackSchema: string | undefined,
): readonly string[] {
	const namespaces = [
		...new Set(
			plan.steps.map((step) => {
				const payload = step.operation.payload;
				if (
					payload === null ||
					typeof payload !== 'object' ||
					Array.isArray(payload) ||
					typeof (payload as Record<string, unknown>).schema !== 'string'
				)
					throw new PgExecutionContractDerivationError(
						step.operation.ref,
						step.operation.operationKind.name,
						'has no derivable target namespace',
					);
				return (payload as Record<string, unknown>).schema as string;
			}),
		),
	];
	if (namespaces.length === 0 && fallbackSchema !== undefined)
		namespaces.push(fallbackSchema);
	return namespaces;
}

async function buildPgExecutionContract(
	pool: Pool,
	schema: string | undefined,
	plan: InProcessProvenPlan,
	expectedTargetIdentity: PostgreSqlObservationTargetIdentity,
): Promise<ExecutionContract> {
	const lease = await acquireTransitionLease(createPgTransitionLessor(pool));
	try {
		const target = await readPgExecutionTargetFromClient(
			lease.session,
			executionTargetNamespaces(plan, schema),
		);
		const mismatch = pgTargetIdentityMismatch(
			expectedTargetIdentity,
			target.identity,
		);
		if (mismatch)
			throw new Error(
				`PostgreSQL target identity changed before plan persistence: ${mismatch}`,
			);
		return createPgExecutionContract(
			plan,
			target.identity,
			target.sessionProvenance,
		);
	} finally {
		await lease.release();
	}
}

function executionContractBlockedAssessment(
	error: PgExecutionContractDerivationError,
): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle: 'planned',
		continuation: 'replan-required',
		reasons: [
			{
				code: 'unsupported-transition',
				changes: [],
				scope: [],
				detail: error.message,
			},
		],
	};
}

/**
 * Proves, binds, and optionally persists one PostgreSQL transition run.
 * The reader sees only an adapter-owned introspection lease; all journal,
 * evidence, and contract sessions are opened and released here.
 */
export async function planPgTransitionRun(
	model: ModelIR,
	readLiveSchema: PgLiveSchemaReader,
	pool: Pool,
	options: PlanPgTransitionRunOptions = {},
): Promise<PgTransitionPlanResult> {
	validateDeclarationModel(model);
	const schema = options.schema;
	const targetLease = await acquireTransitionLease(
		createPgTransitionLessor(pool),
	);
	let targetIdentity: PostgreSqlObservationTargetIdentity;
	try {
		targetIdentity = (
			await readPgExecutionTargetFromClient(targetLease.session, [
				schema ?? 'public',
			])
		).identity;
	} finally {
		await targetLease.release();
	}
	const journalLease = await acquireTransitionLease(
		createPgTransitionLessor(pool),
	);
	try {
		await ensureTransitionJournal(journalLease.session);
	} finally {
		await journalLease.release();
	}
	const introspectionLease = await acquirePgTransitionClient(pool);
	let current: ModelIR;
	try {
		const observed = await readPgExecutionTargetFromClient(
			introspectionLease.client as unknown as TransitionSessionClient,
			[schema ?? 'public'],
		);
		const mismatch = pgTargetIdentityMismatch(
			targetIdentity,
			observed.identity,
		);
		if (mismatch)
			throw new Error(
				`PostgreSQL introspection target identity does not match the captured target: ${mismatch}`,
			);
		current = await readLiveSchema(
			introspectionLease.client as unknown as TransitionSessionClient,
			schema,
		);
	} finally {
		introspectionLease.release();
	}
	const context = await readPgObservationContextFromLessor(
		createPgTransitionLessor(pool),
		schema,
		undefined,
		targetIdentity,
	);
	const registry = createPackRegistry([
		createPgTransitionPack(
			options.dbCasing === undefined ? {} : { dbCasing: options.dbCasing },
		),
	]);
	const compare = createComparator(registry).compare(
		model,
		current,
		equivalenceContext(context),
	);
	const prove = await createProver(registry).prove(
		compare,
		createPgTransitionLessor(pool),
		context,
	);
	if (prove.kind === 'no-drift')
		return { kind: prove.kind, compare, assessment: prove.assessment };
	if (prove.kind !== 'proven')
		return { kind: prove.kind, compare, assessment: prove.assessment };
	let executionContract: ExecutionContract;
	try {
		executionContract = await buildPgExecutionContract(
			pool,
			schema,
			prove.plan,
			targetIdentity,
		);
	} catch (error) {
		if (!(error instanceof PgExecutionContractDerivationError)) throw error;
		return {
			kind: 'blocked',
			compare,
			assessment: executionContractBlockedAssessment(error),
		};
	}
	const durablePlan = bindDeclarationSet(
		bindExecutionContract(prove.plan, executionContract),
		declarationSetFromModel(
			model,
			{
				engine: context.engine,
				database: context.databaseId,
				schema: schema ?? 'public',
			},
			getNamingPluginForDbCasing(options.dbCasing ?? 'preserve'),
		),
	);
	const run = createTransitionRunMetadata(durablePlan);
	const proofContext = prove.plan.observations.find(
		(observation) => observation.role === 'evidence',
	)?.context;
	if (!proofContext)
		throw new Error(
			'internal error: minted proven plan has no evidence observation context',
		);
	await options.beforePersist?.(durablePlan, proofContext);
	if (options.persist !== false)
		try {
			const persistLease = await acquireTransitionLease(
				createPgTransitionLessor(pool),
			);
			try {
				await createPgTransitionRunPersister(persistLease.session).persist(
					run,
					durablePlan,
				);
			} finally {
				await persistLease.release();
			}
		} catch (error) {
			throw new PgTransitionRunPersistenceIndeterminateError(
				run,
				compare,
				prove.assessment,
				error,
			);
		}
	return {
		kind: 'proven',
		compare,
		assessment: prove.assessment,
		plan: durablePlan,
		run,
		proofContext,
	};
}

export type PgTransitionRunApplyResult =
	| { readonly kind: 'busy' }
	| { readonly kind: 'settled'; readonly result: ApplyResult };

export interface ApplyPgTransitionRunOptions {
	/**
	 * Completes durable authorization using the journal already loaded for this
	 * run. This internal trusted facade is not a security boundary: core treats
	 * a callback that returns without throwing as authorization complete and
	 * does not verify that it appended an authorization record.
	 */
	readonly authorize: (
		journal: TransitionRunJournal,
		run: TransitionRunJournal['run'],
		plan: ProvenPlanShape,
		session: TransitionSessionClient,
	) => Promise<void>;
}

/** Applies one already-persisted, non-generator PostgreSQL transition run. */
export async function applyPgTransitionRun(
	pool: Pool,
	runId: string,
	policy: ApplyPolicy,
	expectedPlanDigest: string,
	options: ApplyPgTransitionRunOptions,
): Promise<PgTransitionRunApplyResult> {
	const locked = await withPgTransitionRunLock(pool, runId, async (target) => {
		let loadedJournal: TransitionRunJournal | undefined;
		const loadCurrent = async (id: string) => {
			const lease = await acquireExclusiveTransitionLease(target);
			try {
				const journal = await readTransitionJournal(lease.session, id, {
					ensure: false,
				});
				loadedJournal = journal;
				return journal;
			} finally {
				await lease.release();
			}
		};
		const applier = createApplier(
			createPackRegistry([createPgTransitionPack({})]),
			{ persist: async () => undefined },
		);
		return applier.applyDurable({
			runId,
			expectedPlanDigest,
			loadCurrent,
			prepareExecutionSession: async (session, contract, plan) => {
				const currency = await validatePgManagedLedgerCurrency(session, plan);
				if (currency)
					return { ok: false, kind: 'refused' as const, detail: currency };
				return preparePgExecutionSession(session, contract, plan);
			},
			policy,
			target,
			authorize: async (run, plan, session) => {
				if (!loadedJournal)
					throw new Error('internal error: durable run was not loaded');
				return options.authorize(loadedJournal, run, plan, session);
			},
		});
	});
	return locked.kind === 'busy'
		? { kind: 'busy' }
		: { kind: 'settled', result: locked.value };
}
