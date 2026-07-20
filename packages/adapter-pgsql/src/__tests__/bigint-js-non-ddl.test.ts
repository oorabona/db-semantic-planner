import { schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { generateDDL } from '../ddl/ddl-generator.js';
import { compareSchemata } from '../ddl/schema-diff.js';

function bigintReadModel(js?: 'bigint' | 'number' | 'string') {
	return schema({
		events: {
			id: { type: 'integer', primaryKey: true },
			sequence: js === undefined ? { type: 'bigint' } : { type: 'bigint', js },
		},
	}).model;
}

describe('bigint js read type is non-DDL metadata', () => {
	it('does not affect compareSchemata changes in either direction', () => {
		const unchanged = bigintReadModel();
		const bigintRead = bigintReadModel('bigint');

		expect(compareSchemata(unchanged, bigintRead).changes).toEqual([]);
		expect(compareSchemata(bigintRead, unchanged).changes).toEqual([]);
	});

	it('does not affect generated DDL bytes', () => {
		const unchanged = generateDDL(bigintReadModel()).join('\n');
		const bigintRead = generateDDL(bigintReadModel('bigint')).join('\n');
		const numberRead = generateDDL(bigintReadModel('number')).join('\n');
		const stringRead = generateDDL(bigintReadModel('string')).join('\n');

		expect(bigintRead).toBe(unchanged);
		expect(numberRead).toBe(unchanged);
		expect(stringRead).toBe(unchanged);
	});
});
