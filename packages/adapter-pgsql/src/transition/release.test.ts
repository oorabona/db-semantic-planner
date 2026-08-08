import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	locks: vi.fn(),
	currency: vi.fn(),
	readChain: vi.fn(),
	appendRelease: vi.fn(),
	project: vi.fn(),
}));

vi.mock('@dbsp/core', () => ({ projectLedgerChain: mocks.project }));
vi.mock('./ledger.js', () => ({
	acquirePgLedgerLocks: mocks.locks,
	appendPgLedgerRelease: mocks.appendRelease,
}));
vi.mock('./reinitialize-preflight.js', () => ({
	readPgLedgerScopeCurrency: mocks.currency,
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
}));

import { releasePgManagedAddress } from './release.js';

const address = {
	scope: 'schema' as const,
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

function executor(currentUser = 'owner') {
	return {
		query: vi.fn(async (sql: string) =>
			sql === 'SELECT current_user AS current_user'
				? { rows: [{ current_user: currentUser }] }
				: { rows: [] },
		),
	};
}

function currentManaged(controller = 'owner') {
	mocks.locks.mockResolvedValue({ kind: 'acquired' });
	mocks.currency.mockResolvedValue({ kind: 'current' });
	mocks.readChain.mockResolvedValue({
		terminalMember: { eventId: 'observed', address, controller },
	});
	mocks.project.mockReturnValue({
		kind: 'projected-ledger-chain',
		stableState: 'managed',
	});
}

describe('PostgreSQL release admission', () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		['pending', { phase: 'claimed' }],
		['blocked', { phase: 'indeterminate' }],
	] as const)('refuses a %s address without appending release', async (word, openClaim) => {
		currentManaged();
		mocks.project.mockReturnValue({
			kind: 'projected-ledger-chain',
			stableState: 'unknown',
			openClaim,
		});
		const client = executor();
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({
			outcome: 'release-refused',
			detail: `release refuses ${word} address accounts`,
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
		expect(client.query).not.toHaveBeenCalledWith('BEGIN');
		expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
	});

	it('refuses a different controller', async () => {
		currentManaged('other-owner');
		await expect(
			releasePgManagedAddress({
				executor: executor('owner'),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			detail:
				'release refuses controller owner for address owned by other-owner',
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
		expect(mocks.locks).not.toHaveBeenCalled();
	});

	it('refuses a non-current lineage before reading the address', async () => {
		mocks.locks.mockResolvedValue({ kind: 'acquired' });
		mocks.currency.mockResolvedValue({ kind: 'not-current' });
		await expect(
			releasePgManagedAddress({
				executor: executor(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({
			outcome: 'release-refused',
			detail: 'release refuses lineage not-current',
		});
		expect(mocks.readChain).not.toHaveBeenCalled();
		expect(mocks.locks).not.toHaveBeenCalled();
	});

	it('appends exactly the released terminal shape atomically on success', async () => {
		currentManaged();
		const client = executor();
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({ outcome: 'released' });
		expect(mocks.appendRelease).toHaveBeenCalledWith(
			client,
			{ scope: 'schema', schema: 'tenant' },
			expect.objectContaining({
				address,
				eventKind: 'released',
				predecessor: 'observed',
			}),
		);
		expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
			'SELECT current_user AS current_user',
			'BEGIN',
			'SELECT current_user AS current_user',
			'COMMIT',
		]);
	});
});
