import type { SemanticArtifactRef } from './artifact.js';
import type { ApplyGuard } from './guard.js';
import type { PhysicalOperation } from './operation.js';
import type { Assumption, ProofObligation } from './proof.js';

export interface RuleRef {
	readonly id: string;
	readonly pack: SemanticArtifactRef;
}

export interface RuleSelectionRationale {
	readonly chosen: RuleRef;
	readonly overRules: readonly RuleRef[];
	readonly why: string;
}

export interface TransitionFragment {
	readonly generatedBy: RuleRef;
	readonly operations: readonly PhysicalOperation[];
	readonly obligations: readonly ProofObligation[];
	readonly assumptions: readonly Assumption[];
	readonly guards: readonly ApplyGuard[];
	readonly selectionRationale: RuleSelectionRationale;
}
