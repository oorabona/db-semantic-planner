import type { SemanticArtifactRef, TrustRoot } from './artifact.js';
import type { JsonValue } from './json.js';
import type { EvidenceId, ObservationRequest } from './observation.js';
import type { ResourceAddress } from './resource.js';

export type AssumptionId = string & { readonly __brand: 'AssumptionId' };

export type ClaimId = string & { readonly __brand: 'ClaimId' };

export interface Proposition {
	readonly kind: string;
	readonly scope: readonly ResourceAddress[];
	readonly detail?: JsonValue;
}

export interface ProofObligation {
	readonly proposition: Proposition;
	readonly scope: readonly ResourceAddress[];
	readonly appliesTo?: string;
	readonly dischargeableBy?: readonly ObservationRequest[];
}

export interface Assumption {
	readonly id: AssumptionId;
	readonly class:
		| 'rule-effect-declaration'
		| 'user-blast-radius'
		| 'external-ddl-exclusion'
		| 'operation-pack-semantics'
		| 'baseline-identity-attachment'
		| (string & {});
	readonly asserter: TrustRoot;
	readonly statement: string;
	readonly scope: readonly ResourceAddress[];
}

export type ClaimConclusion =
	| 'established'
	| 'established-under-assumptions'
	| 'undischarged'
	| 'refuted';

export interface ClaimDerivation<
	TConclusion extends ClaimConclusion = ClaimConclusion,
> {
	readonly semantics: SemanticArtifactRef;
	readonly inputs: readonly EvidenceId[];
	readonly proposition: Proposition;
	readonly conclusion: TConclusion;
}

interface ProofClaimBase<TConclusion extends ClaimConclusion> {
	readonly id: ClaimId;
	readonly proposition: Proposition;
	readonly scope: readonly ResourceAddress[];
	readonly supportedBy: readonly EvidenceId[];
	readonly semantics: readonly SemanticArtifactRef[];
	readonly derivedBy: ClaimDerivation<TConclusion>;
}

export type ProofClaim =
	| (ProofClaimBase<'established'> & {
			readonly assumes: readonly [];
	  })
	| (ProofClaimBase<'established-under-assumptions'> & {
			readonly assumes: readonly [AssumptionId, ...AssumptionId[]];
	  })
	| (ProofClaimBase<'undischarged' | 'refuted'> & {
			readonly assumes: readonly AssumptionId[];
	  });
