import type { OperationKindRef, SemanticArtifactRef } from './artifact.js';
import type { ContextFact } from './fingerprint.js';
import type { RuleRef } from './fragment.js';
import type { RecoveryArtefact } from './guard.js';
import type { AssumptionId, ClaimId, ProofObligation } from './proof.js';
import type { ResourceAddress } from './resource.js';

export type OutcomeReasonCode =
	| 'proven-applicable'
	| 'proven-inapplicable'
	| 'context-mismatch'
	| 'insufficient-evidence'
	| 'unsupported-transition'
	| 'ambiguous-rule'
	| 'uncomposable'
	| 'ambiguous-intent'
	| 'guard-failed'
	| 'guard-timeout'
	| 'partially-applied'
	| 'unknown-step-result'
	| 'resume-required';

interface OutcomeReasonBase {
	readonly detail?: string;
	readonly scope: readonly ResourceAddress[];
}

export type OutcomeReason =
	| (OutcomeReasonBase & {
			readonly code: 'proven-applicable';
			readonly claim: ClaimId;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'proven-inapplicable';
			readonly claim: ClaimId;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'context-mismatch';
			readonly artifact: SemanticArtifactRef;
			readonly fact: ContextFact;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'insufficient-evidence';
			readonly obligation: ProofObligation;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'unsupported-transition';
			readonly changes: readonly ResourceAddress[];
	  })
	| (OutcomeReasonBase & {
			readonly code: 'ambiguous-rule';
			readonly candidates: readonly RuleRef[];
	  })
	| (OutcomeReasonBase & {
			readonly code: 'uncomposable';
			readonly fragments: readonly RuleRef[];
			readonly obligation?: ProofObligation;
			readonly assumption?: AssumptionId;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'ambiguous-intent';
			readonly candidates: readonly ResourceAddress[];
	  })
	| (OutcomeReasonBase & {
			readonly code: 'guard-failed';
			readonly stepId: string;
			readonly operationKind: OperationKindRef;
			readonly operationRef: string;
			readonly recovery: readonly RecoveryArtefact[];
	  })
	| (OutcomeReasonBase & {
			readonly code: 'guard-timeout';
			readonly stepId: string;
			readonly operationKind: OperationKindRef;
			readonly operationRef: string;
			readonly maxWaitMs?: number;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'partially-applied';
			readonly stepId: string;
			readonly operationKind: OperationKindRef;
			readonly operationRef: string;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'unknown-step-result';
			readonly stepId: string;
			readonly operationKind: OperationKindRef;
			readonly operationRef: string;
	  })
	| (OutcomeReasonBase & {
			readonly code: 'resume-required';
			readonly stepId: string;
			readonly recovery: readonly RecoveryArtefact[];
	  });

export interface PlanAssessment {
	readonly decision: 'applicable' | 'inapplicable' | 'blocked';
	readonly assurance: 'established' | 'accepted-under-assumptions' | 'unproven';
	readonly lifecycle:
		| 'planned'
		| 'running'
		| 'completed'
		| 'partially-applied'
		| 'outcome-unknown';
	readonly continuation:
		| 'none'
		| 'resume-possible'
		| 'replan-required'
		| 'human-intervention-required';
	readonly reasons: readonly OutcomeReason[];
}

export type ApplicableAssessment = PlanAssessment & {
	readonly decision: 'applicable';
	readonly assurance: 'established' | 'accepted-under-assumptions';
};

export type InapplicableAssessment = PlanAssessment & {
	readonly decision: 'inapplicable';
};
