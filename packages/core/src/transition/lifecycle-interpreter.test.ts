import type {
	LedgerAddress,
	LedgerChainMember,
	LedgerClaimKind,
	LedgerEventKind,
	LedgerStableState,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	LEDGER_LIFECYCLE_GRAMMAR,
	projectLedgerChain,
} from './lifecycle-interpreter.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
};

const ledger = { scope: 'schema', schema: 'tenant' } as const;
const observed = { value: { table: 'accounts' }, digest: 'observed' } as const;

function event(
	eventId: string,
	eventKind: LedgerEventKind,
	predecessor?: string,
): LedgerChainMember {
	return {
		eventId,
		address,
		eventKind,
		...(predecessor === undefined ? {} : { predecessor }),
		controller: 'deployment',
	};
}

function chainForState(state: LedgerStableState): LedgerChainMember[] {
	if (state === 'unknown') return [];
	const adopted = [
		event('adopt-intent', 'adopt-intent'),
		{ ...event('adopt', 'adopt', 'adopt-intent'), observed },
	];
	if (state === 'managed') return adopted;
	return [
		...adopted,
		event('retire-intent', 'retire-intent', 'adopt'),
		event('absent', 'absent', 'retire-intent'),
	];
}

function claimed(
	state: LedgerStableState,
	claimKind: LedgerClaimKind,
): LedgerChainMember[] {
	const prior = chainForState(state);
	const predecessor = prior.at(-1)?.eventId;
	return [
		...prior,
		{
			...event(`claim-${claimKind}`, claimKind, predecessor),
			...(claimKind === 'readdress-intent' ? { pairId: 'pair-1' } : {}),
		},
	];
}

function project(events: readonly LedgerChainMember[]) {
	return projectLedgerChain({ ledger, address, events });
}

describe('ledger lifecycle interpreter', () => {
	it('reports the stable state separately from pending and blocked claims (SC-27)', () => {
		const fixtures: readonly [
			string,
			readonly LedgerChainMember[],
			string,
			LedgerStableState,
		][] = [
			['managed', chainForState('managed'), 'managed', 'managed'],
			['pending', claimed('managed', 'intent'), 'pending', 'managed'],
			[
				'blocked',
				[
					...claimed('managed', 'intent'),
					event('indeterminate', 'indeterminate', 'claim-intent'),
				],
				'blocked',
				'managed',
			],
			['absent', chainForState('absent'), 'absent', 'absent'],
			['unknown', [], 'unknown', 'unknown'],
		];

		for (const [name, events, reported, stableState] of fixtures) {
			const result = project(events);
			expect(result.kind, name).toBe('projected-ledger-chain');
			if (result.kind !== 'projected-ledger-chain') continue;
			expect(result.stableState, name).toBe(stableState);
			expect(result.reportedState.kind, name).toBe(reported);
			if (
				result.reportedState.kind === 'pending' ||
				result.reportedState.kind === 'blocked'
			) {
				expect(result.reportedState.stableState, name).toBe(stableState);
				expect(result.reportedState.claim.kind, name).toBe('intent');
			}
		}
	});

	it('keeps the preceding stable state when a creation or modification is refused (SC-28)', () => {
		const refusedModification = project([
			...claimed('managed', 'intent'),
			event('refused-modification', 'refused', 'claim-intent'),
		]);
		const refusedCreation = project([
			...claimed('unknown', 'intent'),
			event('refused-creation', 'refused', 'claim-intent'),
		]);
		for (const [name, result, stableState] of [
			['modification', refusedModification, 'managed'],
			['creation', refusedCreation, 'unknown'],
		] as const) {
			expect(result.kind, name).toBe('projected-ledger-chain');
			if (result.kind !== 'projected-ledger-chain') continue;
			expect(result.stableState, name).toBe(stableState);
		}
	});

	it('understands the closed-vocabulary release event without inventing a fifteenth kind', () => {
		const result = project([
			...chainForState('managed'),
			event('released', 'released', 'adopt'),
		]);
		expect(result).toMatchObject({
			kind: 'projected-ledger-chain',
			stableState: 'unknown',
			reportedState: { kind: 'unknown' },
		});
	});

	it('draws resolved outcomes from the originating claim column', () => {
		const created = project([
			...claimed('unknown', 'intent'),
			event('create-indeterminate', 'indeterminate', 'claim-intent'),
			{
				...event('create-resolved', 'resolved', 'create-indeterminate'),
				observed,
			},
		]);
		const retired = project([
			...claimed('managed', 'retire-intent'),
			event('retire-indeterminate', 'indeterminate', 'claim-retire-intent'),
			event('retire-resolved', 'resolved', 'retire-indeterminate'),
		]);
		for (const [result, stableState] of [
			[created, 'managed'],
			[retired, 'absent'],
		] as const) {
			expect(result).toMatchObject({
				kind: 'projected-ledger-chain',
				stableState,
			});
		}
	});

	it('returns structured malformed-chain values for every degraded chain shape (SC-29)', () => {
		const malformed = [
			[
				'cycle',
				[event('one', 'intent', 'two'), event('two', 'refused', 'one')],
				'cycle',
			],
			[
				'missing predecessor',
				[event('one', 'intent', 'missing')],
				'missing-predecessor',
			],
			[
				'fork',
				[
					event('one', 'intent'),
					event('two', 'refused', 'one'),
					event('three', 'refused', 'one'),
				],
				'fork',
			],
			[
				'unknown event kind',
				[
					{
						...event('one', 'intent'),
						eventKind: 'not-a-ledger-event' as LedgerEventKind,
					},
				],
				'unknown-event-kind',
			],
		] as const;
		for (const [name, events, code] of malformed) {
			const result = project(events);
			expect(result.kind, name).toBe('unprojectable-ledger-chain');
			if (result.kind !== 'unprojectable-ledger-chain') continue;
			expect(result.reason.code, name).toBe(code);
			expect(result.ledger, name).toEqual(ledger);
			expect(result.address, name).toEqual(address);
			expect(result.events, name).toEqual(events);
			expect(result.codeVersion, name).toBe(1);
		}
	});

	it('walks every grammar-matrix cell, admitting only the named opening states', () => {
		const states: readonly LedgerStableState[] = [
			'unknown',
			'managed',
			'absent',
		];
		for (const [claimKind, column] of Object.entries(
			LEDGER_LIFECYCLE_GRAMMAR,
		) as [
			LedgerClaimKind,
			(typeof LEDGER_LIFECYCLE_GRAMMAR)[LedgerClaimKind],
		][]) {
			for (const state of states) {
				const result = project(claimed(state, claimKind));
				const legal = column.opensFrom.includes(state);
				expect(
					result.kind === 'projected-ledger-chain',
					`${claimKind} from ${state}`,
				).toBe(legal);
			}
		}
	});

	it('walks every resolution column, rejecting every event outside it', () => {
		const kinds: readonly LedgerEventKind[] = [
			'adopt-intent',
			'adopt',
			'intent',
			'retire-intent',
			'readdress-intent',
			'refused',
			'executing',
			'observed',
			'absent',
			'indeterminate',
			'resolved',
			'readdressed-to',
			'readdressed-from',
			'released',
		];
		for (const [claimKind, column] of Object.entries(
			LEDGER_LIFECYCLE_GRAMMAR,
		) as [
			LedgerClaimKind,
			(typeof LEDGER_LIFECYCLE_GRAMMAR)[LedgerClaimKind],
		][]) {
			for (const kind of kinds) {
				const state =
					claimKind === 'readdress-intent' && kind === 'readdressed-to'
						? 'managed'
						: (column.opensFrom[0] ?? 'unknown');
				const base = claimed(state, claimKind);
				const predecessor = base.at(-1)?.eventId;
				const resolution = {
					...event(`resolution-${claimKind}-${kind}`, kind, predecessor),
					...(kind === 'observed' ||
					kind === 'adopt' ||
					kind === 'readdressed-from'
						? { observed }
						: {}),
					...(kind === 'readdressed-to' || kind === 'readdressed-from'
						? { pairId: 'pair-1' }
						: {}),
				};
				const events =
					kind === 'resolved'
						? [
								...base,
								event(
									'indeterminate-before-resolution',
									'indeterminate',
									predecessor,
								),
								{
									...resolution,
									predecessor: 'indeterminate-before-resolution',
									observed,
								},
							]
						: [...base, resolution];
				const result = project(events);
				const legal = column.resolvesThrough.includes(kind);
				expect(
					result.kind === 'projected-ledger-chain',
					`${claimKind} -> ${kind}`,
				).toBe(legal);
			}
		}
	});
});
