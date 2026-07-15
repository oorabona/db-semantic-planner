import type {
	AdvisoryObservationId,
	AssumptionId,
	ClaimId,
	EvidenceId,
	SemanticArtifactId,
} from '@dbsp/types';

export function semanticArtifactId(value: string): SemanticArtifactId {
	return value as SemanticArtifactId;
}

export function assumptionId(value: string): AssumptionId {
	return value as AssumptionId;
}

export function claimId(value: string): ClaimId {
	return value as ClaimId;
}

export function evidenceId(value: string): EvidenceId {
	return value as EvidenceId;
}

export function advisoryObservationId(value: string): AdvisoryObservationId {
	return value as AdvisoryObservationId;
}
