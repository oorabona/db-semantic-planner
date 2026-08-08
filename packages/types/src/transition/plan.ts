/**
 * ProvenPlanShape is the serializable audit/dump shape of a plan the prover can
 * derive. It is not an apply credential: runtime safety comes from @dbsp/core
 * apply() accepting only an InProcessProvenPlan minted by this module instance's
 * prove() through a module-private WeakSet identity capability plus deep-freeze.
 *
 * A serialized, cloned, or hand-forged shape is not authorized for apply(). A
 * separate future adoptSerializedPlan(serialized, observationContext) API
 * (stage: identity & adoption) will re-derive an in-process plan from fresh
 * observations; apply() must not be overloaded to accept serialized data.
 *
 * The derived plan shape is expected to satisfy these relational invariants,
 * which are beyond structural typing:
 * - Every ApplyGuard.appliesTo and ProofObligation.appliesTo matches exactly one PhysicalOperation.ref in the same step/fragment (no dangling or duplicate ref).
 * - Every external-ddl-exclusion binding's AssumptionId is present in the step's restsOnAssumptions closure and in GuardedPlan.assumptions.
 * - Journal record stepIds are consistent with intent.stepId; ApplyResult.observations is a superset of every ObservedOutcomeRecord.observations.
 */

import type { DeclarationSet } from './declaration.js';
import type { ExecutionContract } from './execution-contract.js';
import type { FingerprintManifest } from './fingerprint.js';
import type { RuleSelectionRationale } from './fragment.js';
import type { ApplyGuard, GuardProtocol, RecoveryArtefact } from './guard.js';
import type { LedgerClaimKind } from './ledger.js';
import type { EvidenceId, IssuedObservation } from './observation.js';
import type {
	ClaimSelector,
	OperationExecutionSemantics,
	PhysicalOperation,
} from './operation.js';
import type { ClaimStatementBundle } from './outcome-protocol.js';
import type {
	Assumption,
	AssumptionId,
	ClaimId,
	ProofClaim,
	Proposition,
} from './proof.js';
import type { DeclarableResourceAddress, ResourceAddress } from './resource.js';

/**
 * Immutable managed-outcome material carried by a plan step.  It is produced
 * while proving, covered by the plan digest, and is the only source an
 * executor may use for the address or statement bundle of a managed claim.
 */
export interface ManagedStepClaimMaterial {
	readonly claimId: string;
	readonly address: DeclarableResourceAddress & {
		readonly scope: 'schema' | 'database';
	};
	readonly claimKind: LedgerClaimKind;
	readonly statementBundle: ClaimStatementBundle;
	/** True only when the plan writes an address it did not read. */
	readonly requiresVacancy: boolean;
}

export interface ExecutableAssertion {
	readonly proposition: Proposition;
	readonly scope: readonly ResourceAddress[];
}

export interface DurableIntentRecord {
	readonly runId?: string;
	readonly run?: TransitionRunMetadata;
	readonly stepId: string;
	readonly operation: PhysicalOperation;
	readonly recordedAt: string;
}

export interface TransactionalCompletionRecord {
	readonly runId?: string;
	readonly stepId: string;
	readonly committedWithDdl: boolean;
	readonly recordedAt: string;
}

export interface ObservedOutcomeRecord {
	readonly stepId: string;
	readonly observations: readonly EvidenceId[];
	readonly recordedAt: string;
}

export interface TransitionRunMetadata {
	readonly runId: string;
	readonly planDigest: string;
	readonly targetContextDigest: string;
	readonly databaseId: string;
	readonly coreVersion: string;
	readonly startedAt: string;
	/** Generator removal runs are inspectable but must be freshly re-planned. */
	readonly replayability?: 'replayable' | 'non-replayable-generator-removal';
}

export type TransitionJournalEventName = 'intent' | 'completion' | 'observed';

export type TransitionJournalEventRecord =
	| DurableIntentRecord
	| TransactionalCompletionRecord
	| StepJournal;

export interface TransitionJournalEvent {
	readonly runId: string;
	readonly seq: number;
	readonly event: TransitionJournalEventName;
	readonly stepId: string;
	readonly operationRef: string;
	readonly operationKind: PhysicalOperation['operationKind'];
	readonly recordedAt: string;
	readonly record: TransitionJournalEventRecord;
}

export interface TransitionRunJournal {
	readonly run: TransitionRunMetadata;
	readonly events: readonly TransitionJournalEvent[];
	/** Run-level approval records are deliberately not step attempts. */
	readonly authorizations?: readonly TransitionRunAuthorization[];
}

/**
 * The audit record made before a durable plan may begin execution.  Keeping it
 * outside the step event stream means a crash after authorization is retryable:
 * pristine means no intent, completion, or observed step event.
 */
export interface TransitionRunAuthorization {
	readonly runId: string;
	readonly policy: readonly import('./policy.js').AssumptionAcceptance[];
	readonly grants: readonly {
		readonly assumptionId: string;
		readonly grant: number;
	}[];
	readonly digest: string;
	readonly actor: string;
	readonly authorizedAt: string;
}

export type StepOutcome =
	| 'completed'
	| 'guard-failed'
	| 'guard-timeout'
	| 'context-mismatch'
	| 'operation-failed-not-applied'
	| 'partially-applied'
	| 'unknown-step-result';

interface StepJournalBase {
	readonly intent: DurableIntentRecord;
}

type CompletedStepJournal = StepJournalBase &
	(
		| {
				readonly outcome: 'completed';
				readonly transactionalCompletion: TransactionalCompletionRecord;
				readonly observedOutcome?: ObservedOutcomeRecord;
		  }
		| {
				readonly outcome: 'completed';
				readonly transactionalCompletion?: TransactionalCompletionRecord;
				readonly observedOutcome: ObservedOutcomeRecord;
		  }
	);

type ObservedNonCompletionStepJournal = StepJournalBase & {
	readonly outcome:
		| 'guard-failed'
		| 'guard-timeout'
		| 'context-mismatch'
		| 'operation-failed-not-applied'
		| 'partially-applied';
	readonly observedOutcome: ObservedOutcomeRecord;
	readonly transactionalCompletion?: never;
	readonly recovery?: readonly RecoveryArtefact[];
};

type UnknownStepResultJournal = StepJournalBase & {
	readonly outcome: 'unknown-step-result';
	readonly transactionalCompletion?: never;
	readonly observedOutcome?: never;
	readonly recovery?: never;
};

export type StepJournal =
	| CompletedStepJournal
	| ObservedNonCompletionStepJournal
	| UnknownStepResultJournal;

export interface GuardedPlanStep {
	readonly stepId: string;
	readonly segmentId: string;
	readonly operation: PhysicalOperation;
	readonly expectedBefore: FingerprintManifest;
	readonly expectedAfter: FingerprintManifest;
	readonly requiredClaims: readonly ClaimId[];
	readonly establishesClaims: readonly ClaimId[];
	readonly invalidatesClaims: readonly ClaimSelector[];
	readonly guards: readonly ApplyGuard[];
	readonly restsOnAssumptions: readonly AssumptionId[];
	readonly selectionRationale: RuleSelectionRationale;
	/** Present exactly for a managed DDL operation with a fixed plan-time sink. */
	readonly managedClaim?: ManagedStepClaimMaterial;
}

export interface GuardedPlanSegment {
	readonly segmentId: string;
	readonly stepIds: readonly string[];
	readonly transaction: OperationExecutionSemantics['transaction'];
	readonly commitBoundaryBefore: boolean;
	readonly commitBoundaryAfter: boolean;
}

export interface GuardedPlan {
	readonly observations: readonly IssuedObservation[];
	readonly claims: readonly ProofClaim[];
	readonly assumptions: readonly Assumption[];
	readonly preconditions: readonly ExecutableAssertion[];
	readonly segments: readonly GuardedPlanSegment[];
	readonly steps: readonly GuardedPlanStep[];
	readonly postconditions: readonly ExecutableAssertion[];
	/**
	 * Present on plans emitted by current `dbsp plan`.  It remains optional in
	 * the TypeScript shape solely so recovery can read historic documents; new
	 * execution rejects an absent contract before taking intent.
	 */
	readonly executionContract?: ExecutionContract;
}

export type ProvenGuardProtocol = Exclude<
	GuardProtocol,
	{ readonly kind: 'impossible' }
>;

export interface ProvenApplyGuard extends Omit<ApplyGuard, 'protocol'> {
	readonly protocol: ProvenGuardProtocol;
}

export interface ProvenPlanStep extends Omit<GuardedPlanStep, 'guards'> {
	readonly guards: readonly ProvenApplyGuard[];
}

export interface ProvenPlanShape extends Omit<GuardedPlan, 'steps'> {
	readonly steps: readonly ProvenPlanStep[];
	/**
	 * Present on newly persisted declarative runs. It is inside the plan document
	 * deliberately: the plan digest therefore covers the declaration set.
	 */
	readonly declarations?: DeclarationSet;
}

/**
 * Plain serializable audit/dump format. A future
 * adoptSerializedPlan(serialized, observationContext) API will re-derive an
 * InProcessProvenPlan; apply() must not accept this shape directly.
 */
export type SerializedProvenPlan = ProvenPlanShape;
