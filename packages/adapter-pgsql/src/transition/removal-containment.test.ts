import {
	type LedgerAddress,
	ledgerAddressKey,
	sameLedgerAddress,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	classifyRemovalEffectsClosure,
	readPgRemovalEffectsClosure,
	reservationsForRemovalClosure,
} from './removal-containment.js';

const root: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'db',
	schema: 'public',
	kind: 'table',
	name: 'orders',
};
const child: LedgerAddress = {
	...root,
	kind: 'column',
	name: 'obsolete',
	parent: root,
};
const dependent: LedgerAddress = {
	...root,
	kind: 'table',
	name: 'order_events',
};

describe('removal effects closure', () => {
	it('uses one key-order-insensitive identity for parents and ownership keys', () => {
		const persistedParent = {
			database: 'db',
			catalogueIdentity: {
				value: { oid: '42', source: 'catalogue' },
				format: 1,
				engine: 'postgresql',
			},
			name: 'orders',
			kind: 'table',
			schema: 'public',
			engine: 'postgresql',
		};
		const localParent = {
			engine: 'postgresql',
			database: 'db',
			schema: 'public',
			kind: 'table',
			name: 'orders',
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { source: 'catalogue', oid: '42' },
			},
		};
		const persisted = {
			...root,
			kind: 'column',
			name: 'id',
			parent: persistedParent,
		};
		const local = {
			...root,
			kind: 'column',
			name: 'id',
			parent: localParent,
		};

		expect(sameLedgerAddress(persisted, local)).toBe(true);
		expect(ledgerAddressKey(persisted)).toBe(ledgerAddressKey(local));
		expect(
			sameLedgerAddress(
				{ ...root, kind: 'column', name: 'id' },
				{ ...root, kind: 'column', name: 'id', parent: null as never },
			),
		).toBe(true);
	});

	it('accounts contained children and reserves the root plus every managed dependent', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [{ address: child }, { address: dependent }],
			isManaged: (address) => address.name === dependent.name,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
		if (closure.kind !== 'all-contained-or-managed') return;
		expect(closure.managedDependents).toEqual([dependent]);
		expect(
			reservationsForRemovalClosure({
				closure,
				executionId: 'run',
				rootClaimId: 'claim',
				homeLedger: { scope: 'schema', schema: 'public' },
			}).map((reservation) => reservation.address),
		).toEqual([root, dependent]);
	});

	it('refuses the whole removal when an unmanaged cascade escapes containment', () => {
		const closure = classifyRemovalEffectsClosure({
			root,
			effects: [{ address: dependent }],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('reaches-unmanaged');
	});

	it('parent-accounts extension members without per-member reservations', () => {
		const extension = {
			...root,
			kind: 'extension',
			name: 'hstore',
		} as LedgerAddress;
		const closure = classifyRemovalEffectsClosure({
			root: extension,
			effects: [
				{
					address: { ...root, kind: 'undeclarable', name: 'hstore_type' },
					extensionMember: true,
				},
			],
			isManaged: () => false,
		});
		expect(closure.kind).toBe('all-contained-or-managed');
	});

	it('derives a table attribute parent from the live root OID, not the ledger key', async () => {
		const calls: (readonly unknown[] | undefined)[] = [];
		const closure = await readPgRemovalEffectsClosure({
			executor: {
				query: async (_sql, params) => {
					calls.push(params);
					return calls.length === 1
						? {
								rows: [{ oid: '42' }],
							}
						: {
								rows: [
									{
										kind: 'column',
										name: 'id',
										schema: 'public',
										parent_oid: '42',
									},
								],
							};
				},
			},
			root,
			isManaged: async () => false,
		});
		expect(calls[1]).toEqual(['42', 'pg_class']);
		expect(closure).toMatchObject({
			kind: 'all-contained-or-managed',
			effects: [{ address: { kind: 'column', name: 'id', parent: root } }],
		});
	});

	for (const [kind, catalogueClass] of [
		['enum', 'pg_type'],
		['constraint', 'pg_constraint'],
		['extension', 'pg_extension'],
		['column', 'pg_class'],
	] as const)
		it(`seeds ${kind} roots with ${catalogueClass}`, async () => {
			const calls: (readonly unknown[] | undefined)[] = [];
			const columnRoot = {
				...root,
				kind,
				name: `${kind}_root`,
				...(kind === 'column' ? { parent: root } : {}),
			};
			const closure = await readPgRemovalEffectsClosure({
				executor: {
					query: async (_sql, params) => {
						calls.push(params);
						return calls.length === 1
							? {
									rows: [
										{
											...(kind === 'column'
												? { parent_oid: '43', name: columnRoot.name }
												: { oid: '43' }),
										},
									],
								}
							: { rows: [] };
					},
				},
				root: columnRoot,
				isManaged: async () => false,
			});
			expect(calls[1]).toEqual(['43', catalogueClass]);
			expect(closure.kind).toBe('all-contained-or-managed');
		});
});
