import type { SemanticArtifactRef } from './artifact.js';

export interface ContextFact {
	readonly key: string;
	readonly value: string;
}

export interface UnknownCoverage {
	readonly key: string;
	readonly reason: string;
}

export interface FingerprintManifest {
	readonly algorithm: string;
	readonly semanticModel: SemanticArtifactRef;
	readonly includedFacts: readonly ContextFact[];
	readonly excludedOrUnknownFacts: readonly UnknownCoverage[];
	readonly digest: string;
}
