import type {
	LedgerAddress,
	LedgerChainMember,
	OutcomeClaimPlan,
	SqlBearingOutcomeClaimPlan,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { projectLedgerChain } from './lifecycle-interpreter.js';
import {
	admitOutcomeClaim,
	consumeClaimToken,
	findUniqueLedgerTerminal,
	outcomeClaimId,
} from './outcome-protocol.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

const ledger = { scope: 'schema', schema: 'tenant' } as const;

function event(
	eventId: string,
	eventKind: LedgerChainMember['eventKind'],
	predecessor?: string,
): LedgerChainMember {
	return {
		eventId,
		address,
		eventKind,
		...(predecessor === undefined ? {} : { predecessor }),
		controller: 'deployment',
	};
}

function plan(
	claimId = 'claim-1',
	claimKind: OutcomeClaimPlan['claimKind'] = 'intent',
): SqlBearingOutcomeClaimPlan {
	return {
		claimId,
		claimSpecies: 'sql-bearing',
		address,
		claimKind,
		statementBundle: {
			statements: [{ ordinal: 0, sql: 'CREATE TABLE accounts (id integer)' }],
		},
	};
}

function admit(
	value: OutcomeClaimPlan = plan(),
	events: readonly LedgerChainMember[] = [],
) {
	return admitOutcomeClaim({
		plan: value,
		projection: projectLedgerChain({ ledger, address, events }),
		...(events.length > 0
			? {
					currentUser: 'deployment',
					liveAddress: {
						...address,
						catalogueIdentity: {
							engine: 'postgresql',
							format: 1,
							value: { oid: '42' },
						},
					},
				}
			: {}),
	});
}

describe('outcome claim admission (SC-30, SC-42)', () => {
	it('selects exactly one terminal with one predecessor-set pass', () => {
		expect(
			findUniqueLedgerTerminal([
				event('root', 'intent'),
				event('terminal', 'observed', 'root'),
			]),
		).toMatchObject({ eventId: 'terminal' });
		expect(
			findUniqueLedgerTerminal([
				event('left', 'intent'),
				event('right', 'intent'),
			]),
		).toBeUndefined();
	});

	it('uses the lifecycle grammar rather than re-spelling its legal opening states', () => {
		const managed = [
			event('adopt-intent', 'adopt-intent'),
			{
				...event('adopt', 'adopt', 'adopt-intent'),
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '42' },
				},
				observed: { value: { table: 'accounts' }, digest: 'observed' },
			},
		];
		expect(admit(plan('create'), []).kind).toBe('admitted-outcome-claim');
		expect(admit(plan('modify'), managed).kind).toBe('admitted-outcome-claim');
		expect(admit(plan('retire', 'retire-intent'), [])).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'retire-intent cannot open from stable state unknown',
		});
		expect(admit(plan('adopt', 'adopt-intent'), managed)).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'adopt-intent cannot open from stable state managed',
		});
	});

	it('scopes repeated lifecycles to execution and extends the address chain', () => {
		const first = outcomeClaimId('execution-1', 'step:0/root', address);
		const second = outcomeClaimId('execution-2', 'step:0/root', address);
		expect(second).not.toBe(first);
		const managed = [
			event(first, 'intent'),
			{
				...event('first-observed', 'observed', first),
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '42' },
				},
				observed: { value: { table: 'accounts' }, digest: 'first' },
			},
		];
		const admitted = admit(plan(second), managed);
		if (admitted.kind === 'outcome-protocol-refused')
			throw new Error(admitted.reason);
		expect(admitted).toMatchObject({
			kind: 'admitted-outcome-claim',
			plan: { claimId: second },
		});
	});

	it('refuses a malformed or already-open chain before minting a token', () => {
		expect(admit(plan(), [event('one', 'intent', 'missing')])).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'claim claim-1 refuses malformed ledger chain: missing-predecessor',
		});
		expect(admit(plan(), [event('other', 'intent')])).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'claim claim-1 refuses open claim other',
		});
	});

	it('binds the fixed bundle to one claim token and consumes it exactly once', () => {
		const first = admit(plan('first'));
		const second = admit(plan('second'));
		expect(first.kind).toBe('admitted-outcome-claim');
		expect(second.kind).toBe('admitted-outcome-claim');
		if (
			first.kind !== 'admitted-outcome-claim' ||
			second.kind !== 'admitted-outcome-claim'
		)
			return;
		expect(
			consumeClaimToken(
				first.token,
				second.plan.claimId,
				second.plan.statementBundle.statements,
			),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'claim token belongs to claim first, not second',
		});
		expect(
			consumeClaimToken(first.token, first.plan.claimId, [
				{ ordinal: 0, sql: 'DROP TABLE accounts' },
			]),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: "statements are outside claim first's recorded bundle",
		});
		expect(
			consumeClaimToken(
				first.token,
				first.plan.claimId,
				first.plan.statementBundle.statements,
			),
		).toMatchObject({ statements: first.plan.statementBundle.statements });
		expect(
			consumeClaimToken(
				first.token,
				first.plan.claimId,
				first.plan.statementBundle.statements,
			),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'claim token for claim first has already been consumed',
		});
	});

	it('refuses a hollow sql-bearing claim and malformed SQL bundle', () => {
		expect(
			admit({ ...plan(), statementBundle: { statements: [] } }),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'claim claim-1 has an empty statement bundle',
		});
		expect(
			admit({
				...plan(),
				statementBundle: {
					statements: [{ ordinal: 2, sql: 'CREATE TABLE x ()' }],
				},
			}),
		).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason: 'claim claim-1 has an invalid statement bundle at ordinal 0',
		});
	});

	it('refuses SQL carried by a cascade-covered claim by name', () => {
		const cascadeWithSql = {
			...plan('covered-member'),
			claimSpecies: 'cascade-covered',
			rootClaimId: 'destructive-root',
			statementBundle: {
				statements: [{ ordinal: 0, sql: 'DROP TABLE accounts' }],
			},
		} as unknown as OutcomeClaimPlan;
		expect(admit(cascadeWithSql)).toMatchObject({
			kind: 'outcome-protocol-refused',
			reason:
				'cascade-covered claim covered-member has a non-empty statement bundle',
		});
	});
});
