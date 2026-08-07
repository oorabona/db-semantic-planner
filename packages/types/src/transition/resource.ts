/** The managed catalogue kinds. This union is intentionally closed. */
export type DeclarableKind =
	| 'table'
	| 'column'
	| 'index'
	| 'constraint'
	| 'enum'
	| 'sequence'
	| 'extension';

/** PostgreSQL identifies every managed object except a column by its OID. */
export interface OidCatalogueIdentity {
	readonly kind: 'oid';
	readonly oid: string;
}

/** Columns have no independent durable OID: their parent identity and name are it. */
export interface ColumnCatalogueIdentity {
	readonly kind: 'column';
	readonly parentOid: string;
	readonly name: string;
}

export type CatalogueIdentity = OidCatalogueIdentity | ColumnCatalogueIdentity;

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
