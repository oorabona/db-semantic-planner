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
	TransitionRunJournal,
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
	resume(
		runId: string,
		loadCurrent: TransitionResumeJournalLoader,
		readContext: TransitionResumeContextReader,
		policy: ApplyPolicy,
		target: TransitionConnectionPool,
	): Promise<ApplyResult>;
}

export type TransitionResumeJournalLoader = (
	runId: string,
) => Promise<TransitionRunJournal & { readonly plan: ProvenPlanShape }>;

export type TransitionResumeContextReader = (
	target: TransitionConnectionPool,
	run: TransitionRunJournal['run'],
) => Promise<ObservationContext>;

export type {
	ApplicableAssessment,
	ApplicableEvaluation,
	ApplyPolicy,
	Assumption,
	CapabilityDescriptor,
	Comparator,
	CompareOutcome,
	DurableIntentRecord,
	FingerprintManifest,
	InapplicableAssessment,
	ObservationContext,
	ObservationIssuer,
	ObservationRequest,
	OperationEffectAssessment,
	OperationSemantics,
	PhysicalOperation,
	ProvenApplyGuard,
	ProvenGuardProtocol,
	ProvenPlanShape,
	ProvenPlanStep,
	RecognitionResult,
	ResourceAddress,
	RuleEvaluation,
	RuleSupport,
	SerializedProvenPlan,
	StepJournal,
	TransactionalCompletionRecord,
	TransitionCandidate,
	TransitionRule,
	TransitionRunMetadata,
} from '@dbsp/types';
export { createApplier } from './applier.js';
export { type CheckDelta, checkDelta } from './check-delta.js';
export { createComparator } from './comparator.js';
export {
	matchLiveObservationContext,
	matchRunObservationContext,
	type ObservationContextMatchResult,
	observationContextDigest,
} from './context-match.js';
export {
	type EnumAddDelta,
	type EnumAddDeltaOptions,
	enumAddDelta,
	resolveEnumSchemaForComparison,
} from './enum-delta.js';
export { createEvidenceView } from './evidence-access.js';
export {
	claimEntailsProposition,
	type EvidenceConclusion,
	type EvidenceEntailmentResult,
	evidenceBooleanClaims,
	normalizePropositionForContext,
	observationRequestForProposition,
	sameObservationRequest,
	sameObservationRequestInContext,
} from './evidence-match.js';
export {
	advisoryObservationId,
	assumptionId,
	claimId,
	evidenceId,
	semanticArtifactId,
} from './ids.js';
export {
	defaultIndexName,
	type IndexDelta,
	type IndexSetEntry,
	indexDelta,
	normalizedIndex,
} from './index-delta.js';
export { createProver } from './prover.js';
export {
	type ComparatorNameNormalizer,
	createPackRegistry,
	type ExecutionCoordinator,
	type GuardExecutionResult,
	isOperationRuntime,
	type NonRollbackableExecutionTracker,
	type OperationFingerprints,
	type OperationObservation,
	type OperationResolution,
	type OperationRuntime,
	PackRegistry,
	type RegisteredOperationSemantics,
	type RulePrecedenceFact,
	type TransactionCoordinatorBinding,
	type TransitionConnectionPool,
	type TransitionExecutionClient,
	type TransitionPack,
	type TransitionQueryClient,
	serverVersionNum,
} from './registry.js';
export {
	assumptionAccepted,
	resourceIsWithin,
	resourceScopeCovers,
	sameResource,
	sameTrustRoot,
	selectorMatchesResource,
} from './resource-scope.js';
export {
	type ResumeTransitionInput,
	resumeTransitionRun,
} from './resume.js';
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
