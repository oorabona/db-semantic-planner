import type { ModelIR } from '../model-ir.js';
import type { SemanticArtifactRef } from './artifact.js';
import type { RuleRef, TransitionFragment } from './fragment.js';
import type {
	AdvisoryObservation,
	EvidenceObservation,
	IssuedObservation,
	ObservationContext,
	ObservationRequest,
} from './observation.js';
import type { OperationEffects, PhysicalOperation } from './operation.js';
import type { Assumption, ProofObligation, Proposition } from './proof.js';
import type { ResourceAddress } from './resource.js';

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
	execute(
		request: ObservationRequest,
		target: unknown,
		context: ObservationContext,
	): Promise<IssuedObservation>;
}

export type RecognitionResult<TMatch> =
	| { readonly recognized: false }
	| { readonly recognized: true; readonly match: TMatch };

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

export interface TransitionRule<TMatch = unknown> {
	readonly id: string;
	readonly artifact: SemanticArtifactRef;
	readonly support: RuleSupport;
	recognize(desired: ModelIR, current: ModelIR): RecognitionResult<TMatch>;
	requiredObservations(match: TMatch): readonly ObservationRequest[];
	evaluate(
		match: TMatch,
		evidence: readonly EvidenceObservation[],
		advisory: readonly AdvisoryObservation[],
	): RuleEvaluation;
	generateCandidate(
		match: TMatch,
		evaluation: ApplicableEvaluation,
	): TransitionFragment;
}

export type CompareOutcome =
	| {
			readonly kind: 'transitions';
			readonly fragments: readonly TransitionFragment[];
			readonly obligations: readonly ProofObligation[];
			readonly assumptions: readonly Assumption[];
	  }
	| { readonly kind: 'no-drift'; readonly claimedInvariant: Proposition }
	| {
			readonly kind: 'unsupported';
			readonly changes: readonly ResourceAddress[];
	  }
	| { readonly kind: 'ambiguous'; readonly candidates: readonly RuleRef[] };

export interface Comparator {
	readonly artifact: SemanticArtifactRef;
	compare(desired: ModelIR, current: ModelIR): CompareOutcome;
}
