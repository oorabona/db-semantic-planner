import type { SequenceIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { camelCaseNaming, identityNaming } from './naming-plugin.js';
import {
	getSequenceDatabaseName,
	physicalizeDeclaredSequences,
	SequenceNameCollisionError,
	SequenceNameMapKeyMismatchError,
} from './sequence-name.js';

describe('declared sequence physical names', () => {
	it('maps an authored sequence through the naming plugin', () => {
		expect(
			getSequenceDatabaseName({ name: 'orderNumberSeq' }, camelCaseNaming),
		).toBe('order_number_seq');
		expect(
			getSequenceDatabaseName({ name: 'orderNumberSeq' }, identityNaming),
		).toBe('orderNumberSeq');
	});

	it('refuses two authored sequences with one physical name', () => {
		const sequences = new Map<string, SequenceIR>([
			['orderSeq', { name: 'orderSeq' }],
			['order_seq', { name: 'order_seq' }],
		]);

		expect(() =>
			physicalizeDeclaredSequences(sequences, camelCaseNaming),
		).toThrow(SequenceNameCollisionError);
		expect(() =>
			physicalizeDeclaredSequences(sequences, camelCaseNaming),
		).toThrow(/orderSeq.*order_seq.*order_seq/u);
	});

	it('refuses a declaration whose map key and name differ', () => {
		expect(() =>
			physicalizeDeclaredSequences(
				new Map([['a', { name: 'b' }]]),
				identityNaming,
			),
		).toThrow(SequenceNameMapKeyMismatchError);
	});
});
