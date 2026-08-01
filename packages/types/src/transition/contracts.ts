import type { ModelIR } from '../model-ir.js';
import type { SemanticArtifactRef } from './artifact.js';
import type {
	EquivalenceCapability,
	EquivalenceContext,
} from './equivalence.js';
import type { EvidenceView } from './evidence-access.js';
import type {
	RuleRef,
	RuleSelectionRationale,
	TransitionCompositionFact,
	TransitionFragment,
	TransitionFragmentComposition,
} from './fragment.js';
import type {
	AdvisoryObservation,
	IssuedObservation,
	ObservationContext,
	ObservationPrivilegeMergeResult,
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

export type RulePrecedenceFact = {
	readonly higher: RuleRef;
	readonly lower: RuleRef;
	readonly reason: string;
};

export interface TransitionQueryResult {
	readonly rows: readonly Record<string, unknown>[];
}

declare const transitionSessionClientTypeBrand: unique symbol;

export interface TransitionSessionClient {
	/** Core mints this after acquiring a lease, preserving session affinity. */
	readonly [transitionSessionClientTypeBrand]: never;
	query(sql: string, params?: unknown): Promise<TransitionQueryResult>;
}

export interface TransitionQueryClient {
	// Deliberately duplicated instead of extending TransitionSessionClient: adapters
	// construct raw leases, while only core can mint an affinity-preserving session.
	query(sql: string, params?: unknown): Promise<TransitionQueryResult>;
	/**
	 * Execute a statement contributed by a plan operation.
	 *
	 * This is intentionally a separate, optional channel rather than a SQL
	 * classifier.  Core only routes the client it gives to executeOperation()
	 * through it; adapter-owned preflight, journalling, and cleanup continue to
	 * use query().
	 */
	queryPlanOperation?(
		sql: string,
		params?: unknown,
	): Promise<TransitionQueryResult>;
	release(error?: unknown): void;
}

declare const transitionLessorTypeBrand: unique symbol;

/**
 * A core-minted source of transition leases.
 *
 * The unexported symbol makes this nominal in TypeScript: consumers can use a
 * lessor but cannot construct one without the factory exported by @dbsp/core.
 */
export interface TransitionLessor {
	readonly [transitionLessorTypeBrand]: never;
	/**
	 * Readonly because the minted lessor is frozen. Declaring it as a method
	 * would let TypeScript accept an assignment that throws at runtime.
	 */
	readonly acquire: () => Promise<TransitionQueryClient>;
}

declare const exclusiveTransitionTargetTypeBrand: unique symbol;

/**
 * A callback-scoped target for durable execution.
 *
 * Adapters mint this only after they have acquired their exclusive backend
 * lease.  Its representation deliberately has no public members: core is the
 * only package that can turn it back into a query lease.  This is a nominal
 * accidental-misuse guard, not a security boundary against code which imports
 * core's public factory deliberately.
 */
export interface ExclusiveTransitionTarget {
	readonly [exclusiveTransitionTargetTypeBrand]: never;
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
	mergeObservationPrivileges?(
		left: readonly string[],
		right: readonly string[],
	): ObservationPrivilegeMergeResult;
	readContext?(
		target: TransitionSessionClient,
		context: ObservationContext,
		requests?: readonly ObservationRequest[],
	): Promise<ObservationContext>;
	execute(
		request: ObservationRequest,
		target: TransitionSessionClient,
		context: ObservationContext,
	): Promise<IssuedObservation>;
}

export interface RecognitionContext {
	readonly equivalence?: EquivalenceCapability;
	readonly context: EquivalenceContext;
	readonly evidence?: EvidenceView;
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
	/**
	 * Column fields consumed by this rule when the comparator recognizes the rule
	 * against a focused one-column model. Hidden-diff subtraction only reverts
	 * these fields; undeclared fields remain real drift.
	 */
	readonly consumesColumnFields?: readonly string[];
	recognize(
		desired: ModelIR,
		current: ModelIR,
		context?: RecognitionContext,
	): RecognitionResult<TMatch>;
	requiredObservations(match: TMatch): readonly ObservationRequest[];
	evaluate(
		match: TMatch,
		evidence: EvidenceView,
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
	compare(
		desired: ModelIR,
		current: ModelIR,
		context?: EquivalenceContext,
	): CompareOutcome;
}
