import type {
	ApplicableAssessment,
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
	OutcomeReason,
	PlanAssessment,
	ProvenPlanStep,
	RecoveryArtefact,
	ResourceAddress,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionConnectionPool,
	TrustRoot,
} from '@dbsp/types';
import { claimId, semanticArtifactId } from './ids.js';
import type { Applier, InProcessProvenPlan } from './index.js';
import { isMintedInProcessPlan } from './minting.js';
import {
	isOperationRuntime,
	type OperationRuntime,
	type PackRegistry,
} from './registry.js';
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

function intentRecord(step: ProvenPlanStep): DurableIntentRecord {
	return {
		stepId: step.stepId,
		operation: step.operation,
		recordedAt: recordedAt(),
	};
}

function completionRecord(step: ProvenPlanStep): TransactionalCompletionRecord {
	return {
		stepId: step.stepId,
		committedWithDdl: true,
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
	outcome: 'guard-failed' | 'guard-timeout' | 'partially-applied',
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

function noSingleStepResult(plan: InProcessProvenPlan): ApplyResult {
	return {
		assessment: assessment({
			code: 'uncomposable',
			fragments: plan.steps.map((step) => step.selectionRationale.chosen),
			scope: [],
			detail: 'applier only supports the ADR-0003 single-step slice',
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
			if (plan.steps.length !== 1) {
				return noSingleStepResult(plan);
			}
			const step = plan.steps[0];
			if (!step) {
				return noSingleStepResult(plan);
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

			for (const assumption of plan.assumptions) {
				if (!assumptionAccepted(assumption, policy)) {
					return unacceptedAssumptionResult(plan, assumption);
				}
			}

			const operationResolution = registry.resolveOperation(step.operation);
			if (!operationResolution.ok) {
				return unresolvedOperationResult(step, operationResolution.detail);
			}
			const semantics = operationResolution.semantics;
			if (!isOperationRuntime(semantics)) {
				return unresolvedRuntimeResult(step);
			}
			if (
				semantics.artifact.id !== step.operation.operationKind.artifact.id ||
				semantics.artifact.version !==
					step.operation.operationKind.artifact.version
			) {
				return unresolvedRuntimeResult(step);
			}

			const proofContext = contextFromPlanObservations(plan.observations);
			if (!proofContext) {
				throw new Error(
					'internal error: minted proven plan evidence observations do not share one context',
				);
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
			const intent = intentRecord(step);

			const observations: IssuedObservation[] = [];
			let client: Awaited<ReturnType<OperationRuntime['checkout']>> | undefined;
			let committed = false;
			let transactionStarted = false;
			let releaseError: unknown;
			let runtimeContext = proofContext;
			try {
				const executionClient = await semantics.checkout(target);
				client = executionClient;
				await semantics.writeIntentJournal(executionClient, intent);
				await semantics.begin(executionClient);
				transactionStarted = true;
				await semantics.setLockTimeout(
					executionClient,
					lockTimeoutMs(semantics, step, proofContext),
				);
				await semantics.acquireLocks(
					executionClient,
					step.operation,
					semantics.effectsOf(step.operation, proofContext),
					proofContext,
				);
				runtimeContext = await semantics.observeContext(
					executionClient,
					step.operation,
					proofContext,
				);
				runtimeContext =
					registry.contextWithDerivedCapabilities(runtimeContext);

				const before = await semantics.observeOperation(
					executionClient,
					step.operation,
					runtimeContext,
					'before',
					operationIssuer,
				);
				observations.push(...before.observations);
				let currentFingerprints: ReturnType<
					OperationRuntime['buildFingerprints']
				>;
				try {
					currentFingerprints = semantics.buildFingerprints(
						step.operation,
						durableEvidence(before.observations),
						runtimeContext,
					);
				} catch {
					await semantics.rollback(executionClient);
					const journal = unknownJournal(intent);
					await semantics.writeObservedJournal(executionClient, journal);
					return {
						assessment: assessment(
							contextMismatchReason(
								step,
								'expectedBefore fingerprint could not be rebuilt',
							),
						),
						journals: [journal],
						observations,
					};
				}
				if (
					!fingerprintMatches(
						step.expectedBefore,
						currentFingerprints.expectedBefore,
					)
				) {
					await semantics.rollback(executionClient);
					const journal = contextMismatchJournal(intent, observations);
					await semantics.writeObservedJournal(executionClient, journal);
					return {
						assessment: assessment(
							contextMismatchReason(step, 'expectedBefore mismatch'),
						),
						journals: [journal],
						observations,
					};
				}

				const runGuardPhase = async (
					phase: ProvenPlanStep['guards'][number]['phase'],
				): Promise<ApplyResult | undefined> => {
					for (const guard of step.guards.filter(
						(candidate) => candidate.phase === phase,
					)) {
						const guardResult = await semantics.checkGuard(
							executionClient,
							step.operation,
							guard,
							runtimeContext,
						);
						observations.push(...guardResult.observations);
						if (!guardResult.passed) {
							await semantics.rollback(executionClient);
							const journal = journalWithObserved(
								intent,
								'guard-failed',
								guardResult.observations,
								guardResult.recovery,
							);
							await semantics.writeObservedJournal(executionClient, journal);
							return {
								assessment: assessment({
									code: 'guard-failed',
									stepId: step.stepId,
									operationKind: step.operation.operationKind,
									operationRef: step.operation.ref,
									recovery: guardResult.recovery,
									scope: guard.predicate.scope,
								}),
								journals: [journal],
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

				await semantics.executeOperation(
					executionClient,
					step.operation,
					runtimeContext,
					step.guards.filter((guard) => guard.phase === 'during-operation'),
				);
				const afterGuardFailure = await runGuardPhase('after-operation');
				if (afterGuardFailure) {
					return afterGuardFailure;
				}
				const completion = completionRecord(step);
				await semantics.writeCompletionJournal(
					executionClient,
					step.operation,
					completion,
				);
				await semantics.commit(executionClient);
				committed = true;

				const after = await semantics.observeOperation(
					executionClient,
					step.operation,
					runtimeContext,
					'after',
					operationIssuer,
				);
				observations.push(...after.observations);
				const observedOutcome = {
					stepId: step.stepId,
					observations: evidenceIds(after.observations),
					recordedAt: recordedAt(),
				};

				if (!fingerprintMatches(step.expectedAfter, after.fingerprint)) {
					const journal: StepJournal = {
						intent,
						outcome: 'partially-applied',
						observedOutcome,
						recovery: [],
					};
					await semantics.writeObservedJournal(executionClient, journal);
					return {
						assessment: assessment(
							{
								code: 'partially-applied',
								stepId: step.stepId,
								operationKind: step.operation.operationKind,
								operationRef: step.operation.ref,
								scope: [],
								detail: 'expectedAfter mismatch',
							},
							'partially-applied',
							'human-intervention-required',
						),
						journals: [journal],
						observations,
					};
				}

				const journal: StepJournal = {
					intent,
					outcome: 'completed',
					transactionalCompletion: completion,
					observedOutcome,
				};
				await semantics.writeObservedJournal(executionClient, journal);
				return {
					assessment: completedAssessment(reportedAssessment),
					journals: [journal],
					observations,
				};
			} catch (error) {
				releaseError = error;
				if (client && transactionStarted && !committed) {
					await semantics.rollback(client).catch(() => undefined);
				}
				if (semantics.isLockTimeout(error)) {
					const journal = journalWithObserved(intent, 'guard-timeout', []);
					if (client) {
						await semantics
							.writeObservedJournal(client, journal)
							.catch(() => undefined);
					}
					return {
						assessment: assessment({
							code: 'guard-timeout',
							stepId: step.stepId,
							operationKind: step.operation.operationKind,
							operationRef: step.operation.ref,
							maxWaitMs: lockTimeoutMs(semantics, step, runtimeContext),
							scope: [],
						}),
						journals: [journal],
						observations,
					};
				}
				const journal = unknownJournal(intent);
				if (client) {
					await semantics
						.writeObservedJournal(client, journal)
						.catch(() => undefined);
				}
				return {
					assessment: assessment(
						{
							code: 'unknown-step-result',
							stepId: step.stepId,
							operationKind: step.operation.operationKind,
							operationRef: step.operation.ref,
							scope: [],
							detail:
								error instanceof Error ? error.message : 'unknown apply error',
						},
						'outcome-unknown',
						'human-intervention-required',
					),
					journals: [journal],
					observations,
				};
			} finally {
				if (client) {
					try {
						await semantics.release(client, releaseError);
					} catch {
						// A cleanup failure must not mask the known apply outcome.
					}
				}
			}
		},
	};
}
