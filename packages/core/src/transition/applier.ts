import { createHash, randomUUID } from 'node:crypto';
import type {
	ApplicableAssessment,
	ApplyGuard,
	ApplyPolicy,
	ApplyResult,
	Assumption,
	ClaimId,
	DurableApplyOutcome,
	DurableIntentRecord,
	EvidenceId,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	LedgerPayload,
	ObservationContext,
	OperationEffectAssessment,
	OutcomeReason,
	PlanAssessment,
	ProvenPlanShape,
	ProvenPlanStep,
	RecoveryArtefact,
	RecoveryOutcome,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionLessor,
	TransitionRunJournal,
	TransitionRunMetadata,
} from '@dbsp/types';
import { matchLiveObservationContext } from './context-match.js';
import { mintDurablyLoadedRun } from './durably-loaded-run.js';
import { validateExecutionContract } from './execution-contract.js';
import { claimId, semanticArtifactId } from './ids.js';
import type {
	Applier,
	DurableApplyInput,
	DurableApplyResult,
	InProcessProvenPlan,
	TransitionRunPersister,
} from './index.js';
import { isMintedInProcessPlan, mintInProcessPlan } from './minting.js';
import { transitionPlanDigest } from './plan-digest.js';
import {
	type ExecutionCoordinator,
	isOperationRuntime,
	type OperationRuntime,
	type PackRegistry,
	type TransitionExecutionClient,
} from './registry.js';
import { assumptionAccepted } from './resource-scope.js';
import { resumeTransitionRun } from './resume.js';
import { createTransitionRunMetadata } from './run-metadata.js';
import {
	acquireExclusiveTransitionLease,
	acquireTransitionLease,
	createTransitionLessor,
	isTransitionLessor,
	markTransitionClientCompromised,
	planOperationSession,
	type TransitionLease,
	type TransitionLeaseFailure,
	transitionLessorRejectionAssessment,
} from './transition-lessor.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const APPLIER_ARTIFACT = {
	id: semanticArtifactId('dbsp.core.transition.applier'),
	version: '0.1.0',
};

const UNMINTED_PLAN_DETAIL =
	'plan was not minted by prove() in this process; applying a serialized plan is a separate, not-yet-available API (roadmap: identity & adoption)';

/**
 * An execution path is strict at exactly one of these boundaries.  Public
 * `apply()` has no durable preflight input, so it defaults to the in-process
 * boundary.  Only `applyDurable()` can construct the durable-contract branch
 * after it has loaded and verified the persisted contract.
 */
type ExecutionContextBoundary =
	| {
			readonly kind: 'in-process';
			readonly expectedContext: ObservationContext;
	  }
	| {
			readonly kind: 'durable-contract';
			readonly context: ObservationContext;
	  };

type DurableExecutionCarrier = {
	readonly plan: InProcessProvenPlan;
	readonly assessment: ApplicableAssessment;
	readonly __durableRun?: TransitionRunMetadata;
	readonly __durablyLoadedRun?: import('./durably-loaded-run.js').DurablyLoadedRun;
	/**
	 * The first delivery attempt remains run-scoped for durable journal and
	 * recovery compatibility. A replay receives a fresh attempt identity.
	 */
	readonly __executionId?: string;
	readonly __executionBoundary?: Extract<
		ExecutionContextBoundary,
		{ readonly kind: 'durable-contract' }
	>;
};

function contextMatchAtExecutionBoundary(
	boundary: ExecutionContextBoundary,
	actual: ObservationContext,
) {
	if (boundary.kind === 'durable-contract') return { ok: true } as const;
	return matchLiveObservationContext({
		expected: boundary.expectedContext,
		actual,
	});
}

function snapshotDurablePlan(plan: ProvenPlanShape): InProcessProvenPlan {
	const text = JSON.stringify(plan);
	if (text === undefined)
		throw new Error('durable plan is not JSON serializable');
	return mintInProcessPlan(JSON.parse(text) as ProvenPlanShape);
}

/**
 * Stable durable-apply refusal names.  The assessment remains a
 * `context-mismatch`: no target operation has begun.  The fact value gives
 * the CLI a lossless, public result contract without teaching core execution
 * a second result type.
 */
export type DurableApplyRefusalCode =
	| 'load-failed'
	| 'run-id-mismatch'
	| 'compatibility-refusal'
	| 'plan-digest-mismatch'
	| 'digest-mismatch'
	| 'plan-validation-failed'
	| 'execution-contract-refused'
	| 'execution-preflight-failed'
	| 'execution-failed'
	| 'context-mismatch'
	| 'prior-step-events-refusal'
	| 'transactional-only-refusal'
	| 'operation-unavailable'
	| 'assumption-not-accepted'
	| 'authorization-write-failed'
	| 'database-read-only';

function isDatabaseReadOnlyError(error: unknown): boolean {
	return (
		error !== null &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { readonly code?: unknown }).code === 'database-read-only'
	);
}

function durableRefusal(
	code: DurableApplyRefusalCode,
	detail: string,
): DurableApplyResult {
	return {
		durableOutcome: code,
		assessment: assessment({
			code: 'context-mismatch',
			artifact: APPLIER_ARTIFACT,
			fact: { key: 'durable-apply-outcome', value: code },
			detail,
			scope: [],
		}),
		journals: [],
		observations: [],
	};
}

function durableExecutionOutcome(result: ApplyResult): DurableApplyOutcome {
	if (result.unresolvedOutcome) return result.unresolvedOutcome.kind;
	if (result.assessment.lifecycle === 'completed') return 'completed';
	if (result.assessment.lifecycle === 'partially-applied')
		return 'partially-applied';
	switch (result.assessment.reasons[0]?.code) {
		case 'unknown-step-result':
			return 'unknown-step-result';
		case 'operation-failed-not-applied':
			return 'operation-failed-not-applied';
		case 'guard-failed':
			return 'guard-failed';
		case 'guard-timeout':
			return 'guard-timeout';
		default:
			return result.assessment.lifecycle === 'outcome-unknown'
				? 'outcome-unknown'
				: 'context-mismatch';
	}
}

function recoveryOutcome(result: ApplyResult): RecoveryOutcome {
	if (result.recoveryOutcome) return result.recoveryOutcome;
	if (result.assessment.lifecycle === 'completed') return 'completed';
	if (result.assessment.lifecycle === 'partially-applied')
		return 'recovery-partially-applied';
	switch (result.assessment.reasons[0]?.code) {
		case 'resume-required':
			return 'recovery-resume-required';
		case 'unknown-step-result':
			return 'recovery-unknown-step-result';
		case 'guard-failed':
			return 'recovery-guard-failed';
		case 'guard-timeout':
			return 'recovery-guard-timeout';
		case 'operation-failed-not-applied':
			return 'recovery-operation-failed-not-applied';
		default:
			return 'recovery-context-mismatch';
	}
}

function assessment(
	reason: OutcomeReason,
	lifecycle: PlanAssessment['lifecycle'] = 'planned',
	continuation: PlanAssessment['continuation'] = 'replan-required',
): PlanAssessment {
	return {
		decision: 'blocked',
		assurance: 'unproven',
		lifecycle,
		continuation,
		reasons: [reason],
	};
}

function completedAssessment(
	proven: ApplicableAssessment,
): ApplicableAssessment {
	return {
		...proven,
		lifecycle: 'completed',
		continuation: 'none',
	};
}

function transitionLessorRejectionResult(): ApplyResult {
	return {
		assessment: transitionLessorRejectionAssessment(APPLIER_ARTIFACT),
		journals: [],
		observations: [],
	};
}

function primaryClaimFromPlan(plan: InProcessProvenPlan): ClaimId {
	return (
		plan.claims[0]?.id ??
		plan.steps.flatMap((step) => [...step.requiredClaims])[0] ??
		claimId('dbsp.transition.claim.plan')
	);
}

function derivedApplicableAssessment(
	plan: InProcessProvenPlan,
): ApplicableAssessment {
	const established =
		plan.assumptions.length === 0 &&
		plan.claims.every(
			(item) =>
				item.derivedBy.conclusion === 'established' &&
				item.assumes.length === 0,
		);
	return {
		decision: 'applicable',
		assurance: established ? 'established' : 'accepted-under-assumptions',
		lifecycle: 'planned',
		continuation: 'none',
		reasons: [
			{
				code: 'proven-applicable',
				claim: primaryClaimFromPlan(plan),
				scope: [],
			},
		],
	};
}

function evidenceIds(
	observations: readonly IssuedObservation[],
): readonly EvidenceId[] {
	return observations
		.filter((observation) => observation.role === 'evidence')
		.map((observation) => observation.id);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(',')}}`;
}

function managedOutcomeReadBack(
	observations: readonly IssuedObservation[],
): LedgerPayload {
	const value = {
		observations: observations.map((observation) => ({
			request: observation.request,
			result: observation.result,
		})),
	} as unknown as LedgerPayload['value'];
	return {
		value,
		digest: createHash('sha256').update(canonicalJson(value)).digest('hex'),
	};
}

function recordedAt(): string {
	return new Date().toISOString();
}

function lockTimeoutMs(
	runtime: OperationRuntime,
	step: ProvenPlanStep,
	context: ObservationContext,
): number {
	const effects = runtime.effectsOf(step.operation, context);
	const waits = effects.effects.locks.flatMap((lock) =>
		typeof lock.maxWaitMs === 'number' ? [lock.maxWaitMs] : [],
	);
	return waits.length > 0 ? Math.max(...waits) : 5000;
}

function fingerprintMatches(
	expected: FingerprintManifest,
	actual: FingerprintManifest,
): boolean {
	return expected.digest === actual.digest;
}

function intentRecord(
	step: ProvenPlanStep,
	run: TransitionRunMetadata,
	executionId: string,
): DurableIntentRecord {
	return {
		runId: run.runId,
		run,
		executionId,
		stepId: step.stepId,
		operation: step.operation,
		recordedAt: recordedAt(),
	};
}

function completionRecord(
	step: ProvenPlanStep,
	run: TransitionRunMetadata,
	committedWithDdl = true,
): TransactionalCompletionRecord {
	return {
		runId: run.runId,
		stepId: step.stepId,
		committedWithDdl,
		recordedAt: recordedAt(),
	};
}

function contextMismatchReason(
	step: ProvenPlanStep,
	detail: string,
): OutcomeReason {
	return {
		code: 'context-mismatch',
		artifact: step.operation.operationKind.artifact,
		fact: { key: 'fingerprint', value: detail },
		scope: [],
	};
}

function journalWithObserved(
	intent: DurableIntentRecord,
	outcome:
		| 'guard-failed'
		| 'guard-timeout'
		| 'operation-failed-not-applied'
		| 'partially-applied',
	observations: readonly IssuedObservation[],
	recovery: readonly RecoveryArtefact[] = [],
): StepJournal {
	const base = {
		intent,
		outcome,
		observedOutcome: {
			stepId: intent.stepId,
			observations: evidenceIds(observations),
			recordedAt: recordedAt(),
		},
	};
	if (outcome === 'guard-timeout') {
		return base;
	}
	return { ...base, recovery };
}

function unacceptedAssumptionResult(
	plan: InProcessProvenPlan,
	assumption: Assumption,
): ApplyResult {
	return {
		assessment: assessment({
			code: 'uncomposable',
			fragments: plan.steps.map((step) => step.selectionRationale.chosen),
			assumption: assumption.id,
			scope: assumption.scope,
			detail: 'apply policy did not accept required assumption',
		}),
		journals: [],
		observations: [],
	};
}

function unacceptedStepAssumptionResult(
	_plan: InProcessProvenPlan,
	step: ProvenPlanStep,
	assumption: Assumption,
): ApplyResult {
	return {
		assessment: assessment({
			code: 'uncomposable',
			fragments: [step.selectionRationale.chosen],
			assumption: assumption.id,
			scope: assumption.scope,
			detail: `apply policy did not accept assumption ${assumption.id} required by step ${step.stepId}`,
		}),
		journals: [],
		observations: [],
	};
}

function uncomposablePlanResult(
	plan: InProcessProvenPlan,
	detail: string,
): ApplyResult {
	return {
		assessment: assessment({
			code: 'uncomposable',
			fragments: plan.steps.map((step) => step.selectionRationale.chosen),
			scope: [],
			detail,
		}),
		journals: [],
		observations: [],
	};
}

function unresolvedRuntimeResult(step: ProvenPlanStep): ApplyResult {
	return {
		assessment: assessment(
			contextMismatchReason(step, 'operation runtime missing'),
		),
		journals: [],
		observations: [],
	};
}

function unresolvedOperationResult(
	step: ProvenPlanStep,
	detail: string,
): ApplyResult {
	return {
		assessment: assessment(contextMismatchReason(step, detail)),
		journals: [],
		observations: [],
	};
}

function invalidPlanResult(detail: string): ApplyResult {
	return {
		assessment: assessment({
			code: 'context-mismatch',
			artifact: APPLIER_ARTIFACT,
			fact: { key: 'proven-plan', value: detail },
			scope: [],
		}),
		journals: [],
		observations: [],
	};
}

function persistenceFailureResult(
	run: TransitionRunMetadata,
	error: unknown,
): ApplyResult {
	return {
		assessment: assessment({
			code: 'persistence-failed',
			artifact: APPLIER_ARTIFACT,
			fact: {
				key: 'transition-run-id',
				value: run.runId,
			},
			detail: `transition-run persistence is indeterminate; load run ${run.runId} before retrying: ${errorDetail(error)}`,
			scope: [],
		}),
		journals: [],
		observations: [],
	};
}

function unknownJournal(intent: DurableIntentRecord): StepJournal {
	return {
		intent,
		outcome: 'unknown-step-result',
	};
}

function partiallyAppliedReason(
	step: ProvenPlanStep,
	detail: string,
	recovery: readonly RecoveryArtefact[] = [],
): OutcomeReason {
	return {
		code: 'partially-applied',
		stepId: step.stepId,
		operationKind: step.operation.operationKind,
		operationRef: step.operation.ref,
		scope: [],
		detail,
		...(recovery.length > 0 ? { recovery } : {}),
	};
}

function guardFailedReason(
	step: ProvenPlanStep,
	guard: ApplyGuard,
	recovery: readonly RecoveryArtefact[],
): OutcomeReason {
	return {
		code: 'guard-failed',
		stepId: step.stepId,
		operationKind: step.operation.operationKind,
		operationRef: step.operation.ref,
		recovery,
		scope: guard.predicate.scope,
	};
}

function operationFailedNotAppliedReason(
	step: ProvenPlanStep,
	detail: string,
): OutcomeReason {
	return {
		code: 'operation-failed-not-applied',
		stepId: step.stepId,
		operationKind: step.operation.operationKind,
		operationRef: step.operation.ref,
		scope: [],
		detail,
	};
}

function stoppedAssessment(
	reason: OutcomeReason,
	hasCommittedSteps: boolean,
): PlanAssessment {
	return assessment(
		reason,
		hasCommittedSteps ? 'partially-applied' : 'planned',
		hasCommittedSteps ? 'resume-possible' : 'replan-required',
	);
}

class CommitOutcomeUncertainError extends Error {
	readonly originalError: unknown;

	constructor(error: unknown) {
		super(
			error instanceof Error
				? error.message
				: 'transaction commit outcome is uncertain',
		);
		this.name = 'CommitOutcomeUncertainError';
		this.originalError = error;
	}
}

function errorDetail(error: unknown): string {
	if (error instanceof AggregateError) {
		const details = error.errors
			.map(errorDetail)
			.filter((detail) => detail !== 'unknown error');
		return details.length > 0
			? `${error.message}: ${details.join('; ')}`
			: error.message;
	}
	return error instanceof Error ? error.message : 'unknown error';
}

/** Keep the failed work and the rollback that failed to clean it up together. */
function applyAndRollbackFailure(
	originalError: unknown,
	cleanupError: unknown,
): AggregateError {
	const failure = new AggregateError(
		[originalError, cleanupError],
		'transition apply failed and its rollback also failed',
	);
	Object.defineProperties(failure, {
		originalError: { value: originalError, configurable: true },
		cleanupError: { value: cleanupError, configurable: true },
	});
	return failure;
}

const postRollbackObservedJournalWrites = new WeakMap<
	TransitionExecutionClient,
	{
		readonly coordinator: ExecutionCoordinator | OperationRuntime;
		readonly maxWaitMs: number;
	}
>();

async function rollbackAndPrepareObservedJournalWrite(
	coordinator: ExecutionCoordinator | OperationRuntime,
	client: TransitionExecutionClient,
	maxWaitMs: number,
): Promise<void> {
	await coordinator.rollback(client);
	// ROLLBACK clears PostgreSQL's SET LOCAL lock_timeout. An observed event
	// appends through SELECT ... FOR UPDATE, so give the standalone append a new,
	// bounded transaction.
	postRollbackObservedJournalWrites.set(client, { coordinator, maxWaitMs });
}

function withJournalWriteWarning<T extends PlanAssessment>(
	assessmentValue: T,
	error: unknown,
): T {
	const detail = `observed journal write failed after outcome was decided: ${errorDetail(error)}`;
	return {
		...assessmentValue,
		reasons: assessmentValue.reasons.map((reason, index) =>
			index === 0
				? {
						...reason,
						detail: reason.detail ? `${reason.detail}; ${detail}` : detail,
					}
				: reason,
		),
	};
}

async function writeObservedJournalOutcome(params: {
	readonly semantics: OperationRuntime;
	readonly client: TransitionExecutionClient;
	readonly journal: StepJournal;
}): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly error: unknown }
> {
	try {
		const postRollback = postRollbackObservedJournalWrites.get(params.client);
		if (postRollback) {
			postRollbackObservedJournalWrites.delete(params.client);
			await postRollback.coordinator.begin(params.client);
			try {
				await postRollback.coordinator.setLockTimeout(
					params.client,
					postRollback.maxWaitMs,
				);
				await params.semantics.writeObservedJournal(
					params.client,
					params.journal,
				);
				await postRollback.coordinator.commit(params.client);
			} catch (error) {
				await postRollback.coordinator
					.rollback(params.client)
					.catch(() => undefined);
				throw error;
			}
		} else {
			await params.semantics.writeObservedJournal(
				params.client,
				params.journal,
			);
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	}
}

async function writeObservedJournalOrResult(params: {
	readonly semantics: OperationRuntime;
	readonly client: TransitionExecutionClient;
	readonly journal: StepJournal;
	readonly result: ApplyResult;
	readonly outcomeDurable: boolean;
	readonly onDurableWriteWarning?: (error: unknown) => void;
}): Promise<ApplyResult | undefined> {
	const write = await writeObservedJournalOutcome(params);
	if (write.ok) {
		return undefined;
	}
	if (!params.outcomeDurable) {
		throw write.error;
	}
	if (params.onDurableWriteWarning) {
		params.onDurableWriteWarning(write.error);
		return params.result;
	}
	return {
		...params.result,
		assessment: withJournalWriteWarning(params.result.assessment, write.error),
	};
}

function durableEvidence(
	observations: readonly IssuedObservation[],
): readonly EvidenceObservation[] {
	return observations.filter(
		(observation): observation is EvidenceObservation =>
			observation.role === 'evidence',
	);
}

export function createApplier(
	registry: PackRegistry,
	persister: TransitionRunPersister,
): Applier {
	return {
		artifact: APPLIER_ARTIFACT,
		async apply(
			proven: {
				readonly plan: InProcessProvenPlan;
				readonly assessment: ApplicableAssessment;
			},
			policy: ApplyPolicy,
			target: TransitionLessor,
		): Promise<ApplyResult> {
			const carrier = proven as DurableExecutionCarrier;
			const plan =
				typeof proven === 'object' && proven !== null
					? (proven as { readonly plan?: unknown }).plan
					: undefined;
			if (!isMintedInProcessPlan(plan)) {
				return invalidPlanResult(UNMINTED_PLAN_DETAIL);
			}
			if (plan.segments.length === 0) {
				if (!isTransitionLessor(target)) {
					return transitionLessorRejectionResult();
				}
				return uncomposablePlanResult(
					plan,
					'plan contains no executable steps',
				);
			}
			if (plan.steps.length === 0) {
				return uncomposablePlanResult(
					plan,
					'plan contains no executable steps',
				);
			}
			const diagnostic = validateTransitionRelationalInvariants({
				kind: 'plan',
				plan,
			});
			if (!diagnostic.ok) {
				throw new Error(
					`internal error: minted proven plan violated relational invariants: ${diagnostic.detail}`,
				);
			}
			const reportedAssessment = derivedApplicableAssessment(plan);

			const proofContext = plan.observations.find(
				(observation) => observation.role === 'evidence',
			)?.context;
			if (!proofContext) {
				throw new Error(
					'internal error: minted proven plan has no evidence observation context',
				);
			}
			const executionBoundary: ExecutionContextBoundary =
				carrier.__executionBoundary ?? {
					kind: 'in-process',
					expectedContext: proofContext,
				};
			const assumptionById = new Map(
				plan.assumptions.map((assumption) => [assumption.id, assumption]),
			);
			const stepAssumptionIds = new Set<string>();
			for (const step of plan.steps) {
				for (const assumptionId of step.restsOnAssumptions) {
					stepAssumptionIds.add(assumptionId);
					const assumption = assumptionById.get(assumptionId);
					if (assumption && !assumptionAccepted(assumption, policy)) {
						return unacceptedStepAssumptionResult(plan, step, assumption);
					}
				}
			}
			for (const assumption of plan.assumptions) {
				if (
					!stepAssumptionIds.has(assumption.id) &&
					!assumptionAccepted(assumption, policy)
				) {
					return unacceptedAssumptionResult(plan, assumption);
				}
			}
			const run = carrier.__durableRun ?? createTransitionRunMetadata(plan);
			// A regular apply can only receive a plan minted by prove() in this
			// process.  Durable apply supplies the stricter load-path witness below.
			const durablyLoadedRun =
				carrier.__durablyLoadedRun ?? mintDurablyLoadedRun(run);
			// A durable run is the reviewed plan, not one of its execution attempts.
			// Every admitted attempt gets an opaque fresh identity; a prior committed
			// step fact is refused by applyDurable before this path is reached.
			const executionId =
				carrier.__executionId ?? `dbsp.transition.execution.${randomUUID()}`;
			const operationEffectsByRef = new Map<
				string,
				OperationEffectAssessment
			>();
			for (const step of plan.steps) {
				const operationResolution = registry.resolveOperation(step.operation);
				if (!operationResolution.ok) {
					return unresolvedOperationResult(step, operationResolution.detail);
				}
				operationEffectsByRef.set(
					step.operation.ref,
					operationResolution.semantics.effectsOf(step.operation, proofContext),
				);
			}
			const semanticDiagnostic = validateTransitionRelationalInvariants({
				kind: 'plan',
				plan,
				operationEffectsByRef,
			});
			if (!semanticDiagnostic.ok) {
				throw new Error(
					`internal error: minted proven plan violated relational invariants: ${semanticDiagnostic.detail}`,
				);
			}

			const observations: IssuedObservation[] = [];
			const journals: StepJournal[] = [];
			const journalWriteWarnings: unknown[] = [];
			const recordJournalWriteWarning = (error: unknown): void => {
				journalWriteWarnings.push(error);
			};
			const assessmentWithJournalWriteWarnings = <T extends PlanAssessment>(
				assessmentValue: T,
			): T => {
				let warned = assessmentValue;
				for (const error of journalWriteWarnings) {
					warned = withJournalWriteWarning(warned, error);
				}
				return warned;
			};
			const resultWithJournalWriteWarnings = (
				result: ApplyResult,
			): ApplyResult =>
				journalWriteWarnings.length === 0
					? result
					: {
							...result,
							assessment: {
								...assessmentWithJournalWriteWarnings(result.assessment),
								// At the durable boundary, effects may be committed without an
								// observed journal. Its durable proof is incomplete, so never
								// report that as a completed run.
								...(executionBoundary.kind === 'durable-contract' &&
								result.assessment.lifecycle === 'completed'
									? {
											lifecycle: 'outcome-unknown' as const,
											continuation: 'human-intervention-required' as const,
										}
									: {}),
							},
						};
			const resultWithCommittedJournals = (
				result: ApplyResult,
			): ApplyResult => {
				if (journals.length === 0) {
					return resultWithJournalWriteWarnings(result);
				}
				const assessmentValue =
					result.assessment.lifecycle === 'partially-applied' ||
					result.assessment.lifecycle === 'outcome-unknown'
						? result.assessment
						: {
								...result.assessment,
								lifecycle: 'partially-applied' as const,
								continuation:
									result.assessment.continuation === 'none'
										? ('resume-possible' as const)
										: result.assessment.continuation,
							};
				return resultWithJournalWriteWarnings({
					...result,
					assessment: assessmentValue,
					journals: [...journals, ...result.journals],
				});
			};
			const resultWithObservedJournal = async (params: {
				readonly semantics: OperationRuntime;
				readonly client: TransitionExecutionClient | undefined;
				readonly journal: StepJournal;
				readonly result: ApplyResult;
				readonly outcomeDurable: boolean;
			}): Promise<ApplyResult> => {
				if (!params.client) {
					return resultWithJournalWriteWarnings(params.result);
				}
				const journalWriteFailure = await writeObservedJournalOrResult({
					semantics: params.semantics,
					client: params.client,
					journal: params.journal,
					result: params.result,
					outcomeDurable: params.outcomeDurable,
					onDurableWriteWarning: recordJournalWriteWarning,
				});
				return resultWithJournalWriteWarnings(
					journalWriteFailure ?? params.result,
				);
			};
			// Locking and observing precede the durable step boundary.  The
			// OperationRuntime contract makes that safe: if this refusal is reached,
			// no DDL or external effect has occurred, so there is no step attempt to
			// reconcile.  Previously committed steps remain in `journals`, however,
			// and keep the run recoverable.
			const preIntentRefusal = (reason: OutcomeReason): ApplyResult =>
				resultWithCommittedJournals({
					assessment: stoppedAssessment(reason, journals.length > 0),
					journals: [],
					observations,
				});
			const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));
			type ResolvedStep = {
				readonly step: ProvenPlanStep;
				readonly semantics: OperationRuntime;
				readonly operationIssuer: NonNullable<
					ReturnType<PackRegistry['resolveIssuer']>
				>;
				readonly intent: DurableIntentRecord;
				readonly coordinatorBinding: ReturnType<
					PackRegistry['transactionCoordinatorFor']
				>;
			};
			const preflightSegments: {
				readonly segment: InProcessProvenPlan['segments'][number];
				readonly resolvedSteps: readonly ResolvedStep[];
				readonly first: ResolvedStep;
				readonly transactional: boolean;
				readonly segmentCoordinator: ExecutionCoordinator | OperationRuntime;
			}[] = [];
			for (const segment of plan.segments) {
				const segmentSteps = segment.stepIds.map((stepId) =>
					stepById.get(stepId),
				);
				if (segmentSteps.some((step) => !step)) {
					return resultWithCommittedJournals(
						uncomposablePlanResult(
							plan,
							`segment ${segment.segmentId} references a missing step`,
						),
					);
				}
				const resolvedSteps: ResolvedStep[] = [];
				for (const step of segmentSteps as ProvenPlanStep[]) {
					const operationResolution = registry.resolveOperation(step.operation);
					if (!operationResolution.ok) {
						return resultWithCommittedJournals(
							unresolvedOperationResult(step, operationResolution.detail),
						);
					}
					const semantics = operationResolution.semantics;
					if (!isOperationRuntime(semantics)) {
						return resultWithCommittedJournals(unresolvedRuntimeResult(step));
					}
					if (
						semantics.artifact.id !==
							step.operation.operationKind.artifact.id ||
						semantics.artifact.version !==
							step.operation.operationKind.artifact.version
					) {
						return resultWithCommittedJournals(unresolvedRuntimeResult(step));
					}
					const operationIssuer = registry.resolveIssuer(
						step.operation.operationKind.artifact,
					);
					if (!operationIssuer) {
						return resultWithCommittedJournals(
							unresolvedOperationResult(
								step,
								'operation observation issuer missing',
							),
						);
					}
					const execution = operationEffectsByRef.get(step.operation.ref)
						?.effects.execution;
					if (!execution) {
						return resultWithCommittedJournals(
							unresolvedOperationResult(step, 'operation effects missing'),
						);
					}
					if (
						segment.transaction === 'joins-current' &&
						execution.transaction !== 'joins-current'
					) {
						return resultWithCommittedJournals(
							uncomposablePlanResult(
								plan,
								`step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
							),
						);
					}
					if (
						segment.transaction === 'forbids-transaction' &&
						execution.transaction !== 'forbids-transaction'
					) {
						return resultWithCommittedJournals(
							uncomposablePlanResult(
								plan,
								`step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
							),
						);
					}
					if (
						segment.transaction !== 'forbids-transaction' &&
						execution.transaction === 'forbids-transaction'
					) {
						return resultWithCommittedJournals(
							uncomposablePlanResult(
								plan,
								`step ${step.stepId} forbids the transaction used by segment ${segment.segmentId}`,
							),
						);
					}
					resolvedSteps.push({
						step,
						semantics,
						operationIssuer,
						intent: intentRecord(step, run, executionId),
						coordinatorBinding: registry.transactionCoordinatorFor(semantics),
					});
				}
				const first = resolvedSteps[0];
				if (!first) {
					return resultWithCommittedJournals(
						uncomposablePlanResult(
							plan,
							`segment ${segment.segmentId} contains no steps`,
						),
					);
				}
				const transactional = segment.transaction !== 'forbids-transaction';
				const runtimeSet = new Set(
					resolvedSteps.map((entry) => entry.semantics),
				);
				let segmentCoordinator: ExecutionCoordinator | OperationRuntime =
					first.semantics;
				if (transactional && runtimeSet.size > 1) {
					const firstBinding = first.coordinatorBinding;
					if (!firstBinding) {
						return resultWithCommittedJournals(
							uncomposablePlanResult(
								plan,
								`segment ${segment.segmentId} spans multiple operation runtimes without an explicit shared transaction coordinator`,
							),
						);
					}
					if (
						resolvedSteps.some((entry) => {
							const binding = entry.coordinatorBinding;
							return (
								!binding ||
								binding.coordinator !== firstBinding.coordinator ||
								binding.transactionDomain !== firstBinding.transactionDomain
							);
						})
					) {
						return resultWithCommittedJournals(
							uncomposablePlanResult(
								plan,
								`segment ${segment.segmentId} spans operation runtimes with different transaction coordinators`,
							),
						);
					}
					segmentCoordinator = firstBinding.coordinator;
				} else if (
					transactional &&
					first.coordinatorBinding &&
					resolvedSteps.every((entry) => {
						const binding = entry.coordinatorBinding;
						return (
							binding?.coordinator === first.coordinatorBinding?.coordinator &&
							binding?.transactionDomain ===
								first.coordinatorBinding?.transactionDomain
						);
					})
				) {
					segmentCoordinator = first.coordinatorBinding.coordinator;
				} else if (!transactional && runtimeSet.size > 1) {
					return resultWithCommittedJournals(
						uncomposablePlanResult(
							plan,
							`segment ${segment.segmentId} spans multiple operation runtimes without a transaction`,
						),
					);
				}
				preflightSegments.push({
					segment,
					resolvedSteps,
					first,
					transactional,
					segmentCoordinator,
				});
			}
			if (!isTransitionLessor(target)) {
				return resultWithCommittedJournals(transitionLessorRejectionResult());
			}
			// Once, and here: every check above is pure and in-memory, and nothing
			// below this line is unobservable — the first segment takes a lease,
			// opens a transaction and runs DDL. Persisting inside the loop instead
			// would re-persist per segment and, on a later segment, discard the
			// journals the earlier ones already committed.
			try {
				await persister.persist(run, plan);
			} catch (error) {
				return persistenceFailureResult(run, error);
			}
			let runtimeContext =
				executionBoundary.kind === 'durable-contract'
					? executionBoundary.context
					: proofContext;
			for (const {
				resolvedSteps,
				first,
				transactional,
				segmentCoordinator,
			} of preflightSegments) {
				let client: TransitionExecutionClient | undefined;
				let lease: TransitionLease | undefined;
				let committed = false;
				let transactionStarted = false;
				let releaseFailure: TransitionLeaseFailure | undefined;
				let active = first;
				let activeContext = runtimeContext;
				let activeIntentWritten = false;
				let activeOperationAttempted = false;
				let activeNonRollbackableOperationExecuted = false;
				const completedInSegment: {
					readonly step: ProvenPlanStep;
					readonly semantics: OperationRuntime;
					readonly operationIssuer: NonNullable<
						ReturnType<PackRegistry['resolveIssuer']>
					>;
					readonly intent: DurableIntentRecord;
					readonly stepContext: ObservationContext;
					readonly completion: TransactionalCompletionRecord;
					readonly journal?: StepJournal;
				}[] = [];
				try {
					lease = await acquireTransitionLease(target);
					const leasedSession = lease.session;
					client = {
						opaqueClient: leasedSession,
						markClientCompromised: () => {
							markTransitionClientCompromised(leasedSession);
						},
					};
					const executionClient = client;
					if (executionBoundary.kind === 'durable-contract')
						activeContext = executionBoundary.context;
					if (transactional) {
						await segmentCoordinator.begin(executionClient);
						transactionStarted = true;
						// The reservation takes a PostgreSQL row lock. Set the plan-derived
						// bound first, so this wait and later application locks report the
						// timeout that actually applied.
						await segmentCoordinator.setLockTimeout(
							executionClient,
							lockTimeoutMs(first.semantics, first.step, runtimeContext),
						);
						// PostgreSQL reservations hold the proven run row before any
						// application lock. The subsequent intent append runs on this
						// session and therefore reuses that journal lock. Coordinators
						// without this optional protocol (including the generic
						// non-transactional path) retain the old exposure: a row lock
						// cannot be held across application locking without a transaction.
						await segmentCoordinator.reserveJournalRun?.(executionClient, run);
					}

					for (const entry of resolvedSteps) {
						active = entry;
						activeContext = runtimeContext;
						activeIntentWritten = false;
						activeOperationAttempted = false;
						activeNonRollbackableOperationExecuted = false;
						await segmentCoordinator.setLockTimeout(
							executionClient,
							lockTimeoutMs(entry.semantics, entry.step, runtimeContext),
						);
						await entry.semantics.acquireLocks(
							executionClient,
							entry.step.operation,
							entry.semantics.effectsOf(entry.step.operation, runtimeContext),
							runtimeContext,
						);
						runtimeContext = await entry.semantics.observeContext(
							executionClient,
							entry.step.operation,
							runtimeContext,
						);
						runtimeContext =
							registry.contextWithDerivedCapabilities(runtimeContext);
						const stepContext = runtimeContext;
						activeContext = stepContext;
						const liveContextMatch = contextMatchAtExecutionBoundary(
							executionBoundary,
							stepContext,
						);
						if (!liveContextMatch.ok) {
							const mismatchDetail = liveContextMatch.detail;
							const mismatch = contextMismatchReason(
								entry.step,
								mismatchDetail,
							);
							if (transactionStarted && !committed) {
								try {
									await rollbackAndPrepareObservedJournalWrite(
										segmentCoordinator,
										executionClient,
										lockTimeoutMs(entry.semantics, entry.step, activeContext),
									);
								} catch (cleanupError) {
									return preIntentRefusal(
										contextMismatchReason(
											entry.step,
											errorDetail(
												applyAndRollbackFailure(
													new Error(mismatchDetail),
													cleanupError,
												),
											),
										),
									);
								}
							}
							return preIntentRefusal(mismatch);
						}

						const before = await entry.semantics.observeOperation(
							executionClient,
							entry.step.operation,
							stepContext,
							'before',
							entry.operationIssuer,
						);
						observations.push(...before.observations);
						let currentFingerprints: ReturnType<
							OperationRuntime['buildFingerprints']
						>;
						try {
							currentFingerprints = entry.semantics.buildFingerprints(
								entry.step.operation,
								durableEvidence(before.observations),
								stepContext,
							);
						} catch (error) {
							let reportedError = error;
							if (transactionStarted && !committed) {
								try {
									await rollbackAndPrepareObservedJournalWrite(
										segmentCoordinator,
										executionClient,
										lockTimeoutMs(entry.semantics, entry.step, activeContext),
									);
								} catch (cleanupError) {
									reportedError = applyAndRollbackFailure(error, cleanupError);
								}
							}
							// A builder failure cannot establish drift. Preserve an
							// observed unknown outcome, including the original cause, so
							// admission will not turn an evidence failure into a pristine
							// re-planning loop.
							const journal = unknownJournal(entry.intent);
							const result = {
								assessment: assessment(
									{
										code: 'unknown-step-result',
										stepId: entry.step.stepId,
										operationKind: entry.step.operation.operationKind,
										operationRef: entry.step.operation.ref,
										scope: [],
										detail: `expectedBefore fingerprint construction failed: ${errorDetail(reportedError)}`,
									},
									'outcome-unknown',
									'human-intervention-required',
								),
								journals: [...journals, journal],
								observations,
							};
							return resultWithObservedJournal({
								semantics: entry.semantics,
								client: executionClient,
								journal,
								result,
								outcomeDurable: true,
							});
						}
						if (
							!fingerprintMatches(
								entry.step.expectedBefore,
								currentFingerprints.expectedBefore,
							)
						) {
							const mismatchDetail = 'expectedBefore mismatch';
							const mismatch = contextMismatchReason(
								entry.step,
								mismatchDetail,
							);
							if (transactionStarted && !committed) {
								try {
									await rollbackAndPrepareObservedJournalWrite(
										segmentCoordinator,
										executionClient,
										lockTimeoutMs(entry.semantics, entry.step, activeContext),
									);
								} catch (cleanupError) {
									return preIntentRefusal(
										contextMismatchReason(
											entry.step,
											errorDetail(
												applyAndRollbackFailure(
													new Error(mismatchDetail),
													cleanupError,
												),
											),
										),
									);
								}
							}
							return preIntentRefusal(mismatch);
						}
						const managedClaim =
							executionBoundary.kind === 'durable-contract'
								? entry.step.managedClaim
								: undefined;
						if (
							executionBoundary.kind === 'durable-contract' &&
							entry.semantics.executionContractEligibility?.eligible === true &&
							!managedClaim
						) {
							return preIntentRefusal(
								operationFailedNotAppliedReason(
									entry.step,
									'managed-eligible step has no immutable managed claim material',
								),
							);
						}
						if (managedClaim) {
							const preflightManagedOutcome =
								entry.semantics.preflightManagedOutcome;
							if (preflightManagedOutcome) {
								const detail = await preflightManagedOutcome(executionClient, {
									claim: managedClaim,
									run,
									transactional,
									lockTimeoutMs: lockTimeoutMs(
										entry.semantics,
										entry.step,
										stepContext,
									),
								});
								if (detail) {
									if (transactionStarted && !committed) {
										try {
											await rollbackAndPrepareObservedJournalWrite(
												segmentCoordinator,
												executionClient,
												lockTimeoutMs(
													entry.semantics,
													entry.step,
													activeContext,
												),
											);
										} catch (cleanupError) {
											return preIntentRefusal(
												operationFailedNotAppliedReason(
													entry.step,
													errorDetail(
														applyAndRollbackFailure(
															new Error(detail),
															cleanupError,
														),
													),
												),
											);
										}
									}
									return preIntentRefusal(
										operationFailedNotAppliedReason(entry.step, detail),
									);
								}
							}
						}

						// Mark before awaiting: a write error can still mean the intent
						// reached durable storage, so downstream recovery must remain
						// conservative.
						activeIntentWritten = true;
						await entry.semantics.writeIntentJournal(
							executionClient,
							entry.intent,
						);

						const runGuardPhase = async (
							phase: ProvenPlanStep['guards'][number]['phase'],
							nonRollbackableOperationExecuted = false,
						): Promise<ApplyResult | undefined> => {
							for (const guard of entry.step.guards.filter(
								(candidate) => candidate.phase === phase,
							)) {
								const guardResult = await entry.semantics.checkGuard(
									executionClient,
									entry.step.operation,
									guard,
									stepContext,
								);
								observations.push(...guardResult.observations);
								if (!guardResult.passed) {
									if (transactionStarted && !committed) {
										await rollbackAndPrepareObservedJournalWrite(
											segmentCoordinator,
											executionClient,
											lockTimeoutMs(entry.semantics, entry.step, activeContext),
										);
									}
									const hasAppliedWork =
										journals.length > 0 || nonRollbackableOperationExecuted;
									const journal = journalWithObserved(
										entry.intent,
										nonRollbackableOperationExecuted
											? 'partially-applied'
											: 'guard-failed',
										guardResult.observations,
										guardResult.recovery,
									);
									const guardFailureReason = guardFailedReason(
										entry.step,
										guard,
										guardResult.recovery,
									);
									const result = {
										assessment: hasAppliedWork
											? assessment(
													guardFailureReason,
													'partially-applied',
													'resume-possible',
												)
											: stoppedAssessment(guardFailureReason, false),
										journals: [...journals, journal],
										observations,
									};
									const journalWriteFailure =
										await writeObservedJournalOrResult({
											semantics: entry.semantics,
											client: executionClient,
											journal,
											result,
											outcomeDurable: nonRollbackableOperationExecuted,
											onDurableWriteWarning: recordJournalWriteWarning,
										});
									return journalWriteFailure ?? result;
								}
							}
							return undefined;
						};

						const beforeGuardFailure = await runGuardPhase('before-operation');
						if (beforeGuardFailure) {
							return resultWithJournalWriteWarnings(beforeGuardFailure);
						}

						activeOperationAttempted = true;
						const nonRollbackableExecutionTracker = {
							markNonRollbackableOperationExecuted: () => {
								activeNonRollbackableOperationExecuted = true;
							},
						};
						const executionOutcome = managedClaim
							? await (() => {
									const executeManagedOutcome =
										entry.semantics.executeManagedOutcome;
									if (!executeManagedOutcome)
										throw new Error(
											`managed claim ${managedClaim.plannedClaimKey} has no outcome execution adapter`,
										);
									return executeManagedOutcome(executionClient, {
										claim: managedClaim,
										run,
										durablyLoadedRun,
										executionId,
										transactional,
										lockTimeoutMs: lockTimeoutMs(
											entry.semantics,
											entry.step,
											stepContext,
										),
										readBack: async () => {
											const observed = await entry.semantics.observeOperation(
												executionClient,
												entry.step.operation,
												stepContext,
												'after',
												entry.operationIssuer,
											);
											return managedOutcomeReadBack(observed.observations);
										},
									});
								})()
							: await entry.semantics.executeOperation(
									{
										opaqueClient: planOperationSession(
											executionClient.opaqueClient,
										),
										markClientCompromised:
											executionClient.markClientCompromised,
									},
									entry.step.operation,
									stepContext,
									entry.step.guards.filter(
										(guard) => guard.phase === 'during-operation',
									),
									nonRollbackableExecutionTracker,
								);
						if (executionOutcome.kind === 'recovery-required') {
							if (transactionStarted && !committed) {
								try {
									await rollbackAndPrepareObservedJournalWrite(
										segmentCoordinator,
										executionClient,
										lockTimeoutMs(entry.semantics, entry.step, activeContext),
									);
									transactionStarted = false;
								} catch (cleanupError) {
									executionClient.markClientCompromised();
									return resultWithJournalWriteWarnings({
										assessment: assessment(
											partiallyAppliedReason(
												entry.step,
												`claim ${executionOutcome.claimId} remains open and rollback is ambiguous: ${errorDetail(cleanupError)}`,
											),
											'outcome-unknown',
											'human-intervention-required',
										),
										journals,
										observations,
										unresolvedOutcome: {
											kind: 'recovery-required',
											claimId: executionOutcome.claimId,
											detail: `${executionOutcome.detail}; rollback failed after recovery-required: ${errorDetail(cleanupError)}`,
										},
									});
								}
							}
							return resultWithJournalWriteWarnings({
								assessment: assessment(
									partiallyAppliedReason(
										entry.step,
										`claim ${executionOutcome.claimId} remains open and requires recovery: ${executionOutcome.detail}`,
									),
									'outcome-unknown',
									'human-intervention-required',
								),
								journals,
								observations,
								unresolvedOutcome: executionOutcome,
							});
						}
						if (executionOutcome.kind === 'transport-ambiguous') {
							let detail = executionOutcome.detail;
							if (transactionStarted && !committed) {
								try {
									await rollbackAndPrepareObservedJournalWrite(
										segmentCoordinator,
										executionClient,
										lockTimeoutMs(entry.semantics, entry.step, activeContext),
									);
									transactionStarted = false;
								} catch (cleanupError) {
									detail = `${detail}; rollback failed: ${errorDetail(cleanupError)}`;
								}
							}
							executionClient.markClientCompromised();
							return resultWithJournalWriteWarnings({
								assessment: assessment(
									partiallyAppliedReason(
										entry.step,
										`managed outcome transport is ambiguous: ${detail}`,
									),
									'outcome-unknown',
									'human-intervention-required',
								),
								journals,
								observations,
								unresolvedOutcome: { kind: 'transport-ambiguous', detail },
							});
						}
						if (executionOutcome.kind === 'guard-failed') {
							if (transactionStarted && !committed) {
								await rollbackAndPrepareObservedJournalWrite(
									segmentCoordinator,
									executionClient,
									lockTimeoutMs(entry.semantics, entry.step, activeContext),
								);
							}
							const nonRollbackableFootprint =
								executionOutcome.nonRollbackableFootprint ??
								'unknown-or-present';
							const currentStepHasDurableFootprint =
								activeNonRollbackableOperationExecuted &&
								nonRollbackableFootprint === 'unknown-or-present';
							const hasCommittedSteps = journals.length > 0;
							const journal = journalWithObserved(
								entry.intent,
								hasCommittedSteps || currentStepHasDurableFootprint
									? 'partially-applied'
									: 'guard-failed',
								[],
								executionOutcome.recovery,
							);
							const reason = guardFailedReason(
								entry.step,
								executionOutcome.guard,
								executionOutcome.recovery,
							);
							const hasAppliedWork =
								hasCommittedSteps || currentStepHasDurableFootprint;
							const result = {
								assessment: hasAppliedWork
									? assessment(reason, 'partially-applied', 'resume-possible')
									: stoppedAssessment(reason, false),
								journals: [...journals, journal],
								observations,
							};
							const journalWriteFailure = await writeObservedJournalOrResult({
								semantics: entry.semantics,
								client: executionClient,
								journal,
								result,
								outcomeDurable: currentStepHasDurableFootprint,
								onDurableWriteWarning: recordJournalWriteWarning,
							});
							return resultWithJournalWriteWarnings(
								journalWriteFailure ?? result,
							);
						}
						if (executionOutcome.kind === 'partially-applied') {
							if (transactionStarted && !committed) {
								await rollbackAndPrepareObservedJournalWrite(
									segmentCoordinator,
									executionClient,
									lockTimeoutMs(entry.semantics, entry.step, activeContext),
								);
							}
							if (transactional) {
								const detail =
									executionOutcome.detail ??
									'operation reported a partial outcome before commit; transaction rolled back';
								const journal = journalWithObserved(
									entry.intent,
									'operation-failed-not-applied',
									[],
									executionOutcome.recovery,
								);
								const result = {
									assessment: stoppedAssessment(
										operationFailedNotAppliedReason(entry.step, detail),
										journals.length > 0,
									),
									journals: [...journals, journal],
									observations,
								};
								return resultWithObservedJournal({
									semantics: entry.semantics,
									client: executionClient,
									journal,
									result,
									outcomeDurable: journals.length > 0,
								});
							}
							const journal = journalWithObserved(
								entry.intent,
								'partially-applied',
								[],
								executionOutcome.recovery,
							);
							const result = {
								assessment: assessment(
									partiallyAppliedReason(
										entry.step,
										executionOutcome.detail ??
											'operation partially applied and requires recovery',
										executionOutcome.recovery,
									),
									'partially-applied',
									'resume-possible',
								),
								journals: [...journals, journal],
								observations,
							};
							const journalWriteFailure = await writeObservedJournalOrResult({
								semantics: entry.semantics,
								client: executionClient,
								journal,
								result,
								outcomeDurable: true,
								onDurableWriteWarning: recordJournalWriteWarning,
							});
							return resultWithJournalWriteWarnings(
								journalWriteFailure ?? result,
							);
						}
						const afterGuardFailure = await runGuardPhase(
							'after-operation',
							activeNonRollbackableOperationExecuted,
						);
						if (afterGuardFailure) {
							return resultWithJournalWriteWarnings(afterGuardFailure);
						}
						const postconditionAfterCommit =
							operationEffectsByRef.get(entry.step.operation.ref)?.effects
								.execution.postconditionVisibility === 'after-commit';
						if (postconditionAfterCommit) {
							if (!transactional || resolvedSteps.length !== 1) {
								return resultWithCommittedJournals(
									uncomposablePlanResult(
										plan,
										`step ${entry.step.stepId} postcondition is only visible after commit and must execute in its own transactional segment`,
									),
								);
							}
							const completion = completionRecord(
								entry.step,
								run,
								transactional,
							);
							await entry.semantics.writeCompletionJournal(
								executionClient,
								entry.step.operation,
								completion,
							);
							completedInSegment.push({
								step: entry.step,
								semantics: entry.semantics,
								operationIssuer: entry.operationIssuer,
								intent: entry.intent,
								stepContext,
								completion,
							});
							continue;
						}
						let after: Awaited<
							ReturnType<OperationRuntime['observeOperation']>
						>;
						try {
							after = await entry.semantics.observeOperation(
								executionClient,
								entry.step.operation,
								stepContext,
								'after',
								entry.operationIssuer,
							);
						} catch (error) {
							if (transactionStarted && !committed) {
								await rollbackAndPrepareObservedJournalWrite(
									segmentCoordinator,
									executionClient,
									lockTimeoutMs(entry.semantics, entry.step, activeContext),
								);
							}
							const journal = journalWithObserved(
								entry.intent,
								transactional
									? 'operation-failed-not-applied'
									: 'partially-applied',
								[],
							);
							const detail =
								error instanceof Error
									? error.message
									: 'after observation failed';
							const result = {
								assessment: transactional
									? stoppedAssessment(
											operationFailedNotAppliedReason(
												entry.step,
												`expectedAfter observation failed before commit: ${detail}`,
											),
											journals.length > 0,
										)
									: assessment(
											partiallyAppliedReason(entry.step, detail),
											'partially-applied',
											'human-intervention-required',
										),
								journals: [...journals, journal],
								observations,
							};
							const journalWriteFailure = await writeObservedJournalOrResult({
								semantics: entry.semantics,
								client: executionClient,
								journal,
								result,
								outcomeDurable: !transactional,
								onDurableWriteWarning: recordJournalWriteWarning,
							});
							return resultWithJournalWriteWarnings(
								journalWriteFailure ?? result,
							);
						}
						observations.push(...after.observations);
						const observedOutcome = {
							stepId: entry.step.stepId,
							observations: evidenceIds(after.observations),
							recordedAt: recordedAt(),
						};
						if (
							!fingerprintMatches(entry.step.expectedAfter, after.fingerprint)
						) {
							if (transactionStarted && !committed) {
								await rollbackAndPrepareObservedJournalWrite(
									segmentCoordinator,
									executionClient,
									lockTimeoutMs(entry.semantics, entry.step, activeContext),
								);
							}
							const journal: StepJournal = {
								intent: entry.intent,
								outcome: transactional
									? 'operation-failed-not-applied'
									: 'partially-applied',
								observedOutcome,
								recovery: [],
							};
							const result = {
								assessment: transactional
									? stoppedAssessment(
											operationFailedNotAppliedReason(
												entry.step,
												'expectedAfter mismatch before commit',
											),
											journals.length > 0,
										)
									: assessment(
											partiallyAppliedReason(
												entry.step,
												'expectedAfter mismatch',
											),
											'partially-applied',
											'human-intervention-required',
										),
								journals: [...journals, journal],
								observations,
							};
							const journalWriteFailure = await writeObservedJournalOrResult({
								semantics: entry.semantics,
								client: executionClient,
								journal,
								result,
								outcomeDurable: !transactional,
								onDurableWriteWarning: recordJournalWriteWarning,
							});
							return resultWithJournalWriteWarnings(
								journalWriteFailure ?? result,
							);
						}
						const completion = completionRecord(entry.step, run, transactional);
						await entry.semantics.writeCompletionJournal(
							executionClient,
							entry.step.operation,
							completion,
						);
						const journal: StepJournal = {
							intent: entry.intent,
							outcome: 'completed',
							transactionalCompletion: completion,
							observedOutcome,
						};
						if (transactional) {
							completedInSegment.push({
								step: entry.step,
								semantics: entry.semantics,
								operationIssuer: entry.operationIssuer,
								intent: entry.intent,
								stepContext,
								completion,
								journal,
							});
						} else {
							const journalWrite = await writeObservedJournalOutcome({
								semantics: entry.semantics,
								client: executionClient,
								journal,
							});
							if (!journalWrite.ok) {
								recordJournalWriteWarning(journalWrite.error);
							}
							journals.push(journal);
						}
					}

					if (transactional) {
						try {
							await segmentCoordinator.commit(executionClient);
						} catch (error) {
							throw new CommitOutcomeUncertainError(error);
						}
						committed = true;
					}

					for (const entry of completedInSegment) {
						let journal = entry.journal;
						if (!journal) {
							let after: Awaited<
								ReturnType<OperationRuntime['observeOperation']>
							>;
							try {
								after = await entry.semantics.observeOperation(
									executionClient,
									entry.step.operation,
									entry.stepContext,
									'after',
									entry.operationIssuer,
								);
							} catch (error) {
								const unknown = unknownJournal(entry.intent);
								const result = {
									assessment: assessment(
										{
											code: 'unknown-step-result',
											stepId: entry.step.stepId,
											operationKind: entry.step.operation.operationKind,
											operationRef: entry.step.operation.ref,
											scope: [],
											detail: `after-commit expectedAfter observation failed after commit: ${errorDetail(error)}`,
										},
										'outcome-unknown',
										'human-intervention-required',
									),
									journals: [...journals, unknown],
									observations,
								};
								return await resultWithObservedJournal({
									semantics: entry.semantics,
									client: executionClient,
									journal: unknown,
									result,
									outcomeDurable: true,
								});
							}
							observations.push(...after.observations);
							const observedOutcome = {
								stepId: entry.step.stepId,
								observations: evidenceIds(after.observations),
								recordedAt: recordedAt(),
							};
							if (
								!fingerprintMatches(entry.step.expectedAfter, after.fingerprint)
							) {
								const journalWithMismatch: StepJournal = {
									intent: entry.intent,
									outcome: 'partially-applied',
									observedOutcome,
									recovery: [],
								};
								const result = {
									assessment: assessment(
										partiallyAppliedReason(
											entry.step,
											'expectedAfter mismatch after commit',
										),
										'partially-applied',
										'human-intervention-required',
									),
									journals: [...journals, journalWithMismatch],
									observations,
								};
								const journalWriteFailure = await writeObservedJournalOrResult({
									semantics: entry.semantics,
									client: executionClient,
									journal: journalWithMismatch,
									result,
									outcomeDurable: true,
									onDurableWriteWarning: recordJournalWriteWarning,
								});
								return resultWithJournalWriteWarnings(
									journalWriteFailure ?? result,
								);
							}
							journal = {
								intent: entry.intent,
								outcome: 'completed',
								transactionalCompletion: entry.completion,
								observedOutcome,
							};
						}
						const journalWrite = await writeObservedJournalOutcome({
							semantics: entry.semantics,
							client: executionClient,
							journal,
						});
						if (!journalWrite.ok) {
							recordJournalWriteWarning(journalWrite.error);
						}
						journals.push(journal);
					}
				} catch (error) {
					releaseFailure = { error };
					if (error instanceof CommitOutcomeUncertainError) {
						// COMMIT may have reached PostgreSQL even though its acknowledgement
						// was lost. This lease must never return to the pool, and no observed
						// journal append may turn transport ambiguity into a claimed fact.
						client?.markClientCompromised();
						const journal = unknownJournal(active.intent);
						const result = {
							assessment: assessment(
								{
									code: 'unknown-step-result',
									stepId: active.step.stepId,
									operationKind: active.step.operation.operationKind,
									operationRef: active.step.operation.ref,
									scope: [],
									detail: `commit outcome uncertain after commit failure: ${errorDetail(error.originalError)}`,
								},
								'outcome-unknown',
								'human-intervention-required',
							),
							journals: [...journals, journal],
							observations,
						};
						return result;
					}
					let rollbackAttempted = false;
					let rollbackSucceeded = false;
					if (client && transactionStarted && !committed) {
						rollbackAttempted = true;
						try {
							await rollbackAndPrepareObservedJournalWrite(
								segmentCoordinator,
								client,
								lockTimeoutMs(active.semantics, active.step, activeContext),
							);
							rollbackSucceeded = true;
						} catch {
							// The outcome below reports uncertainty; resume must re-introspect.
						}
					}
					if (
						rollbackAttempted &&
						!rollbackSucceeded &&
						(activeOperationAttempted || completedInSegment.length > 0)
					) {
						// Attribute uncertainty to the earliest operation that ran in this
						// segment. The durable record cannot yet express reconcilable
						// segment uncertainty, so an unconfirmed rollback after executed
						// work requires human intervention.
						const uncertain = completedInSegment[0] ?? active;
						const journal = unknownJournal(uncertain.intent);
						const result = {
							assessment: assessment(
								{
									code: 'unknown-step-result',
									stepId: uncertain.step.stepId,
									operationKind: uncertain.step.operation.operationKind,
									operationRef: uncertain.step.operation.ref,
									scope: [],
									detail:
										error instanceof Error
											? `rollback outcome uncertain after failure: ${error.message}; human intervention is required because the durable record cannot yet express reconcilable segment uncertainty`
											: 'rollback outcome uncertain after apply failure; human intervention is required because the durable record cannot yet express reconcilable segment uncertainty',
								},
								'outcome-unknown',
								'human-intervention-required',
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: uncertain.semantics,
							client,
							journal,
							result,
							outcomeDurable: true,
						});
					}
					if (!activeIntentWritten) {
						if (segmentCoordinator.isLockTimeout(error)) {
							return preIntentRefusal({
								code: 'guard-timeout',
								stepId: active.step.stepId,
								operationKind: active.step.operation.operationKind,
								operationRef: active.step.operation.ref,
								maxWaitMs: lockTimeoutMs(
									active.semantics,
									active.step,
									activeContext,
								),
								scope: [],
							});
						}
						return preIntentRefusal(
							operationFailedNotAppliedReason(
								active.step,
								error instanceof Error
									? error.message
									: 'operation setup failed before intent',
							),
						);
					}
					if (segmentCoordinator.isLockTimeout(error)) {
						const hasAppliedWork =
							journals.length > 0 || activeNonRollbackableOperationExecuted;
						const journal = journalWithObserved(
							active.intent,
							activeNonRollbackableOperationExecuted
								? 'partially-applied'
								: 'guard-timeout',
							[],
						);
						const result = {
							assessment: stoppedAssessment(
								{
									code: 'guard-timeout',
									stepId: active.step.stepId,
									operationKind: active.step.operation.operationKind,
									operationRef: active.step.operation.ref,
									maxWaitMs: lockTimeoutMs(
										active.semantics,
										active.step,
										activeContext,
									),
									scope: [],
								},
								hasAppliedWork,
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: hasAppliedWork,
						});
					}
					if (!activeOperationAttempted) {
						const detail =
							error instanceof Error
								? error.message
								: 'operation setup failed before executeOperation';
						const journal = journalWithObserved(
							active.intent,
							'operation-failed-not-applied',
							[],
						);
						const result = {
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: journals.length > 0,
						});
					}
					if (
						transactional &&
						rollbackAttempted &&
						rollbackSucceeded &&
						!activeNonRollbackableOperationExecuted
					) {
						const detail =
							error instanceof Error
								? error.message
								: 'operation failed before commit';
						const journal = journalWithObserved(
							active.intent,
							'operation-failed-not-applied',
							[],
						);
						const result = {
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: journals.length > 0,
						});
					}
					if (!committed && !activeNonRollbackableOperationExecuted) {
						const detail =
							error instanceof Error
								? error.message
								: 'operation failed before non-rollbackable DDL was reached';
						const journal = journalWithObserved(
							active.intent,
							'operation-failed-not-applied',
							[],
						);
						const result = {
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: journals.length > 0,
						});
					}
					if (committed || activeNonRollbackableOperationExecuted) {
						const journal = journalWithObserved(
							active.intent,
							'partially-applied',
							[],
						);
						const result = {
							assessment: assessment(
								partiallyAppliedReason(
									active.step,
									error instanceof Error
										? error.message
										: 'segment failed after an earlier commit',
								),
								'partially-applied',
								'resume-possible',
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: true,
						});
					}
					if (journals.length > 0) {
						const detail =
							error instanceof Error
								? error.message
								: 'segment failed after an earlier commit without a confirmed rollback';
						const journal = unknownJournal(active.intent);
						const result = {
							assessment: assessment(
								{
									code: 'unknown-step-result',
									stepId: active.step.stepId,
									operationKind: active.step.operation.operationKind,
									operationRef: active.step.operation.ref,
									scope: [],
									detail,
								},
								'outcome-unknown',
								'human-intervention-required',
							),
							journals: [...journals, journal],
							observations,
						};
						return resultWithObservedJournal({
							semantics: active.semantics,
							client,
							journal,
							result,
							outcomeDurable: true,
						});
					}
					const journal = unknownJournal(active.intent);
					const result = {
						assessment: assessment(
							{
								code: 'unknown-step-result',
								stepId: active.step.stepId,
								operationKind: active.step.operation.operationKind,
								operationRef: active.step.operation.ref,
								scope: [],
								detail:
									error instanceof Error
										? error.message
										: 'unknown apply error',
							},
							'outcome-unknown',
							'human-intervention-required',
						),
						journals: [...journals, journal],
						observations,
					};
					return resultWithObservedJournal({
						semantics: active.semantics,
						client,
						journal,
						result,
						outcomeDurable: true,
					});
				} finally {
					if (lease) {
						await lease.release(releaseFailure);
					}
				}
			}
			return resultWithJournalWriteWarnings({
				assessment: completedAssessment(reportedAssessment),
				journals,
				observations,
			});
		},
		async applyDurable(input: DurableApplyInput): Promise<DurableApplyResult> {
			let loaded: TransitionRunJournal & { readonly plan: ProvenPlanShape };
			try {
				const supplied = await input.loadCurrent(input.runId);
				loaded = JSON.parse(JSON.stringify(supplied)) as typeof supplied;
			} catch (error) {
				return durableRefusal(
					'load-failed',
					`run could not be loaded: ${errorDetail(error)}`,
				);
			}
			if (loaded.run.runId !== input.runId) {
				return durableRefusal(
					'run-id-mismatch',
					'loaded run id does not match requested run id',
				);
			}
			if (loaded.run.coreVersion !== '0.3.0') {
				return durableRefusal(
					'compatibility-refusal',
					`run is execution-ineligible; re-plan (execution compatibility epoch ${loaded.run.coreVersion} is not supported; expected 0.3.0)`,
				);
			}
			let plan: InProcessProvenPlan;
			try {
				// The durable evidence is immutable before any adapter extension can
				// inspect it. Callbacks receive this same verified snapshot.
				plan = snapshotDurablePlan(loaded.plan);
			} catch (error) {
				return durableRefusal(
					'plan-validation-failed',
					`loaded plan could not be snapshotted safely: ${errorDetail(error)}`,
				);
			}
			let observedPlanDigest: string;
			try {
				observedPlanDigest = transitionPlanDigest(plan);
			} catch (error) {
				return durableRefusal(
					'plan-validation-failed',
					`loaded plan could not be digested: ${errorDetail(error)}`,
				);
			}
			if (input.expectedPlanDigest !== observedPlanDigest) {
				return durableRefusal(
					'plan-digest-mismatch',
					`reviewed plan digest does not match the stored plan: expected ${input.expectedPlanDigest}; observed ${observedPlanDigest}`,
				);
			}
			if (loaded.run.planDigest !== observedPlanDigest) {
				return durableRefusal(
					'digest-mismatch',
					'loaded plan digest does not match run metadata',
				);
			}
			const contract = validateExecutionContract(plan.executionContract);
			if (!contract.ok)
				return durableRefusal('execution-contract-refused', contract.detail);
			let structural: ReturnType<typeof validateTransitionRelationalInvariants>;
			try {
				structural = validateTransitionRelationalInvariants({
					kind: 'plan',
					plan,
				});
			} catch (error) {
				return durableRefusal(
					'plan-validation-failed',
					`loaded plan could not be structurally validated: ${errorDetail(error)}`,
				);
			}
			if (!structural.ok)
				return durableRefusal('plan-validation-failed', structural.detail);
			if (loaded.events.length > 0) {
				return durableRefusal(
					'prior-step-events-refusal',
					'run has prior step-attempt events; run dbsp recover instead',
				);
			}
			const nonTransactionalAssumptions = plan.assumptions.filter(
				(assumption) => assumption.class === 'non-transactional-segment',
			);
			if (
				plan.segments.some(
					(segment) => segment.transaction === 'forbids-transaction',
				) &&
				(nonTransactionalAssumptions.length === 0 ||
					!nonTransactionalAssumptions.every((assumption) =>
						assumptionAccepted(assumption, input.policy),
					))
			) {
				return durableRefusal(
					'transactional-only-refusal',
					"durable apply executes segments that forbid a transaction block only when the plan's non-transactional-segment assumption is accepted; run was not attempted",
				);
			}
			const context = plan.observations.find(
				(observation) => observation.role === 'evidence',
			)?.context;
			if (!context)
				return durableRefusal(
					'plan-validation-failed',
					'loaded plan has no evidence observation context',
				);
			const effects = new Map<string, OperationEffectAssessment>();
			for (const step of plan.steps) {
				let resolution: ReturnType<typeof registry.resolveOperation>;
				try {
					resolution = registry.resolveOperation(step.operation);
				} catch (error) {
					return durableRefusal(
						'plan-validation-failed',
						`operation ${step.operation.ref} could not be resolved: ${errorDetail(error)}`,
					);
				}
				if (
					!resolution.ok ||
					resolution.semantics.artifact.id !==
						step.operation.operationKind.artifact.id ||
					resolution.semantics.artifact.version !==
						step.operation.operationKind.artifact.version
				) {
					return durableRefusal(
						'operation-unavailable',
						`required operation artifact ${step.operation.operationKind.artifact.id}@${step.operation.operationKind.artifact.version} is unavailable`,
					);
				}
				try {
					effects.set(
						step.operation.ref,
						resolution.semantics.effectsOf(step.operation, context),
					);
				} catch (error) {
					return durableRefusal(
						'plan-validation-failed',
						`operation ${step.operation.ref} could not be validated: ${errorDetail(error)}`,
					);
				}
			}
			let semantic: ReturnType<typeof validateTransitionRelationalInvariants>;
			try {
				semantic = validateTransitionRelationalInvariants({
					kind: 'plan',
					plan,
					operationEffectsByRef: effects,
				});
			} catch (error) {
				return durableRefusal(
					'plan-validation-failed',
					`loaded plan could not be semantically validated: ${errorDetail(error)}`,
				);
			}
			if (!semantic.ok)
				return durableRefusal('plan-validation-failed', semantic.detail);
			const durablyLoadedRun = mintDurablyLoadedRun(loaded.run);
			for (const assumption of plan.assumptions) {
				if (!assumptionAccepted(assumption, input.policy)) {
					return durableRefusal(
						'assumption-not-accepted',
						`assumption ${assumption.id} (${assumption.class}) is not accepted for its trust root and scope`,
					);
				}
			}
			let lease: TransitionLease | undefined;
			let leaseReleaseFailure: TransitionLeaseFailure | undefined;
			try {
				lease = await acquireExclusiveTransitionLease(input.target);
			} catch (error) {
				return durableRefusal(
					'execution-preflight-failed',
					`execution preflight lease could not be acquired: ${errorDetail(error)}`,
				);
			}
			try {
				const preflightLease = lease;
				let prepared: Awaited<ReturnType<typeof input.prepareExecutionSession>>;
				try {
					prepared = await input.prepareExecutionSession(
						preflightLease.session,
						contract.contract,
						plan,
					);
				} catch (error) {
					return durableRefusal(
						'execution-preflight-failed',
						`execution preflight query failed: ${errorDetail(error)}`,
					);
				}
				if (!prepared.ok)
					return durableRefusal(
						prepared.kind === 'read-only'
							? 'database-read-only'
							: prepared.kind === 'failed'
								? 'execution-preflight-failed'
								: 'execution-contract-refused',
						prepared.detail,
					);
				try {
					await input.authorize(loaded.run, plan, preflightLease.session);
				} catch (error) {
					return durableRefusal(
						'authorization-write-failed',
						`authorization could not be committed: ${errorDetail(error)}`,
					);
				}
				const pinnedTarget = createTransitionLessor(async () => ({
					query: (sql: string, params?: unknown) =>
						preflightLease.session.query(sql, params),
					// Re-minting the logical lease must retain the operation origin.
					// The ordinary channel remains available to durable infrastructure.
					queryPlanOperation: (sql: string, params?: unknown) =>
						planOperationSession(preflightLease.session).query(sql, params),
					// apply() owns logical segment leases, but this outer durable
					// boundary owns the physical connection until apply() has settled:
					// post-step observed-journal writes still use this session.
					release: (error?: unknown) => {
						if (error) leaseReleaseFailure = { error };
					},
				}));
				// Await before this try's finally returns the physical lease. A bare
				// return would run finally while apply() still owns its logical leases
				// and can still owe an observed-journal write.
				try {
					const result = await this.apply(
						{
							plan,
							assessment: derivedApplicableAssessment(plan),
							__durableRun: loaded.run,
							__durablyLoadedRun: durablyLoadedRun,
							__executionId: `dbsp.transition.execution.${randomUUID()}`,
							__executionBoundary: {
								kind: 'durable-contract',
								context: prepared.context,
							},
						} as DurableExecutionCarrier,
						input.policy,
						pinnedTarget,
					);
					return { ...result, durableOutcome: durableExecutionOutcome(result) };
				} catch (error) {
					return durableRefusal(
						isDatabaseReadOnlyError(error)
							? 'database-read-only'
							: 'execution-failed',
						`execution phase failed: ${errorDetail(error)}`,
					);
				}
			} finally {
				if (lease) await lease.release(leaseReleaseFailure);
			}
		},
		async resume(journal, readContext, policy, target, admitRecovery) {
			const result = await resumeTransitionRun(registry, {
				journal,
				readContext,
				target,
				...(policy ? { policy } : {}),
				...(admitRecovery ? { admitRecovery } : {}),
			});
			return { ...result, recoveryOutcome: recoveryOutcome(result) };
		},
	};
}
