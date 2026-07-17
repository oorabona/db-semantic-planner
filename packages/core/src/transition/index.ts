import type {
	ApplicableAssessment,
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	InapplicableAssessment,
	ObservationContext,
	PlanAssessment,
	ProofClaim,
	ProvenPlanShape,
	SemanticArtifactRef,
	TransitionConnectionPool,
} from '@dbsp/types';

export type InProcessProvenPlan = ProvenPlanShape & {
	readonly __inProcessProvenPlan: unique symbol;
};

export type EstablishedProofClaim = ProofClaim & {
	readonly assumes: readonly [];
	readonly derivedBy: { readonly conclusion: 'established' };
};

export type ProveOutcome =
	| {
			readonly kind: 'proven';
			readonly plan: InProcessProvenPlan;
			readonly assessment: ApplicableAssessment;
	  }
	| {
			readonly kind: 'no-drift';
			readonly claim: EstablishedProofClaim;
			readonly assessment: ApplicableAssessment;
	  }
	| {
			readonly kind: 'blocked';
			readonly assessment: PlanAssessment;
	  }
	| {
			readonly kind: 'inapplicable';
			readonly assessment: InapplicableAssessment;
			readonly claim?: ProofClaim;
	  };

export interface Prover {
	readonly artifact: SemanticArtifactRef;
	prove(
		compare: CompareOutcome,
		target: TransitionConnectionPool,
		context: ObservationContext,
	): Promise<ProveOutcome>;
}

export interface Applier {
	readonly artifact: SemanticArtifactRef;
	apply(
		proven: {
			readonly plan: InProcessProvenPlan;
			readonly assessment: ApplicableAssessment;
		},
		policy: ApplyPolicy,
		target: TransitionConnectionPool,
	): Promise<ApplyResult>;
}

export type {
	ApplicableAssessment,
	ApplicableEvaluation,
	ApplyPolicy,
	CapabilityDescriptor,
	Comparator,
	CompareOutcome,
	InapplicableAssessment,
	ObservationIssuer,
	OperationEffectAssessment,
	OperationSemantics,
	ProvenApplyGuard,
	ProvenGuardProtocol,
	ProvenPlanShape,
	ProvenPlanStep,
	RecognitionResult,
	RuleEvaluation,
	RuleSupport,
	SerializedProvenPlan,
	TransitionCandidate,
	TransitionRule,
} from '@dbsp/types';
export { createApplier } from './applier.js';
export { type CheckDelta, checkDelta } from './check-delta.js';
export { createComparator } from './comparator.js';
export { type EnumAddDelta, enumAddDelta } from './enum-delta.js';
export {
	advisoryObservationId,
	assumptionId,
	claimId,
	evidenceId,
	semanticArtifactId,
} from './ids.js';
export { createProver } from './prover.js';
export {
	type ComparatorNameNormalizer,
	createPackRegistry,
	type GuardExecutionResult,
	isOperationRuntime,
	type OperationFingerprints,
	type OperationObservation,
	type OperationResolution,
	type OperationRuntime,
	PackRegistry,
	type RegisteredOperationSemantics,
	type TransitionConnectionPool,
	type TransitionExecutionClient,
	type TransitionPack,
	type TransitionQueryClient,
} from './registry.js';
export {
	createStagedTransitionOrchestrator,
	type StagedTransitionInput,
	type StagedTransitionOrchestrator,
} from './staged-orchestrator.js';
export {
	chooseReadyCandidate,
	preflightStagedComposition,
	projectCompareToSingleCandidate,
	type StagedCompositionCandidate,
	type StagedCompositionPreflight,
	type StagedCompositionPreflightInput,
} from './staging.js';
export {
	type TransitionRelationalValidationInput,
	type TransitionRelationalValidationResult,
	validateTransitionRelationalInvariants,
} from './validation.js';
