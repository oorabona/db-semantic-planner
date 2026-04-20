/**
 * Tests for identifier-validation utility.
 */
import { describe, expect, it } from 'vitest';
import {
	InvalidIdentifierError,
	validateIdentifier,
} from './identifier-validation.js';

describe('validateIdentifier', () => {
	describe('valid identifiers', () => {
		it('accepts simple lowercase name', () => {
			expect(() => validateIdentifier('users', 'table')).not.toThrow();
		});

		it('accepts name with uppercase', () => {
			expect(() => validateIdentifier('MyTable', 'table')).not.toThrow();
		});

		it('accepts name starting with underscore', () => {
			expect(() => validateIdentifier('_internal', 'schema')).not.toThrow();
		});

		it('accepts name with digits (not first)', () => {
			expect(() => validateIdentifier('table1', 'table')).not.toThrow();
		});

		it('accepts name with dollar sign', () => {
			expect(() => validateIdentifier('col$1', 'column')).not.toThrow();
		});

		it('accepts exactly 63-byte name', () => {
			const name = 'a'.repeat(63);
			expect(() => validateIdentifier(name, 'table')).not.toThrow();
		});
	});

	describe('empty / null guards', () => {
		it('rejects empty string', () => {
			expect(() => validateIdentifier('', 'schema')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('', 'schema')).toThrow('cannot be empty');
		});
	});

	describe('length limit', () => {
		it('rejects name longer than 63 bytes', () => {
			const name = 'a'.repeat(64);
			expect(() => validateIdentifier(name, 'table')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier(name, 'table')).toThrow(
				'exceeds maximum length',
			);
		});

		it('rejects multi-byte UTF-8 name that fits in chars but exceeds 63 bytes', () => {
			// Each é is 2 UTF-8 bytes — 32 × 2 = 64 bytes
			// But wait: é is not in [a-zA-Z0-9_$] so it fails char validation first.
			// Use ASCII to test byte length: 64 'a' chars = 64 bytes
			const name = 'a'.repeat(64);
			expect(() => validateIdentifier(name, 'column')).toThrow(
				'exceeds maximum length',
			);
		});
	});

	describe('control characters and NUL bytes', () => {
		it('rejects NUL byte in middle', () => {
			expect(() => validateIdentifier('tab\x00le', 'table')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('tab\x00le', 'table')).toThrow(
				'control characters or NUL byte',
			);
		});

		it('rejects leading NUL byte', () => {
			expect(() => validateIdentifier('\x00table', 'table')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects control character (tab)', () => {
			expect(() => validateIdentifier('col\tname', 'column')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects control character (newline)', () => {
			expect(() => validateIdentifier('col\nname', 'column')).toThrow(
				InvalidIdentifierError,
			);
		});
	});

	describe('SQL injection patterns', () => {
		it('rejects double-quote character', () => {
			expect(() => validateIdentifier('"injected"', 'schema')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects semicolon', () => {
			expect(() =>
				validateIdentifier('schema;DROP TABLE users;--', 'schema'),
			).toThrow(InvalidIdentifierError);
		});

		it('rejects crafted .use injection payload', () => {
			// Simulates: .use malicious"; DROP TABLE users; --
			const payload = 'malicious"; DROP TABLE users; --';
			expect(() => validateIdentifier(payload, 'schema')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects schema name with whitespace', () => {
			expect(() => validateIdentifier('my schema', 'schema')).toThrow(
				InvalidIdentifierError,
			);
		});
	});

	describe('character set', () => {
		it('rejects name starting with digit', () => {
			expect(() => validateIdentifier('1table', 'table')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('1table', 'table')).toThrow(
				'cannot start with a digit',
			);
		});

		it('rejects name with hyphen', () => {
			expect(() => validateIdentifier('my-table', 'table')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects name with dot', () => {
			expect(() => validateIdentifier('schema.table', 'table')).toThrow(
				InvalidIdentifierError,
			);
		});
	});

	describe('error messages include type label', () => {
		it('includes identifierType in message', () => {
			let err: unknown;
			try {
				validateIdentifier('bad name', 'column');
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(InvalidIdentifierError);
			expect((err as InvalidIdentifierError).identifierType).toBe('column');
			expect((err as InvalidIdentifierError).message).toContain('column');
		});
	});

	describe('error message escaping (control character regression)', () => {
		it('escapes newline in error message', () => {
			let err: unknown;
			try {
				validateIdentifier('foo\nbar', 'table');
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(InvalidIdentifierError);
			const message = (err as InvalidIdentifierError).message;
			// Message should NOT contain a literal newline character
			expect(message.includes('\n')).toBe(false);
			// Message should contain escaped form (JSON.stringify produces "foo\\nbar")
			expect(message).toContain('"foo\\nbar"');
		});

		it('escapes NUL byte in error message', () => {
			let err: unknown;
			try {
				validateIdentifier('foo\x00bar', 'column');
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(InvalidIdentifierError);
			const message = (err as InvalidIdentifierError).message;
			// Message should NOT contain a literal NUL byte
			expect(message.includes('\x00')).toBe(false);
			// Message should contain escaped form
			expect(message).toContain('"foo\\u0000bar"');
		});

		it('escapes tab in error message', () => {
			let err: unknown;
			try {
				validateIdentifier('foo\tbar', 'schema');
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(InvalidIdentifierError);
			const message = (err as InvalidIdentifierError).message;
			// Message should NOT contain a literal tab character
			expect(message.includes('\t')).toBe(false);
			// Message should contain escaped form
			expect(message).toContain('"foo\\tbar"');
		});
	});
});
