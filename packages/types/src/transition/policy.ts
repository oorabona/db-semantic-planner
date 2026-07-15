import type { TrustRoot } from './artifact.js';
import type { ResourceSelector } from './resource.js';

export interface AssumptionAcceptance {
	readonly class: string;
	readonly fromTrustRoot?: TrustRoot;
	readonly withinScope?: readonly ResourceSelector[];
}

export interface ApplyPolicy {
	readonly accepts: readonly AssumptionAcceptance[];
}
