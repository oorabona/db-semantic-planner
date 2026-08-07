import type {
	LedgerAddress,
	LedgerClaimKind,
	LedgerPayload,
} from './ledger.js';
import type { LedgerChainProjection, LedgerStableState } from './projection.js';

/** A planned managed statement has a stable position inside its claim bundle. */
export interface ClaimBundleStatement {
	readonly ordinal: number;
	readonly sql: string;
}

/**
 * The complete ordered set of statements a claim may execute.  It is supplied
 * by planning and never extended by the execution path.
 */
export interface ClaimStatementBundle {
	readonly statements: readonly ClaimBundleStatement[];
}

/**
 * Opaque capability minted only by the core claim-admission boundary.
 * Its members are intentionally not public: adapters present it to core rather
 * than reconstructing a claim identity from data controlled by a caller.
 */
declare const claimTokenBrand: unique symbol;
export interface ClaimToken {
	readonly [claimTokenBrand]: 'dbsp-outcome-claim-token';
}

/** The fixed plan-time material that becomes one ledger claim. */
export interface OutcomeClaimPlan {
	readonly claimId: string;
	readonly address: LedgerAddress;
	readonly claimKind: LedgerClaimKind;
	readonly statementBundle: ClaimStatementBundle;
	readonly declared?: LedgerPayload;
	readonly pairId?: string;
}

/** The only successful result of admission, including its single-use token. */
export interface AdmittedOutcomeClaim {
	readonly kind: 'admitted-outcome-claim';
	readonly plan: OutcomeClaimPlan;
	readonly stableStateBeforeClaim: LedgerStableState;
	readonly token: ClaimToken;
}

/** Every refusal retains the subject's server or admission words. */
export interface OutcomeProtocolRefusal {
	readonly kind: 'outcome-protocol-refused';
	readonly reason: string;
}

export type OutcomeClaimAdmission =
	| AdmittedOutcomeClaim
	| OutcomeProtocolRefusal;

/** A typed live-vacancy result supplied by the catalogue-specific reader. */
export type OutcomeVacancy =
	| { readonly kind: 'vacant' }
	| { readonly kind: 'occupied'; readonly reason: string };

/** A projected chain is always supplied to core admission as one unit. */
export interface OutcomeClaimAdmissionInput {
	readonly plan: OutcomeClaimPlan;
	readonly projection: LedgerChainProjection;
}
