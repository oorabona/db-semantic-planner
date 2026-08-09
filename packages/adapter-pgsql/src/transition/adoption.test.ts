import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	readChain: vi.fn(),
	readIdentity: vi.fn(),
	runOutcome: vi.fn(),
}));

vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
}));
vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: mocks.readIdentity,
}));
vi.mock('./outcome-protocol.js', () => ({
	runPgTransactionalOutcome: mocks.runOutcome,
}));

import { executePgDeclaredAdoption } from './adoption.js';

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
		mocks.runOutcome.mockResolvedValue({ kind: 'executed-outcome-claim' });
		const shapeMatches = vi.fn(async () => true);

		await expect(
			executePgDeclaredAdoption({
				executor,
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches,
				executionId: 'run-1',
			}),
		).resolves.toEqual({ outcome: 'completed' });
		expect(shapeMatches).toHaveBeenCalledOnce();
		expect(mocks.runOutcome).toHaveBeenCalledWith(
			executor,
			expect.objectContaining({
				plan: expect.objectContaining({
					claimKind: 'adopt-intent',
					declared: declaration,
				}),
				recordCatalogueIdentity: true,
			}),
		);
	});

	it('refuses a live shape mismatch before reading identity or claiming', async () => {
		unmanaged();
		const result = await executePgDeclaredAdoption({
			executor,
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
		expect(mocks.runOutcome).not.toHaveBeenCalled();
	});

	it('refuses a changed physical identity before claiming', async () => {
		unmanaged();
		mocks.readIdentity.mockResolvedValue({
			...address,
			catalogueIdentity: { ...identity, value: { oid: '43' } },
		});
		const result = await executePgDeclaredAdoption({
			executor,
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
		expect(mocks.runOutcome).not.toHaveBeenCalled();
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
				home: { scope: 'schema', schema: 'tenant' },
				address,
				declaration,
				expectedCatalogueIdentity: identity,
				shapeMatches: async () => true,
			}),
		).resolves.toEqual({ outcome: 'no-op' });
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
		mocks.runOutcome.mockResolvedValue({
			kind: 'outcome-protocol-refused',
			reason:
				'claim token for concurrent-claim is no longer valid because its claim is closed',
		});

		await expect(
			executePgDeclaredAdoption({
				executor,
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
		mocks.runOutcome.mockResolvedValue({
			kind: 'outcome-protocol-refused',
			reason:
				'claim token for another change is no longer valid because its claim is closed',
		});

		await expect(
			executePgDeclaredAdoption({
				executor,
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
});
