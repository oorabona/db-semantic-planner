import type { SequenceIR } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { camelCaseNaming, identityNaming } from './naming-plugin.js';
import {
	getSequenceDatabaseName,
	LegacySequenceNameError,
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

	it('prints legacy sequence SQL only with valid schema-qualified identifiers', () => {
		expect(
			new LegacySequenceNameError('orderNumberSeq', 'order_number_seq').message,
		).toContain(
			'Rename "orderNumberSeq" to "order_number_seq" before comparing',
		);
		expect(
			new LegacySequenceNameError('orderNumberSeq', 'order_number_seq').message,
		).not.toContain('ALTER SEQUENCE');
		expect(
			new LegacySequenceNameError(
				'orderNumberSeq',
				'order_number_seq',
				'tenant_a',
			).message,
		).toContain(
			'ALTER SEQUENCE "tenant_a"."orderNumberSeq" RENAME TO "order_number_seq"',
		);
		expect(
			new LegacySequenceNameError('bad"name', 'order_number_seq', 'tenant_a')
				.message,
		).not.toContain('ALTER SEQUENCE');
	});

	it('escapes hostile sequence identifiers in single-line diagnostics', () => {
		const name = 'bad\\name\nnext';
		for (const error of [
			new SequenceNameMapKeyMismatchError(name, name),
			new SequenceNameCollisionError(name, name, name),
			new LegacySequenceNameError(name, name),
		]) {
			expect(error.message).not.toMatch(/[\r\n]/u);
			expect(error.message).toContain('bad\\\\name\\nnext');
		}
	});
});
