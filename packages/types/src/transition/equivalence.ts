import type { SemanticArtifactRef } from './artifact.js';
import type { ExpressionValue } from './expression.js';
import type { EvidenceObservation } from './observation.js';
import type { Assumption, ProofClaimDraft, ProofObligation } from './proof.js';

export type EquivalenceResult =
	| {
			readonly kind: 'equivalent';
			readonly claim: ProofClaimDraft<
				'established' | 'established-under-assumptions'
			>;
			readonly assumptions?: readonly Assumption[];
	  }
	| { readonly kind: 'different'; readonly claim: ProofClaimDraft<'refuted'> }
	| {
			readonly kind: 'unknown';
			readonly obligations: readonly ProofObligation[];
	  };

export interface TypeRef {
	readonly kind: 'type';
	readonly name: string;
	readonly schema?: string;
	readonly schemaScope?: 'target' | 'absolute';
	readonly modifiers: readonly string[];
	readonly arrayDepth: number;
	readonly catalog?: {
		readonly oid?: string;
		readonly name?: string;
		readonly schema?: string;
		readonly typmod?: number;
		readonly formatType?: string;
	};
}

export interface CollationRef {
	readonly kind: 'collation';
	readonly name?: string;
	readonly schema?: string;
	readonly isDefault: boolean;
	readonly catalog?: {
		readonly oid?: string;
		readonly provider?: string;
		readonly version?: string;
	};
}

export interface EquivalenceContext {
	readonly engine: string;
	readonly databaseId?: string;
	readonly targetSchema?: string;
	readonly searchPath?: readonly string[];
}

export type ExpressionEquivalenceCategory =
	| 'scalar'
	| 'predicate'
	| 'qualified-name'
	| 'statement';

export interface EquivalenceCapability {
	readonly artifact: SemanticArtifactRef;
	compareType(
		a: TypeRef,
		b: TypeRef,
		context: EquivalenceContext,
		evidence?: readonly EvidenceObservation[],
	): EquivalenceResult;
	compareExpression(
		a: ExpressionValue,
		b: ExpressionValue,
		category: ExpressionEquivalenceCategory,
		context: EquivalenceContext,
		evidence?: readonly EvidenceObservation[],
	): EquivalenceResult;
	compareCollation(
		a: CollationRef,
		b: CollationRef,
		context: EquivalenceContext,
		evidence?: readonly EvidenceObservation[],
	): EquivalenceResult;
}
