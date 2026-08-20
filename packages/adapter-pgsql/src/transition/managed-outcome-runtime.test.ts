import { describe, expect, it, vi } from 'vitest';

const executePgAdmittedOperation = vi.hoisted(() => vi.fn());

vi.mock('./outcome-protocol.js', () => ({
	executePgAdmittedOperation,
	lockPgJournalRun: (run: unknown) => run,
}));

vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: vi.fn(),
}));

import { withPgManagedOutcomeRuntime } from './managed-outcome-runtime.js';

const request = {
	executionId: 'dbsp.transition.execution.attempt-1',
	transactional: true,
	claim: {
		plannedClaimKey: 'create:accounts',
		address: {
			scope: 'schema' as const,
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'table',
			name: 'accounts',
		},
		claimKind: 'intent',
		statementBundle: {
			statements: [{ ordinal: 0, sql: 'CREATE TABLE accounts ()' }],
		},
		requiresVacancy: true,
	},
	run: { runId: 'run-1', planDigest: 'digest' },
	durablyLoadedRun: { runId: 'run-1', planDigest: 'digest' },
	readBack: async () => ({ value: {}, digest: 'observed' }),
} as never;

describe('PostgreSQL managed outcome runtime', () => {
	it('preserves a recovery-required claim identity', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-recovery-required',
			claimId: 'open-claim',
			reason: 'sender disconnected',
		});
		const runtime = withPgManagedOutcomeRuntime({});
		await expect(
			runtime.executeManagedOutcome(
				{
					opaqueClient: { query: vi.fn() },
					markClientCompromised: vi.fn(),
				} as never,
				request,
			),
		).resolves.toEqual({
			kind: 'recovery-required',
			claimId: 'open-claim',
			detail: 'sender disconnected',
		});
	});

	it('preserves recovery-required and compromises the execution client', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-recovery-required',
			claimId: 'open-claim',
			reason: 'sender disconnected',
		});
		const runtime = withPgManagedOutcomeRuntime({});
		const markClientCompromised = vi.fn();
		await expect(
			runtime.executeManagedOutcome(
				{ opaqueClient: { query: vi.fn() }, markClientCompromised } as never,
				request,
			),
		).resolves.toEqual({
			kind: 'recovery-required',
			claimId: 'open-claim',
			detail: 'sender disconnected',
		});
		expect(markClientCompromised).toHaveBeenCalledOnce();
	});

	it('preserves transport ambiguity and compromises the execution client', async () => {
		executePgAdmittedOperation.mockResolvedValue({
			kind: 'outcome-transport-ambiguous',
			reason: 'commit acknowledgement lost',
		});
		const runtime = withPgManagedOutcomeRuntime({});
		const markClientCompromised = vi.fn();
		await expect(
			runtime.executeManagedOutcome(
				{ opaqueClient: { query: vi.fn() }, markClientCompromised } as never,
				request,
			),
		).resolves.toEqual({
			kind: 'transport-ambiguous',
			detail: 'commit acknowledgement lost',
		});
		expect(markClientCompromised).toHaveBeenCalledOnce();
	});
});
