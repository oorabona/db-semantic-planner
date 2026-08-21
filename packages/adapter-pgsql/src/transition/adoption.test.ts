import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	readChain: vi.fn(),
	readIdentity: vi.fn(),
	executeAdmitted: vi.fn(),
}));

vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
}));
vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: mocks.readIdentity,
}));
vi.mock('./outcome-protocol.js', () => ({
	executePgAdmittedOperation: mocks.executeAdmitted,
}));

import {
	executePgDeclaredAdoption,
	type PgPersistedDeclaredAdoptionInput,
} from './adoption.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};
const identity = { engine: 'postgresql', format: 1, value: { oid: '42' } };
const declaration = {
	value: { kind: 'table', name: 'accounts', shape: { name: 'accounts' } },
	digest: 'declared-shape',
};
const executor = { query: vi.fn() };

function persisted(): Pick<
	PgPersistedDeclaredAdoptionInput,
	| 'run'
	| 'manifest'
	| 'recomputedPlanDigest'
	| 'approval'
	| 'executionId'
	| 'step'
> {
	return {
		run: { runId: 'run-1', planDigest: 'digest' } as never,
		manifest: {} as never,
		recomputedPlanDigest: 'digest',
		approval: { approvals: [] },
		executionId: 'dbsp.generator.execution.attempt-1',
		step: {
			stepKey: 'adoption:accounts',
			address,
			claimKind: 'adopt-intent',
			plannedClaimKeys: ['adoption:accounts/root'],
			statementBundle: { statements: [] },
			classification: 'non-destructive',
			requiresVacancy: false,
			expectedDeclaration: declaration,
			expectedCatalogueIdentity: identity,
			lifecycle: { kind: 'adoption', shape: {} },
		} as unknown as PgPersistedDeclaredAdoptionInput['step'],
	};
}

function unmanaged() {
	mocks.readChain.mockResolvedValue({ events: [] });
}

describe('declared PostgreSQL adoption admission', () => {
	beforeEach(() => vi.clearAllMocks());

	it('records the reviewed declaration and live identity only after the declared shape matches', async () => {
		unmanaged();
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: identity,
		});
		mocks.executeAdmitted.mockResolvedValue({ kind: 'executed-outcome-claim' });
		const shapeMatches = vi.fn(async () => true);

		await expect(
			executePgDeclaredAdoption({
				executor,
				...persisted(),
				...persisted(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches,
			}),
		).resolves.toEqual({ outcome: 'completed' });
		expect(shapeMatches).toHaveBeenCalledOnce();
		expect(mocks.executeAdmitted).toHaveBeenCalledWith(
			executor,
			expect.objectContaining({
				operation: expect.objectContaining({
					request: expect.objectContaining({
						plan: expect.objectContaining({
							claimKind: 'adopt-intent',
							declared: declaration,
							executionId: 'dbsp.generator.execution.attempt-1',
						}),
						reservations: [
							expect.objectContaining({
								executionId: 'dbsp.generator.execution.attempt-1',
							}),
						],
						recordCatalogueIdentity: true,
					}),
				}),
			}),
		);
	});

	it('refuses a live shape mismatch before reading identity or claiming', async () => {
		unmanaged();
		const result = await executePgDeclaredAdoption({
			executor,
			...persisted(),
			home: { scope: 'schema', schema: 'tenant' },
			address,
			declaration,
			expectedCatalogueIdentity: identity,
			shapeMatches: async () => false,
		});
		expect(result).toEqual({
			outcome: 'adoption-refused',
			detail: 'declared adoption for accounts refuses live shape mismatch',
		});
		expect(mocks.readIdentity).not.toHaveBeenCalled();
		expect(mocks.executeAdmitted).not.toHaveBeenCalled();
	});

	it('refuses a changed physical identity before claiming', async () => {
		unmanaged();
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: { ...identity, value: { oid: '43' } },
		});
		const result = await executePgDeclaredAdoption({
			executor,
			...persisted(),
			home: { scope: 'schema', schema: 'tenant' },
			address,
			declaration,
			expectedCatalogueIdentity: identity,
			shapeMatches: async () => true,
		});
		expect(result).toEqual({
			outcome: 'adoption-refused',
			detail: 'declared adoption for accounts refuses live identity mismatch',
		});
		expect(mocks.executeAdmitted).not.toHaveBeenCalled();
	});

	it('treats an already managed adoption as an idempotent no-op', async () => {
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: identity,
		});
		mocks.readChain.mockResolvedValue({
			ledger: { scope: 'schema', schema: 'tenant' },
			address,
			events: [
				{
					eventId: 'adopt-intent',
					address,
					eventKind: 'adopt-intent',
					controller: 'owner',
				},
				{
					eventId: 'adopt',
					address,
					eventKind: 'adopt',
					observed: declaration,
					predecessor: 'adopt-intent',
					controller: 'owner',
				},
			],
			terminalMember: {
				eventId: 'adopt',
				address,
				eventKind: 'adopt',
				observed: declaration,
				controller: 'owner',
			},
		});
		await expect(
			executePgDeclaredAdoption({
				executor,
				...persisted(),
				...persisted(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches: async () => true,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
	});

	it.each([
		[
			'SQL outside lifecycle material',
			(value: ReturnType<typeof persisted>) => ({
				...value,
				step: {
					...value.step,
					statementBundle: { statements: [{ ordinal: 0, sql: 'SELECT 1' }] },
				},
			}),
		],
		[
			'substituted declaration',
			(value: ReturnType<typeof persisted>) => ({
				...value,
				step: {
					...value.step,
					expectedDeclaration: { ...declaration, digest: 'substituted' },
				},
			}),
		],
	] as const)('C02 validates %s before a no-op-capable preflight', async (_label, mutate) => {
		const result = await executePgDeclaredAdoption({
			executor,
			...mutate(persisted()),
			home: { scope: 'schema', schema: 'tenant' },
			address,
			declaration,
			expectedCatalogueIdentity: identity,
			shapeMatches: async () => true,
		});
		expect(result).toMatchObject({
			outcome: 'execution-failed',
			detail: expect.stringContaining('adoption step adoption:accounts'),
		});
		expect(mocks.readChain).not.toHaveBeenCalled();
		expect(mocks.readIdentity).not.toHaveBeenCalled();
	});

	it('re-reads a completed adoption when the token gate reports a concurrent close', async () => {
		mocks.readChain
			.mockResolvedValueOnce({ events: [] })
			.mockResolvedValueOnce({
				ledger: { scope: 'schema', schema: 'tenant' },
				address,
				events: [
					{
						eventId: 'adopt-intent',
						address,
						eventKind: 'adopt-intent',
						controller: 'owner',
					},
					{
						eventId: 'adopt',
						address,
						eventKind: 'adopt',
						observed: declaration,
						predecessor: 'adopt-intent',
						controller: 'owner',
					},
				],
			});
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: identity,
		});
		mocks.executeAdmitted.mockResolvedValue({
			kind: 'outcome-protocol-refused',
			reason:
				'claim token for concurrent-claim is no longer valid because its claim is closed',
		});

		await expect(
			executePgDeclaredAdoption({
				executor,
				...persisted(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches: async () => true,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
	});

	it('keeps a non-adoption protocol failure in the execution-failed result', async () => {
		unmanaged();
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: identity,
		});
		mocks.executeAdmitted.mockResolvedValue({
			kind: 'outcome-protocol-refused',
			reason:
				'claim token for another change is no longer valid because its claim is closed',
		});

		await expect(
			executePgDeclaredAdoption({
				executor,
				...persisted(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches: async () => true,
			}),
		).resolves.toEqual({
			outcome: 'execution-failed',
			detail:
				'claim token for another change is no longer valid because its claim is closed',
		});
	});

	it.each([
		[
			{
				kind: 'outcome-recovery-required',
				claimId: 'open-claim',
				reason: 'open',
			},
			{
				outcome: 'recovery-required',
				claimId: 'open-claim',
				detail: 'claim open-claim remains open and requires recovery: open',
			},
		],
		[
			{ kind: 'outcome-transport-ambiguous', reason: 'commit unknown' },
			{ outcome: 'transport-ambiguous', detail: 'commit unknown' },
		],
	] as const)('preserves admitted unresolved outcome %s', async (admitted, expected) => {
		unmanaged();
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: identity,
		});
		mocks.executeAdmitted.mockResolvedValue(admitted);
		await expect(
			executePgDeclaredAdoption({
				executor,
				...persisted(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches: async () => true,
			}),
		).resolves.toEqual(expected);
	});
});
