import type { ModelIR } from '../model-ir.js';
import type { SemanticArtifactRef } from './artifact.js';
import type {
	EquivalenceCapability,
	EquivalenceContext,
} from './equivalence.js';
import type {
	RuleRef,
	RuleSelectionRationale,
	TransitionCompositionFact,
	TransitionFragment,
	TransitionFragmentComposition,
} from './fragment.js';
import type {
	AdvisoryObservation,
	EvidenceObservation,
	IssuedObservation,
	ObservationContext,
	ObservationRequest,
} from './observation.js';
import type { OperationEffects, PhysicalOperation } from './operation.js';
import type {
	Assumption,
	ProofClaimDraft,
	ProofObligation,
	Proposition,
} from './proof.js';
import type { ResourceAddress } from './resource.js';

export interface TransitionQueryResult {
	readonly rows: readonly Record<string, unknown>[];
}

export interface TransitionQueryClient {
	query(sql: string, params?: unknown): Promise<TransitionQueryResult>;
	release(error?: unknown): void;
}

export interface TransitionConnectionPool {
	connect(): Promise<TransitionQueryClient>;
}

export interface OperationEffectAssessment {
	readonly effects: OperationEffects;
	readonly restsOn: readonly Assumption[];
}

export interface OperationSemantics {
	readonly artifact: SemanticArtifactRef;
	effectsOf(
		operation: PhysicalOperation,
		context: ObservationContext,
	): OperationEffectAssessment;
}

export interface ObservationIssuer {
	readonly artifact: SemanticArtifactRef;
	readContext?(
		target: unknown,
		context: ObservationContext,
		requests?: readonly ObservationRequest[],
	): Promise<ObservationContext>;
	execute(
		request: ObservationRequest,
		target: unknown,
		context: ObservationContext,
	): Promise<IssuedObservation>;
}

export interface RecognitionContext {
	readonly equivalence?: EquivalenceCapability;
	readonly context: EquivalenceContext;
	readonly evidence?: readonly EvidenceObservation[];
}

export type RecognitionResult<TMatch> =
	| {
			readonly recognized: false;
			readonly claimDrafts?: readonly ProofClaimDraft<'refuted'>[];
	  }
	| {
			readonly recognized: 'no-drift';
			readonly claimDraft: ProofClaimDraft<'established'>;
	  }
	| {
			readonly recognized: 'unsupported';
			readonly changes: readonly ResourceAddress[];
			readonly detail?: string;
	  }
	| {
			readonly recognized: true;
			readonly match: TMatch;
			readonly claimDrafts?: readonly ProofClaimDraft[];
	  }
	| {
			readonly recognized: 'unknown';
			readonly obligations: readonly ProofObligation[];
	  };

export type RuleEvaluation =
	| {
			readonly outcome: 'applicable';
			readonly obligations: readonly ProofObligation[];
			readonly assumptions: readonly Assumption[];
	  }
	| {
			readonly outcome: 'inapplicable';
			readonly obligations: readonly ProofObligation[];
			readonly assumptions: readonly Assumption[];
	  }
	| {
			readonly outcome: 'blocked';
			readonly obligations: readonly ProofObligation[];
			readonly assumptions: readonly Assumption[];
	  };

export type ApplicableEvaluation = Extract<
	RuleEvaluation,
	{ readonly outcome: 'applicable' }
>;

export interface RuleSupport {
	readonly engine: string;
	readonly versions: readonly {
		readonly min?: string;
		readonly max?: string;
	}[];
	readonly requiredCapabilities: readonly string[];
}

export type CapabilityAvailabilityPredicate = {
	readonly kind: 'minServerVersionNum';
	readonly minServerVersionNum: number;
};

export interface CapabilityDescriptor {
	readonly id: string;
	readonly predicate: CapabilityAvailabilityPredicate;
}

export interface CompositionFactSatisfactionOwner {
	readonly compositionFactKinds: readonly string[];
	satisfiesCompositionFact(
		fact: TransitionCompositionFact,
		current: ModelIR,
		context: ObservationContext,
	): boolean;
}

export interface TransitionRule<TMatch = unknown> {
	readonly id: string;
	readonly artifact: SemanticArtifactRef;
	readonly support: RuleSupport;
	recognize(
		desired: ModelIR,
		current: ModelIR,
		context?: RecognitionContext,
	): RecognitionResult<TMatch>;
	requiredObservations(match: TMatch): readonly ObservationRequest[];
	evaluate(
		match: TMatch,
		evidence: readonly EvidenceObservation[],
		advisory: readonly AdvisoryObservation[],
	): RuleEvaluation;
	declareComposition?(
		match: TMatch,
		context: ObservationContext,
	): TransitionFragmentComposition | undefined;
	generateCandidate(
		match: TMatch,
		evaluation: ApplicableEvaluation,
	): TransitionFragment;
}

export interface TransitionCandidate<TMatch = unknown> {
	readonly rule: RuleRef;
	readonly match: TMatch;
	readonly requiredObservations: readonly ObservationRequest[];
	readonly obligations: readonly ProofObligation[];
	readonly claimDrafts?: readonly ProofClaimDraft[];
	readonly selectionRationale: RuleSelectionRationale;
}

export interface UnknownTransitionRecognition {
	readonly rule: RuleRef;
	readonly desired: ModelIR;
	readonly current: ModelIR;
	readonly obligations: readonly ProofObligation[];
}

export type CompareOutcome =
	| {
			readonly kind: 'transitions';
			readonly candidates: readonly TransitionCandidate[];
			readonly obligations: readonly ProofObligation[];
	  }
	| { readonly kind: 'no-drift'; readonly claimedInvariant: Proposition }
	| {
			readonly kind: 'unsupported';
			readonly changes: readonly ResourceAddress[];
	  }
	| {
			readonly kind: 'unknown';
			readonly recognitions: readonly UnknownTransitionRecognition[];
			readonly obligations: readonly ProofObligation[];
	  }
	| {
			readonly kind: 'uncomposable';
			readonly candidates: readonly TransitionCandidate[];
			readonly recognitions: readonly UnknownTransitionRecognition[];
			readonly obligations: readonly ProofObligation[];
			readonly detail: string;
	  }
	| { readonly kind: 'ambiguous'; readonly candidates: readonly RuleRef[] };

export interface Comparator {
	readonly artifact: SemanticArtifactRef;
	compare(desired: ModelIR, current: ModelIR): CompareOutcome;
}
