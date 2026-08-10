import type {
	AdmittedOutcomeClaim,
	DestructiveAction,
	DestructiveAuthorityEvidence,
	DestructiveAuthorityPermit,
	DestructiveDecision,
	OutcomeClaimAdmission,
	OutcomeClaimAdmissionInput,
	OutcomeProtocolRefusal,
} from '@dbsp/types';
import { sameLedgerAddress } from '@dbsp/types';
import { admitOutcomeClaim } from './outcome-protocol.js';

const permits = new WeakMap<object, { readonly closureDigest?: string }>();

function declarationPermits(
	action: DestructiveAction,
	evidence: DestructiveAuthorityEvidence,
): boolean {
	if (action.kind === 'removal')
		return (
			evidence.declaration === 'requires-removal' ||
			(evidence.declaration === 'replacement-requested-by-plan' &&
				evidence.replacementAddress !== undefined &&
				sameLedgerAddress(evidence.replacementAddress, action.address))
		);
	return evidence.declaration === 'requires-lossy-change';
}

function refusalReasons(
	action: DestructiveAction,
	evidence: DestructiveAuthorityEvidence,
): readonly string[] {
	const reasons: string[] = [];
	if (!declarationPermits(action, evidence))
		reasons.push('declaration does not permit this destructive action');
	if (evidence.ownership !== 'managed-by-me')
		reasons.push(`ownership is ${evidence.ownership}`);
	if (evidence.catalogueIdentity !== 'matches-recorded')
		reasons.push(`catalogue identity is ${evidence.catalogueIdentity}`);
	if (evidence.operatorAcceptance !== 'destructive-plan-accepted')
		reasons.push('operator acceptance is absent');
	if (
		action.kind === 'removal' &&
		evidence.containment !== 'all-contained-or-managed'
	)
		reasons.push(
			evidence.containment === 'reaches-unmanaged' &&
				evidence.containmentUnmanaged !== undefined
				? `containment closure is reaches-unmanaged: ${evidence.containmentUnmanaged.kind} ${evidence.containmentUnmanaged.schema ?? '<database>'}.${evidence.containmentUnmanaged.name}`
				: evidence.containment === 'undecidable' &&
						evidence.containmentReason !== undefined
					? `containment closure is undecidable: ${evidence.containmentReason}`
					: `containment closure is ${evidence.containment ?? 'undecidable'}`,
		);
	if (evidence.ledgerLineage !== 'matches-database')
		reasons.push(`ledger lineage is ${evidence.ledgerLineage}`);
	return reasons;
}

/**
 * The total destructive classifier produces a decision for every evidence
 * tuple; only its permitting cells produce positive destructive authority.
 */
export function decideDestructiveDecision(
	action: DestructiveAction,
	evidence: DestructiveAuthorityEvidence,
): DestructiveDecision {
	const reasons = refusalReasons(action, evidence);
	if (reasons.length > 0)
		return { kind: 'destructive-decision-refused', action, reasons };
	const permit = Object.freeze({}) as DestructiveAuthorityPermit;
	permits.set(
		permit,
		action.kind === 'removal' && action.closureDigest !== undefined
			? { closureDigest: action.closureDigest }
			: {},
	);
	return { kind: 'destructive-decision-permitted', action, permit };
}

/** Runtime defense for the erased opaque type at adapter boundaries. */
export function isDestructiveAuthorityPermit(
	permit: DestructiveAuthorityPermit,
): boolean {
	return permits.has(permit);
}

/** The adapter compares this immutable admission set after taking its locks. */
export function closureDigestForDestructiveAuthorityPermit(
	permit: DestructiveAuthorityPermit,
): string | undefined {
	return permits.get(permit)?.closureDigest;
}

/**
 * Couples the positive authority result to the existing single token producer.
 * The adapter's destructive emitter accepts this value, never raw evidence.
 */
export type AdmittedDestructiveOutcomeClaim = AdmittedOutcomeClaim & {
	readonly destructivePermit: DestructiveAuthorityPermit;
};

export function admitDestructiveOutcomeClaim(input: {
	readonly decision: Extract<
		DestructiveDecision,
		{ readonly kind: 'destructive-decision-permitted' }
	>;
	readonly admission: OutcomeClaimAdmissionInput;
}):
	| AdmittedDestructiveOutcomeClaim
	| Exclude<OutcomeClaimAdmission, AdmittedOutcomeClaim> {
	if (!isDestructiveAuthorityPermit(input.decision.permit)) {
		return {
			kind: 'outcome-protocol-refused',
			reason: 'destructive authority permit was not minted by the interpreter',
		};
	}
	if (
		!sameLedgerAddress(
			input.decision.action.address,
			input.admission.plan.address,
		)
	) {
		return {
			kind: 'outcome-protocol-refused',
			reason: 'destructive authority address does not match the claim address',
		};
	}
	const admitted = admitOutcomeClaim(input.admission);
	if (admitted.kind !== 'admitted-outcome-claim') return admitted;
	return { ...admitted, destructivePermit: input.decision.permit };
}

/** Attach a real interpreter permit to an adapter-opened, already minted claim. */
export function attachDestructiveAuthorityPermit(input: {
	readonly decision: Extract<
		DestructiveDecision,
		{ readonly kind: 'destructive-decision-permitted' }
	>;
	readonly claim: AdmittedOutcomeClaim;
}): AdmittedDestructiveOutcomeClaim | OutcomeProtocolRefusal {
	if (!isDestructiveAuthorityPermit(input.decision.permit))
		return {
			kind: 'outcome-protocol-refused',
			reason: 'destructive authority permit was not minted by the interpreter',
		};
	if (
		!sameLedgerAddress(input.decision.action.address, input.claim.plan.address)
	)
		return {
			kind: 'outcome-protocol-refused',
			reason: 'destructive authority address does not match the claim address',
		};
	return { ...input.claim, destructivePermit: input.decision.permit };
}
