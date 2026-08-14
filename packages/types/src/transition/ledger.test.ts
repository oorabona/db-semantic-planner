import { describe, expect, it } from 'vitest';
import { type LedgerAddress, sameLedgerAddress } from './ledger.js';

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
});
