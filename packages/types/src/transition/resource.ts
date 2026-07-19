export interface ResourceAddress {
	readonly engine: string;
	readonly database: string;
	readonly schema?: string;
	readonly kind: string;
	readonly name: string;
	readonly qualifiedBy?: readonly string[];
}

export interface ResourceSelector {
	readonly kind?: string;
	readonly schema?: string;
	readonly name?: string;
	readonly within?: ResourceAddress;
}
