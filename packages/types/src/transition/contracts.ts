import type { ModelIR } from '../model-ir.js';
import type { SemanticArtifactRef } from './artifact.js';
import type {
	RuleRef,
	RuleSelectionRationale,
	TransitionFragment,
} from './fragment.js';
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
	): Promise<ObservationContext>;
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

export interface TransitionCandidate<TMatch = unknown> {
	readonly rule: RuleRef;
	readonly match: TMatch;
	readonly requiredObservations: readonly ObservationRequest[];
	readonly obligations: readonly ProofObligation[];
	readonly selectionRationale: RuleSelectionRationale;
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
	| { readonly kind: 'ambiguous'; readonly candidates: readonly RuleRef[] };

export interface Comparator {
	readonly artifact: SemanticArtifactRef;
	compare(desired: ModelIR, current: ModelIR): CompareOutcome;
}
