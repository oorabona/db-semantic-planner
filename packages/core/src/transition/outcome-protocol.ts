import type {
	ClaimBundleStatement,
	ClaimStatementBundle,
	ClaimToken,
	OutcomeClaimAdmission,
	OutcomeClaimAdmissionInput,
	OutcomeClaimPlan,
	OutcomeProtocolRefusal,
} from '@dbsp/types';
import { LEDGER_LIFECYCLE_GRAMMAR } from './lifecycle-interpreter.js';

interface ClaimTokenRecord {
	readonly claimId: string;
	readonly bundle: ClaimStatementBundle;
	consumed: boolean;
}

const tokenRecords = new WeakMap<object, ClaimTokenRecord>();

function refusal(reason: string): OutcomeProtocolRefusal {
	return { kind: 'outcome-protocol-refused', reason };
}

function sameAddress(
	left: OutcomeClaimPlan['address'],
	right: OutcomeClaimPlan['address'],
): boolean {
	return (
		left.scope === right.scope &&
		left.engine === right.engine &&
		left.database === right.database &&
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.name === right.name &&
		JSON.stringify(left.parent ?? null) === JSON.stringify(right.parent ?? null)
	);
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
	if (!sameAddress(plan.address, projection.address))
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
