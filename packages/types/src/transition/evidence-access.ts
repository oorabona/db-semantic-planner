import type { SemanticArtifactRef } from './artifact.js';
import type {
	EvidenceObservation,
	ObservationContext,
	ObservationRequest,
} from './observation.js';
import type { ProofObligation } from './proof.js';

export type EvidenceClaimConclusion =
	| 'established'
	| 'undischarged'
	| 'refuted'
	| 'conflicted';

export interface EvidenceClaimResult {
	readonly conclusion: EvidenceClaimConclusion;
	readonly supportedBy: readonly EvidenceObservation[];
}

export interface EvidenceObservationFilters {
	readonly issuer?: SemanticArtifactRef;
	readonly source?: EvidenceObservation['source'];
}

export interface EvidenceView {
	readonly context: ObservationContext;
	claimHolds(target: ObservationRequest | ProofObligation): EvidenceClaimResult;
	observationsFor(
		request: ObservationRequest,
		filters?: EvidenceObservationFilters,
	): readonly EvidenceObservation[];
	normalizeRequest(request: ObservationRequest): ObservationRequest;
}

export type ProofEvidenceAccess = EvidenceView;
