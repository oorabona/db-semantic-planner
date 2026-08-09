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

/**
 * JSON-compatible structural serialization whose object-member order is stable.
 * Ledger parents are persisted through PostgreSQL jsonb, which normalizes that
 * order before a later read-back.
 */
function canonicalJson(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'null';
	if (Array.isArray(value)) {
		const entries: string[] = [];
		for (let index = 0; index < value.length; index += 1)
			entries.push(
				Object.hasOwn(value, index) ? canonicalJson(value[index]) : 'null',
			);
		return `[${entries.join(',')}]`;
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value);
}

function normalizedParent(
	parent: ResourceAddress | null | undefined,
): Record<string, unknown> | null {
	if (parent === null || parent === undefined) return null;
	return { ...parent, parent: normalizedParent(parent.parent) };
}

/**
 * The sole structural equality for a ledger address.  Parent absence is
 * canonicalized so `undefined` and `null` mean the same root address.
 */
export function sameLedgerAddress(
	left: LedgerAddress,
	right: LedgerAddress,
): boolean {
	return (
		left.scope === right.scope &&
		left.engine === right.engine &&
		left.database === right.database &&
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.name === right.name &&
		canonicalJson(normalizedParent(left.parent)) ===
			canonicalJson(normalizedParent(right.parent))
	);
}

/** A canonical map key with the same key-order-insensitive parent semantics. */
export function ledgerAddressKey(address: LedgerAddress): string {
	return canonicalJson({
		...address,
		parent: normalizedParent(address.parent),
	});
}

export interface LedgerPayload {
	readonly value: JsonValue;
	readonly digest: string;
}

/**
 * The durable, operator-facing explanation attached to a `refused` terminal.
 * The address itself remains in the event's canonical address columns; these
 * values preserve the other facts needed to explain a historic refusal.
 */
export interface LedgerRefusal {
	readonly code: `ERR-${number}`;
	readonly cause: string;
	readonly state: 'unknown' | 'managed' | 'absent';
	readonly withheldAuthority: string;
	readonly resolvingCommand: string;
}

export interface LedgerChainMember {
	readonly eventId: string;
	readonly executionId?: string;
	readonly plannedClaimKey?: string;
	readonly claimGroupId?: string;
	readonly rootClaimId?: string;
	readonly address: LedgerAddress;
	readonly catalogueIdentity?: CatalogueIdentity;
	readonly eventKind: LedgerEventKind;
	readonly predecessor?: string;
	readonly pairId?: string;
	readonly declared?: LedgerPayload;
	readonly observed?: LedgerPayload;
	/** Present exactly on a durable `refused` terminal. */
	readonly refusal?: LedgerRefusal;
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
	| 'database-read-only'
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
