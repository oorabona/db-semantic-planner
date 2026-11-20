import { describe, expect, it } from 'vitest';
import { NotYetSupportedError } from './include-errors.js';

describe('NotYetSupportedError message', () => {
	it('writes "an" before a position that starts with a vowel', () => {
		expect(
			new NotYetSupportedError('outerRef()', 'expression argument', 1029)
				.message,
		).toBe(
			'outerRef() in an expression argument is not supported yet (#1029).',
		);
	});

	it('writes "a" before a position that starts with a consonant', () => {
		expect(
			new NotYetSupportedError('join', 'scalar subquery body', 1039).message,
		).toBe('join in a scalar subquery body is not supported yet (#1039).');
		expect(
			new NotYetSupportedError(
				'a qualified outerRef()',
				'local-source subquery body',
				1040,
			).message,
		).toBe(
			'a qualified outerRef() in a local-source subquery body is not supported yet (#1040).',
		);
	});
});
