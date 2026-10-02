import { canonicalJsonDigest } from '@dbsp/core/internal';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
	const session = { query: vi.fn() };
	const recovery = vi.fn();
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
						executionId,
						rootClaimId: 'claim:generator',
						homeLedger: { scope: 'schema', schema: 'tenant' },
					},
				]
			: [],
	);
	return {
		session,
		recovery,
		reservations,
		currency: vi.fn(async () => ({ kind: 'current' })),
		chain: vi.fn(async () => []),
	};
});

vi.mock('./lessor.js', () => ({
	withPgTransitionRunLock: vi.fn(async (_pool, _runId, callback) => ({
		kind: 'acquired',
		value: await callback({}),
	})),
}));
vi.mock('./journal.js', () => ({
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
				record: { executionId: 'dbsp.generator.execution.run:generator' },
			},
		],
	})),
}));
vi.mock('./database-writability.js', () => ({
	assertPgDatabaseWritable: vi.fn(),
	isPgDatabaseReadOnlyError: vi.fn(() => false),
}));
vi.mock('./ledger.js', () => ({
	readPgLedgerReservationsForExecution: vi.fn(
		async (_session, _home, executionId) => fixture.reservations(executionId),
	),
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: fixture.chain,
}));
vi.mock('./reinitialize-preflight.js', () => ({
	readPgLedgerScopeCurrency: fixture.currency,
	readVerifiedPgLedgerReservationsForPair: vi.fn(),
}));
vi.mock('./outcome-protocol.js', () => ({
	recoverPgOutcomeClaim: fixture.recovery,
}));
vi.mock('./readdress.js', () => ({ recoverPgReaddressPair: vi.fn() }));
vi.mock('./operations/create-unique-index-concurrently.js', () => ({
	assertCreateUniqueIndexConcurrentlyRecoveryNotInvalid: vi.fn(),
}));
vi.mock('@dbsp/core/internal', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/core/internal')>()),
	acquireExclusiveTransitionLease: vi.fn(async () => ({
		session: fixture.session,
		release: vi.fn(),
	})),
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
	transitionPlanDigest: vi.fn(() => 'digest:generator'),
}));

import {
	executionIdsForRun,
	reconcilePgTransitionRun,
	recoveryPayload,
} from './reconcile.js';

describe('adapter transition reconciliation', () => {
	beforeEach(() => {
		fixture.recovery.mockReset();
		fixture.reservations.mockClear();
		fixture.currency.mockReset();
		fixture.currency.mockResolvedValue({ kind: 'current' });
		fixture.chain.mockReset();
		fixture.chain.mockResolvedValue([]);
	});

	it('canonicalizes absent and null catalogue identity before recovery', () => {
		expect(recoveryPayload(undefined)).toEqual({
			value: {},
			digest: canonicalJsonDigest({}),
		});
		const value = { catalogueIdentity: null };
		expect(recoveryPayload(null as never)).toEqual({
			value,
			digest: canonicalJsonDigest(value),
		});
	});

	it('keeps documented generator scopes and every durable attempt', () => {
		expect(
			executionIdsForRun({
				run: { runId: 'run:generator', planDigest: 'digest:generator' },
				plan: { generator: {}, steps: [] },
				events: [{ event: 'intent', record: { executionId: 'attempt-2' } }],
			} as never),
		).toEqual([
			'run:generator',
			'attempt-2',
			'dbsp.generator.execution.run:generator',
		]);
	});

	it('uses the pool-owned outcome session and exact generator resolution id', async () => {
		fixture.recovery.mockResolvedValue({
			kind: 'outcome-recovery-appended',
			classification: { resolution: { reason: 'refused' } },
			append: { kind: 'appended-outcome-resolution' },
		});
		const pool = { connect: vi.fn() };
		await expect(
			reconcilePgTransitionRun(pool as never, 'run:generator'),
		).resolves.toMatchObject({
			kind: 'completed',
		});
		expect(fixture.recovery).toHaveBeenCalledWith(
			pool,
			expect.objectContaining({
				resolutionEventId: 'claim:generator:reconcile:run:generator',
			}),
		);
	});

	it.each([
		'appended-outcome-resolution',
		'already-appended-outcome-resolution',
	] as const)(
		'keeps %s indeterminate recovery unresolved',
		async (appendKind) => {
			fixture.recovery.mockResolvedValue({
				kind: 'outcome-recovery-appended',
				classification: {
					resolution: {
						eventKind: 'indeterminate',
						reason: 'live state remains unknown',
					},
				},
				append: { kind: appendKind },
			});
			await expect(
				reconcilePgTransitionRun({} as never, 'run:generator'),
			).resolves.toMatchObject({
				kind: 'unresolved',
				recovery: [{ outcome: 'indeterminate-appended' }],
			});
		},
	);

	it('refuses a stale selected ledger before recovery append', async () => {
		fixture.currency.mockResolvedValueOnce({
			kind: 'not-current',
			marker: { kind: 'future', version: 2 },
			reason: 'marker',
		} as never);
		await expect(
			reconcilePgTransitionRun({} as never, 'run:generator'),
		).resolves.toMatchObject({
			kind: 'unresolved',
			selectedIssue: { kind: 'ledger-not-current' },
		});
		expect(fixture.recovery).not.toHaveBeenCalled();
	});

	it('refuses reservation disagreement before recovery append', async () => {
		fixture.reservations.mockResolvedValueOnce([
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
		]);
		await expect(
			reconcilePgTransitionRun({} as never, 'run:generator'),
		).resolves.toMatchObject({
			kind: 'selection-unavailable',
			detail: expect.stringContaining('reservation disagreement'),
		});
		expect(fixture.recovery).not.toHaveBeenCalled();
	});

	it('refuses multiple open roots before recovery append', async () => {
		const rows = await fixture.reservations(
			'dbsp.generator.execution.run:generator',
		);
		fixture.reservations.mockResolvedValueOnce([
			...rows,
			{
				...rows[0]!,
				address: { ...rows[0]!.address, name: 'second_root' },
			},
		] as never);
		await expect(
			reconcilePgTransitionRun({} as never, 'run:generator'),
		).resolves.toMatchObject({
			kind: 'selection-unavailable',
			detail: expect.stringContaining('open root members'),
		});
		expect(fixture.recovery).not.toHaveBeenCalled();
	});
});
