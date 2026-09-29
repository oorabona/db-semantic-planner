import type { LedgerAddress, LedgerChainMember, LedgerHome } from '@dbsp/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	chain: vi.fn<
		(
			ledger: LedgerHome,
			address: LedgerAddress,
		) => Promise<{
			readonly ledger: LedgerHome;
			readonly address: LedgerAddress;
			readonly events: readonly LedgerChainMember[];
			readonly terminalMember?: LedgerChainMember;
		}>
	>(async (ledger, address) => ({ ledger, address, events: [] })),
	lock: vi.fn(async () => ({ kind: 'acquired' as const })),
	appendClaim: vi.fn(async () => undefined),
	appendResolution: vi.fn(async () => undefined),
}));

vi.mock('./chain-reader.js', () => ({
	readPgLedgerAddressChain: (
		_client: unknown,
		ledger: LedgerHome,
		address: LedgerAddress,
	) => mocks.chain(ledger, address),
}));
vi.mock('./ledger.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./ledger.js')>()),
	acquirePgLedgerLocks: () => mocks.lock(),
	appendPgLedgerClaim: () => mocks.appendClaim(),
	appendPgLedgerResolution: () => mocks.appendResolution(),
}));

import {
	createPgApplicationStepTx,
	planPgApplicationSteps,
	runPgApplicationSteps,
	validatePgConvergeApplicationSteps,
} from './application-step.js';

const apply = async () => undefined;

function completedOnceChain(
	ledger: LedgerHome,
	address: LedgerAddress,
	digest: string,
) {
	const declared = {
		value: { id: 'items-backfill', digest, step: 'once' },
		digest,
	} as const;
	const claim: LedgerChainMember = {
		eventId: 'application-step-claim',
		address,
		eventKind: 'intent',
		declared,
		controller: 'owner',
		controllerOid: '10',
	};
	const observed: LedgerChainMember = {
		eventId: 'application-step-observed',
		address,
		eventKind: 'observed',
		predecessor: claim.eventId,
		observed: declared,
		controller: 'owner',
		controllerOid: '10',
	};
	return {
		ledger,
		address,
		events: [claim, observed],
		terminalMember: observed,
	};
}

function queryWithCurrentController(text: string) {
	return text.startsWith('SELECT current_user')
		? { rows: [{ current_user: 'owner', current_user_oid: '10' }] }
		: { rows: [] };
}

afterEach(() => {
	mocks.chain.mockReset();
	mocks.chain.mockImplementation(async (ledger, address) => ({
		ledger,
		address,
		events: [],
	}));
	mocks.lock.mockReset();
	mocks.lock.mockResolvedValue({ kind: 'acquired' });
	mocks.appendClaim.mockReset();
	mocks.appendClaim.mockResolvedValue(undefined);
	mocks.appendResolution.mockReset();
	mocks.appendResolution.mockResolvedValue(undefined);
});

describe('converge application steps', () => {
	it.each([
		undefined,
		[
			{
				kind: 'once',
				id: '',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
			{
				kind: 'once',
				id: 'one',
				digest: 'v2',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: '',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				scope: 'database',
				phase: 'after-generated-ddl',
				apply,
			},
		],
		[{ kind: 'once', id: 'one', digest: 'v1', phase: 'later', apply }],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				lockTimeoutMs: 0,
				apply,
			},
		],
		[
			{
				kind: 'once',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply: 'no',
			},
		],
		[
			{
				kind: 'assert',
				id: 'one',
				digest: 'v1',
				phase: 'after-generated-ddl',
				apply,
			},
		],
	])('rejects invalid declarations before connection work', (steps) => {
		if (steps === undefined) {
			expect(validatePgConvergeApplicationSteps(steps)).toEqual([]);
			return;
		}
		expect(() => validatePgConvergeApplicationSteps(steps)).toThrow();
	});

	it('refuses transaction control through the callback facade', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		const tx = createPgApplicationStepTx({ query } as never);
		await expect(tx.query('BEGIN')).rejects.toThrow('transaction control');
		await expect(tx.query('  rollback')).rejects.toThrow('transaction control');
		await tx.query('SELECT 1');
		expect(query).toHaveBeenCalledWith('SELECT 1', []);
	});

	it('rolls back and identifies a planning inspection failure', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			Reflect.apply(planPgApplicationSteps, undefined, [
				{
					client: { query } as never,
					database: 'app',
					schema: 'public',
					steps: [
						{
							kind: 'assert',
							id: 'state-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							inspect: async () => {
								throw new Error('syntax error at or near "constraint"');
							},
							apply,
						},
					],
				},
			]),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
			message: 'syntax error at or near "constraint"',
		});
		expect(query.mock.calls.map(([text]) => text)).toEqual([
			'BEGIN READ ONLY',
			'ROLLBACK',
		]);
	});

	it('refuses an inspection status outside the public contract', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		await expect(
			Reflect.apply(planPgApplicationSteps, undefined, [
				{
					client: { query } as never,
					database: 'app',
					schema: 'public',
					steps: [
						{
							kind: 'assert',
							id: 'state-check',
							digest: 'v1',
							phase: 'after-generated-ddl',
							inspect: async () => 'unknown',
							apply,
						},
					],
				},
			]),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
		});
		expect(query.mock.calls.map(([text]) => text)).toEqual([
			'BEGIN READ ONLY',
			'ROLLBACK',
		]);
	});

	it('verifies an assert after applying it before recording the ledger row', async () => {
		const query = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
		const inspect = vi.fn(async () => 'unhealthy' as const);
		const repair = vi.fn(async () => undefined);
		await expect(
			runPgApplicationSteps({
				client: { query } as never,
				database: 'app',
				schema: 'public',
				phase: 'after-generated-ddl',
				steps: [
					{
						kind: 'assert',
						id: 'state-check',
						digest: 'v1',
						phase: 'after-generated-ddl',
						inspect,
						apply: repair,
					},
				],
			}),
		).rejects.toMatchObject({
			refusal: 'application-step-failed',
			stepId: 'state-check',
		});
		expect(repair).toHaveBeenCalledOnce();
		expect(inspect).toHaveBeenCalledTimes(2);
		expect(mocks.appendResolution).not.toHaveBeenCalled();
		expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
	});

	it('treats a completed once with its recorded digest as complete in apply and check mode', async () => {
		mocks.chain.mockImplementation(async (ledger, address) =>
			completedOnceChain(ledger, address, 'v1'),
		);
		const query = vi.fn(async (text: string) =>
			queryWithCurrentController(text),
		);
		const completed = {
			kind: 'once' as const,
			id: 'items-backfill',
			digest: 'v1',
			phase: 'after-generated-ddl' as const,
			apply: vi.fn(async () => undefined),
		};
		const input = {
			client: { query } as never,
			database: 'app',
			schema: 'public',
			steps: [completed],
		};

		await expect(planPgApplicationSteps(input)).resolves.toEqual([]);
		await expect(
			runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
		).resolves.toEqual([]);
		expect(completed.apply).not.toHaveBeenCalled();
		expect(mocks.appendClaim).not.toHaveBeenCalled();
		expect(mocks.appendResolution).not.toHaveBeenCalled();
	});

	it('refuses a completed once whose recorded digest changes in apply and check mode', async () => {
		mocks.chain.mockImplementation(async (ledger, address) =>
			completedOnceChain(ledger, address, 'v1'),
		);
		const query = vi.fn(async (text: string) =>
			queryWithCurrentController(text),
		);
		const changed = {
			kind: 'once' as const,
			id: 'items-backfill',
			digest: 'v2',
			phase: 'after-generated-ddl' as const,
			apply: vi.fn(async () => undefined),
		};
		const input = {
			client: { query } as never,
			database: 'app',
			schema: 'public',
			steps: [changed],
		};

		await expect(planPgApplicationSteps(input)).rejects.toMatchObject({
			refusal: 'application-step-changed',
			stepId: 'items-backfill',
		});
		await expect(
			runPgApplicationSteps({ ...input, phase: 'after-generated-ddl' }),
		).rejects.toMatchObject({
			refusal: 'application-step-changed',
			stepId: 'items-backfill',
		});
		expect(changed.apply).not.toHaveBeenCalled();
		expect(mocks.appendClaim).not.toHaveBeenCalled();
		expect(mocks.appendResolution).not.toHaveBeenCalled();
	});
});
