import type {
	ApplicableAssessment,
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
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
	Comparator,
	CompareOutcome,
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
export { createComparator } from './comparator.js';
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
	type TransitionRelationalValidationInput,
	type TransitionRelationalValidationResult,
	validateTransitionRelationalInvariants,
} from './validation.js';
