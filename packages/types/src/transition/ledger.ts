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
