/**
 * Durable, reviewed conditions for executing a serialized transition plan.
 *
 * This is deliberately a small document format rather than a second copy of
 * ObservationContext.  Its requirements are canonicalized before persistence
 * and are covered by the plan digest.
 */
export const EXECUTION_CONTRACT_VERSION = 1 as const;

export type ExecutionRequirementMode =
	| 'must-match'
	| 'set-and-verify'
	| 'must-satisfy'
	| 'provenance';

export interface PostgreSqlNamespaceIdentity {
	readonly name: string;
	readonly oid: string;
}

export interface PostgreSqlPhysicalTargetRequirement {
	readonly kind: 'postgresql.physical-target';
	readonly mode: 'must-match';
	readonly systemIdentifier: string;
	readonly databaseOid: string;
	/** Canonical lexical set, never a positional list. */
	readonly namespaces: readonly PostgreSqlNamespaceIdentity[];
}

export interface PostgreSqlEngineRequirement {
	readonly kind: 'postgresql.engine-version';
	readonly mode: 'must-satisfy';
	readonly stepId: string;
	readonly minServerVersionNum?: number;
	readonly maxServerVersionNum?: number;
}

/** Authority is a capability over an object, never a role-name comparison. */
export interface PostgreSqlAuthorityRequirement {
	readonly kind: 'postgresql.authority';
	readonly mode: 'must-satisfy';
	readonly action: 'schema-usage' | 'table-alter' | 'type-alter';
	readonly schema: string;
	readonly object?: string;
}

export interface PostgreSqlSessionSettingRequirement {
	readonly kind: 'postgresql.session-setting';
	readonly mode: 'set-and-verify' | 'provenance';
	readonly setting:
		| 'standard_conforming_strings'
		| 'search_path'
		| 'client_encoding'
		| 'TimeZone';
	readonly value: string;
}

export type ExecutionRequirement =
	| PostgreSqlPhysicalTargetRequirement
	| PostgreSqlEngineRequirement
	| PostgreSqlAuthorityRequirement
	| PostgreSqlSessionSettingRequirement;

export interface ExecutionContract {
	readonly version: typeof EXECUTION_CONTRACT_VERSION;
	/** A canonically ordered set. Unknown kinds and modes are invalid. */
	readonly requirements: readonly ExecutionRequirement[];
}
