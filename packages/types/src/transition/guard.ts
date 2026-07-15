import type { JsonValue } from './json.js';
import type { AssumptionId, ClaimId } from './proof.js';
import type { ResourceAddress } from './resource.js';

export type GuardProtocolKind =
	| 'lock-and-check'
	| 'engine-validated'
	| 'multi-resource'
	| 'impossible';

export interface RecoveryArtefact {
	readonly kind: string;
	readonly resource: ResourceAddress;
	readonly note?: string;
}

/** A protocol must guarantee stable binding of every semantic dependency, OR carry an external-ddl-exclusion
 * assumption scoped to exactly those objects, OR be impossible (ADR §4b "bind the target"). */
export type TargetBinding =
	| {
			readonly kind: 'stable-identity';
			readonly bound: readonly ResourceAddress[];
			readonly identityClaim: ClaimId;
	  }
	| {
			readonly kind: 'external-ddl-exclusion';
			readonly assumption: AssumptionId;
			readonly scope: readonly ResourceAddress[];
	  }
	| { readonly kind: 'unbindable' };

export type BoundBinding = Extract<
	TargetBinding,
	| { readonly kind: 'stable-identity' }
	| { readonly kind: 'external-ddl-exclusion' }
>;

export type GuardProtocol =
	| {
			readonly kind: 'lock-and-check';
			readonly onFailureLeaves: readonly RecoveryArtefact[];
			readonly binding: BoundBinding;
	  }
	| {
			readonly kind: 'engine-validated';
			readonly onFailureLeaves: readonly RecoveryArtefact[];
			readonly binding: BoundBinding;
	  }
	| {
			readonly kind: 'multi-resource';
			readonly onFailureLeaves: readonly RecoveryArtefact[];
			readonly binding: BoundBinding;
	  }
	| {
			readonly kind: 'impossible';
			readonly onFailureLeaves: readonly RecoveryArtefact[];
			readonly binding?: TargetBinding;
	  };

export interface GuardPredicate {
	readonly kind: string;
	readonly scope: readonly ResourceAddress[];
	readonly detail?: JsonValue;
}

export interface ApplyGuard {
	readonly appliesTo: string;
	readonly predicate: GuardPredicate;
	readonly protocol: GuardProtocol;
	readonly phase: 'before-operation' | 'during-operation' | 'after-operation';
}
