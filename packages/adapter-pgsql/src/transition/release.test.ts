import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	locks: vi.fn(),
	currency: vi.fn(),
	readChain: vi.fn(),
	readControllerOid: vi.fn(),
	appendRelease: vi.fn(),
	physicalIntegrity: vi.fn(),
	project: vi.fn(),
}));

vi.mock('@dbsp/core', () => ({ projectLedgerChain: mocks.project }));
vi.mock('./ledger.js', () => ({
	acquirePgLedgerLocks: mocks.locks,
	appendPgLedgerRelease: mocks.appendRelease,
	validatePgLedgerPhysicalShape: mocks.physicalIntegrity,
}));
vi.mock('./reinitialize-preflight.js', () => ({
	readPgLedgerScopeCurrency: mocks.currency,
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
	readPgLedgerControllerOid: mocks.readControllerOid,
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

function executor(currentUser = 'owner', currentUserOid = '10') {
	return {
		query: vi.fn(async (sql: string) =>
			sql ===
			'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid'
				? {
						rows: [
							{ current_user: currentUser, current_user_oid: currentUserOid },
						],
					}
				: { rows: [] },
		),
	};
}

function currentManaged(controller = 'owner', controllerOid = '10') {
	mocks.locks.mockResolvedValue({ kind: 'acquired' });
	mocks.currency.mockResolvedValue({ kind: 'current' });
	mocks.readChain.mockResolvedValue({
		terminalMember: { eventId: 'observed', address, controller },
	});
	mocks.readControllerOid.mockResolvedValue(controllerOid);
	mocks.project.mockReturnValue({
		kind: 'projected-ledger-chain',
		stableState: 'managed',
	});
}

describe('PostgreSQL release admission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.physicalIntegrity.mockResolvedValue(undefined);
	});

	it.each([
		['pending', { phase: 'claimed' }],
		['blocked', { phase: 'indeterminate' }],
	] as const)('refuses a %s address without appending release', async (_word, openClaim) => {
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
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address,
			refusal: {
				code: 'ERR-08',
				state: 'unknown',
				withheldAuthority: 'managed mutation authority',
				resolvingCommand: 'dbsp inspect',
			},
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
			refusal: expect.objectContaining({ code: 'ERR-05', state: 'managed' }),
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
		expect(mocks.locks).not.toHaveBeenCalled();
	});

	it('refuses a dropped and recreated same-named controller role', async () => {
		currentManaged('owner', '10');
		await expect(
			releasePgManagedAddress({
				executor: executor('owner', '99'),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			refusal: expect.objectContaining({ code: 'ERR-05', state: 'managed' }),
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
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
		).resolves.toMatchObject({
			outcome: 'release-refused',
			address,
			refusal: expect.objectContaining({ code: 'ERR-06', state: 'unknown' }),
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
			'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
			'BEGIN',
			'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid',
			'COMMIT',
		]);
	});
});
