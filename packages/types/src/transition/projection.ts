import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerClaimKind,
	LedgerEventKind,
	LedgerHome,
	LedgerPayload,
} from './ledger.js';

/** The only durable management states an address can have. */
export type LedgerStableState = 'unknown' | 'managed' | 'absent';

/** A claim is open until its own grammar column closes it. */
export interface LedgerOpenClaim {
	readonly event: LedgerChainMember;
	readonly kind: LedgerClaimKind;
	readonly stableStateBeforeClaim: LedgerStableState;
	readonly phase: 'claimed' | 'executing' | 'indeterminate';
}

/** What readers present: stable state plus any still-open claim. */
export type LedgerReportedState =
	| { readonly kind: LedgerStableState }
	| {
			readonly kind: 'pending';
			readonly stableState: LedgerStableState;
			readonly claim: LedgerOpenClaim;
	  }
	| {
			readonly kind: 'blocked';
			readonly stableState: LedgerStableState;
			readonly claim: LedgerOpenClaim;
	  };

/** The legal lifecycle grammar is deliberately a closed, per-claim matrix. */
export interface LedgerLifecycleGrammarColumn {
	readonly claimKind: LedgerClaimKind;
	readonly opensFrom: readonly LedgerStableState[];
	readonly resolvesThrough: readonly LedgerEventKind[];
}

export interface ProjectedLedgerChain {
	readonly kind: 'projected-ledger-chain';
	readonly ledger: LedgerHome;
	readonly address: LedgerAddress;
	readonly events: readonly LedgerChainMember[];
	readonly stableState: LedgerStableState;
	readonly openClaim?: LedgerOpenClaim;
	readonly reportedState: LedgerReportedState;
	/** The last declaration fact recorded by a claim chain, if any. */
	readonly declaration?: LedgerPayload;
	/** The last read-back recorded by a claim chain, if any. */
	readonly observation?: LedgerPayload;
}

export type UnprojectableChainReason =
	| { readonly code: 'cycle'; readonly eventIds: readonly string[] }
	| {
			readonly code: 'missing-predecessor';
			readonly eventId: string;
			readonly predecessor: string;
	  }
	| {
			readonly code: 'fork';
			readonly predecessor?: string;
			readonly eventIds: readonly string[];
	  }
	| {
			readonly code: 'unknown-event-kind';
			readonly eventId: string;
			readonly eventKind: string;
	  }
	| { readonly code: 'address-mismatch'; readonly eventId: string }
	| { readonly code: 'duplicate-event-id'; readonly eventId: string }
	| {
			readonly code: 'invalid-lifecycle-edge';
			readonly eventId: string;
			readonly detail: string;
	  };

/**
 * A degraded read is data, not an exception. Its required reason lets every
 * mutation fail closed while inspect-like readers can still display the chain.
 */
export interface UnprojectableLedgerChain {
	readonly kind: 'unprojectable-ledger-chain';
	readonly ledger: LedgerHome;
	readonly address: LedgerAddress;
	readonly events: readonly LedgerChainMember[];
	readonly reason: UnprojectableChainReason;
	readonly codeVersion: 1;
}

export type LedgerChainProjection =
	| ProjectedLedgerChain
	| UnprojectableLedgerChain;
