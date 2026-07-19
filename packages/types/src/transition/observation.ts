import type { SemanticArtifactRef } from './artifact.js';
import type { JsonValue } from './json.js';
import type { ResourceAddress } from './resource.js';

export type EvidenceId = string & { readonly __brand: 'EvidenceId' };

export type AdvisoryObservationId = string & {
	readonly __brand: 'AdvisoryObservationId';
};

export interface ObservationRequest {
	readonly kind: string;
	readonly scope: readonly ResourceAddress[];
	readonly detail?: JsonValue;
}

export interface ObservationBooleanClaim {
	readonly kind: string;
	readonly holds: boolean;
	readonly scope?: readonly ResourceAddress[];
	readonly detail?: JsonValue;
}

export interface ObservationContext {
	readonly engine: string;
	readonly engineVersion: string;
	readonly databaseId: string;
	readonly capabilities: readonly string[];
	readonly privileges: readonly string[];
	readonly effectiveRole?: string;
	readonly targetSchema?: string;
	readonly searchPath?: readonly string[];
	readonly sessionConfiguration: Readonly<Record<string, string>>;
	readonly extensions: Readonly<Record<string, string>>;
	readonly collationProvider?: string;
	readonly collationVersion?: string;
	readonly transaction?: string;
}

export type ObservationPrivilegeMergeResult =
	| {
			readonly merged: readonly string[];
	  }
	| {
			readonly conflict: string;
	  };

export type ObservationStability =
	| 'connection-constant'
	| 'session-bound'
	| 'transaction-snapshot'
	| 'lock-protected'
	| 'externally-mutable'
	| 'historical-only';

export interface ObservationResult {
	readonly value: JsonValue;
	readonly digest?: string;
}

interface IssuedObservationBase {
	readonly issuer: SemanticArtifactRef;
	readonly request: ObservationRequest;
	readonly result: ObservationResult;
	readonly context: ObservationContext;
	readonly stability: ObservationStability;
	readonly takenAt: string;
	readonly scope: readonly ResourceAddress[];
}

/** Durable evidence: a fact about the SYSTEM, valid until the context fingerprint moves. */
export interface EvidenceObservation extends IssuedObservationBase {
	readonly role: 'evidence';
	readonly id: EvidenceId;
	readonly stability: Exclude<ObservationStability, 'historical-only'>;
	readonly source:
		| 'system-catalog'
		| 'vendor-deparser'
		| 'dependency-catalog'
		| 'configuration-probe'
		| 'privilege-probe';
	readonly validity: {
		readonly expiresAt?: string;
		readonly invalidatedBy: readonly string[];
	};
}

/** Advisory only (incl. rehearsal, which is `historical-only`): raises confidence, discharges NOTHING. */
export interface AdvisoryObservation extends IssuedObservationBase {
	readonly role: 'advisory';
	readonly id: AdvisoryObservationId;
}

export type IssuedObservation = EvidenceObservation | AdvisoryObservation;
