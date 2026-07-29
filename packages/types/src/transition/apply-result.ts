import type { PlanAssessment } from './assessment.js';
import type { RecoveryArtefact } from './guard.js';
import type { IssuedObservation } from './observation.js';
import type { ProvenGuardProtocol, StepJournal } from './plan.js';

/** Stable phase-owned result of a durable apply attempt. */
export type DurableApplyOutcome =
	| 'completed'
	| 'operation-failed-not-applied'
	| 'partially-applied'
	| 'unknown-step-result'
	| 'outcome-unknown'
	| 'guard-failed'
	| 'guard-timeout'
	| 'context-mismatch'
	| 'transactional-only-refusal'
	| 'digest-mismatch'
	| 'prior-step-events-refusal'
	| 'compatibility-refusal'
	| 'assumption-not-accepted'
	| 'authorization-write-failed'
	| 'execution-contract-refused'
	| 'execution-preflight-failed'
	| 'execution-failed'
	| 'operation-unavailable'
	| 'plan-validation-failed'
	| 'run-id-mismatch'
	| 'load-failed'
	| 'plan-digest-mismatch';

/** Stable phase-owned result of recovery classification. */
export type RecoveryOutcome =
	| 'completed'
	| 'recovery-resume-required'
	| 'recovery-partially-applied'
	| 'recovery-unknown-step-result'
	| 'recovery-guard-failed'
	| 'recovery-guard-timeout'
	| 'recovery-operation-failed-not-applied'
	| 'recovery-context-mismatch'
	| 'recovery-read-failed';

export interface ApplyResult {
	readonly assessment: PlanAssessment;
	readonly journals: readonly StepJournal[];
	readonly observations: readonly IssuedObservation[];
	readonly recovery?: readonly {
		readonly stepId: string;
		readonly protocol: ProvenGuardProtocol['kind'];
		readonly artefact: RecoveryArtefact;
	}[];
	/** Present only on the durable-apply entry point. */
	readonly durableOutcome?: DurableApplyOutcome;
	/** Present only on the recovery entry point. */
	readonly recoveryOutcome?: RecoveryOutcome;
}
