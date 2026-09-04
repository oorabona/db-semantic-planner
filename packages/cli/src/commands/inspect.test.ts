import { createPgsqlGeneratedManagedStep } from '@dbsp/adapter-pgsql';
import { projectLedgerChain } from '@dbsp/core';
import { type LedgerAddress, ledgerAddressKey, refusalFor } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	inspectAddress,
	inspectRefusal,
	renderInspectHuman,
} from './inspect.js';

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
				refusal: refusalFor('ERR-05', {
					address,
					state: claimKind === 'retire-intent' ? 'managed' : 'unknown',
				}),
				controller: 'deploy',
			},
		],
	});
}

describe('inspect address selection', () => {
	it('OBL-CLI2 renders control bytes as escaped diagnostic text', () => {
		const rendered = renderInspectHuman({
			ledger: { scope: 'schema', schema: 'public' },
			marker: { kind: 'unreadable', reason: 'server\u0007text' },
			live: { kind: 'not-requested' },
		});
		expect(rendered).not.toContain('\u0007');
		expect(rendered).toContain('\\u0007');
	});

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

	it('addresses a parented index and database-scoped extension without flattening either address', () => {
		expect(
			inspectAddress(
				'app',
				'tenant',
				'index:orders_pkey',
				'table',
				'table:orders',
			),
		).toMatchObject({
			kind: 'index',
			name: 'orders_pkey',
			parent: { kind: 'table', name: 'orders', schema: 'tenant' },
		});
		expect(
			inspectAddress(
				'app',
				'tenant',
				'extension:hstore',
				'table',
				undefined,
				'database',
			),
		).toEqual({
			scope: 'database',
			engine: 'postgresql',
			database: 'app',
			kind: 'extension',
			name: 'hstore',
		});
	});

	it('C10 gives generated and inspect-side child addresses the same ledger key', () => {
		const generated = createPgsqlGeneratedManagedStep({
			change: {
				kind: 'create_index',
				table: 'orders',
				destructive: false,
				details: 'create index',
				meta: {
					index: { name: 'orders_created_at_idx', columns: ['created_at'] },
				},
			},
			database: 'app',
			schema: 'tenant',
			stepKey: 'generator:index',
			order: 0,
			statements: ['CREATE INDEX orders_created_at_idx ON orders (created_at)'],
		});
		const inspected = inspectAddress(
			'app',
			'tenant',
			'index:orders_created_at_idx',
			'table',
			'table:orders',
		);
		expect(ledgerAddressKey(generated.address!)).toBe(
			ledgerAddressKey(inspected),
		);
	});

	it.each([
		'index:orders_created_at_idx',
		'constraint:orders_pkey',
		'policy:tenant_policy',
	])('C03 tells inspect users that child %s needs --parent', (selector) => {
		expect(() => inspectAddress('app', 'tenant', selector)).toThrow(
			'requires --parent <kind:name>',
		);
	});
});

describe('SC-64 inspect refusal rendering', () => {
	it.each([
		['intent', 'unknown'],
		['retire-intent', 'managed'],
	] as const)(
		'renders a terminal %s refusal with the four actionable fields',
		(claimKind, state) => {
			const refusal = inspectRefusal(refusalProjection(claimKind));
			if (!refusal) throw new Error('expected terminal refusal');
			expect(refusal).toEqual({
				code: 'ERR-05',
				cause: 'recorded identity differs from the live object',
				address,
				state,
				withheldAuthority: 'managed mutation authority',
				resolvingCommand: 'dbsp apply',
			});
			// Text and --format json use the same serializer boundary.
			expect(
				JSON.parse(
					renderInspectHuman({
						ledger: { scope: 'schema', schema: 'public' },
						marker: { kind: 'current' },
						refusal,
						live: { kind: 'not-requested' },
					}),
				),
			).toMatchObject({ refusal });
		},
	);

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

describe('SC-67 inspect object-name output', () => {
	it('escapes a catalogue-derived object name in human output and emits parseable JSON', () => {
		const escapedAddress = {
			...address,
			name: 'accounts\n\u001b[2J',
		};
		const result = {
			address: escapedAddress,
			ledger: { scope: 'schema' as const, schema: 'public' },
			marker: { kind: 'current' as const },
			live: {
				kind: 'present' as const,
				catalogueIdentity: { engine: 'postgresql', value: { oid: '42' } },
			},
		};
		const human = renderInspectHuman(result);
		expect(human).toContain('accounts\\n\\u001b[2J');
		expect(human).not.toContain('\u001b[2J');
		expect(JSON.parse(human)).toMatchObject({ address: escapedAddress });
	});
});
