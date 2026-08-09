import type {
	Assumption,
	GuardedPlanStep,
	NormalizedManagedStep,
	ObservationContext,
	OperationEffectAssessment,
	PhysicalOperation,
	ProofClaim,
	ProvenPlanShape,
	ResourceAddress,
	TransitionFragment,
} from '@dbsp/types';
import { stableJson } from './stable-json.js';

export type TransitionRelationalValidationInput =
	| {
			readonly kind: 'fragment';
			readonly fragment: TransitionFragment;
			readonly claims: readonly ProofClaim[];
			readonly assumptions: readonly Assumption[];
	  }
	| {
			readonly kind: 'plan';
			readonly plan: ProvenPlanShape;
			readonly operationEffectsByRef?: ReadonlyMap<
				string,
				OperationEffectAssessment
			>;
	  };

export type TransitionRelationalValidationResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly detail: string };

declare const validatedManagedStepManifestBrand: unique symbol;

/** A manifest normalized and accepted by the managed lifecycle boundary. */
export interface ValidatedManagedStepManifest {
	readonly steps: readonly NormalizedManagedStep[];
	readonly [validatedManagedStepManifestBrand]: 'dbsp-validated-managed-step-manifest';
}

export type ValidatedManagedStepManifestResult =
	| { readonly ok: true; readonly manifest: ValidatedManagedStepManifest }
	| { readonly ok: false; readonly detail: string };

function validatedManifest(
	steps: readonly NormalizedManagedStep[],
): ValidatedManagedStepManifest {
	const normalized = Object.freeze(
		steps.map((step) =>
			Object.freeze({
				...step,
				dependencyOrder: Object.freeze([...step.dependencyOrder]),
				plannedClaimKeys: Object.freeze([...step.plannedClaimKeys]),
				statementBundle: Object.freeze({
					...step.statementBundle,
					statements: Object.freeze(
						step.statementBundle.statements.map((statement) =>
							Object.freeze({ ...statement }),
						),
					),
				}),
			}),
		),
	);
	return Object.freeze({ steps: normalized }) as ValidatedManagedStepManifest;
}

/**
 * Generic lifecycle invariants for adapter-produced normalized managed steps.
 * Mapping a concrete DDL kind remains adapter work; core only validates the
 * durable protocol shape before it becomes digest-covered plan material.
 */
export function validateNormalizedManagedStepManifest(
	steps: readonly NormalizedManagedStep[],
): ValidatedManagedStepManifestResult {
	const keys = new Set<string>();
	const plannedClaimKeys = new Set<string>();
	for (const [index, step] of steps.entries()) {
		if (step.order !== index)
			return {
				ok: false,
				detail: `managed step ${step.stepKey} has non-contiguous order`,
			};
		if (keys.has(step.stepKey))
			return {
				ok: false,
				detail: `duplicate managed step key ${step.stepKey}`,
			};
		keys.add(step.stepKey);
		if ((step.address === undefined) === (step.closure === undefined))
			return {
				ok: false,
				detail: `managed step ${step.stepKey} must have exactly one address or closure root`,
			};
		if (step.plannedClaimKeys.length === 0)
			return {
				ok: false,
				detail: `managed step ${step.stepKey} has no planned claim key`,
			};
		for (const plannedClaimKey of step.plannedClaimKeys) {
			if (plannedClaimKeys.has(plannedClaimKey))
				return {
					ok: false,
					detail: `duplicate planned claim key ${plannedClaimKey}`,
				};
			plannedClaimKeys.add(plannedClaimKey);
		}
		if (
			step.statementBundle.statements.some(
				(statement, ordinal) =>
					statement.ordinal !== ordinal || statement.sql.length === 0,
			)
		)
			return {
				ok: false,
				detail: `managed step ${step.stepKey} has an invalid statement bundle`,
			};
		if (
			step.classification === 'removal' &&
			step.replayPolicy !== 'fresh-live-only'
		)
			return {
				ok: false,
				detail: `removal step ${step.stepKey} is not fresh-live-only`,
			};
		if (step.classification !== 'removal' && step.replayPolicy !== 'recorded')
			return {
				ok: false,
				detail: `non-removal step ${step.stepKey} is not recorded-replayable`,
			};
		if (
			step.classification === 'removal' &&
			(step.claimKind !== 'retire-intent' || step.requiresVacancy)
		)
			return {
				ok: false,
				detail: `removal step ${step.stepKey} has an invalid lifecycle claim`,
			};
		if (step.classification !== 'removal' && step.claimKind === 'retire-intent')
			return {
				ok: false,
				detail: `non-removal step ${step.stepKey} cannot retire a managed address`,
			};
		if (
			step.lifecycle?.kind === 'adoption' &&
			step.claimKind !== 'adopt-intent'
		)
			return {
				ok: false,
				detail: `adoption step ${step.stepKey} must use adopt-intent`,
			};
	}
	for (const step of steps) {
		for (const dependency of step.dependencyOrder) {
			if (!keys.has(dependency))
				return {
					ok: false,
					detail: `managed step ${step.stepKey} references missing dependency ${dependency}`,
				};
			if (dependency === step.stepKey)
				return {
					ok: false,
					detail: `managed step ${step.stepKey} depends on itself`,
				};
			const dependencyStep = steps.find(
				(candidate) => candidate.stepKey === dependency,
			);
			if (dependencyStep && dependencyStep.order >= step.order)
				return {
					ok: false,
					detail: `managed step ${step.stepKey} depends on a non-preceding step ${dependency}`,
				};
		}
	}
	return { ok: true, manifest: validatedManifest(steps) };
}

function sameTrustRoot(
	left: Assumption['asserter'],
	right: Assumption['asserter'],
): boolean {
	return stableJson(left) === stableJson(right);
}

function sameArtifact(
	left: Assumption['asserter'],
	right: Assumption['asserter'],
): boolean {
	return sameTrustRoot(left, right);
}

function sameResource(left: ResourceAddress, right: ResourceAddress): boolean {
	return stableJson(left) === stableJson(right);
}

function resourceCovers(
	covering: readonly ResourceAddress[],
	target: readonly ResourceAddress[],
): boolean {
	return target.every((resource) =>
		covering.some((candidate) => sameResource(candidate, resource)),
	);
}

function refCounts(
	operations: readonly PhysicalOperation[],
): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const operation of operations) {
		counts.set(operation.ref, (counts.get(operation.ref) ?? 0) + 1);
	}
	return counts;
}

function duplicateOperationRef(
	counts: ReadonlyMap<string, number>,
): string | undefined {
	for (const [ref, count] of counts) {
		if (count > 1) {
			return ref;
		}
	}
	return undefined;
}

function validatesExactlyOneRef(
	ref: string | undefined,
	counts: ReadonlyMap<string, number>,
): boolean {
	return typeof ref === 'string' && ref.length > 0 && counts.get(ref) === 1;
}

function validateAssumptionIds(
	assumptions: readonly Assumption[],
): TransitionRelationalValidationResult {
	const seen = new Set<string>();
	for (const assumption of assumptions) {
		if (seen.has(assumption.id)) {
			return {
				ok: false,
				detail: `duplicate assumption id ${assumption.id}`,
			};
		}
		seen.add(assumption.id);
	}
	return { ok: true };
}

function validateClaimIdsAndEvidence(
	plan: ProvenPlanShape,
): TransitionRelationalValidationResult {
	const claimIds = new Set<string>();
	const observationIds = new Set<string>();
	for (const observation of plan.observations) {
		if (observation.role !== 'evidence') {
			continue;
		}
		if (observationIds.has(observation.id)) {
			return {
				ok: false,
				detail: `duplicate observation id ${observation.id}`,
			};
		}
		observationIds.add(observation.id);
	}
	for (const claim of plan.claims) {
		if (claimIds.has(claim.id)) {
			return {
				ok: false,
				detail: `duplicate claim id ${claim.id}`,
			};
		}
		claimIds.add(claim.id);
		const conclusionShape = validateClaimConclusionShape(claim);
		if (!conclusionShape.ok) {
			return conclusionShape;
		}
		for (const evidenceId of claim.supportedBy) {
			if (!observationIds.has(evidenceId)) {
				return {
					ok: false,
					detail: `claim ${claim.id} supportedBy references missing observation ${evidenceId}`,
				};
			}
		}
		for (const evidenceId of claim.derivedBy.inputs) {
			if (!observationIds.has(evidenceId)) {
				return {
					ok: false,
					detail: `claim ${claim.id} derivedBy.inputs references missing observation ${evidenceId}`,
				};
			}
		}
	}
	return { ok: true };
}

function assumptionExists(
	assumptions: readonly Assumption[],
	assumptionId: string,
): boolean {
	return assumptions.some((assumption) => assumption.id === assumptionId);
}

function validateClaimConclusionShape(
	claim: ProofClaim,
): TransitionRelationalValidationResult {
	if (
		claim.derivedBy.conclusion === 'established' &&
		claim.assumes.length > 0
	) {
		return {
			ok: false,
			detail: `established claim ${claim.id} must not assume ${claim.assumes.join(', ')}`,
		};
	}
	if (
		claim.derivedBy.conclusion === 'established-under-assumptions' &&
		claim.assumes.length === 0
	) {
		return {
			ok: false,
			detail: `established-under-assumptions claim ${claim.id} must list at least one assumption`,
		};
	}
	return { ok: true };
}

function validateEstablishedClaim(params: {
	readonly claimId: string;
	readonly claims: readonly ProofClaim[];
	readonly assumptions: readonly Assumption[];
	readonly requiredAssumptionIds?: readonly string[] | undefined;
	readonly missingDetail: string;
	readonly rejectedDetail: (
		conclusion: ProofClaim['derivedBy']['conclusion'],
	) => string;
	readonly missingAssumptionDetail: (assumptionId: string) => string;
	readonly missingClosureDetail: (assumptionId: string) => string;
}): TransitionRelationalValidationResult {
	const {
		claimId,
		claims,
		assumptions,
		requiredAssumptionIds,
		missingDetail,
		rejectedDetail,
		missingAssumptionDetail,
		missingClosureDetail,
	} = params;
	const claim = claims.find((candidate) => candidate.id === claimId);
	if (!claim) {
		return { ok: false, detail: missingDetail };
	}
	const conclusionShape = validateClaimConclusionShape(claim);
	if (!conclusionShape.ok) {
		return conclusionShape;
	}
	if (claim.derivedBy.conclusion === 'established') {
		return { ok: true };
	}
	if (claim.derivedBy.conclusion !== 'established-under-assumptions') {
		return {
			ok: false,
			detail: rejectedDetail(claim.derivedBy.conclusion),
		};
	}
	for (const assumptionId of claim.assumes) {
		if (!assumptionExists(assumptions, assumptionId)) {
			return {
				ok: false,
				detail: missingAssumptionDetail(assumptionId),
			};
		}
		if (
			requiredAssumptionIds &&
			!requiredAssumptionIds.includes(assumptionId)
		) {
			return {
				ok: false,
				detail: missingClosureDetail(assumptionId),
			};
		}
	}
	return { ok: true };
}

function expectedOperationPackTrustRoot(
	operation: PhysicalOperation,
): Assumption['asserter'] {
	return { kind: 'pack', artifact: operation.operationKind.artifact };
}

function operationPackSemanticsAssumption(
	assumptions: readonly Assumption[],
	operation: PhysicalOperation,
): Assumption | undefined {
	const expectedAsserter = expectedOperationPackTrustRoot(operation);
	return assumptions.find(
		(assumption) =>
			assumption.class === 'operation-pack-semantics' &&
			sameArtifact(assumption.asserter, expectedAsserter),
	);
}

function operationPackSemanticsAssumptionsFromEffects(params: {
	readonly operation: PhysicalOperation;
	readonly effects: OperationEffectAssessment;
}): readonly Assumption[] {
	const expectedAsserter = expectedOperationPackTrustRoot(params.operation);
	return params.effects.restsOn.filter(
		(assumption) =>
			assumption.class === 'operation-pack-semantics' &&
			sameArtifact(assumption.asserter, expectedAsserter),
	);
}

function validateOperationPackSemanticsAssumption(params: {
	readonly operation: PhysicalOperation;
	readonly assumptions: readonly Assumption[];
	readonly stepId?: string;
	readonly requiredAssumptionIds?: readonly string[] | undefined;
	readonly operationEffects?: OperationEffectAssessment | undefined;
}): TransitionRelationalValidationResult {
	const {
		operation,
		assumptions,
		stepId,
		requiredAssumptionIds,
		operationEffects,
	} = params;
	if (operationEffects) {
		const requiredOperationPackAssumptions =
			operationPackSemanticsAssumptionsFromEffects({
				operation,
				effects: operationEffects,
			});
		if (requiredOperationPackAssumptions.length === 0) {
			return {
				ok: false,
				detail: `operation ${operation.ref} is missing an operation-pack-semantics assumption for ${operation.operationKind.artifact.id}@${operation.operationKind.artifact.version}`,
			};
		}
		for (const required of requiredOperationPackAssumptions) {
			const actual = assumptions.find(
				(assumption) => assumption.id === required.id,
			);
			if (!actual) {
				return {
					ok: false,
					detail: `operation ${operation.ref} is missing operation-pack-semantics assumption ${required.id} in plan assumptions`,
				};
			}
			if (stableJson(actual) !== stableJson(required)) {
				return {
					ok: false,
					detail: `operation ${operation.ref} operation-pack-semantics assumption ${required.id} does not match its operation effects`,
				};
			}
			if (
				requiredAssumptionIds &&
				!requiredAssumptionIds.includes(required.id)
			) {
				return {
					ok: false,
					detail: `step ${stepId ?? operation.ref} is missing operation-pack-semantics assumption ${required.id} from the step assumption closure`,
				};
			}
		}
		return { ok: true };
	}
	if (requiredAssumptionIds) {
		return { ok: true };
	}
	const assumption = operationPackSemanticsAssumption(assumptions, operation);
	if (!assumption) {
		return {
			ok: false,
			detail: `operation ${operation.ref} is missing an operation-pack-semantics assumption for ${operation.operationKind.artifact.id}@${operation.operationKind.artifact.version}`,
		};
	}
	return { ok: true };
}

function validateBinding(params: {
	readonly guard: GuardedPlanStep['guards'][number];
	readonly claims: readonly ProofClaim[];
	readonly assumptions: readonly Assumption[];
	readonly requiredAssumptionIds?: readonly string[];
	readonly expectedAsserter: Assumption['asserter'];
}): TransitionRelationalValidationResult {
	const {
		guard,
		claims,
		assumptions,
		requiredAssumptionIds,
		expectedAsserter,
	} = params;
	if (guard.protocol.kind === 'impossible' || !guard.protocol.binding) {
		return {
			ok: false,
			detail: `guard ${guard.predicate.kind} has an impossible protocol`,
		};
	}
	const binding = guard.protocol.binding;
	if (binding.kind === 'stable-identity') {
		return validateEstablishedClaim({
			claimId: binding.identityClaim,
			claims,
			assumptions,
			requiredAssumptionIds,
			missingDetail: `stable-identity binding references missing or unestablished claim ${binding.identityClaim}`,
			rejectedDetail: (conclusion) =>
				`stable-identity binding references ${conclusion} claim ${binding.identityClaim}`,
			missingAssumptionDetail: (assumptionId) =>
				`stable-identity binding claim ${binding.identityClaim} assumes missing assumption ${assumptionId}`,
			missingClosureDetail: (assumptionId) =>
				`stable-identity binding claim ${binding.identityClaim} assumes ${assumptionId}, which is missing from the step assumption closure`,
		});
	}
	if (binding.kind !== 'external-ddl-exclusion') {
		return {
			ok: false,
			detail: `guard ${guard.predicate.kind} has unbindable target protocol`,
		};
	}

	const assumption = assumptions.find(
		(candidate) => candidate.id === binding.assumption,
	);
	if (!assumption) {
		return {
			ok: false,
			detail: `external-ddl-exclusion binding references missing assumption ${binding.assumption}`,
		};
	}
	if (assumption.class !== 'external-ddl-exclusion') {
		return {
			ok: false,
			detail: `external-ddl-exclusion binding ${binding.assumption} references assumption class ${assumption.class}`,
		};
	}
	if (!sameTrustRoot(assumption.asserter, expectedAsserter)) {
		return {
			ok: false,
			detail: `external-ddl-exclusion assumption ${binding.assumption} has the wrong trust root`,
		};
	}
	if (!resourceCovers(assumption.scope, binding.scope)) {
		return {
			ok: false,
			detail: `external-ddl-exclusion assumption ${binding.assumption} does not cover its binding scope`,
		};
	}
	if (!resourceCovers(assumption.scope, guard.predicate.scope)) {
		return {
			ok: false,
			detail: `external-ddl-exclusion assumption ${binding.assumption} does not cover its guard scope`,
		};
	}
	if (
		requiredAssumptionIds &&
		!requiredAssumptionIds.includes(binding.assumption)
	) {
		return {
			ok: false,
			detail: `external-ddl-exclusion assumption ${binding.assumption} is missing from the step assumption closure`,
		};
	}
	return { ok: true };
}

function validateObservationContexts(
	contexts: readonly ObservationContext[],
): TransitionRelationalValidationResult {
	if (contexts.length === 0) {
		return {
			ok: false,
			detail: 'plan contains no durable evidence context',
		};
	}
	const expected = stableJson(contexts[0]);
	for (const context of contexts.slice(1)) {
		if (stableJson(context) !== expected) {
			return {
				ok: false,
				detail: 'plan evidence observations do not share one context',
			};
		}
	}
	return { ok: true };
}

function executionCommitBoundaryBefore(
	execution: OperationEffectAssessment['effects']['execution'],
): boolean {
	return (
		execution.commitBoundary === 'before' ||
		execution.commitBoundary === 'before-and-after'
	);
}

function executionCommitBoundaryAfter(
	execution: OperationEffectAssessment['effects']['execution'],
): boolean {
	return (
		execution.commitBoundary === 'after' ||
		execution.commitBoundary === 'before-and-after'
	);
}

function executionPostconditionVisibleOnlyAfterCommit(
	execution: OperationEffectAssessment['effects']['execution'],
): boolean {
	return execution.postconditionVisibility === 'after-commit';
}

function validateSegmentExecutionSemantics(
	plan: ProvenPlanShape,
	operationEffectsByRef: ReadonlyMap<string, OperationEffectAssessment>,
): TransitionRelationalValidationResult {
	const stepById = new Map(plan.steps.map((step) => [step.stepId, step]));
	const executableStepIds = plan.segments.flatMap((segment) => [
		...segment.stepIds,
	]);
	const globalStepIndex = new Map(
		executableStepIds.map((stepId, index) => [stepId, index]),
	);
	for (const segment of plan.segments) {
		for (const [segmentIndex, stepId] of segment.stepIds.entries()) {
			const step = stepById.get(stepId);
			if (!step) {
				continue;
			}
			const effects = operationEffectsByRef.get(step.operation.ref);
			if (!effects) {
				return {
					ok: false,
					detail: `step ${step.stepId} is missing operation effects for segment validation`,
				};
			}
			const execution = effects.effects.execution;
			if (
				segment.transaction === 'joins-current' &&
				execution.transaction !== 'joins-current'
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
				};
			}
			if (
				segment.transaction === 'forbids-transaction' &&
				execution.transaction !== 'forbids-transaction'
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} execution semantics do not match segment ${segment.segmentId}`,
				};
			}
			if (
				segment.transaction !== 'forbids-transaction' &&
				execution.transaction === 'forbids-transaction'
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} forbids the transaction used by segment ${segment.segmentId}`,
				};
			}
			if (
				execution.transaction === 'requires-new' &&
				segment.transaction !== 'requires-new'
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a new transaction outside segment ${segment.segmentId}`,
				};
			}
			if (execution.transaction === 'requires-new' && segmentIndex > 0) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a new segment before execution`,
				};
			}
			if (
				execution.transaction === 'forbids-transaction' &&
				segment.stepIds.length !== 1
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} forbids coalescing with other segment steps`,
				};
			}

			const currentGlobalIndex = globalStepIndex.get(stepId) ?? 0;
			const hasPriorExecutableStep = currentGlobalIndex > 0;
			if (
				executionCommitBoundaryBefore(execution) &&
				hasPriorExecutableStep &&
				!segment.commitBoundaryBefore
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a commit boundary before segment ${segment.segmentId}`,
				};
			}
			if (executionCommitBoundaryBefore(execution) && segmentIndex > 0) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a commit boundary before operation but is coalesced in segment ${segment.segmentId}`,
				};
			}
			const hasLaterSegmentStep = segmentIndex < segment.stepIds.length - 1;
			if (
				executionCommitBoundaryAfter(execution) &&
				!segment.commitBoundaryAfter
			) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a commit boundary after segment ${segment.segmentId}`,
				};
			}
			if (executionCommitBoundaryAfter(execution) && hasLaterSegmentStep) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires a commit boundary after operation but is coalesced in segment ${segment.segmentId}`,
				};
			}
			if (executionPostconditionVisibleOnlyAfterCommit(execution)) {
				if (segment.stepIds.length !== 1) {
					return {
						ok: false,
						detail: `step ${step.stepId} postcondition is only visible after commit and cannot be coalesced in segment ${segment.segmentId}`,
					};
				}
				if (hasPriorExecutableStep && !segment.commitBoundaryBefore) {
					return {
						ok: false,
						detail: `step ${step.stepId} postcondition is only visible after commit and requires a commit boundary before segment ${segment.segmentId}`,
					};
				}
				if (!segment.commitBoundaryAfter) {
					return {
						ok: false,
						detail: `step ${step.stepId} postcondition is only visible after commit and requires a commit boundary after segment ${segment.segmentId}`,
					};
				}
			}
		}
	}
	return { ok: true };
}

function validateFragment(
	fragment: TransitionFragment,
	claims: readonly ProofClaim[],
	assumptions: readonly Assumption[],
): TransitionRelationalValidationResult {
	const assumptionIds = validateAssumptionIds(assumptions);
	if (!assumptionIds.ok) {
		return assumptionIds;
	}
	const counts = refCounts(fragment.operations);
	const duplicate = duplicateOperationRef(counts);
	if (duplicate) {
		return {
			ok: false,
			detail: `duplicate operation ref ${duplicate}`,
		};
	}
	for (const obligation of fragment.obligations) {
		if (!validatesExactlyOneRef(obligation.appliesTo, counts)) {
			return {
				ok: false,
				detail: `proof obligation ${obligation.proposition.kind} has missing or dangling appliesTo`,
			};
		}
	}
	for (const operation of fragment.operations) {
		const operationPackAssumption = validateOperationPackSemanticsAssumption({
			operation,
			assumptions,
		});
		if (!operationPackAssumption.ok) {
			return operationPackAssumption;
		}
	}
	for (const guard of fragment.guards) {
		if (!validatesExactlyOneRef(guard.appliesTo, counts)) {
			return {
				ok: false,
				detail: `guard ${guard.predicate.kind} has missing or dangling appliesTo`,
			};
		}
		if (guard.protocol.kind === 'impossible') {
			return {
				ok: false,
				detail: `guard ${guard.predicate.kind} has an impossible protocol`,
			};
		}
		const binding = validateBinding({
			guard,
			claims,
			assumptions,
			expectedAsserter: { kind: 'pack', artifact: fragment.generatedBy.pack },
		});
		if (!binding.ok) {
			return binding;
		}
	}
	return { ok: true };
}

function validatePlan(
	plan: ProvenPlanShape,
	operationEffectsByRef?: ReadonlyMap<string, OperationEffectAssessment>,
): TransitionRelationalValidationResult {
	const assumptionIds = validateAssumptionIds(plan.assumptions);
	if (!assumptionIds.ok) {
		return assumptionIds;
	}
	const claimEvidence = validateClaimIdsAndEvidence(plan);
	if (!claimEvidence.ok) {
		return claimEvidence;
	}
	const operations = plan.steps.map((step) => step.operation);
	const counts = refCounts(operations);
	const duplicate = duplicateOperationRef(counts);
	if (duplicate) {
		return {
			ok: false,
			detail: `duplicate operation ref ${duplicate}`,
		};
	}
	const claimIds = new Set(plan.claims.map((claim) => claim.id));
	const assumptionIdSet = new Set(
		plan.assumptions.map((assumption) => assumption.id),
	);
	const stepIds = new Set(plan.steps.map((step) => step.stepId));
	const segmentIds = new Set<string>();
	const segmentStepIds = new Set<string>();
	const segmentByStepId = new Map<string, string>();
	for (const segment of plan.segments) {
		if (segmentIds.has(segment.segmentId)) {
			return {
				ok: false,
				detail: `duplicate segment id ${segment.segmentId}`,
			};
		}
		segmentIds.add(segment.segmentId);
		if (segment.stepIds.length === 0) {
			return {
				ok: false,
				detail: `segment ${segment.segmentId} contains no steps`,
			};
		}
		for (const stepId of segment.stepIds) {
			if (!stepIds.has(stepId)) {
				return {
					ok: false,
					detail: `segment ${segment.segmentId} references missing step ${stepId}`,
				};
			}
			if (segmentStepIds.has(stepId)) {
				return {
					ok: false,
					detail: `step ${stepId} is assigned to multiple segments`,
				};
			}
			segmentStepIds.add(stepId);
			segmentByStepId.set(stepId, segment.segmentId);
		}
	}
	const flattenedSegmentStepIds = plan.segments.flatMap((segment) => [
		...segment.stepIds,
	]);
	const planStepIds = plan.steps.map((step) => step.stepId);
	if (stableJson(planStepIds) !== stableJson(flattenedSegmentStepIds)) {
		return {
			ok: false,
			detail:
				'plan step order does not match flattened segment execution order',
		};
	}
	for (const step of plan.steps) {
		if (!segmentIds.has(step.segmentId)) {
			return {
				ok: false,
				detail: `step ${step.stepId} references missing segment ${step.segmentId}`,
			};
		}
		if (!segmentStepIds.has(step.stepId)) {
			return {
				ok: false,
				detail: `step ${step.stepId} is missing from its segment`,
			};
		}
		if (segmentByStepId.get(step.stepId) !== step.segmentId) {
			return {
				ok: false,
				detail: `step ${step.stepId} segment ${step.segmentId} does not match its segment membership`,
			};
		}
		const operationPackAssumption = validateOperationPackSemanticsAssumption({
			operation: step.operation,
			assumptions: plan.assumptions,
			requiredAssumptionIds: step.restsOnAssumptions,
			stepId: step.stepId,
			operationEffects: operationEffectsByRef?.get(step.operation.ref),
		});
		if (!operationPackAssumption.ok) {
			return operationPackAssumption;
		}
		for (const claimId of step.requiredClaims) {
			if (!claimIds.has(claimId)) {
				return {
					ok: false,
					detail: `step ${step.stepId} requires missing claim ${claimId}`,
				};
			}
			const requiredClaim = validateEstablishedClaim({
				claimId,
				claims: plan.claims,
				assumptions: plan.assumptions,
				requiredAssumptionIds: step.restsOnAssumptions,
				missingDetail: `step ${step.stepId} requires missing claim ${claimId}`,
				rejectedDetail: (conclusion) =>
					`step ${step.stepId} requires ${conclusion} claim ${claimId}`,
				missingAssumptionDetail: (assumptionId) =>
					`step ${step.stepId} required claim ${claimId} assumes missing assumption ${assumptionId}`,
				missingClosureDetail: (assumptionId) =>
					`step ${step.stepId} required claim ${claimId} assumes ${assumptionId}, which is missing from the step assumption closure`,
			});
			if (!requiredClaim.ok) {
				return requiredClaim;
			}
		}
		for (const assumptionId of step.restsOnAssumptions) {
			if (!assumptionIdSet.has(assumptionId)) {
				return {
					ok: false,
					detail: `step ${step.stepId} references missing assumption ${assumptionId}`,
				};
			}
		}
		for (const guard of step.guards) {
			if (guard.appliesTo !== step.operation.ref) {
				return {
					ok: false,
					detail: `guard ${guard.predicate.kind} applies to ${guard.appliesTo}, not step operation ${step.operation.ref}`,
				};
			}
			if (!validatesExactlyOneRef(guard.appliesTo, counts)) {
				return {
					ok: false,
					detail: `guard ${guard.predicate.kind} has missing or dangling appliesTo`,
				};
			}
			const binding = validateBinding({
				guard,
				claims: plan.claims,
				assumptions: plan.assumptions,
				requiredAssumptionIds: step.restsOnAssumptions,
				expectedAsserter: {
					kind: 'pack',
					artifact: step.selectionRationale.chosen.pack,
				},
			});
			if (!binding.ok) {
				return binding;
			}
		}
	}
	const contexts = plan.observations
		.filter((observation) => observation.role === 'evidence')
		.map((observation) => observation.context);
	const observationContexts = validateObservationContexts(contexts);
	if (!observationContexts.ok) {
		return observationContexts;
	}
	if (operationEffectsByRef) {
		const segmentExecution = validateSegmentExecutionSemantics(
			plan,
			operationEffectsByRef,
		);
		if (!segmentExecution.ok) {
			return segmentExecution;
		}
	}
	return { ok: true };
}

/**
 * Diagnostic consistency check for transition fragments and already-trusted,
 * in-process plans. For plan inputs this is not an untrusted serialized-plan
 * validator; apply() first requires the module-private minting capability, and
 * any later plan failure is a prover bug.
 */
export function validateTransitionRelationalInvariants(
	input: TransitionRelationalValidationInput,
): TransitionRelationalValidationResult {
	return input.kind === 'fragment'
		? validateFragment(input.fragment, input.claims, input.assumptions)
		: validatePlan(input.plan, input.operationEffectsByRef);
}
