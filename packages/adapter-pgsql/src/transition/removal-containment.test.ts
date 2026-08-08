import {
	type LedgerAddress,
	ledgerAddressKey,
	sameLedgerAddress,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	classifyRemovalEffectsClosure,
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

	it('accounts contained children without separate claims and reserves managed dependents', () => {
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
			}),
		).toHaveLength(1);
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
});
