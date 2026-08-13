import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
	const lockSession = { query: vi.fn() };
	const recovery = vi.fn();
	return { lockSession, recovery };
});

vi.mock('@dbsp/adapter-pgsql', () => ({
	assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid: vi.fn(),
	assertPgDatabaseWritable: vi.fn(),
	escapeDiagnosticText: (value: string) => value,
	isPgDatabaseReadOnlyError: vi.fn(() => false),
	readPgLedgerAddressChain: vi.fn(async () => []),
	readPgLedgerReservationsForExecution: vi.fn(
		async (_session, _home, executionId) =>
			executionId === 'dbsp.generator.execution.run:generator'
				? [
						{
							address: {
								scope: 'schema',
								engine: 'postgresql',
								database: 'app',
								schema: 'tenant',
								kind: 'table',
								name: 'interrupted_generator',
							},
							claimKind: 'retire-intent',
							executionId: 'dbsp.generator.execution.run:generator',
							rootClaimId: 'claim:generator',
							homeLedger: { scope: 'schema', schema: 'tenant' },
						},
					]
				: [],
	),
	readPgLedgerScopeCurrency: vi.fn(async () => ({ kind: 'current' })),
	readTransitionJournal: vi.fn(async () => ({
		run: { runId: 'run:generator', planDigest: 'digest:generator' },
		plan: {
			generator: {},
			steps: [
				{
					managedClaim: {
						plannedClaimKey: 'generator:0',
						address: {
							scope: 'schema',
							engine: 'postgresql',
							database: 'app',
							schema: 'tenant',
							kind: 'table',
							name: 'interrupted_generator',
						},
						statementBundle: { statements: [] },
					},
					guards: [],
					restsOnAssumptions: [],
				},
			],
		},
		events: [],
	})),
	readVerifiedPgLedgerReservationsForPair: vi.fn(),
	recoverPgReaddressPair: vi.fn(),
	withPgTransitionRunLock: vi.fn(async (_pool, _runId, callback) => ({
		kind: 'acquired',
		value: await callback({}),
	})),
}));

vi.mock('@dbsp/adapter-pgsql/internal', () => ({
	recoverPgOutcomeClaim: fixture.recovery,
}));

vi.mock('@dbsp/core', () => ({
	acquireExclusiveTransitionLease: vi.fn(async () => ({
		session: fixture.lockSession,
		release: vi.fn(),
	})),
	assumptionAccepted: vi.fn(),
	outcomeClaimId: vi.fn(),
	projectLedgerChain: vi.fn(() => ({
		kind: 'projected-ledger-chain',
		openClaim: {
			event: {
				eventId: 'claim:generator',
				executionId: 'dbsp.generator.execution.run:generator',
				rootClaimId: 'claim:generator',
				plannedClaimKey: 'generator:0',
			},
			stableStateBeforeClaim: 'managed',
		},
	})),
	resourceScopeCovers: vi.fn(),
	transitionPlanDigest: vi.fn(() => 'digest:generator'),
}));

import { classifyReconcileFailure, runReconcile } from './reconcile.js';

describe('reconcile durable outcome ordering', () => {
	it.each([
		['authentication', { code: '28P01' }, 'reconcile'],
		['transport', { code: '08006' }, 'reconcile'],
		['malformed-journal', new Error('opaque'), 'journal'],
		['catalogue', new Error('opaque'), 'catalogue'],
	] as const)('OBL-REC3 keeps the %s cause distinct', (cause, error, stage) => {
		expect(classifyReconcileFailure(error, stage)).toBe(cause);
	});
	it('commits an interrupted generator refusal through the pool-owned outcome session', async () => {
		fixture.recovery.mockResolvedValue({
			kind: 'outcome-recovery-appended',
			classification: {
				resolution: { reason: 'interrupted generator claim refused' },
			},
			append: { kind: 'appended-outcome-resolution' },
		});
		const pool = { connect: vi.fn() };

		await expect(
			runReconcile(
				'run:generator',
				{ db: 'postgres://fixture' },
				pool as never,
			),
		).resolves.toMatchObject({ outcome: 'reconcile-completed' });

		expect(fixture.recovery).toHaveBeenCalledWith(
			pool,
			expect.objectContaining({
				resolutionEventId: 'claim:generator:reconcile:run:generator',
			}),
		);
	});
});
