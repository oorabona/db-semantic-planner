import type { JsonValue } from './json.js';
import type { CatalogueIdentity, ResourceAddress } from './resource.js';

/** The outcome protocol is closed at the fourteen ADR 0006 event kinds. */
export const LEDGER_EVENT_KINDS = [
	'adopt-intent',
	'adopt',
	'intent',
	'retire-intent',
	'readdress-intent',
	'refused',
	'executing',
	'observed',
	'absent',
	'indeterminate',
	'resolved',
	'readdressed-to',
	'readdressed-from',
	'released',
] as const;

export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

export type LedgerClaimKind = Extract<
	LedgerEventKind,
	'adopt-intent' | 'intent' | 'retire-intent' | 'readdress-intent'
>;

/**
 * A canonical address is recorded as columns by PostgreSQL and as this shape at
 * the adapter boundary.  `scope` selects exactly one physical ledger.
 */
export interface LedgerAddress extends ResourceAddress {
	readonly scope: 'schema' | 'database';
}

export interface LedgerPayload {
	readonly value: JsonValue;
	readonly digest: string;
}

export interface LedgerChainMember {
	readonly eventId: string;
	readonly address: LedgerAddress;
	readonly catalogueIdentity?: CatalogueIdentity;
	readonly eventKind: LedgerEventKind;
	readonly predecessor?: string;
	readonly pairId?: string;
	readonly declared?: LedgerPayload;
	readonly observed?: LedgerPayload;
	readonly controller: string;
	readonly recordedAt?: string;
}

/** A durable effects-closure reservation, anchored in its root claim's ledger. */
export interface LedgerReservationRow {
	readonly address: LedgerAddress;
	readonly claimKind: LedgerClaimKind;
	readonly executionId: string;
	readonly pairId?: string;
	readonly rootClaimId: string;
	readonly homeLedger: LedgerHome;
}

export interface LedgerHome {
	readonly scope: 'schema' | 'database';
	/** Present exactly for a schema ledger. */
	readonly schema?: string;
}

/** The lineage facts stored beside every ledger; their admission rules ship later. */
export interface LedgerIdentity {
	readonly clusterSystemIdentifier: string;
	readonly databaseOid: string;
	readonly namespaceOid?: string;
}

export interface LedgerShapeMarker {
	readonly version: number;
}

/**
 * The only marker vocabulary understood by the reinitialize-preflight path.
 * `absent` is deliberately distinct from a malformed or old marker: a
 * missing marker is how a new scope enters the cutover.
 */
export type LedgerMarkerState =
	| { readonly kind: 'current' }
	| { readonly kind: 'absent' }
	| { readonly kind: 'older'; readonly version: number }
	| { readonly kind: 'future'; readonly version: number }
	| { readonly kind: 'mixed'; readonly versions: readonly number[] }
	| { readonly kind: 'unreadable'; readonly reason: string };

/** The closed result set for one explicit reinitialize-preflight scope. */
export type ReinitializePreflightScopeOutcome =
	| 'current'
	| 'unchanged'
	| 'failed'
	| 'not-attempted';

export type ReinitializePreflightRefusalCode =
	| 'reinitialize-preflight-marker-not-current'
	| 'reinitialize-preflight-advisory-lock'
	| 'reinitialize-preflight-ownership'
	| 'reinitialize-preflight-grants'
	| 'reinitialize-preflight-lineage'
	| 'reinitialize-preflight-failed';

/** The exact operation that produced a reported preflight failure. */
export type ReinitializePreflightFailureStep =
	| 'advisory-lock'
	| 'marker'
	| 'identity'
	| 'ownership-grants'
	| 'archive'
	| 'create'
	| 'record-identity'
	| 'creation-grants'
	| 'write-marker'
	| 'output';

/** PostgreSQL's unmodified message, paired with the engine step that failed. */
export interface ReinitializePreflightFailureReason {
	readonly step: ReinitializePreflightFailureStep;
	readonly message: string;
}

interface ReinitializePreflightScopeReportBase {
	readonly ledger: LedgerHome;
	readonly marker: LedgerMarkerState;
	readonly refusal?: {
		readonly code: ReinitializePreflightRefusalCode;
		readonly detail: string;
	};
}

/** A failed scope is structurally required to retain its diagnostic. */
export type ReinitializePreflightScopeReport =
	| (ReinitializePreflightScopeReportBase & {
			readonly outcome: 'failed';
			readonly reason: ReinitializePreflightFailureReason;
	  })
	| (ReinitializePreflightScopeReportBase & {
			readonly outcome: Exclude<ReinitializePreflightScopeOutcome, 'failed'>;
			readonly reason?: never;
	  });

/** A current DSL declaration for which no chain exists in its home ledger. */
export interface ReinitializePreflightAdoptionCandidate {
	readonly address: LedgerAddress;
	readonly declaration: LedgerPayload;
}

export interface ReinitializePreflightReport {
	readonly scopes: readonly ReinitializePreflightScopeReport[];
	readonly adoptionCandidates: readonly ReinitializePreflightAdoptionCandidate[];
}
