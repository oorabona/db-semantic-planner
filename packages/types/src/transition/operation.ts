import type { OperationKindRef } from './artifact.js';
import type { JsonValue } from './json.js';
import type { ResourceAddress, ResourceSelector } from './resource.js';

/**
 * This envelope is opaque: expression safety is enforced by the owning
 * operation pack's payload type and its effectsOf/renderer, and a pack that
 * emits a raw fragment must type it UnsafeNativeFragment carrying its
 * assumption before erasing to JsonValue here.
 */
export interface PhysicalOperation<TPayload extends JsonValue = JsonValue> {
	readonly ref: string;
	readonly operationKind: OperationKindRef;
	readonly payload: TPayload;
}

export interface LockRequirement {
	readonly resource: ResourceAddress;
	readonly mode: string;
	readonly maxWaitMs?: number;
	readonly order?: number;
}

export interface ClaimSelector {
	readonly proposition?: string;
	readonly scope: ResourceSelector;
}

export interface ContextMutation {
	readonly facet: 'role' | 'search_path' | 'session' | 'transaction';
	readonly key?: string;
	readonly value: string;
}

export interface ExternalEffectCoverage {
	readonly accountedFor: readonly ResourceSelector[];
	readonly couldNotAccountFor: readonly ResourceSelector[];
}

export interface OperationExecutionSemantics {
	readonly transaction:
		| 'joins-current'
		| 'requires-new'
		| 'forbids-transaction';
	readonly commitBoundary: 'none' | 'before' | 'after' | 'before-and-after';
}

export interface OperationEffects {
	readonly reads: readonly ResourceSelector[];
	readonly writes: readonly ResourceSelector[];
	readonly locks: readonly LockRequirement[];
	readonly invalidates: readonly ClaimSelector[];
	readonly contextMutations: readonly ContextMutation[];
	readonly externalEffects: ExternalEffectCoverage;
	readonly execution: OperationExecutionSemantics;
}
