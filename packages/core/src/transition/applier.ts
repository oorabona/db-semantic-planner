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
			let runtimeContext = proofContext;

			const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));
			for (const segment of plan.segments) {
				const segmentSteps = segment.stepIds.map((stepId) =>
					stepById.get(stepId),
				);
				if (segmentSteps.some((step) => !step)) {
					return uncomposablePlanResult(
						plan,
						`segment ${segment.segmentId} references a missing step`,
					);
				}
				const resolvedSteps = [];
				for (const step of segmentSteps as ProvenPlanStep[]) {
					const operationResolution = registry.resolveOperation(step.operation);
					if (!operationResolution.ok) {
						return unresolvedOperationResult(step, operationResolution.detail);
					}
					const semantics = operationResolution.semantics;
					if (!isOperationRuntime(semantics)) {
						return unresolvedRuntimeResult(step);
					}
					if (
						semantics.artifact.id !==
							step.operation.operationKind.artifact.id ||
						semantics.artifact.version !==
							step.operation.operationKind.artifact.version
					) {
						return unresolvedRuntimeResult(step);
					}
					const operationIssuer = registry.resolveIssuer(
						step.operation.operationKind.artifact,
					);
					if (!operationIssuer) {
						return unresolvedOperationResult(
							step,
							'operation observation issuer missing',
						);
					}
					const execution = operationEffectsByRef.get(step.operation.ref)
						?.effects.execution;
					if (!execution) {
						return unresolvedOperationResult(step, 'operation effects missing');
					}
					if (
						segment.transaction === 'joins-current' &&
						execution.transaction !== 'joins-current'
					) {
						return uncomposablePlanResult(
							plan,
							`step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
						);
					}
					if (
						segment.transaction === 'forbids-transaction' &&
						execution.transaction !== 'forbids-transaction'
					) {
						return uncomposablePlanResult(
							plan,
							`step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
						);
					}
					if (
						segment.transaction !== 'forbids-transaction' &&
						execution.transaction === 'forbids-transaction'
					) {
						return uncomposablePlanResult(
							plan,
							`step ${step.stepId} forbids the transaction used by segment ${segment.segmentId}`,
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
					return uncomposablePlanResult(
						plan,
						`segment ${segment.segmentId} contains no steps`,
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
						return uncomposablePlanResult(
							plan,
							`segment ${segment.segmentId} spans multiple operation runtimes without an explicit shared transaction coordinator`,
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
						return uncomposablePlanResult(
							plan,
							`segment ${segment.segmentId} spans operation runtimes with different transaction coordinators`,
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
					return uncomposablePlanResult(
						plan,
						`segment ${segment.segmentId} spans multiple operation runtimes without a transaction`,
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
				let activeNonRollbackableOperationExecuted = false;
				const completedInSegment: {
					readonly step: ProvenPlanStep;
					readonly semantics: OperationRuntime;
					readonly journal: StepJournal;
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
							return {
								assessment: stoppedAssessment(
									contextMismatchReason(
										entry.step,
										'expectedBefore fingerprint could not be rebuilt',
									),
									journals.length > 0,
								),
								journals: [...journals, journal],
								observations,
							};
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
							return {
								assessment: stoppedAssessment(
									contextMismatchReason(entry.step, 'expectedBefore mismatch'),
									journals.length > 0,
								),
								journals: [...journals, journal],
								observations,
							};
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
									await entry.semantics.writeObservedJournal(
										executionClient,
										journal,
									);
									const guardFailureReason = guardFailedReason(
										entry.step,
										guard,
										guardResult.recovery,
									);
									return {
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
								}
							}
							return undefined;
						};

						const beforeGuardFailure = await runGuardPhase('before-operation');
						if (beforeGuardFailure) {
							return beforeGuardFailure;
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
							const journal = journalWithObserved(
								entry.intent,
								'guard-failed',
								[],
								executionOutcome.recovery,
							);
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							const reason = guardFailedReason(
								entry.step,
								executionOutcome.guard,
								executionOutcome.recovery,
							);
							return {
								assessment: stoppedAssessment(reason, journals.length > 0),
								journals: [...journals, journal],
								observations,
							};
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
								return {
									assessment: stoppedAssessment(
										operationFailedNotAppliedReason(entry.step, detail),
										journals.length > 0,
									),
									journals: [...journals, journal],
									observations,
								};
							}
							const journal = journalWithObserved(
								entry.intent,
								'partially-applied',
								[],
								executionOutcome.recovery,
							);
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							return {
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
						}
						if (!transactional) {
							activeNonRollbackableOperationExecuted = true;
						}
						const afterGuardFailure = await runGuardPhase(
							'after-operation',
							!transactional,
						);
						if (afterGuardFailure) {
							return afterGuardFailure;
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
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							const detail =
								error instanceof Error
									? error.message
									: 'after observation failed';
							return {
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
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							return {
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
								journal,
							});
						} else {
							await entry.semantics.writeObservedJournal(
								executionClient,
								journal,
							);
							journals.push(journal);
						}
					}

					if (transactional) {
						await segmentCoordinator.commit(executionClient);
						committed = true;
					}

					for (const entry of completedInSegment) {
						await entry.semantics.writeObservedJournal(
							executionClient,
							entry.journal,
						);
						journals.push(entry.journal);
					}
				} catch (error) {
					releaseError = error;
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
					if (rollbackAttempted && !rollbackSucceeded) {
						const journal = unknownJournal(active.intent);
						if (client) {
							await active.semantics
								.writeObservedJournal(client, journal)
								.catch(() => undefined);
						}
						return {
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
						};
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
						return {
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
						return {
							assessment: stoppedAssessment(
								operationFailedNotAppliedReason(active.step, detail),
								journals.length > 0,
							),
							journals: [...journals, journal],
							observations,
						};
					}
					if (
						committed ||
						journals.length > 0 ||
						activeNonRollbackableOperationExecuted
					) {
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
						return {
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
					}
					const journal = unknownJournal(active.intent);
					if (client) {
						await active.semantics
							.writeObservedJournal(client, journal)
							.catch(() => undefined);
					}
					return {
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
				assessment: completedAssessment(reportedAssessment),
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
