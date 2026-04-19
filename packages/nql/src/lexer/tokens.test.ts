/**
 * Tests for NQL lexer token patterns.
 * P0-1: RangeValue regex must not greedily swallow integer subtraction like 10-5.
 */

import { describe, expect, it } from 'vitest';
import { Minus, NqlLexer, NumberLiteral, RangeValue } from './tokens.js';

describe('NqlLexer: RangeValue token', () => {
	it('tokenizes ISO date 2024-01-15 as a single RangeValue', () => {
		const result = NqlLexer.tokenize('2024-01-15');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]!.tokenType).toBe(RangeValue);
		expect(result.tokens[0]!.image).toBe('2024-01-15');
	});

	it('tokenizes datetime 2024-01-15T08:30 as a single RangeValue', () => {
		const result = NqlLexer.tokenize('2024-01-15T08:30');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]!.tokenType).toBe(RangeValue);
	});

	it('tokenizes HH:MM time 08:00 as a single RangeValue', () => {
		// Time-only ranges like [08:00,18:00) are valid NQL range values.
		const result = NqlLexer.tokenize('08:00');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]!.tokenType).toBe(RangeValue);
		expect(result.tokens[0]!.image).toBe('08:00');
	});

	it('does NOT tokenize integer subtraction 10-5 as RangeValue', () => {
		// P0-1: 10-5 must yield [NumberLiteral, Minus, NumberLiteral], not a
		// single RangeValue that coerces to the string '10-5'.
		const result = NqlLexer.tokenize('10-5');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens).toHaveLength(3);
		expect(result.tokens[0]!.tokenType).toBe(NumberLiteral);
		expect(result.tokens[0]!.image).toBe('10');
		expect(result.tokens[1]!.tokenType).toBe(Minus);
		expect(result.tokens[2]!.tokenType).toBe(NumberLiteral);
		expect(result.tokens[2]!.image).toBe('5');
	});

	it('does NOT tokenize 1-1 as RangeValue (short operands, no year prefix)', () => {
		const result = NqlLexer.tokenize('1-1');
		expect(result.errors).toHaveLength(0);
		// Must not be a single RangeValue token
		const first = result.tokens[0];
		expect(first?.tokenType).not.toBe(RangeValue);
	});

	it('tokenizes bare year 2024 as NumberLiteral (no separator group)', () => {
		// A bare year without a separator group is just a NumberLiteral
		const result = NqlLexer.tokenize('2024');
		expect(result.errors).toHaveLength(0);
		expect(result.tokens).toHaveLength(1);
		expect(result.tokens[0]!.tokenType).toBe(NumberLiteral);
	});
});
