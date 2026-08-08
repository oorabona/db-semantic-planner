import type { LedgerAddress } from './ledger.js';

/** The two destructive effects defined by the managed-ledger authority table. */
export type DestructiveAction =
	| { readonly kind: 'removal'; readonly address: LedgerAddress }
	| { readonly kind: 'data-destructive'; readonly address: LedgerAddress };

export type DeclarationDestructiveOutcome =
	| 'requires-removal'
	| 'requires-lossy-change'
	| 'replacement-requested-by-plan'
	| 'requires-neither'
	| 'absent'
	| 'uncomputable';

export type OwnershipDestructiveOutcome =
	| 'managed-by-me'
	| 'managed-by-other'
	| 'pending'
	| 'blocked'
	| 'unknown'
	| 'uncomputable';

export type CatalogueIdentityDestructiveOutcome =
	| 'matches-recorded'
	| 'differs'
	| 'object-absent'
	| 'catalogue-unavailable';

export type OperatorAcceptanceDestructiveOutcome =
	| 'destructive-plan-accepted'
	| 'absent';

export type ContainmentClosureDestructiveOutcome =
	| 'all-contained-or-managed'
	| 'reaches-unmanaged'
	| 'undecidable';

export type LedgerLineageDestructiveOutcome =
	| 'matches-database'
	| 'differs'
	| 'unreadable';

/** Closed evidence supplied to the sole destructive-decision interpreter. */
export interface DestructiveAuthorityEvidence {
	readonly declaration: DeclarationDestructiveOutcome;
	/** Present only for replacement-requested-by-plan; it limits that permit. */
	readonly replacementAddress?: LedgerAddress;
	readonly ownership: OwnershipDestructiveOutcome;
	readonly catalogueIdentity: CatalogueIdentityDestructiveOutcome;
	readonly operatorAcceptance: OperatorAcceptanceDestructiveOutcome;
	/** Required only for removals. */
	readonly containment?: ContainmentClosureDestructiveOutcome;
	readonly ledgerLineage: LedgerLineageDestructiveOutcome;
}

declare const destructiveAuthorityPermitBrand: unique symbol;

/**
 * Opaque positive evidence. It has no constructible fields, so an execution
 * sink can require it without accepting a caller-assembled set of booleans.
 */
export interface DestructiveAuthorityPermit {
	readonly [destructiveAuthorityPermitBrand]: 'dbsp-destructive-authority-permit';
}

export interface PermittedDestructiveDecision {
	readonly kind: 'destructive-decision-permitted';
	readonly action: DestructiveAction;
	readonly permit: DestructiveAuthorityPermit;
}

export interface RefusedDestructiveDecision {
	readonly kind: 'destructive-decision-refused';
	readonly action: DestructiveAction;
	readonly reasons: readonly string[];
}

export type DestructiveDecision =
	| PermittedDestructiveDecision
	| RefusedDestructiveDecision;
