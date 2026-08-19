import { describe, expect, it } from 'vitest';
import {
	type LedgerAddress,
	ledgerAddressKey,
	ledgerAddressParentJson,
	sameLedgerAddress,
} from './ledger.js';

const address: LedgerAddress = {
	scope: 'schema',
	engine: 'postgresql',
	database: 'app',
	schema: 'tenant',
	kind: 'table',
	name: 'accounts',
	parent: {
		engine: 'postgresql',
		database: 'app',
		schema: 'tenant',
		kind: 'schema',
		name: 'tenant',
	},
};

describe('ledger address equality', () => {
	it('OBL-PRED1 mutation: one address field off rejects while independently reconstructed value accepts', () => {
		expect(sameLedgerAddress(address, structuredClone(address))).toBe(true);
		expect(sameLedgerAddress(address, { ...address, name: 'Accounts' })).toBe(
			false,
		);
		expect(sameLedgerAddress(address, { ...address, scope: 'database' })).toBe(
			false,
		);
	});

	it('uses only the canonical address tuple for both equality and map keys', () => {
		const persisted: LedgerAddress = {
			...address,
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '41' },
			},
			qualifiedBy: ['catalogue'],
			parent: {
				...address.parent!,
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '40' },
				},
				qualifiedBy: ['persisted'],
			},
		};
		const observed: LedgerAddress = {
			...address,
			catalogueIdentity: {
				engine: 'postgresql',
				format: 1,
				value: { oid: '99' },
			},
			qualifiedBy: ['inspection'],
			parent: {
				...address.parent!,
				catalogueIdentity: {
					engine: 'postgresql',
					format: 1,
					value: { oid: '98' },
				},
				qualifiedBy: ['observed'],
			},
		};

		expect(sameLedgerAddress(persisted, observed)).toBe(true);
		expect(ledgerAddressKey(persisted)).toBe(ledgerAddressKey(observed));
		expect(ledgerAddressParentJson(persisted)).toBe(
			ledgerAddressParentJson(observed),
		);
	});
});
