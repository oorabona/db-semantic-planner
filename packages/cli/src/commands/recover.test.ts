import type { ApplyResult, TransitionRunJournal } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { authorizationDigest } from './apply.js';
import {
	exitCodeForRecoverOutcome,
	outcomeForRecoveryResult,
	RECOVER_OUTCOME_CONTRACT,
	recoveryPolicyForJournal,
	runRecover,
	validateRecoveryAuthorization,
} from './recover.js';

describe('dbsp recover contract', () => {
	it('mutation: recovering without the external review anchor opens a database connection', async () => {
		await expect(
			runRecover('run-reviewed', { db: 'postgres://must-not-connect' }),
		).resolves.toEqual({
			outcome: 'plan-digest-required',
			runId: 'run-reviewed',
		});
	});

	it('mutation: treating a completed recovery as proven-applicable exits non-zero', () => {
		const result = {
			assessment: {
				decision: 'applicable',
				assurance: 'established',
				lifecycle: 'completed',
				continuation: 'none',
				reasons: [],
			},
			journals: [],
			observations: [],
		} satisfies ApplyResult;
		const outcome = outcomeForRecoveryResult(result);
		expect(outcome).toBe('completed');
		expect(exitCodeForRecoverOutcome(outcome)).toBe(0);
	});

	it('mutation: collapsing recovery failures onto exit 1 loses automation-safe classification', () => {
		const codes = RECOVER_OUTCOME_CONTRACT.map(([, code]) => code);
		expect(new Set(codes).size).toBe(codes.length);
		for (const [outcome, code] of RECOVER_OUTCOME_CONTRACT)
			expect(exitCodeForRecoverOutcome(outcome)).toBe(code);
	});

	it('mutation: treating attempted events without a durable authorization as legitimate recovery invents approval', () => {
		const journal = {
			run: { runId: 'run-1', planDigest: 'wrong' },
			plan: { assumptions: [], steps: [] },
			events: [{ event: 'intent' }],
			authorizations: [],
		} as unknown as TransitionRunJournal & {
			readonly plan: import('@dbsp/types').ProvenPlanShape;
		};
		// The intentionally bad digest is repaired below only to keep this test
		// focused on authorization; the structural validator still protects input.
		const result = validateRecoveryAuthorization(journal);
		expect(result).toEqual({
			ok: false,
			outcome: 'recovery-authorization-missing',
		});
	});

	it('mutation: dereferencing a malformed assumption before validation crashes recovery', () => {
		const journal = {
			run: { runId: 'run-1', planDigest: 'not-a-real-digest' },
			plan: { assumptions: [null], steps: [] },
			events: [],
		} as unknown as TransitionRunJournal & {
			readonly plan: import('@dbsp/types').ProvenPlanShape;
		};
		expect(() => recoveryPolicyForJournal(journal, 'run-1')).not.toThrow();
		expect(recoveryPolicyForJournal(journal, 'run-1')).toMatchObject({
			ok: false,
			outcome: 'recovery-plan-invalid',
		});
	});

	it('mutation: validating an authorization as policy-only accepts a record replayed onto another run', () => {
		const policy = [] as const;
		const record = {
			runId: 'run-minted',
			policy,
			grants: [],
			digest: authorizationDigest(
				'run-minted',
				'plan-digest',
				policy,
				[],
				'operator',
				'2026-07-29T00:00:00.000Z',
			),
			actor: 'operator',
			authorizedAt: '2026-07-29T00:00:00.000Z',
		};
		const journal = {
			run: { runId: 'run-presented', planDigest: 'plan-digest' },
			plan: { assumptions: [], steps: [] },
			events: [{ event: 'intent' }],
			authorizations: [record],
		} as unknown as TransitionRunJournal & {
			readonly plan: import('@dbsp/types').ProvenPlanShape;
		};
		expect(validateRecoveryAuthorization(journal)).toEqual({
			ok: false,
			outcome: 'recovery-authorization-invalid',
		});
	});

	it('mutation: leaving actor or authorization time outside the digest permits a rewritten approval receipt', () => {
		const policy = [] as const;
		const journal = {
			run: { runId: 'run-presented', planDigest: 'plan-digest' },
			plan: { assumptions: [], steps: [] },
			events: [{ event: 'intent' }],
			authorizations: [
				{
					runId: 'run-presented',
					policy,
					grants: [],
					digest: authorizationDigest(
						'run-presented',
						'plan-digest',
						policy,
						[],
						'approved-operator',
						'2026-07-29T00:00:00.000Z',
					),
					actor: 'rewritten-operator',
					authorizedAt: '2026-07-30T00:00:00.000Z',
				},
			],
		} as unknown as TransitionRunJournal & {
			readonly plan: import('@dbsp/types').ProvenPlanShape;
		};
		expect(validateRecoveryAuthorization(journal)).toEqual({
			ok: false,
			outcome: 'recovery-authorization-invalid',
		});
	});

	it('accepts an authorization when a PostgreSQL parser spells its timestamp instant differently', () => {
		const policy = [] as const;
		const journal = {
			run: { runId: 'run-presented', planDigest: 'plan-digest' },
			plan: { assumptions: [], steps: [] },
			events: [{ event: 'intent' }],
			authorizations: [
				{
					runId: 'run-presented',
					policy,
					grants: [],
					digest: authorizationDigest(
						'run-presented',
						'plan-digest',
						policy,
						[],
						'operator',
						'2026-07-29T00:00:00.000Z',
					),
					actor: 'operator',
					authorizedAt: '2026-07-29 00:00:00+00',
				},
			],
		} as unknown as TransitionRunJournal & {
			readonly plan: import('@dbsp/types').ProvenPlanShape;
		};

		expect(validateRecoveryAuthorization(journal)).toEqual({
			ok: true,
			policy: { accepts: [] },
		});
	});
});
