import type { ClaimId, ProofObligation } from './proof.js';

export type EquivalenceResult =
	| { readonly kind: 'equivalent'; readonly claim: ClaimId }
	| { readonly kind: 'different'; readonly claim: ClaimId }
	| {
			readonly kind: 'unknown';
			readonly obligations: readonly ProofObligation[];
	  };
