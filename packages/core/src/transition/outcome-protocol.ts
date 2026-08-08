import { createHash } from 'node:crypto';
import type {
	ClaimBundleStatement,
	ClaimStatementBundle,
	ClaimToken,
	LedgerAddress,
	LedgerChainMember,
	OutcomeClaimAdmission,
	OutcomeClaimAdmissionInput,
	OutcomeClaimPlan,
	OutcomeProtocolRefusal,
	OutcomeRecoveryClassification,
	OutcomeRecoveryInput,
	OutcomeRecoveryReadBack,
} from '@dbsp/types';
import { sameLedgerAddress } from '@dbsp/types';
import { LEDGER_LIFECYCLE_GRAMMAR } from './lifecycle-interpreter.js';
import { stableJson } from './stable-json.js';

interface ClaimTokenRecord {
	readonly claimId: string;
	readonly bundle: ClaimStatementBundle;
	consumed: boolean;
}

const tokenRecords = new WeakMap<object, ClaimTokenRecord>();

/**
 * The sole durable identity builder for a managed outcome claim.  An outcome
 * chain is per canonical ledger address, so the address — rather than a
 * rendered operation object — is its stable root.  Hashing the canonical
 * representation keeps the persisted identifier opaque, compact, and free of
 * serializer type tags.
 */
export function outcomeClaimId(address: LedgerAddress): string {
	return `dbsp.transition.outcome.${createHash('sha256')
		.update(stableJson(address))
		.digest('hex')}`;
}

function refusal(reason: string): OutcomeProtocolRefusal {
	return { kind: 'outcome-protocol-refused', reason };
}

function bundleRefusal(
	plan: OutcomeClaimPlan,
): OutcomeProtocolRefusal | undefined {
	const statements = plan.statementBundle.statements;
	if (statements.length === 0 && plan.claimKind !== 'adopt-intent')
		return refusal(`claim ${plan.claimId} has an empty statement bundle`);
	for (let index = 0; index < statements.length; index += 1) {
		const statement = statements[index];
		if (!statement || statement.ordinal !== index || statement.sql.length === 0)
			return refusal(
				`claim ${plan.claimId} has an invalid statement bundle at ordinal ${index}`,
			);
	}
	return undefined;
}

function fixedBundle(bundle: ClaimStatementBundle): ClaimStatementBundle {
	return Object.freeze({
		statements: Object.freeze(
			bundle.statements.map((statement) =>
				Object.freeze({ ordinal: statement.ordinal, sql: statement.sql }),
			),
		),
	});
}

/**
 * The sole token producer. The WeakMap makes a token opaque at runtime as well
 * as in its public type, and records its single-use state independently of a
 * transaction boundary.
 */
export function mintClaimToken(plan: OutcomeClaimPlan): ClaimToken {
	const token = Object.freeze({}) as ClaimToken;
	tokenRecords.set(token, {
		claimId: plan.claimId,
		bundle: fixedBundle(plan.statementBundle),
		consumed: false,
	});
	return token;
}

/**
 * Reads the claim identity of a core-minted capability without exposing its
 * bundle or giving callers a way to mint one.
 */
export function claimIdForToken(token: ClaimToken): string | undefined {
	return tokenRecords.get(token)?.claimId;
}

/**
 * Consumes exactly one planned statement. The PostgreSQL execution sink calls
 * this immediately before it sends SQL, after it has verified the claim is
 * still open in the ledger.
 */
export function consumeClaimToken(
	token: ClaimToken,
	claimId: string,
	statements: readonly ClaimBundleStatement[],
): ClaimStatementBundle | OutcomeProtocolRefusal {
	const record = tokenRecords.get(token);
	if (!record) return refusal('claim token was not minted by claim admission');
	if (record.claimId !== claimId)
		return refusal(
			`claim token belongs to claim ${record.claimId}, not ${claimId}`,
		);
	if (record.consumed)
		return refusal(
			`claim token for claim ${claimId} has already been consumed`,
		);
	if (
		statements.length !== record.bundle.statements.length ||
		statements.some((statement, index) => {
			const expected = record.bundle.statements[index];
			return (
				expected === undefined ||
				expected.ordinal !== statement.ordinal ||
				expected.sql !== statement.sql
			);
		})
	)
		return refusal(`statements are outside claim ${claimId}'s recorded bundle`);
	record.consumed = true;
	return record.bundle;
}

/**
 * Admits an open claim from the one lifecycle grammar, and mints the execution
 * token only after the chain and plan-time bundle have both passed.
 */
export function admitOutcomeClaim(
	input: OutcomeClaimAdmissionInput,
): OutcomeClaimAdmission {
	const { plan, projection } = input;
	const bundleError = bundleRefusal(plan);
	if (bundleError) return bundleError;
	if (projection.kind !== 'projected-ledger-chain')
		return refusal(
			`claim ${plan.claimId} refuses malformed ledger chain: ${projection.reason.code}`,
		);
	if (!sameLedgerAddress(plan.address, projection.address))
		return refusal(
			`claim ${plan.claimId} address does not match its ledger chain`,
		);
	if (projection.openClaim !== undefined)
		return refusal(
			`claim ${plan.claimId} refuses open claim ${projection.openClaim.event.eventId}`,
		);
	const column = LEDGER_LIFECYCLE_GRAMMAR[plan.claimKind];
	if (!column.opensFrom.includes(projection.stableState))
		return refusal(
			`${plan.claimKind} cannot open from stable state ${projection.stableState}`,
		);
	return {
		kind: 'admitted-outcome-claim',
		plan,
		stableStateBeforeClaim: projection.stableState,
		token: mintClaimToken(plan),
	};
}

function recoveryPending(
	input: OutcomeRecoveryInput,
	reason: string,
): OutcomeRecoveryClassification {
	return {
		kind: 'outcome-recovery-pending',
		address: input.projection.address,
		reason,
	};
}

function terminalMember(
	events: readonly LedgerChainMember[],
): LedgerChainMember | undefined {
	const predecessors = new Set(
		events
			.map((event) => event.predecessor)
			.filter(
				(predecessor): predecessor is string => predecessor !== undefined,
			),
	);
	const terminal = events.filter((event) => !predecessors.has(event.eventId));
	return terminal.length === 1 ? terminal[0] : undefined;
}

function appendRecovery(
	input: OutcomeRecoveryInput,
	readBack: OutcomeRecoveryReadBack,
	eventKind: 'refused' | 'observed' | 'absent' | 'indeterminate' | 'resolved',
	reason: string,
): OutcomeRecoveryClassification {
	const projection = input.projection;
	if (projection.kind !== 'projected-ledger-chain')
		return {
			kind: 'outcome-recovery-malformed-chain',
			address: projection.address,
			reason: projection.reason.code,
		};
	const claim = projection.openClaim;
	const predecessor = terminalMember(projection.events);
	if (!claim || !predecessor)
		return recoveryPending(
			input,
			'recovery could not identify the open claim terminal',
		);
	return {
		kind: 'outcome-recovery-append',
		address: projection.address,
		resolution: {
			eventKind,
			predecessor: predecessor.eventId,
			rootClaimId: claim.event.eventId,
			reason,
			readBack,
		},
	};
}

/**
 * Classifies one open outcome-protocol claim from a fresh catalogue read.
 * It never issues DDL; its only mutation instruction is an append for the
 * adapter to perform after the read has completed.  Calling this once per
 * address deliberately keeps interrupted closures independently recoverable.
 */
export async function classifyOutcomeRecovery(
	input: OutcomeRecoveryInput,
): Promise<OutcomeRecoveryClassification> {
	const projection = input.projection;
	if (projection.kind !== 'projected-ledger-chain')
		return {
			kind: 'outcome-recovery-malformed-chain',
			address: projection.address,
			reason: projection.reason.code,
		};
	if (projection.openClaim === undefined)
		return {
			kind: 'outcome-recovery-no-open-claim',
			address: projection.address,
		};

	// This is intentionally before every recovery append decision. A failed
	// read remains a pending claim, including a claim that has not reached DDL.
	const readBack = await input.catalogue(projection.address);
	if (readBack.kind === 'catalogue-unavailable')
		return recoveryPending(input, readBack.reason);

	const claim = projection.openClaim;
	if (claim.phase === 'indeterminate') {
		if (!input.resolveIndeterminate)
			return {
				kind: 'outcome-recovery-blocked',
				address: projection.address,
				reason:
					'indeterminate claim remains blocked until resolved with a read-back',
			};
		if (claim.kind === 'intent') {
			if (readBack.kind === 'present')
				return appendRecovery(
					input,
					readBack,
					'resolved',
					'resolved intent is supported by the catalogue read-back',
				);
			if (claim.stableStateBeforeClaim !== 'managed')
				return appendRecovery(
					input,
					readBack,
					'resolved',
					'resolved intent absence is supported by the catalogue read-back',
				);
			return {
				kind: 'outcome-recovery-blocked',
				address: projection.address,
				reason:
					'catalogue absence cannot resolve an indeterminate modify intent to managed',
			};
		}
		if (claim.kind === 'retire-intent')
			return appendRecovery(
				input,
				readBack,
				'resolved',
				readBack.kind === 'absent'
					? 'resolved retirement absence is supported by the catalogue read-back'
					: 'resolved retirement is supported by the catalogue read-back',
			);
		return {
			kind: 'outcome-recovery-blocked',
			address: projection.address,
			reason: `indeterminate ${claim.kind} has no resolved grammar column`,
		};
	}

	if (claim.phase === 'claimed')
		return appendRecovery(
			input,
			readBack,
			'refused',
			'recovery read live state before refusing a claim that never reached executing',
		);

	if (claim.kind === 'intent') {
		// A managed alteration can keep its catalogue object while doing nothing.
		// When the operation's own postcondition observation proves its expected
		// before-state, that is stronger than generic catalogue presence.
		if (readBack.effect === 'no-effect')
			return appendRecovery(
				input,
				readBack,
				'refused',
				'recovery operation read-back proves no effect after executing',
			);
		if (readBack.effect === 'unverifiable')
			return appendRecovery(
				input,
				readBack,
				'indeterminate',
				'recovery operation read-back cannot verify effect after executing',
			);
		if (readBack.kind === 'absent')
			return appendRecovery(
				input,
				readBack,
				'refused',
				'recovery read-back proves no effect after executing',
			);
		if (
			claim.stableStateBeforeClaim !== 'managed' &&
			!input.acceptedExternalDdlExclusion
		)
			return appendRecovery(
				input,
				readBack,
				'indeterminate',
				'create read-back requires the run accepted external-ddl-exclusion',
			);
		return appendRecovery(
			input,
			readBack,
			'observed',
			'recovery observed the live catalogue read-back after executing',
		);
	}
	if (claim.kind === 'retire-intent')
		return appendRecovery(
			input,
			readBack,
			readBack.kind === 'absent' ? 'absent' : 'indeterminate',
			readBack.kind === 'absent'
				? 'recovery observed retirement absence after executing'
				: 'retirement remains indeterminate because the catalogue object is present',
		);

	// Readdress and adopt never have an executing edge in their own grammar.
	return recoveryPending(
		input,
		`executing ${claim.kind} is not a recoverable lifecycle edge`,
	);
}
