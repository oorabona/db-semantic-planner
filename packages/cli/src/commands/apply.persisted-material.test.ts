import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
	const appendIntent = vi.fn(async () => undefined);
	const reservations = vi.fn(async () => []);
	const chain = vi.fn(async () => ({ events: [] }));
	const journal = {
		run: {
			runId: 'run:substituted',
			planDigest: 'reviewed-digest',
			targetContextDigest: 'context:substituted',
			databaseId: 'database:substituted',
			coreVersion: '3.0.0',
			startedAt: '2026-08-21T00:00:00.000Z',
		},
		plan: {
			generator: {
				kind: 'schema-differ-generator',
				planningSchema: 'tenant',
			},
			steps: [
				{
					stepKey: 'generator:0:adoption',
					order: 0,
					statementBundle: { statements: [] },
					expectedDeclaration: null,
				},
			],
		},
		events: [],
	};
	return {
		appendIntent,
		chain,
		journal,
		journalReadError: undefined as Error | undefined,
		reservations,
	};
});

const executeGeneratorPlan = vi.hoisted(() => vi.fn());

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		appendIntentJournal: fixture.appendIntent,
		createPgTransitionLessor: vi.fn(() => ({})),
		readPgLedgerAddressChain: fixture.chain,
		readPgLedgerReservationsForExecution: fixture.reservations,
		readTransitionJournal: vi.fn(async () => {
			if (fixture.journalReadError !== undefined)
				throw fixture.journalReadError;
			return fixture.journal;
		}),
		withPgTransitionRunLock: vi.fn(async (_pool, _runId, callback) => ({
			kind: 'acquired' as const,
			value: await callback({}),
		})),
	};
});

vi.mock('./generator-execution.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('./generator-execution.js')>();
	return { ...actual, executeGeneratorPlan };
});

vi.mock('@dbsp/core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/core')>();
	const lease = { session: {}, release: vi.fn(async () => undefined) };
	return {
		...actual,
		acquireTransitionLease: vi.fn(async () => lease),
		acquireExclusiveTransitionLease: vi.fn(async () => lease),
	};
});

import { transitionPlanDigest } from '@dbsp/core';
import { formatApplyHuman, runApply } from './apply.js';

const recordedAttemptExecutionId = 'dbsp.generator.execution.recorded-attempt';

function prepareReplayableGeneratorJournal(): void {
	const address = {
		scope: 'schema' as const,
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant',
		kind: 'table',
		name: 'accounts',
	};
	fixture.journal.plan = {
		generator: {
			kind: 'schema-differ-generator',
			planningSchema: 'tenant',
		},
		steps: [
			{
				stepKey: 'generator:0:accounts',
				order: 0,
				segmentId: 'generator:0',
				dependencyOrder: [],
				address,
				claimKind: 'intent',
				plannedClaimKeys: ['generator:0:accounts'],
				statementBundle: {
					statements: [{ ordinal: 0, sql: 'ALTER TABLE tenant.accounts' }],
				},
				classification: 'non-destructive',
				requiresVacancy: false,
				replayPolicy: 'recorded',
			},
		],
	} as never;
	fixture.journal.run.planDigest = transitionPlanDigest(
		fixture.journal.plan as never,
	);
	fixture.journal.events = [
		{
			event: 'intent',
			stepId: `dbsp.generator.attempt:${recordedAttemptExecutionId}`,
			operationRef: 'dbsp.generator.attempt',
			record: { executionId: recordedAttemptExecutionId },
		} as never,
	];
}

describe('apply persisted generator material', () => {
	it('refuses a recorded generator attempt with a ledger reservation and directs recovery', async () => {
		const previous = {
			events: fixture.journal.events,
			plan: fixture.journal.plan,
			planDigest: fixture.journal.run.planDigest,
		};
		prepareReplayableGeneratorJournal();
		executeGeneratorPlan.mockImplementationOnce(async (input) => {
			await input.recordAttempt('dbsp.generator.execution.minted-attempt');
			return { outcome: 'completed' };
		});
		fixture.reservations.mockResolvedValueOnce([
			{
				address: (fixture.journal.plan as any).steps[0]?.address,
				executionId: recordedAttemptExecutionId,
			},
		] as never);
		try {
			const result = await runApply(
				fixture.journal.run.runId,
				{
					db: 'postgres://must-not-connect',
					planDigest: fixture.journal.run.planDigest,
				},
				{} as never,
			);
			expect(result).toMatchObject({
				outcome: 'prior-step-events-refusal',
				result: {
					outcome: 'prior-step-events-refusal',
					detail:
						'run has prior generator step-attempt events; run dbsp reconcile --db <database> <run-id>',
				},
			});
			expect(formatApplyHuman(result)).toContain(
				`resolving command: dbsp reconcile --db <database> ${fixture.journal.run.runId}`,
			);
			expect(executeGeneratorPlan).not.toHaveBeenCalled();
			expect(fixture.appendIntent).not.toHaveBeenCalled();
		} finally {
			executeGeneratorPlan.mockReset();
			fixture.reservations.mockReset();
			fixture.journal.events = previous.events;
			fixture.journal.plan = previous.plan;
			fixture.journal.run.planDigest = previous.planDigest;
		}
	});

	it('retries a recorded generator attempt with no ledger evidence and records a new attempt', async () => {
		const previous = {
			events: fixture.journal.events,
			plan: fixture.journal.plan,
			planDigest: fixture.journal.run.planDigest,
		};
		prepareReplayableGeneratorJournal();
		executeGeneratorPlan.mockImplementationOnce(async (input) => {
			await input.recordAttempt('dbsp.generator.execution.minted-attempt');
			return { outcome: 'completed' };
		});
		try {
			await expect(
				runApply(
					fixture.journal.run.runId,
					{
						db: 'postgres://must-not-connect',
						planDigest: fixture.journal.run.planDigest,
					},
					{} as never,
				),
			).resolves.toMatchObject({ outcome: 'completed' });
			expect(fixture.appendIntent).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					executionId: 'dbsp.generator.execution.minted-attempt',
				}),
			);
		} finally {
			executeGeneratorPlan.mockReset();
			fixture.reservations.mockReset();
			fixture.journal.events = previous.events;
			fixture.journal.plan = previous.plan;
			fixture.journal.run.planDigest = previous.planDigest;
		}
	});

	it('OBL-LIFE2: substituted declaration resolves to a digest refusal, never a throw', async () => {
		await expect(
			runApply(
				fixture.journal.run.runId,
				{
					db: 'postgres://must-not-connect',
					planDigest: fixture.journal.run.planDigest,
				},
				{} as never,
			),
		).resolves.toMatchObject({
			outcome: 'plan-digest-mismatch',
			result: {
				assessment: {
					reasons: [
						{
							detail: expect.stringContaining(
								'persisted generator manifest is invalid',
							),
						},
					],
				},
			},
		});
	});

	it('OBL-LIFE1: absent persisted material resolves to a digest refusal, never a rejected promise', async () => {
		fixture.journalReadError = new Error(
			'dbsp transition run plan row is invalid and non-resumable',
		);
		try {
			await expect(
				runApply(
					fixture.journal.run.runId,
					{
						db: 'postgres://must-not-connect',
						planDigest: fixture.journal.run.planDigest,
					},
					{} as never,
				),
			).resolves.toMatchObject({
				outcome: 'plan-digest-mismatch',
				result: {
					assessment: {
						reasons: [
							{
								detail:
									'dbsp transition run plan row is invalid and non-resumable',
							},
						],
					},
				},
			});
		} finally {
			fixture.journalReadError = undefined;
		}
	});

	it('propagates journal read errors outside the invalid/non-resumable contract', async () => {
		fixture.journalReadError = new Error('database transport failed');
		try {
			await expect(
				runApply(
					fixture.journal.run.runId,
					{
						db: 'postgres://must-not-connect',
						planDigest: fixture.journal.run.planDigest,
					},
					{} as never,
				),
			).rejects.toThrow('database transport failed');
		} finally {
			fixture.journalReadError = undefined;
		}
	});
});
