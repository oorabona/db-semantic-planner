import { projectLedgerChain } from '@dbsp/core';
import type { LedgerAddress } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { serializeCliJson } from '../utils/output.js';
import { inspectAddress, inspectRefusal } from './inspect.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'fixture',
	schema: 'public',
	kind: 'table',
	name: 'accounts',
};

function refusalProjection(claimKind: 'intent' | 'retire-intent' = 'intent') {
	const managedPrefix =
		claimKind === 'retire-intent'
			? [
					{
						eventId: 'adopt-claim',
						address,
						eventKind: 'adopt-intent' as const,
						controller: 'deploy',
					},
					{
						eventId: 'adopted',
						address,
						eventKind: 'adopt' as const,
						predecessor: 'adopt-claim',
						observed: { value: { table: 'accounts' }, digest: 'observed' },
						controller: 'deploy',
					},
				]
			: [];
	return projectLedgerChain({
		ledger: { scope: 'schema', schema: 'public' },
		address,
		events: [
			...managedPrefix,
			{
				eventId: 'claim',
				address,
				eventKind: claimKind,
				...(claimKind === 'retire-intent' ? { predecessor: 'adopted' } : {}),
				controller: 'deploy',
			},
			{
				eventId: 'refused',
				address,
				eventKind: 'refused',
				predecessor: 'claim',
				controller: 'deploy',
			},
		],
	});
}

describe('inspect address selection', () => {
	it('uses the supplied kind prefix without appending a ledger event', () => {
		expect(inspectAddress('app', 'tenant', 'enum:status')).toEqual({
			scope: 'schema',
			engine: 'postgresql',
			database: 'app',
			schema: 'tenant',
			kind: 'enum',
			name: 'status',
		});
	});

	it('keeps an unqualified selector at the caller supplied kind', () => {
		expect(inspectAddress('app', 'tenant', 'orders', 'table')).toMatchObject({
			kind: 'table',
			name: 'orders',
		});
	});
});

describe('SC-64 inspect refusal rendering', () => {
	it.each([
		['intent', 'intent execution authority', 'unknown'],
		['retire-intent', 'retire-intent execution authority', 'managed'],
	] as const)('renders a terminal %s refusal with the four actionable fields', (claimKind, withheldAuthority, state) => {
		const refusal = inspectRefusal(refusalProjection(claimKind));
		expect(refusal).toEqual({
			cause: 'claim claim recorded a refusal',
			address,
			state,
			withheldAuthority,
			resolvingCommand: 'dbsp apply',
		});
		// Text and --format json use the same serializer boundary.
		expect(JSON.parse(serializeCliJson({ refusal }))).toEqual({ refusal });
	});

	it('keeps ERR-02 as the prescribed unknown state, not a refusal', () => {
		const projection = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'public' },
			address,
			events: [],
		});
		expect(projection).toMatchObject({
			kind: 'projected-ledger-chain',
			stableState: 'unknown',
		});
		expect(inspectRefusal(projection)).toBeUndefined();
	});

	it('keeps ERR-08 malformed chains readable without inventing a refusal', () => {
		const projection = projectLedgerChain({
			ledger: { scope: 'schema', schema: 'public' },
			address,
			events: [
				{
					eventId: 'one',
					address,
					eventKind: 'intent',
					predecessor: 'two',
					controller: 'deploy',
				},
				{
					eventId: 'two',
					address,
					eventKind: 'refused',
					predecessor: 'one',
					controller: 'deploy',
				},
			],
		});
		expect(projection).toMatchObject({
			kind: 'unprojectable-ledger-chain',
			reason: { code: 'cycle' },
		});
		expect(inspectRefusal(projection)).toBeUndefined();
	});
});
