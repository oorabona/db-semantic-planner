import { describe, expect, it } from 'vitest';
import {
	isCheckConstraintNotValid,
	renderCheckConstraintClause,
	stripNotValidSuffix,
} from './check-expression.js';

describe('check-expression NOT VALID handling', () => {
	it('does not strip a bare predicate ending with NOT valid', () => {
		expect(
			renderCheckConstraintClause({
				expression: 'enabled AND NOT valid',
			}),
		).toBe('CHECK (enabled AND NOT valid)');
		expect(stripNotValidSuffix('enabled AND NOT valid')).toBe(
			'enabled AND NOT valid',
		);
		expect(
			isCheckConstraintNotValid({ expression: 'enabled AND NOT valid' }),
		).toBe(false);
	});

	it('strips and detects NOT VALID only after a full CHECK clause', () => {
		expect(stripNotValidSuffix('CHECK (enabled AND NOT valid) NOT VALID')).toBe(
			'CHECK (enabled AND NOT valid)',
		);
		expect(
			renderCheckConstraintClause({
				expression: 'CHECK (enabled AND NOT valid) NOT VALID',
			}),
		).toBe('CHECK (enabled AND NOT valid) NOT VALID');
	});

	it('renders explicit notValid on a bare predicate as a CHECK clause plus modifier', () => {
		expect(
			renderCheckConstraintClause({
				expression: 'enabled AND NOT valid',
				notValid: true,
			}),
		).toBe('CHECK (enabled AND NOT valid) NOT VALID');
	});

	it('preserves NO INHERIT while stripping and detecting the trailing NOT VALID modifier', () => {
		expect(stripNotValidSuffix('CHECK ((x > 0)) NO INHERIT NOT VALID')).toBe(
			'CHECK ((x > 0)) NO INHERIT',
		);
		expect(
			renderCheckConstraintClause({
				expression: 'CHECK ((x > 0)) NO INHERIT NOT VALID',
			}),
		).toBe('CHECK ((x > 0)) NO INHERIT NOT VALID');
		expect(
			renderCheckConstraintClause({
				expression: 'CHECK ((x > 0)) NO INHERIT NOT VALID',
				notValid: false,
			}),
		).toBe('CHECK ((x > 0)) NO INHERIT');
	});
});
