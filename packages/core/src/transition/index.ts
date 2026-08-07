import type {
	ApplicableAssessment,
	ApplyPolicy,
	ApplyResult,
	CompareOutcome,
	DurableApplyOutcome,
	ExclusiveTransitionTarget,
	ExecutionContract,
	InapplicableAssessment,
	ObservationContext,
	PlanAssessment,
	ProofClaim,
	ProvenPlanShape,
	SemanticArtifactRef,
	TransitionLessor,
	TransitionRunJournal,
	TransitionRunMetadata,
	TransitionSessionClient,
} from '@dbsp/types';

export type InProcessProvenPlan = ProvenPlanShape & {
	readonly __inProcessProvenPlan: unique symbol;
};

/**
 * Makes a transition run and its proven plan durable before execution begins.
 * Implementations must persist both rows atomically and accept retries only
 * when the metadata and plan are identical.
 */
export type TransitionRunPersister = {
	persist(run: TransitionRunMetadata, plan: ProvenPlanShape): Promise<void>;
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
		target: TransitionLessor,
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
		target: TransitionLessor,
	): Promise<ApplyResult>;
	applyDurable(input: DurableApplyInput): Promise<DurableApplyResult>;
	resume(
		journal: import('./resume.js').VerifiedRecoveryJournal,
		readContext: import('./resume.js').ResumeTransitionInput['readContext'],
		policy: ApplyPolicy | undefined,
		target: import('./transition-lessor.js').TransitionReadTarget,
		admitRecovery?: TransitionRecoveryAdmission,
	): Promise<ApplyResult>;
}

/** Durable-run entry point; it snapshots and verifies serialized evidence. */
export interface DurableApplyInput {
	readonly runId: string;
	/**
	 * Content hash the operator reviewed outside the target database. Durable
	 * apply refuses unless it is the hash of the loaded plan itself.
	 */
	readonly expectedPlanDigest: string;
	readonly loadCurrent: TransitionResumeJournalLoader;
	readonly policy: ApplyPolicy;
	readonly target: ExclusiveTransitionTarget;
	/** Runs on the held execution lease before authorization, a transaction, intent, or DDL. */
	readonly prepareExecutionSession: (
		target: TransitionSessionClient,
		contract: ExecutionContract,
		plan: ProvenPlanShape,
	) => Promise<
		| { readonly ok: true; readonly context: ObservationContext }
		| {
				readonly ok: false;
				/** Omitted by legacy adapters; treated as a contract refusal. */
				readonly kind?: 'refused' | 'failed';
				readonly detail: string;
		  }
	>;
	/** Called on that same preflight lease, after admission and before any step attempt. */
	readonly authorize: (
		run: TransitionRunJournal['run'],
		plan: ProvenPlanShape,
		target: TransitionSessionClient,
	) => Promise<void>;
}

export type DurableApplyResult = ApplyResult & {
	readonly durableOutcome: DurableApplyOutcome;
};

export type TransitionResumeJournalLoader = (
	runId: string,
) => Promise<TransitionRunJournal & { readonly plan: ProvenPlanShape }>;

export type TransitionResumeContextReader = (
	target: import('./transition-lessor.js').TransitionReadTarget,
	run: TransitionRunJournal['run'],
) => Promise<ObservationContext>;

/**
 * Recovery admission identifies the physical PostgreSQL target before any
 * classification journal can be written. It deliberately does not re-check
 * apply authority or the historic observation-context digest.
 */
export type TransitionRecoveryAdmission = (
	target: import('./transition-lessor.js').TransitionReadTarget,
	contract: ExecutionContract,
) => Promise<
	| { readonly ok: true; readonly context: ObservationContext }
	| { readonly ok: false; readonly detail: string }
>;

export type {
	ApplicableAssessment,
	ApplicableEvaluation,
	ApplyPolicy,
	Assumption,
	CapabilityDescriptor,
	Comparator,
	CompareOutcome,
	DurableIntentRecord,
	ExclusiveTransitionTarget,
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
	admitRecordedIdentity,
	assertCanonicalizableJson,
	bindDeclarationSet,
	type DeclarationAddressContext,
	declarationSetFromModel,
	validateDeclarationModel,
} from './declaration.js';
export {
	type EnumAddDelta,
	type EnumAddDeltaOptions,
	enumAddDelta,
	resolveEnumSchemaForComparison,
} from './enum-delta.js';
export { createEvidenceView } from './evidence-access.js';
export {
	claimEntailsProposition,
	concludeEvidenceForObligation,
	type EvidenceConclusion,
	type EvidenceEntailmentResult,
	evidenceBooleanClaims,
	normalizePropositionForContext,
	observationRequestForProposition,
	sameObservationRequest,
	sameObservationRequestInContext,
} from './evidence-match.js';
export {
	bindExecutionContract,
	createExecutionContract,
	type ExecutionContractValidation,
	validateExecutionContract,
} from './execution-contract.js';
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
export { transitionPlanDigest } from './plan-digest.js';
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
	serverVersionNum,
	type TransactionCoordinatorBinding,
	type TransitionExecutionClient,
	type TransitionLessor,
	type TransitionPack,
	type TransitionQueryClient,
	type TransitionSessionClient,
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
	loadVerifiedRecoveryJournal,
	type RecoveryJournalLoadResult,
	type ResumeTransitionInput,
	resumeTransitionRun,
	type VerifiedRecoveryJournal,
} from './resume.js';
export { createTransitionRunMetadata } from './run-metadata.js';
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
	acquireExclusiveTransitionLease,
	acquireTransitionLease,
	acquireTransitionTargetLease,
	createExclusiveTransitionTarget,
	createTransitionLessor,
	isExclusiveTransitionTarget,
	isTransitionLessor,
	planOperationSession,
	TRANSITION_LESSOR_REJECTION,
	type TransitionLeaseFailure,
	type TransitionReadTarget,
} from './transition-lessor.js';
export {
	type TransitionRelationalValidationInput,
	type TransitionRelationalValidationResult,
	validateTransitionRelationalInvariants,
} from './validation.js';
