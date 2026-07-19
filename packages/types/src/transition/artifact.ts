export type SemanticArtifactId = string & {
	readonly __brand: 'SemanticArtifactId';
};

export interface SemanticArtifactRef {
	readonly id: SemanticArtifactId;
	readonly version: string;
}

export interface OperationKindRef {
	readonly artifact: SemanticArtifactRef;
	readonly name: string;
}

export type TrustRoot =
	| { readonly kind: 'pack'; readonly artifact: SemanticArtifactRef }
	| { readonly kind: 'human'; readonly identity: string }
	| { readonly kind: 'policy'; readonly policyId: string };
