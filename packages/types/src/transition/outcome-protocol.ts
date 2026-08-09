import type {
	LedgerAddress,
	LedgerClaimKind,
	LedgerPayload,
	LedgerRefusal,
} from './ledger.js';
import type { LedgerChainProjection, LedgerStableState } from './projection.js';
import type { CatalogueIdentity, ControllerIdentity } from './resource.js';

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

/**
 * Opaque execution authority minted only after an adapter has admitted a live
 * operation.  It deliberately has no structural fields a caller can supply.
 */
declare const admittedPermitBrand: unique symbol;
export interface AdmittedPermit {
	readonly [admittedPermitBrand]: 'dbsp-admitted-permit';
}

/** The fixed plan-time material that becomes one ledger claim. */
export interface OutcomeClaimPlan {
	readonly claimId: string;
	/** One actual apply attempt; deliberately distinct from the persisted run id. */
	readonly executionId?: string;
	/** Digest-covered logical position of this claim in the reviewed plan. */
	readonly plannedClaimKey?: string;
	/** The atomic closure identity; a single-address claim uses its root claim id. */
	readonly claimGroupId?: string;
	readonly rootClaimId?: string;
	readonly address: LedgerAddress;
	readonly claimKind: LedgerClaimKind;
	readonly statementBundle: ClaimStatementBundle;
	/**
	 * A creation verifies that its target address remains vacant before DDL.
	 * Absent only on plans written before this material was introduced.
	 */
	readonly requiresVacancy?: boolean;
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
	/** Read exactly once by the adapter in the claiming transaction. */
	/** @deprecated Compatibility input for pre-controller-OID callers. */
	readonly currentUser?: string;
	/** Current role read by the adapter on the locked claiming session. */
	readonly currentController?: ControllerIdentity;
	/** Fresh locked catalogue identity for an existing managed address. */
	readonly liveAddress?: LedgerAddress;
}

/** Typed catalogue evidence used by outcome-protocol recovery. */
export type OutcomeRecoveryEffect = 'applied' | 'no-effect' | 'unverifiable';

export type OutcomeRecoveryReadBack =
	| { readonly kind: 'absent'; readonly effect?: OutcomeRecoveryEffect }
	| {
			readonly kind: 'present';
			readonly catalogueIdentity: CatalogueIdentity;
			/** The canonical shape read from the live catalogue. */
			readonly observed: LedgerPayload;
			/** Operation-specific read-back when the catalogue presence is insufficient. */
			readonly effect?: OutcomeRecoveryEffect;
	  };

/** A failed read is evidence of nothing, and therefore permits no append. */
export interface OutcomeCatalogueUnavailable {
	readonly kind: 'catalogue-unavailable';
	readonly reason: string;
}

export type OutcomeRecoveryCatalogueRead =
	| OutcomeRecoveryReadBack
	| OutcomeCatalogueUnavailable;

/** The catalogue boundary is injected so core has no database dependency. */
export type OutcomeRecoveryCatalogueReader = (
	address: LedgerAddress,
) => Promise<OutcomeRecoveryCatalogueRead>;

/** A recovery append has one canonical predecessor/payload comparison shape. */
export interface OutcomeRecoveryResolution {
	readonly eventKind:
		| 'refused'
		| 'observed'
		| 'absent'
		| 'indeterminate'
		| 'resolved';
	readonly predecessor: string;
	readonly rootClaimId: string;
	readonly reason: string;
	readonly readBack: OutcomeRecoveryReadBack;
	/** Present exactly when recovery closes the open claim as refused. */
	readonly refusal?: LedgerRefusal;
}

export type OutcomeRecoveryClassification =
	| {
			readonly kind: 'outcome-recovery-append';
			readonly address: LedgerAddress;
			readonly resolution: OutcomeRecoveryResolution;
	  }
	| {
			readonly kind: 'outcome-recovery-pending';
			readonly address: LedgerAddress;
			readonly reason: string;
			/** A catalogue failure is a named pre-append refusal, not a retry hint. */
			readonly reasonCode?: 'catalogue-unavailable';
	  }
	| {
			readonly kind: 'outcome-recovery-blocked';
			readonly address: LedgerAddress;
			readonly reason: string;
	  }
	| {
			readonly kind: 'outcome-recovery-no-open-claim';
			readonly address: LedgerAddress;
	  }
	| {
			readonly kind: 'outcome-recovery-malformed-chain';
			readonly address: LedgerAddress;
			readonly reason: string;
	  };

/**
 * Claim-bound evidence required before an interrupted creation or modification
 * can be attributed to DBSP. The adapter reconstructs these values from the
 * durable run, admitted operation and scoped authorization while holding its
 * run and ledger locks; a same-name catalogue object is never this evidence.
 */
export interface OutcomeIndeterminateRecoveryEvidence {
	readonly runId: string;
	readonly planDigest: string;
	readonly executionId: string;
	readonly claimId: string;
	readonly plannedClaimKey?: string;
	/** Digest recorded when the exact admitted statement bundle was minted. */
	readonly admittedBundleDigest: string;
	/** Digest re-read from the persisted operation at resolution time. */
	readonly persistedBundleDigest: string;
	readonly recordedPreState: 'unknown' | 'managed' | 'absent';
	/** Operation-owned read-back verified its declaration/identity postcondition. */
	readonly operationPostcondition: 'verified';
	readonly externalDdlExclusion: {
		readonly planDigest: string;
		readonly address: LedgerAddress;
		readonly trustRoot: string;
	};
}

export interface OutcomeRecoveryInput {
	readonly projection: LedgerChainProjection;
	readonly catalogue: OutcomeRecoveryCatalogueReader;
	/** Accepted with the interrupted run, never inferred from a current policy. */
	readonly acceptedExternalDdlExclusion: boolean;
	/** Required for resolving an indeterminate creation or modification. */
	readonly indeterminateEvidence?: OutcomeIndeterminateRecoveryEvidence;
	/** Only an explicit reconciliation path may close an indeterminate claim. */
	readonly resolveIndeterminate?: boolean;
}
