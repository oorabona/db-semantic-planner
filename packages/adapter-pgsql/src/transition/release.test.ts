import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	locks: vi.fn(),
	currency: vi.fn(),
	readChain: vi.fn(),
	readControllerOid: vi.fn(),
	appendRelease: vi.fn(),
	physicalIntegrity: vi.fn(),
	postLockEvidence: vi.fn(),
	project: vi.fn(),
	readIdentity: vi.fn(),
}));

vi.mock('@dbsp/core', async (importOriginal) => ({
	...(await importOriginal<typeof import('@dbsp/core')>()),
	projectLedgerChain: mocks.project,
}));
vi.mock('./ledger.js', () => ({
	acquirePgLedgerLocks: mocks.locks,
	appendPgLedgerRelease: mocks.appendRelease,
	assertPgLedgerPhysicalShapeVerified: vi.fn(),
	classifyPgLedgerPhysicalShape: vi.fn(),
	isPgOrderedLedgerLocks: vi.fn(),
	validatePgLedgerPhysicalShape: mocks.physicalIntegrity,
}));
vi.mock('./post-lock-admission-evidence.js', () => ({
	createPostLockAdmissionEvidence: mocks.postLockEvidence,
}));
vi.mock('./reinitialize-preflight.js', () => ({
	readPgLedgerScopeCurrency: mocks.currency,
}));
vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: mocks.readChain,
	readPgLedgerControllerOid: mocks.readControllerOid,
}));
vi.mock('./catalogue-identity.js', () => ({
	readPgCatalogueIdentity: mocks.readIdentity,
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
		query: vi.fn(async (sql: string) => {
			if (sql.startsWith('SELECT pg_catalog.pg_is_in_recovery()'))
				return {
					rows: [
						{
							in_recovery: false,
							default_transaction_read_only: 'off',
							transaction_read_only: 'off',
						},
					],
				};
			return sql ===
				'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid'
				? {
						rows: [
							{ current_user: currentUser, current_user_oid: currentUserOid },
						],
					}
				: { rows: [] };
		}),
	};
}

function currentManaged(
	controller = 'owner',
	controllerOid = '10',
	managedAddress = address,
) {
	mocks.locks.mockResolvedValue({ kind: 'acquired' });
	mocks.currency.mockResolvedValue({ kind: 'current' });
	mocks.readChain.mockResolvedValue({
		terminalMember: {
			eventId: 'observed',
			address: managedAddress,
			controller,
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '42' },
			},
		},
	});
	mocks.readIdentity.mockResolvedValue({
		...managedAddress,
		catalogueIdentity: {
			engine: 'postgresql',
			format: 1,
			value: { oid: '42' },
		},
	});
	mocks.readControllerOid.mockResolvedValue(controllerOid);
	mocks.project.mockReturnValue({
		kind: 'projected-ledger-chain',
		stableState: 'managed',
	});
}

describe('PostgreSQL release admission', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.postLockEvidence.mockResolvedValue({});
	});

	it.each([
		['pending', { phase: 'claimed' }],
		['blocked', { phase: 'indeterminate' }],
	] as const)(
		'refuses a %s address without appending release',
		async (_word, openClaim) => {
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
		},
	);

	it('classifies a null-prototype relation-lock rejection without rethrowing it', async () => {
		currentManaged();
		const client = executor();
		const query = client.query.getMockImplementation()!;
		client.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('LOCK TABLE')) throw Object.create(null);
			return query(sql);
		});
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({
			outcome: 'release-unavailable',
			address,
			detail: 'relation lock failed while establishing a relation lock',
		});
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

	it('refuses post-lock physical-shape evidence failure before reading or appending', async () => {
		currentManaged();
		const proof = {};
		mocks.locks.mockResolvedValue({ kind: 'acquired', proof });
		mocks.postLockEvidence.mockRejectedValue(new Error('counterfeit ledger'));
		await expect(
			releasePgManagedAddress({
				executor: executor(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			refusal: expect.objectContaining({ code: 'ERR-06' }),
		});
		expect(mocks.postLockEvidence).toHaveBeenCalledWith(
			expect.anything(),
			proof,
		);
		expect(mocks.readChain).toHaveBeenCalledTimes(1);
		expect(mocks.appendRelease).not.toHaveBeenCalled();
	});

	it('OBL-CLI10: names a read-only database before release reads or appends', async () => {
		const client = executor();
		client.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('SELECT pg_catalog.pg_is_in_recovery()'))
				return {
					rows: [
						{
							in_recovery: false,
							default_transaction_read_only: 'on',
							transaction_read_only: 'on',
						},
					],
				};
			return { rows: [] };
		});
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({
			outcome: 'database-read-only',
			address,
			detail: 'database-read-only: target session is read-only',
		});
		expect(mocks.currency).not.toHaveBeenCalled();
		expect(mocks.readChain).not.toHaveBeenCalled();
		expect(mocks.appendRelease).not.toHaveBeenCalled();
	});

	it('appends exactly the released terminal shape atomically on success', async () => {
		const proof = {};
		currentManaged();
		mocks.locks.mockResolvedValue({ kind: 'acquired', proof });
		const client = executor();
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({ outcome: 'released' });
		expect(mocks.postLockEvidence).toHaveBeenCalledWith(client, proof);
		expect(mocks.appendRelease).toHaveBeenCalledWith(
			client,
			{ scope: 'schema', schema: 'tenant' },
			expect.objectContaining({
				address,
				eventKind: 'released',
				predecessor: 'observed',
			}),
		);
		expect(client.query).toHaveBeenCalledWith(
			'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
		);
		expect(client.query).toHaveBeenCalledWith(
			"SET LOCAL lock_timeout = '5000ms'",
		);
	});

	it.each([
		['Unicode', 'café', '"café"'],
		['spaces', 'order items', '"order items"'],
		['embedded double quotes', 'order"items', '"order""items"'],
		['hyphens', 'order-items', '"order-items"'],
	] as const)(
		'locks an adopted relation name with %s',
		async (_label, name, rendered) => {
			const adopted = { ...address, name };
			currentManaged('owner', '10', adopted);
			const client = executor();
			await expect(
				releasePgManagedAddress({
					executor: client,
					home: { scope: 'schema', schema: 'tenant' },
					address: adopted,
				}),
			).resolves.toEqual({ outcome: 'released' });
			expect(client.query).toHaveBeenCalledWith(
				`LOCK TABLE ONLY "tenant".${rendered} IN SHARE UPDATE EXCLUSIVE MODE`,
			);
		},
	);

	it('refuses a NUL-bearing adopted relation name before its lock query', async () => {
		const adopted = { ...address, name: 'order\0items' };
		currentManaged('owner', '10', adopted);
		const client = executor();
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address: adopted,
			}),
		).resolves.toEqual({
			outcome: 'release-unavailable',
			address: adopted,
			detail: 'PostgreSQL lock identifier must not contain NUL',
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
		expect(client.query).not.toHaveBeenCalledWith(
			expect.stringContaining('LOCK TABLE'),
		);
	});

	it.each([
		'permission denied for relation accounts',
		'canceling statement due to lock timeout',
	])('surfaces a relation lock failure truthfully: %s', async (message) => {
		currentManaged();
		const client = executor();
		client.query.mockImplementation(async (sql: string) => {
			if (sql.startsWith('SELECT pg_catalog.pg_is_in_recovery()'))
				return {
					rows: [
						{
							in_recovery: false,
							default_transaction_read_only: 'off',
							transaction_read_only: 'off',
						},
					],
				};
			if (
				sql ===
				'SELECT current_user AS current_user, current_user::regrole::oid::text AS current_user_oid'
			)
				return { rows: [{ current_user: 'owner', current_user_oid: '10' }] };
			if (sql.startsWith('LOCK TABLE')) throw new Error(message);
			return { rows: [] };
		});
		await expect(
			releasePgManagedAddress({
				executor: client,
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toEqual({
			outcome: 'release-unavailable',
			address,
			detail: 'relation lock failed while establishing a relation lock',
		});
		expect(client.query).toHaveBeenCalledWith(
			"SET LOCAL lock_timeout = '5000ms'",
		);
		expect(mocks.appendRelease).not.toHaveBeenCalled();
	});

	it('classifies a null-prototype catalogue rejection instead of throwing from its error wrapper', async () => {
		currentManaged();
		mocks.readIdentity.mockRejectedValue(Object.create(null));
		await expect(
			releasePgManagedAddress({
				executor: executor(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			refusal: { code: 'ERR-09', state: 'managed' },
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
	});

	it.each(['column', 'policy'] as const)(
		'locks the parent table for a %s release using the child schema',
		async (kind) => {
			const child = {
				...address,
				kind,
				name: kind === 'column' ? 'status' : 'accounts_policy',
				parent: { ...address, schema: 'stale_parent_schema' },
			};
			const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
			currentManaged('owner', '10', child as never);
			const client = executor();
			await expect(
				releasePgManagedAddress({
					executor: client,
					home: { scope: 'schema', schema: 'tenant' },
					address: child as never,
				}),
			).resolves.toEqual({ outcome: 'released' });
			expect(client.query).toHaveBeenCalledWith(
				'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
			);
			const relationLockOrder = client.query.mock.invocationCallOrder.find(
				(_order, index) =>
					client.query.mock.calls[index]?.[0] ===
					'LOCK TABLE ONLY "tenant"."accounts" IN SHARE UPDATE EXCLUSIVE MODE',
			);
			expect(mocks.readIdentity.mock.invocationCallOrder[0]).toBeLessThan(
				relationLockOrder!,
			);
			expect(relationLockOrder).toBeLessThan(
				mocks.readIdentity.mock.invocationCallOrder[1]!,
			);
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining('ignores mismatched parent schema'),
			);
			warning.mockRestore();
		},
	);

	it.each([
		['absent', undefined, 'ERR-05'],
		[
			'identity mismatch',
			{
				...address,
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '99' },
				},
			},
			'ERR-05',
		],
	] as const)(
		'refuses a live %s before appending release',
		async (_label, live, code) => {
			currentManaged();
			mocks.readIdentity.mockResolvedValue(live);
			await expect(
				releasePgManagedAddress({
					executor: executor(),
					home: { scope: 'schema', schema: 'tenant' },
					address,
				}),
			).resolves.toMatchObject({
				outcome: 'release-refused',
				refusal: expect.objectContaining({ code, state: 'managed' }),
			});
			expect(mocks.appendRelease).not.toHaveBeenCalled();
		},
	);

	it('refuses a managed terminal without a recorded identity', async () => {
		currentManaged();
		mocks.readChain.mockResolvedValue({
			terminalMember: { eventId: 'observed', address, controller: 'owner' },
		});
		await expect(
			releasePgManagedAddress({
				executor: executor(),
				home: { scope: 'schema', schema: 'tenant' },
				address,
			}),
		).resolves.toMatchObject({
			outcome: 'release-refused',
			refusal: expect.objectContaining({ code: 'ERR-05', state: 'managed' }),
		});
		expect(mocks.appendRelease).not.toHaveBeenCalled();
	});
});
