/**
 * > ProvenPlanShape is the serializable structural shape a Prover may brand in @dbsp/core after validating the following relational invariants at runtime (they are beyond structural typing).
 *
 * - Every ApplyGuard.appliesTo and ProofObligation.appliesTo matches exactly one PhysicalOperation.ref in the same step/fragment (no dangling or duplicate ref).
 * - Every external-ddl-exclusion binding's AssumptionId is present in the step's restsOnAssumptions closure and in GuardedPlan.assumptions.
 * - Journal record stepIds are consistent with intent.stepId; ApplyResult.observations is a superset of every ObservedOutcomeRecord.observations.
 *
 * A persisted or reloaded plan is a GuardedPlan and must be re-proven before apply; proof is never trusted across serialization.
 */
import type { FingerprintManifest } from './fingerprint.js';
import type { RuleSelectionRationale } from './fragment.js';
import type { ApplyGuard, GuardProtocol, RecoveryArtefact } from './guard.js';
import type { EvidenceId, IssuedObservation } from './observation.js';
import type { ClaimSelector, PhysicalOperation } from './operation.js';
import type {
	Assumption,
	AssumptionId,
	ClaimId,
	ProofClaim,
	Proposition,
} from './proof.js';
import type { ResourceAddress } from './resource.js';

export interface ExecutableAssertion {
	readonly proposition: Proposition;
	readonly scope: readonly ResourceAddress[];
}

export interface DurableIntentRecord {
	readonly stepId: string;
	readonly operation: PhysicalOperation;
	readonly recordedAt: string;
}

export interface TransactionalCompletionRecord {
	readonly stepId: string;
	readonly committedWithDdl: boolean;
	readonly recordedAt: string;
}

export interface ObservedOutcomeRecord {
	readonly stepId: string;
	readonly observations: readonly EvidenceId[];
	readonly recordedAt: string;
}

export type StepOutcome =
	| 'completed'
	| 'guard-failed'
	| 'guard-timeout'
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
	readonly outcome: 'guard-failed' | 'guard-timeout' | 'partially-applied';
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
	readonly operation: PhysicalOperation;
	readonly expectedBefore: FingerprintManifest;
	readonly expectedAfter: FingerprintManifest;
	readonly requiredClaims: readonly ClaimId[];
	readonly establishesClaims: readonly ClaimId[];
	readonly invalidatesClaims: readonly ClaimSelector[];
	readonly guards: readonly ApplyGuard[];
	readonly restsOnAssumptions: readonly AssumptionId[];
	readonly selectionRationale: RuleSelectionRationale;
}

export interface GuardedPlan {
	readonly observations: readonly IssuedObservation[];
	readonly claims: readonly ProofClaim[];
	readonly assumptions: readonly Assumption[];
	readonly preconditions: readonly ExecutableAssertion[];
	readonly steps: readonly GuardedPlanStep[];
	readonly postconditions: readonly ExecutableAssertion[];
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
}
