import type { LedgerAddress } from '@dbsp/types';
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
