import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
	const lockSession = { query: vi.fn() };
	const recovery = vi.fn();
	const writability = vi.fn();
	const readOnly = vi.fn(() => false);
	const reservations = vi.fn(async (executionId: string) =>
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
	);
	const currency = vi.fn(async () => ({ kind: 'current' }));
	const chain = vi.fn(async () => []);
	return {
		lockSession,
		recovery,
		writability,
		readOnly,
		reservations,
		currency,
		chain,
	};
});

vi.mock('@dbsp/adapter-pgsql', () => ({
	assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid: vi.fn(),
	assertPgDatabaseWritable: fixture.writability,
	escapeDiagnosticText: (value: string) => value,
	isPgDatabaseReadOnlyError: fixture.readOnly,
	readPgLedgerAddressChain: fixture.chain,
	readPgLedgerReservationsForExecution: vi.fn(
		async (_session, _home, executionId) => fixture.reservations(executionId),
	),
	readPgLedgerScopeCurrency: fixture.currency,
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
		events: [
			{
				event: 'intent',
				record: {
					executionId: 'dbsp.generator.execution.run:generator',
				},
			} as never,
		],
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
	acquireTransitionTargetLease: vi.fn(async () => ({
		session: fixture.lockSession,
		release: vi.fn(),
	})),
	assumptionAccepted: vi.fn(),
	loadVerifiedRecoveryJournal: vi.fn(async () => ({
		ok: true,
		journal: {
			run: { runId: 'run:generator', planDigest: 'digest:generator' },
			plan: { steps: [], assumptions: [] },
			events: [],
		},
	})),
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

import {
	classifyReconcileFailure,
	executionIdsForRun,
	runReconcile,
	unresolvedRecoveryDetail,
} from './reconcile.js';

describe('reconcile durable outcome ordering', () => {
	function resetFixture(): void {
		fixture.recovery.mockReset();
		fixture.writability.mockReset();
		fixture.readOnly.mockReset();
		fixture.readOnly.mockReturnValue(false);
		fixture.reservations.mockClear();
		fixture.currency.mockReset();
		fixture.currency.mockResolvedValue({ kind: 'current' });
		fixture.chain.mockReset();
		fixture.chain.mockResolvedValue([]);
	}

	it.each([
		['authentication', { code: '28P01' }, 'reconcile'],
		['transport', { code: '08006' }, 'reconcile'],
		['malformed-journal', new Error('opaque'), 'journal'],
		['catalogue', new Error('opaque'), 'catalogue'],
	] as const)('OBL-REC3 keeps the %s cause distinct', (cause, error, stage) => {
		expect(classifyReconcileFailure(error, stage)).toBe(cause);
	});

	it.each([
		'transport-ambiguous',
		'no-open-claim',
	] as const)('never treats %s as completed recovery', (outcome) => {
		expect(
			unresolvedRecoveryDetail([
				{
					address: {
						scope: 'schema',
						engine: 'postgresql',
						database: 'app',
						schema: 'tenant',
						kind: 'table',
						name: 'accounts',
					},
					outcome,
				},
			]),
		).toContain(outcome);
	});

	it('keeps documented generator scopes and adds every durable attempt', () => {
		const executionId = 'dbsp.generator.execution.attempt-2';
		expect(
			executionIdsForRun({
				run: { runId: 'run:generator', planDigest: 'digest:generator' },
				plan: { generator: {}, steps: [] },
				events: [
					{
						event: 'intent',
						record: { executionId },
					} as never,
				],
			} as never),
		).toEqual([
			'run:generator',
			executionId,
			'dbsp.generator.execution.run:generator',
		]);
	});
	it('commits an interrupted generator refusal through the pool-owned outcome session', async () => {
		resetFixture();
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

	it.each([
		[
			'foreign executionId',
			() =>
				fixture.reservations.mockImplementation(async (executionId: string) =>
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
									executionId: 'foreign-execution',
									rootClaimId: 'claim:generator',
									homeLedger: { scope: 'schema', schema: 'tenant' },
								},
							]
						: [],
				),
			'reservation disagreement',
		],
		[
			'two open roots',
			() => {
				const row = {
					address: {
						scope: 'schema' as const,
						engine: 'postgresql' as const,
						database: 'app',
						schema: 'tenant',
						kind: 'table' as const,
						name: 'interrupted_generator',
					},
					claimKind: 'retire-intent' as const,
					executionId: 'dbsp.generator.execution.run:generator',
					rootClaimId: 'claim:generator',
					homeLedger: { scope: 'schema' as const, schema: 'tenant' },
				};
				fixture.reservations.mockImplementation(async (executionId: string) =>
					executionId === 'dbsp.generator.execution.run:generator'
						? [
								row,
								{ ...row, address: { ...row.address, name: 'second_root' } },
							]
						: [],
				);
				fixture.chain.mockResolvedValue({ terminalMember: {} } as never);
			},
			'has 2 open root members',
		],
		[
			'stale ledger home',
			() =>
				fixture.currency.mockResolvedValue({
					kind: 'not-current',
					marker: { kind: 'future' },
				} as never),
			'ledger marker future',
		],
	] as const)('OBL-REC1: reconcile refuses a %s group before recovery append', async (_name, arrange, detail) => {
		resetFixture();
		arrange();
		await expect(
			runReconcile('run:generator', { db: 'postgres://fixture' }, {} as never),
		).resolves.toMatchObject({
			outcome:
				_name === 'stale ledger home'
					? 'reconcile-unresolved'
					: 'reconcile-claim-selection-unavailable',
			detail: expect.stringContaining(detail),
		});
		expect(fixture.recovery).not.toHaveBeenCalled();
	});

	it('OBL-CLI10: recover returns the typed read-only refusal before marker selection', async () => {
		resetFixture();
		fixture.writability.mockRejectedValue(
			new Error('database-read-only: target session is read-only'),
		);
		fixture.readOnly.mockReturnValue(true);
		const { runRecover } = await import('./recover.js');
		await expect(
			runRecover(
				'run:generator',
				{ db: 'postgres://fixture', planDigest: 'digest:generator' },
				{} as never,
			),
		).resolves.toMatchObject({
			outcome: 'database-read-only',
			detail: 'database-read-only: target session is read-only',
		});
		expect(fixture.currency).not.toHaveBeenCalled();
		expect(fixture.recovery).not.toHaveBeenCalled();
	});
});
