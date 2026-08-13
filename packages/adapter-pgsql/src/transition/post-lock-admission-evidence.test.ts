import { describe, expect, it, vi } from 'vitest';
import { acquirePgLedgerLocks } from './ledger.js';
import {
	createPostLockAdmissionEvidence,
	isPostLockAdmissionEvidence,
	type PostLockAdmissionEvidence,
} from './post-lock-admission-evidence.js';

const home = { scope: 'schema' as const, schema: 'tenant' };

function typeChecks() {
	// @ts-expect-error PostLockAdmissionEvidence is adapter-branded, not structural.
	const forgedEvidence: PostLockAdmissionEvidence = {
		homes: [home],
		backendId: '42',
		transactionId: '77',
	};
	void forgedEvidence;
}
void typeChecks;

function lockedSession() {
	return {
		query: vi.fn(async () => ({ rows: [{ locked: true }] })),
	};
}

describe('PostLockAdmissionEvidence', () => {
	it('brands only evidence built after shape and currency checks on the locked session', async () => {
		const session = lockedSession();
		const locks = await acquirePgLedgerLocks(session, [home]);
		if (locks.kind !== 'acquired')
			throw new Error('test lock was not acquired');
		const classifyShape = vi.fn(async () => ({ kind: 'verified' as const }));
		const readCurrency = vi.fn(async () => ({ kind: 'current' as const }));
		const readSessionIdentity = vi.fn(async () => ({
			backendId: '42',
			transactionId: '77',
		}));

		const evidence = await createPostLockAdmissionEvidence(
			session,
			locks.proof,
			{
				classifyShape,
				readCurrency: readCurrency as never,
				readSessionIdentity,
			},
		);
		const clone = {
			homes: evidence.homes.map((candidate) => ({ ...candidate })),
			backendId: evidence.backendId,
			transactionId: evidence.transactionId,
		};

		expect(classifyShape).toHaveBeenCalledOnce();
		expect(readCurrency).toHaveBeenCalledOnce();
		expect(readSessionIdentity).toHaveBeenCalledOnce();
		expect(Object.isFrozen(evidence)).toBe(true);
		expect(isPostLockAdmissionEvidence(evidence)).toBe(true);
		expect(isPostLockAdmissionEvidence(clone)).toBe(false);
	});

	it('refuses a structural ordered-lock lookalike before consulting seams', async () => {
		const session = lockedSession();
		const classifyShape = vi.fn(async () => ({ kind: 'verified' as const }));
		const readCurrency = vi.fn(async () => ({ kind: 'current' as const }));

		await expect(
			createPostLockAdmissionEvidence(session, { homes: [home] } as never, {
				classifyShape,
				readCurrency: readCurrency as never,
				readSessionIdentity: async () => ({
					backendId: '42',
					transactionId: undefined,
				}),
			}),
		).rejects.toThrow('ordered ledger locks were not acquired');
		expect(classifyShape).not.toHaveBeenCalled();
		expect(readCurrency).not.toHaveBeenCalled();
	});
});
