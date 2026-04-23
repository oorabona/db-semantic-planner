/**
 * Tests for Identifier Validation (Block 1)
 */

import { describe, expect, it } from 'vitest';
import {
	InvalidIdentifierError,
	isReservedKeyword,
	sanitizeForDisplay,
	validateCollationName,
	validateIdentifier,
	validateIdentifiers,
	validateQualifiedIdentifier,
} from '../validate.js';

describe('Identifier Validation', () => {
	describe('validateIdentifier', () => {
		describe('valid identifiers', () => {
			it('accepts simple lowercase identifier', () => {
				expect(() => validateIdentifier('users', 'table')).not.toThrow();
			});

			it('accepts identifier with underscore', () => {
				expect(() =>
					validateIdentifier('user_profiles', 'table'),
				).not.toThrow();
			});

			it('accepts identifier starting with underscore', () => {
				expect(() => validateIdentifier('_private', 'column')).not.toThrow();
			});

			it('accepts identifier with digits', () => {
				expect(() => validateIdentifier('table1', 'table')).not.toThrow();
			});

			it('accepts identifier with dollar sign', () => {
				expect(() => validateIdentifier('col$1', 'column')).not.toThrow();
			});

			it('accepts uppercase identifiers', () => {
				expect(() => validateIdentifier('Users', 'table')).not.toThrow();
				expect(() => validateIdentifier('USERS', 'table')).not.toThrow();
			});

			it('accepts mixed case identifiers', () => {
				expect(() => validateIdentifier('userProfiles', 'table')).not.toThrow();
			});

			it('accepts max length identifier (63 chars)', () => {
				const maxLength = 'a'.repeat(63);
				expect(() => validateIdentifier(maxLength, 'table')).not.toThrow();
			});

			it('accepts SQL reserved keywords (they will be quoted)', () => {
				expect(() => validateIdentifier('select', 'column')).not.toThrow();
				expect(() => validateIdentifier('from', 'column')).not.toThrow();
				expect(() => validateIdentifier('where', 'column')).not.toThrow();
			});
		});

		describe('invalid identifiers', () => {
			it('rejects empty string', () => {
				expect(() => validateIdentifier('', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('', 'table')).toThrow(
					'cannot be empty',
				);
			});

			it('rejects identifier exceeding 63 characters', () => {
				const tooLong = 'a'.repeat(64);
				expect(() => validateIdentifier(tooLong, 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier(tooLong, 'table')).toThrow(
					'exceeds maximum length',
				);
			});

			it('rejects identifier starting with digit', () => {
				expect(() => validateIdentifier('1table', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('1table', 'table')).toThrow(
					'cannot start with a digit',
				);
			});

			it('rejects identifier with spaces', () => {
				expect(() => validateIdentifier('user table', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('user table', 'table')).toThrow(
					'contains invalid characters',
				);
			});

			it('rejects identifier with special characters', () => {
				expect(() => validateIdentifier('user-table', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('user.table', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier("user'table", 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('user"table', 'table')).toThrow(
					InvalidIdentifierError,
				);
			});

			it('rejects identifier with control characters', () => {
				expect(() => validateIdentifier('user\x00table', 'table')).toThrow(
					InvalidIdentifierError,
				);
				expect(() => validateIdentifier('user\ntable', 'table')).toThrow(
					'contains control characters',
				);
				expect(() => validateIdentifier('user\ttable', 'table')).toThrow(
					'contains control characters',
				);
			});

			it('rejects null byte', () => {
				expect(() => validateIdentifier('test\0', 'table')).toThrow(
					'contains control characters',
				);
			});

			it('includes identifier type in error message', () => {
				try {
					validateIdentifier('', 'schema');
				} catch (e) {
					expect(e).toBeInstanceOf(InvalidIdentifierError);
					expect((e as InvalidIdentifierError).identifierType).toBe('schema');
				}
			});

			it('includes identifier value in error', () => {
				try {
					validateIdentifier('bad-name', 'column');
				} catch (e) {
					expect(e).toBeInstanceOf(InvalidIdentifierError);
					expect((e as InvalidIdentifierError).identifier).toBe('bad-name');
				}
			});
		});
	});

	describe('validateQualifiedIdentifier', () => {
		it('parses simple table name', () => {
			const result = validateQualifiedIdentifier('users');
			expect(result).toEqual({ table: 'users' });
			expect(result.schema).toBeUndefined();
		});

		it('parses schema.table format', () => {
			const result = validateQualifiedIdentifier('public.users');
			expect(result).toEqual({ schema: 'public', table: 'users' });
		});

		it('validates both parts', () => {
			expect(() => validateQualifiedIdentifier('bad-schema.users')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateQualifiedIdentifier('public.bad-table')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects too many dots', () => {
			expect(() => validateQualifiedIdentifier('catalog.schema.table')).toThrow(
				'too many dots',
			);
		});

		it('rejects empty parts', () => {
			expect(() => validateQualifiedIdentifier('.users')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateQualifiedIdentifier('public.')).toThrow(
				InvalidIdentifierError,
			);
		});
	});

	describe('validateIdentifiers', () => {
		it('validates multiple identifiers', () => {
			expect(() =>
				validateIdentifiers({
					users: 'table',
					id: 'column',
					public: 'schema',
					u: 'alias',
				}),
			).not.toThrow();
		});

		it('throws on first invalid identifier', () => {
			expect(() =>
				validateIdentifiers({
					users: 'table',
					'bad-id': 'column', // Invalid
					public: 'schema',
				}),
			).toThrow(InvalidIdentifierError);
		});

		it('skips empty values', () => {
			expect(() =>
				validateIdentifiers({
					users: 'table',
					'': 'column', // Skipped because key is empty
				}),
			).not.toThrow();
		});
	});

	describe('isReservedKeyword', () => {
		it('detects SQL reserved keywords', () => {
			expect(isReservedKeyword('select')).toBe(true);
			expect(isReservedKeyword('SELECT')).toBe(true);
			expect(isReservedKeyword('from')).toBe(true);
			expect(isReservedKeyword('where')).toBe(true);
			expect(isReservedKeyword('join')).toBe(true);
			expect(isReservedKeyword('and')).toBe(true);
			expect(isReservedKeyword('or')).toBe(true);
			expect(isReservedKeyword('null')).toBe(true);
			expect(isReservedKeyword('true')).toBe(true);
			expect(isReservedKeyword('false')).toBe(true);
		});

		it('returns false for non-keywords', () => {
			expect(isReservedKeyword('users')).toBe(false);
			expect(isReservedKeyword('id')).toBe(false);
			expect(isReservedKeyword('email')).toBe(false);
			expect(isReservedKeyword('created_at')).toBe(false);
		});

		it('is case-insensitive', () => {
			expect(isReservedKeyword('SELECT')).toBe(true);
			expect(isReservedKeyword('Select')).toBe(true);
			expect(isReservedKeyword('select')).toBe(true);
		});
	});

	describe('sanitizeForDisplay', () => {
		it('replaces control characters', () => {
			expect(sanitizeForDisplay('test\x00value')).toBe('test?value');
			expect(sanitizeForDisplay('test\nvalue')).toBe('test?value');
			expect(sanitizeForDisplay('test\tvalue')).toBe('test?value');
		});

		it('truncates long strings', () => {
			const long = 'a'.repeat(200);
			expect(sanitizeForDisplay(long).length).toBe(100);
		});

		it('preserves normal characters', () => {
			expect(sanitizeForDisplay('normal_identifier')).toBe('normal_identifier');
		});
	});

	describe('InvalidIdentifierError', () => {
		it('has correct properties', () => {
			const error = new InvalidIdentifierError(
				'bad-value',
				'column',
				'test reason',
			);

			expect(error.name).toBe('InvalidIdentifierError');
			expect(error.identifier).toBe('bad-value');
			expect(error.identifierType).toBe('column');
			expect(error.reason).toBe('test reason');
			expect(error.message).toBe(
				'Invalid column identifier "bad-value": test reason',
			);
		});
	});

	describe('validateCollationName', () => {
		it('accepts collation with @euro modifier', () => {
			expect(() =>
				validateCollationName('de_DE.utf8@euro', 'collation'),
			).not.toThrow();
		});

		it('accepts collation without modifier (no regression)', () => {
			expect(() =>
				validateCollationName('en_US.utf8', 'collation'),
			).not.toThrow();
		});

		it('rejects bare @ with no modifier', () => {
			expect(() => validateCollationName('de_DE.utf8@', 'collation')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('rejects @modifier longer than 4 alphanumeric characters', () => {
			expect(() =>
				validateCollationName('de_DE.utf8@toolongmod', 'collation'),
			).toThrow(InvalidIdentifierError);
		});

		it('rejects @modifier containing non-alphanumeric characters', () => {
			expect(() =>
				validateCollationName('de_DE.utf8@has-dash', 'collation'),
			).toThrow(InvalidIdentifierError);
		});
	});
});
