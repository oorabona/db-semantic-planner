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

/**
 * The scoped approvals carried into admitted execution.  This distinct input
 * prevents execution boundaries from silently degrading reviewed scope to a
 * bare list of approval-class strings.
 */
export interface ScopedApprovalSet {
	readonly approvals: readonly AssumptionAcceptance[];
	/** The authority root declared for this admitted policy evaluation. */
	readonly declaredTrustRoot?: TrustRoot;
}
