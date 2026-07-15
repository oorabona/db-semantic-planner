import type {
	ApplicableAssessment,
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	ObservationContext,
	ObservationIssuer,
	PlanAssessment,
	ProofClaim,
	ProvenPlanShape,
	SemanticArtifactRef,
} from '@dbsp/types';

export type ProvenPlan = ProvenPlanShape & { readonly __proven: unique symbol };

export type EstablishedProofClaim = ProofClaim & {
	readonly assumes: readonly [];
	readonly derivedBy: { readonly conclusion: 'established' };
};

export type ProveOutcome =
	| {
			readonly kind: 'proven';
			readonly plan: ProvenPlan;
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
		issuer: ObservationIssuer,
		context: ObservationContext,
	): Promise<ProveOutcome>;
}

export interface Applier {
	readonly artifact: SemanticArtifactRef;
	apply(
		proven: {
			readonly plan: ProvenPlan;
			readonly assessment: ApplicableAssessment;
		},
		policy: ApplyPolicy,
	): Promise<ApplyResult>;
}

export type {
	ApplicableAssessment,
	ApplicableEvaluation,
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
	TransitionRule,
} from '@dbsp/types';
