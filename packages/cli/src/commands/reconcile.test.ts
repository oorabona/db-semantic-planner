import { describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
	reconcile: vi.fn(),
	writable: vi.fn(),
	readOnly: vi.fn(() => false),
	lockSession: { query: vi.fn() },
}));

vi.mock('@dbsp/adapter-pgsql', () => ({
	escapeDiagnosticText: (value: string) => value,
	assertPgDatabaseWritable: fixture.writable,
	createPgTransitionPack: vi.fn(),
	isPgDatabaseReadOnlyError: fixture.readOnly,
	preparePgRecoveryAdmission: vi.fn(),
	readPgLedgerScopeCurrency: vi.fn(),
	readPgObservationContextFromLessor: vi.fn(),
	readTransitionJournal: vi.fn(),
	withPgTransitionRunLock: vi.fn(async (_pool, _runId, callback) => ({
		kind: 'acquired',
		value: await callback({}),
	})),
	PgReconcileTransitionRunError: class PgReconcileTransitionRunError extends Error {
		readonly originalCause: unknown;
		readonly stage: 'journal' | 'catalogue' | 'reconcile';
		constructor(stage: 'journal' | 'catalogue' | 'reconcile', cause: unknown) {
			super('reconcile failed');
			this.stage = stage;
			this.originalCause = cause;
		}
	},
	reconcilePgTransitionRun: fixture.reconcile,
}));

vi.mock('@dbsp/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/core')>()),
	acquireTransitionTargetLease: vi.fn(async () => ({
		session: fixture.lockSession,
		release: vi.fn(),
	})),
	loadVerifiedRecoveryJournal: vi.fn(async () => ({
		ok: true,
		journal: {
			run: { runId: 'run-1', planDigest: 'digest:generator' },
			plan: { assumptions: [], steps: [] },
			events: [],
		},
	})),
}));

import {
	classifyReconcileFailure,
	formatReconcileHuman,
	runReconcile,
	unresolvedRecoveryDetail,
} from './reconcile.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

describe('reconcile CLI mapping', () => {
	it.each([
		['authentication', { code: '28P01' }, 'reconcile'],
		['transport', { code: '08006' }, 'reconcile'],
		['malformed-journal', new Error('opaque'), 'journal'],
		['catalogue', new Error('opaque'), 'catalogue'],
	] as const)('OBL-REC3 keeps the %s cause distinct', (cause, error, stage) => {
		expect(classifyReconcileFailure(error, stage)).toBe(cause);
	});

	it.each(['transport-ambiguous', 'no-open-claim'] as const)(
		'keeps %s in rendered unresolved diagnostics',
		(outcome) => {
			expect(unresolvedRecoveryDetail([{ address, outcome }])).toContain(
				outcome,
			);
		},
	);

	it('maps the adapter marker issue to ERR-03 without scanning detail text', async () => {
		fixture.reconcile.mockResolvedValue({
			kind: 'unresolved',
			runId: 'run-1',
			addresses: [address],
			recovery: [{ address, outcome: 'blocked' }],
			selectedIssue: {
				kind: 'ledger-not-current',
				currency: {
					kind: 'not-current',
					marker: { kind: 'future', version: 2 },
					reason: 'marker',
				},
				affectedAddresses: [address],
			},
		});
		const result = await runReconcile(
			'run-1',
			{ db: 'postgres://fixture' },
			{} as never,
		);
		expect(result).toMatchObject({
			outcome: 'reconcile-unresolved',
			detail: 'ledger marker future; run dbsp preflight --reinitialize',
			refusal: { refusal: { code: 'ERR-03' } },
		});
	});

	it('maps read-only and recovery issues to their existing documents', async () => {
		fixture.reconcile
			.mockResolvedValueOnce({
				kind: 'database-read-only',
				runId: 'run-1',
				addresses: [address],
				selectedIssue: {
					kind: 'database-read-only',
					reason: 'target is read-only',
					affectedAddresses: [address],
				},
			})
			.mockResolvedValueOnce({
				kind: 'unresolved',
				runId: 'run-1',
				addresses: [address],
				recovery: [
					{
						address,
						outcome: 'malformed-chain',
						reason: 'chain invalid',
						failureCause: 'malformed-journal',
					},
				],
				selectedIssue: { kind: 'malformed-chain', address },
			});
		await expect(
			runReconcile('run-1', { db: 'postgres://fixture' }, {} as never),
		).resolves.toMatchObject({ refusal: { refusal: { code: 'ERR-07' } } });
		await expect(
			runReconcile('run-1', { db: 'postgres://fixture' }, {} as never),
		).resolves.toMatchObject({ refusal: { refusal: { code: 'ERR-08' } } });
	});

	it('keeps indeterminate recovery unresolved in the rendered document', async () => {
		fixture.reconcile.mockResolvedValue({
			kind: 'unresolved',
			runId: 'run-1',
			addresses: [address],
			recovery: [
				{
					address,
					outcome: 'indeterminate-appended',
					reason: 'live state remains unknown',
				},
			],
		});
		const result = await runReconcile(
			'run-1',
			{ db: 'postgres://fixture' },
			{} as never,
		);
		expect(result.outcome).toBe('reconcile-unresolved');
		expect(formatReconcileHuman(result)).toContain(
			'accounts: indeterminate-appended: live state remains unknown',
		);
	});

	it('maps an adapter-held lock to the existing unavailable result', async () => {
		fixture.reconcile.mockResolvedValue({
			kind: 'busy',
			runId: 'run-1',
			addresses: [],
		});
		await expect(
			runReconcile('run-1', { db: 'postgres://fixture' }, {} as never),
		).resolves.toEqual({
			outcome: 'reconcile-run-unavailable',
			runId: 'run-1',
			addresses: [],
		});
	});

	it('keeps recover read-only handling before marker selection', async () => {
		fixture.writable.mockRejectedValueOnce(new Error('target is read-only'));
		fixture.readOnly.mockReturnValueOnce(true);
		const { runRecover } = await import('./recover.js');
		await expect(
			runRecover(
				'run-1',
				{ db: 'postgres://fixture', planDigest: 'digest:generator' },
				{} as never,
			),
		).resolves.toMatchObject({
			outcome: 'database-read-only',
			detail: 'target is read-only',
		});
	});
});
