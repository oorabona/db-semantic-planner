import { describe, expect, it } from 'vitest';
import type { SourceLocation } from './types.js';
import {
	createLexerError,
	createParseError,
	createSemanticError,
	formatError,
	NqlErrorCodes,
	NqlSemanticException,
} from './types.js';

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------
describe('formatError', () => {
	const loc: SourceLocation = { line: 3, column: 7, offset: 42 };

	it('includes location when present', () => {
		const err = createLexerError('ERR-LEX-001', 'Bad char', loc);
		expect(formatError(err)).toBe('[ERR-LEX-001] Bad char (line 3, column 7)');
	});

	it('omits location when absent', () => {
		const err = createLexerError('ERR-LEX-001', 'Bad char');
		expect(formatError(err)).toBe('[ERR-LEX-001] Bad char');
	});

	it('includes suggestion when present', () => {
		const err = createSemanticError(
			'ERR-SEM-001',
			'Unknown column',
			undefined,
			'Did you mean "name"?',
		);
		expect(formatError(err)).toBe(
			'[ERR-SEM-001] Unknown column\n  → Did you mean "name"?',
		);
	});

	it('omits suggestion when absent', () => {
		const err = createSemanticError('ERR-SEM-001', 'Unknown column');
		expect(formatError(err)).not.toContain('→');
	});

	it('includes both location and suggestion', () => {
		const err = createSemanticError(
			'ERR-SEM-001',
			'Unknown column',
			loc,
			'Did you mean "name"?',
		);
		const formatted = formatError(err);
		expect(formatted).toContain('(line 3, column 7)');
		expect(formatted).toContain('→ Did you mean "name"?');
		// Location comes before suggestion
		const locIdx = formatted.indexOf('(line');
		const sugIdx = formatted.indexOf('→');
		expect(locIdx).toBeLessThan(sugIdx);
	});

	it('handles neither location nor suggestion', () => {
		const err = createSemanticError('ERR-SEM-001', 'Problem');
		expect(formatError(err)).toBe('[ERR-SEM-001] Problem');
	});
});

// ---------------------------------------------------------------------------
// createLexerError
// ---------------------------------------------------------------------------
describe('createLexerError', () => {
	it('sets all fields when all params provided', () => {
		const loc: SourceLocation = { line: 1, column: 5, offset: 4 };
		const err = createLexerError('ERR-LEX-001', 'Unexpected char', loc, '@');
		expect(err.code).toBe('ERR-LEX-001');
		expect(err.message).toBe('Unexpected char');
		expect(err.location).toEqual(loc);
		expect(err.unexpectedChar).toBe('@');
	});

	it('leaves optional fields undefined when omitted', () => {
		const err = createLexerError('ERR-LEX-002', 'Unterminated string');
		expect(err.location).toBeUndefined();
		expect(err.unexpectedChar).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// createParseError
// ---------------------------------------------------------------------------
describe('createParseError', () => {
	it('sets all fields when all params provided', () => {
		const loc: SourceLocation = { line: 2, column: 10, offset: 20 };
		const err = createParseError(
			'ERR-PARSE-001',
			'Unexpected token',
			loc,
			['SELECT', 'FROM'],
			'WHERE',
		);
		expect(err.code).toBe('ERR-PARSE-001');
		expect(err.message).toBe('Unexpected token');
		expect(err.location).toEqual(loc);
		expect(err.expected).toEqual(['SELECT', 'FROM']);
		expect(err.found).toBe('WHERE');
	});

	it('leaves optional fields undefined when omitted', () => {
		const err = createParseError('ERR-PARSE-002', 'Missing WHERE');
		expect(err.location).toBeUndefined();
		expect(err.expected).toBeUndefined();
		expect(err.found).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// createSemanticError
// ---------------------------------------------------------------------------
describe('createSemanticError', () => {
	it('sets all fields when all params provided', () => {
		const loc: SourceLocation = { line: 5, column: 3, offset: 55 };
		const err = createSemanticError(
			'ERR-SEM-001',
			'Unknown column',
			loc,
			'Did you mean "email"?',
			'users.emal',
		);
		expect(err.code).toBe('ERR-SEM-001');
		expect(err.message).toBe('Unknown column');
		expect(err.location).toEqual(loc);
		expect(err.suggestion).toBe('Did you mean "email"?');
		expect(err.relatedSymbol).toBe('users.emal');
	});

	it('leaves optional fields undefined when omitted', () => {
		const err = createSemanticError('ERR-SEM-002', 'Aggregate before group');
		expect(err.location).toBeUndefined();
		expect(err.suggestion).toBeUndefined();
		expect(err.relatedSymbol).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// NqlSemanticException
// ---------------------------------------------------------------------------
describe('NqlSemanticException', () => {
	it('sets all properties from constructor', () => {
		const loc: SourceLocation = { line: 10, column: 1, offset: 100 };
		const ex = new NqlSemanticException(
			'ERR-SEM-003',
			'Circular reference',
			loc,
			'Check your joins',
			'orders.user_id',
		);
		expect(ex.code).toBe('ERR-SEM-003');
		expect(ex.message).toBe('Circular reference');
		expect(ex.location).toEqual(loc);
		expect(ex.suggestion).toBe('Check your joins');
		expect(ex.relatedSymbol).toBe('orders.user_id');
	});

	it('has name "NqlSemanticException"', () => {
		const ex = new NqlSemanticException('ERR-SEM-001', 'test');
		expect(ex.name).toBe('NqlSemanticException');
	});

	it('is instanceof Error', () => {
		const ex = new NqlSemanticException('ERR-SEM-001', 'test');
		expect(ex).toBeInstanceOf(Error);
	});

	it('is instanceof NqlSemanticException', () => {
		const ex = new NqlSemanticException('ERR-SEM-001', 'test');
		expect(ex).toBeInstanceOf(NqlSemanticException);
	});

	it('leaves optional fields undefined when omitted', () => {
		const ex = new NqlSemanticException('ERR-SEM-004', 'Duplicate binding');
		expect(ex.location).toBeUndefined();
		expect(ex.suggestion).toBeUndefined();
		expect(ex.relatedSymbol).toBeUndefined();
	});

	it('code matches ERR-SEM-xxx pattern', () => {
		const ex = new NqlSemanticException('ERR-SEM-999', 'test');
		expect(ex.code).toMatch(/^ERR-SEM-.+$/);
	});
});

// ---------------------------------------------------------------------------
// NqlErrorCodes
// ---------------------------------------------------------------------------
describe('NqlErrorCodes', () => {
	it('lexer codes follow ERR-LEX-xxx convention', () => {
		const lexCodes = Object.entries(NqlErrorCodes).filter(([key]) =>
			key.startsWith('LEX_'),
		);
		expect(lexCodes.length).toBeGreaterThan(0);
		for (const [, value] of lexCodes) {
			expect(value).toMatch(/^ERR-LEX-\d{3}$/);
		}
	});

	it('parser codes follow ERR-PARSE-xxx convention', () => {
		const parseCodes = Object.entries(NqlErrorCodes).filter(([key]) =>
			key.startsWith('PARSE_'),
		);
		expect(parseCodes.length).toBeGreaterThan(0);
		for (const [, value] of parseCodes) {
			expect(value).toMatch(/^ERR-PARSE-\d{3}$/);
		}
	});

	it('semantic codes follow ERR-SEM-xxx convention', () => {
		const semCodes = Object.entries(NqlErrorCodes).filter(([key]) =>
			key.startsWith('SEM_'),
		);
		expect(semCodes.length).toBeGreaterThan(0);
		for (const [, value] of semCodes) {
			expect(value).toMatch(/^ERR-SEM-\d{3}$/);
		}
	});

	it('limit codes follow ERR-LIMIT-xxx convention', () => {
		const limitCodes = Object.entries(NqlErrorCodes).filter(([key]) =>
			key.startsWith('LIMIT_'),
		);
		expect(limitCodes.length).toBeGreaterThan(0);
		for (const [, value] of limitCodes) {
			expect(value).toMatch(/^ERR-LIMIT-\d{3}$/);
		}
	});

	it('contains expected total count of error codes', () => {
		const allCodes = Object.keys(NqlErrorCodes);
		// 3 LEX + 4 PARSE + 8 SEM + 3 LIMIT = 18
		expect(allCodes).toHaveLength(18);
	});

	it('all values are unique', () => {
		const values = Object.values(NqlErrorCodes);
		const unique = new Set(values);
		expect(unique.size).toBe(values.length);
	});
});
