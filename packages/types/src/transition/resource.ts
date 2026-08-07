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
