import type { SemanticArtifactRef } from './artifact.js';
import type { ApplyGuard } from './guard.js';
import type { JsonValue } from './json.js';
import type { PhysicalOperation } from './operation.js';
import type { Assumption, ProofClaimDraft, ProofObligation } from './proof.js';
import type { ResourceAddress } from './resource.js';

export interface RuleRef {
	readonly id: string;
	readonly pack: SemanticArtifactRef;
}

export interface RuleSelectionRationale {
	readonly chosen: RuleRef;
	readonly overRules: readonly RuleRef[];
	readonly why: string;
}

export interface TransitionCompositionFact {
	readonly kind: string;
	readonly resource: ResourceAddress;
	readonly detail?: JsonValue;
}

export interface TransitionFragmentComposition {
	readonly produces?: readonly {
		readonly opRef: string;
		readonly fact: TransitionCompositionFact;
		readonly available: 'after-operation' | 'after-commit';
	}[];
	readonly requires?: readonly {
		readonly opRef: string;
		readonly fact: TransitionCompositionFact;
		readonly needs: 'producer-before-operation' | 'producer-after-commit';
	}[];
	readonly order?: readonly {
		readonly before: string;
		readonly after: string;
		readonly requiresCommitBetween?: boolean;
		readonly reason: string;
	}[];
}

export interface TransitionFragment {
	readonly generatedBy: RuleRef;
	readonly operations: readonly PhysicalOperation[];
	readonly composition?: TransitionFragmentComposition;
	readonly obligations: readonly ProofObligation[];
	readonly claimDrafts?: readonly ProofClaimDraft[];
	readonly assumptions: readonly Assumption[];
	readonly guards: readonly ApplyGuard[];
	readonly selectionRationale: RuleSelectionRationale;
}
