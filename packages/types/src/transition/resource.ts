import type { JsonObject } from './json.js';

/** The managed catalogue kinds. This union is intentionally closed. */
export type DeclarableKind =
	| 'table'
	| 'column'
	| 'index'
	| 'constraint'
	| 'enum'
	| 'sequence'
	| 'extension';

/** Adapter-owned, versioned durable catalogue identity. */
export interface CatalogueIdentity {
	readonly engine: string;
	readonly format: number;
	readonly value: JsonObject;
}

/**
 * The durable PostgreSQL role identity which controls a managed ledger entry.
 * A role name alone is reusable after DROP/CREATE; the OID binds the record to
 * the role that was actually present when the event was written.
 */
export interface ControllerIdentity {
	readonly name: string;
	readonly oid: string;
}

/** Compare the complete durable controller identity in one place. */
export function sameControllerIdentity(
	recorded: ControllerIdentity,
	current: ControllerIdentity,
): boolean {
	return recorded.name === current.name && recorded.oid === current.oid;
}

export interface ResourceAddress {
	readonly engine: string;
	readonly database: string;
	readonly schema?: string;
	/** The containing object, for example an index or column's table. */
	readonly parent?: ResourceAddress;
	readonly kind: string;
	readonly name: string;
	/** Recorded catalogue identity. It is absent only for legacy/non-managed scope. */
	readonly catalogueIdentity?: CatalogueIdentity;
	readonly qualifiedBy?: readonly string[];
}

/** A managed declaration cannot spell a kind outside the declarable set. */
export type DeclarableResourceAddress<
	K extends DeclarableKind = DeclarableKind,
> = Omit<ResourceAddress, 'kind'> & {
	readonly kind: K;
};

export interface ResourceSelector {
	readonly kind?: string;
	readonly schema?: string;
	readonly name?: string;
	readonly within?: ResourceAddress;
}
