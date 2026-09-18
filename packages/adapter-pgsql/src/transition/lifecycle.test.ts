import type { createApplier } from '@dbsp/core';
import type {
	ApplyPolicy,
	PlanAssessment,
	ProvenPlanShape,
	TransitionRunAuthorization,
	TransitionRunJournal,
	TransitionRunMetadata,
} from '@dbsp/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	appendAuthorization: vi.fn(),
	applyDurable: vi.fn(),
	execution: vi.fn(),
	leaseRelease: vi.fn(),
	readJournal: vi.fn(),
	runLock: vi.fn(),
	session: { query: vi.fn() },
	transaction: vi.fn(),
}));

vi.mock('@dbsp/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/core')>()),
	acquireExclusiveTransitionLease: vi.fn(async () => ({
		session: mocks.session,
		release: mocks.leaseRelease,
	})),
	createApplier: vi.fn(() => ({ applyDurable: mocks.applyDurable })),
	createPackRegistry: vi.fn(() => ({})),
}));
vi.mock('./journal.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./journal.js')>()),
	appendTransitionAuthorization: mocks.appendAuthorization,
	readTransitionJournal: mocks.readJournal,
}));
vi.mock('./lessor.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./lessor.js')>()),
	withPgTransitionRunLock: mocks.runLock,
}));
vi.mock('./outcome-protocol.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./outcome-protocol.js')>()),
	withPgTransitionTransaction: mocks.transaction,
}));

import { applyPgTransitionRun } from './lifecycle.js';

type DurableApplyInput = Parameters<
	ReturnType<typeof createApplier>['applyDurable']
>[0];
type DurableApplyResult = Awaited<
	ReturnType<ReturnType<typeof createApplier>['applyDurable']>
>;

const plan = {} as ProvenPlanShape;
const policy = [] as unknown as ApplyPolicy;

function run(runId = 'run:lifecycle'): TransitionRunMetadata {
	return {
		runId,
		planDigest: 'plan-digest',
		targetContextDigest: 'target-context-digest',
		databaseId: 'database-id',
		coreVersion: '0.3.0',
		replayability: 'replayable',
		startedAt: '2026-09-18T00:00:00.000Z',
	};
}

function journal(
	metadata: TransitionRunMetadata,
	authorizations: readonly TransitionRunAuthorization[] = [],
): TransitionRunJournal & { readonly plan: ProvenPlanShape } {
	return { run: metadata, plan, events: [], authorizations };
}

function authorization(
	runId: string,
	digest: string,
): TransitionRunAuthorization {
	return {
		runId,
		policy: [],
		grants: [],
		digest,
		actor: 'operator',
		authorizedAt: '2026-09-18T00:00:01.000Z',
	};
}

function durableResult(
	outcome: Exclude<
		DurableApplyResult['durableOutcome'],
		'recovery-required' | 'transport-ambiguous'
	>,
): DurableApplyResult {
	return {
		durableOutcome: outcome,
		assessment: {} as PlanAssessment,
		journals: [],
		observations: [],
	};
}

async function driveMockedCoreApplier(
	input: DurableApplyInput,
): Promise<DurableApplyResult> {
	const loaded = await input.loadCurrent(input.runId);
	try {
		await input.authorize(loaded.run, loaded.plan, mocks.session as never);
	} catch {
		return durableResult('authorization-write-failed');
	}
	mocks.execution();
	return durableResult('completed');
}

describe('applyPgTransitionRun authorization lifecycle', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.applyDurable.mockImplementation(driveMockedCoreApplier);
		mocks.runLock.mockImplementation(async (_pool, _runId, work) => ({
			kind: 'acquired' as const,
			value: await work({} as never),
		}));
		mocks.session.query.mockResolvedValue({ rows: [{}] });
		mocks.transaction.mockImplementation(async (session, work) =>
			work(session),
		);
	});

	it('refuses a record for a different run before core execution', async () => {
		const metadata = run();
		mocks.readJournal.mockResolvedValue(journal(metadata));

		const result = await applyPgTransitionRun(
			{} as never,
			metadata.runId,
			policy,
			metadata.planDigest,
			{
				authorize: async () => authorization('run:other', 'other-digest'),
			},
		);

		expect(result).toMatchObject({
			kind: 'settled',
			result: { durableOutcome: 'authorization-write-failed' },
		});
		expect(mocks.execution).not.toHaveBeenCalled();
		expect(mocks.appendAuthorization).not.toHaveBeenCalled();
	});

	it('passes authorize the journal freshly read in its authorization transaction', async () => {
		const metadata = run();
		const appendedBetweenReads = authorization(metadata.runId, 'between-reads');
		const selected = authorization(metadata.runId, 'selected');
		mocks.readJournal
			.mockResolvedValueOnce(journal(metadata))
			.mockResolvedValueOnce(journal(metadata, [appendedBetweenReads]));
		const authorize = vi.fn(async ({ current }) => {
			expect(current.authorizations).toEqual([appendedBetweenReads]);
			return selected;
		});

		const result = await applyPgTransitionRun(
			{} as never,
			metadata.runId,
			policy,
			metadata.planDigest,
			{ authorize },
		);

		expect(result).toMatchObject({
			kind: 'settled',
			result: { durableOutcome: 'completed' },
		});
		expect(authorize).toHaveBeenCalledWith({
			run: metadata,
			plan,
			current: journal(metadata, [appendedBetweenReads]),
		});
		expect(mocks.appendAuthorization).toHaveBeenCalledWith(
			mocks.session,
			selected,
		);
	});
});
