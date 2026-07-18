import { createHash, randomUUID } from 'node:crypto';
import type {
	ApplicableAssessment,
	ApplyGuard,
	ApplyPolicy,
	ApplyResult,
	Assumption,
	ClaimId,
	DurableIntentRecord,
	EvidenceId,
	EvidenceObservation,
	FingerprintManifest,
	IssuedObservation,
	ObservationContext,
	OperationEffectAssessment,
	OutcomeReason,
	PlanAssessment,
	ProvenPlanStep,
	RecoveryArtefact,
	ResourceAddress,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionConnectionPool,
	TransitionRunMetadata,
	TrustRoot,
} from '@dbsp/types';
import { matchLiveObservationContext } from './context-match.js';
import { claimId, semanticArtifactId } from './ids.js';
import type { Applier, InProcessProvenPlan } from './index.js';
import { isMintedInProcessPlan } from './minting.js';
import {
	type ExecutionCoordinator,
	isOperationRuntime,
	type OperationRuntime,
	type PackRegistry,
} from './registry.js';
import { resumeTransitionRun } from './resume.js';
import { stableJson } from './stable-json.js';
import { validateTransitionRelationalInvariants } from './validation.js';

const APPLIER_ARTIFACT = {
	id: semanticArtifactId('dbsp.core.transition.applier'),
	version: '0.1.0',
};

const UNMINTED_PLAN_DETAIL =
	'plan was not minted by prove() in this process; applying a serialized plan is a separate, not-yet-available API (roadmap: identity & adoption)';

function sameTrustRoot(left: TrustRoot, right: TrustRoot): boolean {
	return stableJson(left) === stableJson(right);
}

function selectorMatchesResource(
	selector: NonNullable<ApplyPolicy['accepts'][number]['withinScope']>[number],
	resource: ResourceAddress,
): boolean {
	if (selector.within && !resourceIsWithin(resource, selector.within)) {
		return false;
	}
	if (selector.kind && selector.kind !== resource.kind) {
		return false;
	}
	if (selector.schema && selector.schema !== resource.schema) {
		return false;
	}
	if (selector.name && selector.name !== resource.name) {
		return false;
	}
	return true;
}

function sameResource(left: ResourceAddress, right: ResourceAddress): boolean {
	return stableJson(left) === stableJson(right);
}

function resourceIsWithin(
	resource: ResourceAddress,
	parent: ResourceAddress,
): boolean {
	if (sameResource(resource, parent)) {
		return true;
	}
	return (
		resource.engine === parent.engine &&
		resource.database === parent.database &&
		resource.schema === parent.schema &&
		(resource.qualifiedBy?.includes(parent.name) ?? false)
	);
}

function assumptionAccepted(
	assumption: Assumption,
	policy: ApplyPolicy,
): boolean {
	return policy.accepts.some((acceptance) => {
		if (acceptance.class !== assumption.class) {
			return false;
		}
		if (
			acceptance.fromTrustRoot &&
			!sameTrustRoot(acceptance.fromTrustRoot, assumption.asserter)
		) {
			return false;
		}
		if (assumption.scope.length === 0) {
			return !acceptance.withinScope || acceptance.withinScope.length === 0;
		}
		if (!acceptance.withinScope || acceptance.withinScope.length === 0) {
			return true;
		}
		return assumption.scope.every((resource) =>
			acceptance.withinScope?.some((selector) =>
				selectorMatchesResource(selector, resource),
			),
		);
	});
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

function recordedAt(): string {
	return new Date().toISOString();
}

function digest(value: unknown): string {
	return createHash('sha256').update(stableJson(value)).digest('hex');
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

function contextFromPlanObservations(
	observations: readonly IssuedObservation[],
): ObservationContext | undefined {
	const evidence = observations.filter(
		(observation) => observation.role === 'evidence',
	);
	const first = evidence[0]?.context;
	if (!first) {
		return undefined;
	}
	const expected = stableJson(first);
	for (const observation of evidence.slice(1)) {
		if (stableJson(observation.context) !== expected) {
			return undefined;
		}
	}
	return first;
}

function fingerprintMatches(
	expected: FingerprintManifest,
	actual: FingerprintManifest,
): boolean {
	return expected.digest === actual.digest;
}

function transitionRunMetadata(
	plan: InProcessProvenPlan,
	context: ObservationContext,
): TransitionRunMetadata {
	return {
		runId: `dbsp-${randomUUID()}`,
		planDigest: digest(plan),
		targetContextDigest: digest(context),
		databaseId: context.databaseId,
		coreVersion: APPLIER_ARTIFACT.version,
		startedAt: recordedAt(),
	};
}

function intentRecord(
	step: ProvenPlanStep,
	run: TransitionRunMetadata,
): DurableIntentRecord {
	return {
		runId: run.runId,
		run,
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

function contextMismatchJournal(
	intent: DurableIntentRecord,
	observations: readonly IssuedObservation[],
): StepJournal {
	return {
		intent,
		outcome: 'context-mismatch',
		observedOutcome: {
			stepId: intent.stepId,
			observations: evidenceIds(observations),
			recordedAt: recordedAt(),
		},
	};
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
	return error instanceof Error ? error.message : 'unknown error';
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
	readonly client: Awaited<ReturnType<OperationRuntime['checkout']>>;
	readonly journal: StepJournal;
}): Promise<
	{ readonly ok: true } | { readonly ok: false; readonly error: unknown }
> {
	try {
		await params.semantics.writeObservedJournal(params.client, params.journal);
		return { ok: true };
	} catch (error) {
		return { ok: false, error };
	}
}

async function writeObservedJournalOrResult(params: {
	readonly semantics: OperationRuntime;
	readonly client: Awaited<ReturnType<OperationRuntime['checkout']>>;
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

export function createApplier(registry: PackRegistry): Applier {
	return {
		artifact: APPLIER_ARTIFACT,
		async apply(
			proven: {
				readonly plan: InProcessProvenPlan;
				readonly assessment: ApplicableAssessment;
			},
			policy: ApplyPolicy,
			target: TransitionConnectionPool,
		): Promise<ApplyResult> {
			const plan =
				typeof proven === 'object' && proven !== null
					? (proven as { readonly plan?: unknown }).plan
					: undefined;
			if (!isMintedInProcessPlan(plan)) {
				return invalidPlanResult(UNMINTED_PLAN_DETAIL);
			}
			if (plan.steps.length === 0 || plan.segments.length === 0) {
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

			const proofContext = contextFromPlanObservations(plan.observations);
			if (!proofContext) {
				throw new Error(
					'internal error: minted proven plan evidence observations do not share one context',
				);
			}
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
			const run = transitionRunMetadata(plan, proofContext);
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
							assessment: assessmentWithJournalWriteWarnings(result.assessment),
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
			let runtimeContext = proofContext;

			const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));
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
				const resolvedSteps = [];
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
						intent: intentRecord(step, run),
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

				let client:
					| Awaited<ReturnType<OperationRuntime['checkout']>>
					| undefined;
				let committed = false;
				let transactionStarted = false;
				let releaseError: unknown;
				let active = first;
				let activeContext = runtimeContext;
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
					client = await segmentCoordinator.checkout(target);
					const executionClient = client;
					if (transactional) {
						await segmentCoordinator.begin(executionClient);
						transactionStarted = true;
					}

					for (const entry of resolvedSteps) {
						active = entry;
						activeContext = runtimeContext;
						activeOperationAttempted = false;
						activeNonRollbackableOperationExecuted = false;
						await entry.semantics.writeIntentJournal(
							executionClient,
							entry.intent,
						);
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
						const liveContextMatch = matchLiveObservationContext({
							expected: proofContext,
							actual: stepContext,
						});
						if (!liveContextMatch.ok) {
							if (transactionStarted && !committed) {
								await segmentCoordinator.rollback(executionClient);
							}
							const journal = contextMismatchJournal(entry.intent, []);
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							return resultWithJournalWriteWarnings({
								assessment: stoppedAssessment(
									contextMismatchReason(entry.step, liveContextMatch.detail),
									journals.length > 0,
								),
								journals: [...journals, journal],
								observations,
							});
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
						} catch {
							if (transactionStarted && !committed) {
								await segmentCoordinator.rollback(executionClient);
							}
							const journal = unknownJournal(entry.intent);
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							return resultWithJournalWriteWarnings({
								assessment: stoppedAssessment(
									contextMismatchReason(
										entry.step,
										'expectedBefore fingerprint could not be rebuilt',
									),
									journals.length > 0,
								),
								journals: [...journals, journal],
								observations,
							});
						}
						if (
							!fingerprintMatches(
								entry.step.expectedBefore,
								currentFingerprints.expectedBefore,
							)
						) {
							if (transactionStarted && !committed) {
								await segmentCoordinator.rollback(executionClient);
							}
							const journal = contextMismatchJournal(
								entry.intent,
								observations,
							);
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							return resultWithJournalWriteWarnings({
								assessment: stoppedAssessment(
									contextMismatchReason(entry.step, 'expectedBefore mismatch'),
									journals.length > 0,
								),
								journals: [...journals, journal],
								observations,
							});
						}

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
										await segmentCoordinator.rollback(executionClient);
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
						if (!transactional) {
							activeNonRollbackableOperationExecuted = true;
						}
						const executionOutcome = await entry.semantics.executeOperation(
							executionClient,
							entry.step.operation,
							stepContext,
							entry.step.guards.filter(
								(guard) => guard.phase === 'during-operation',
							),
						);
						if (executionOutcome.kind === 'guard-failed') {
							if (transactionStarted && !committed) {
								await segmentCoordinator.rollback(executionClient);
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
								await segmentCoordinator.rollback(executionClient);
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
								await entry.semantics.writeObservedJournal(
									executionClient,
									journal,
								);
								return resultWithJournalWriteWarnings({
									assessment: stoppedAssessment(
										operationFailedNotAppliedReason(entry.step, detail),
										journals.length > 0,
									),
									journals: [...journals, journal],
									observations,
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
							!transactional,
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
								await segmentCoordinator.rollback(executionClient);
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
								await segmentCoordinator.rollback(executionClient);
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
								await entry.semantics
									.writeObservedJournal(executionClient, unknown)
									.catch(() => undefined);
								return resultWithJournalWriteWarnings({
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
					releaseError = error;
					if (error instanceof CommitOutcomeUncertainError) {
						if (client && transactionStarted) {
							await segmentCoordinator.rollback(client).catch(() => undefined);
						}
						const journal = unknownJournal(active.intent);
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
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
						});
					}
					let rollbackAttempted = false;
					let rollbackSucceeded = false;
					if (client && transactionStarted && !committed) {
						rollbackAttempted = true;
						try {
							await segmentCoordinator.rollback(client);
							rollbackSucceeded = true;
						} catch {
							// The outcome below reports uncertainty; resume must re-introspect.
						}
					}
					if (
						rollbackAttempted &&
						!rollbackSucceeded &&
						activeOperationAttempted
					) {
						const journal = unknownJournal(active.intent);
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
							assessment: assessment(
								{
									code: 'unknown-step-result',
									stepId: active.step.stepId,
									operationKind: active.step.operation.operationKind,
									operationRef: active.step.operation.ref,
									scope: [],
									detail:
										error instanceof Error
											? `rollback outcome uncertain after failure: ${error.message}`
											: 'rollback outcome uncertain after apply failure',
								},
								'outcome-unknown',
								'human-intervention-required',
							),
							journals: [...journals, journal],
							observations,
						});
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
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
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
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
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
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
						});
					}
					if (committed || activeNonRollbackableOperationExecuted) {
						const journal = journalWithObserved(
							active.intent,
							'partially-applied',
							[],
						);
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
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
						});
					}
					if (journals.length > 0) {
						const detail =
							error instanceof Error
								? error.message
								: 'segment failed after an earlier commit without a confirmed rollback';
						const journal = unknownJournal(active.intent);
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return resultWithJournalWriteWarnings({
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
						});
					}
					const journal = unknownJournal(active.intent);
					if (client) {
						await active.semantics
							.writeObservedJournal(client, journal)
							.catch(() => undefined);
					}
					return resultWithJournalWriteWarnings({
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
					});
				} finally {
					if (client) {
						try {
							await segmentCoordinator.release(client, releaseError);
						} catch {
							// A cleanup failure must not mask the known apply outcome.
						}
					}
				}
			}
			return {
				assessment: assessmentWithJournalWriteWarnings(
					completedAssessment(reportedAssessment),
				),
				journals,
				observations,
			};
		},
		async resume(runId, loadCurrent, readContext, policy, target) {
			return resumeTransitionRun(registry, {
				runId,
				loadCurrent,
				readContext,
				policy,
				target,
			});
		},
	};
}
