import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
	const journal = {
		run: { runId: 'run:substituted', planDigest: 'reviewed-digest' },
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
	return { journal, journalReadError: undefined as Error | undefined };
});

vi.mock('@dbsp/adapter-pgsql', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/adapter-pgsql')>();
	return {
		...actual,
		createPgTransitionLessor: vi.fn(() => ({})),
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

vi.mock('@dbsp/core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@dbsp/core')>();
	const lease = { session: {}, release: vi.fn(async () => undefined) };
	return {
		...actual,
		acquireTransitionLease: vi.fn(async () => lease),
		acquireExclusiveTransitionLease: vi.fn(async () => lease),
	};
});

import { runApply } from './apply.js';

describe('apply persisted generator material', () => {
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
