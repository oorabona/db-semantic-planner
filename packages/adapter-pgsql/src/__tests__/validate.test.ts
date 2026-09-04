/**
 * Tests for Identifier Validation (Block 1)
 */

import { describe, expect, it } from 'vitest';
import {
	escapeDiagnosticText,
	InvalidIdentifierError,
	isReservedKeyword,
	sanitizeForDisplay,
	validateCheckExpression,
	validateCollationName,
	validateIdentifier,
	validateIdentifiers,
	validateQualifiedIdentifier,
} from '../validate.js';

describe('escapeDiagnosticText', () => {
	it('escapes Unicode line separators, bidi controls, and backslashes unambiguously', () => {
		expect(
			escapeDiagnosticText('left\\nright\nnext\u2028line\u202eright'),
		).toBe('left\\\\nright\\nnext\\u2028line\\u202eright');
	});
});

function getCheckValidationError(sql: string): Error {
	try {
		validateCheckExpression(sql, 'test check');
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error('Expected validateCheckExpression to throw');
}

describe('validateCheckExpression', () => {
	it('rejects non-string input before coercion', () => {
		const forgedExpression = {
			toString: () => 'CHECK (true); DROP TABLE users; --',
		};

		expect(() =>
			validateCheckExpression(
				forgedExpression as unknown as string,
				'test check',
			),
		).toThrow(
			'Unsafe SQL expression in test check: expected a string, received object',
		);
		expect(() =>
			validateCheckExpression('CHECK (amount > 0)', 'test check'),
		).not.toThrow();
		expect(() =>
			validateCheckExpression(
				'CHECK (true); DROP TABLE users; --',
				'test check',
			),
		).toThrow(
			'Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "CHECK (true); DROP TABLE users; --"',
		);
	});

	it('accepts semicolon and line-comment marker inside single-quoted literals', () => {
		expect(() =>
			validateCheckExpression(
				"CHECK (status IN ('a;b', 'c--d'))",
				'test check',
			),
		).not.toThrow();
	});

	it('accepts block-comment markers inside array string literals', () => {
		expect(() =>
			validateCheckExpression(
				"CHECK (status = ANY (ARRAY['a;b'::text, 'c/*x*/d'::text]))",
				'test check',
			),
		).not.toThrow();
	});

	it('accepts doubled single quote inside a literal', () => {
		expect(() =>
			validateCheckExpression("CHECK (note = 'it''s')", 'test check'),
		).not.toThrow();
	});

	it('accepts an apostrophe inside a double-quoted identifier', () => {
		expect(() =>
			validateCheckExpression('CHECK ("it\'s" = true)', 'test check'),
		).not.toThrow();
	});

	it('does not let an apostrophe in a double-quoted identifier hide SQL injection', () => {
		const sql = '"flag\'"; DROP TABLE victims; SELECT 1 AS "bar\'"';
		expect(() => validateCheckExpression(sql, 'test check')).toThrow(
			/contains forbidden token ";" outside string literal/,
		);
	});

	it('accepts escape string literals with backslashes', () => {
		expect(() =>
			validateCheckExpression(String.raw`CHECK (note = E'a\'b')`, 'test check'),
		).not.toThrow();
	});

	it.each(['U', 'u'])(
		'rejects %s& Unicode-escape string literals after scanning their inert contents',
		(prefix) => {
			const sql = String.raw`CHECK (note = ${prefix}&'a;--\005C')`;
			expect(() => validateCheckExpression(sql, 'test check')).toThrow(
				`Unsafe SQL expression in test check: contains a Unicode-escape string literal (U&'...'), which PostgreSQL accepts only when standard_conforming_strings is enabled; use an ordinary single-quoted literal or E'...' instead. Value: "${sql}"`,
			);
		},
	);

	it('accepts escape string literals with doubled quotes', () => {
		expect(() =>
			validateCheckExpression("CHECK (note = E'it''s')", 'test check'),
		).not.toThrow();
	});

	it('still rejects a semicolon after an escape string literal', () => {
		expect(() =>
			validateCheckExpression(
				String.raw`CHECK (note = E'a\'b'); DROP TABLE users`,
				'test check',
			),
		).toThrow(/contains forbidden token ";" outside string literal/);
	});

	it('rejects backslashes in ordinary quoted strings because applying-session settings change their meaning', () => {
		const sql = String.raw`CHECK ((a ~ '\d+'::text))`;
		expect(() => validateCheckExpression(sql, 'test check')).toThrow(
			`Unsafe SQL expression in test check: contains a backslash in an ordinary single-quoted string literal, whose meaning depends on PostgreSQL standard_conforming_strings; use E'...' for a setting-independent string literal. Value: "${sql}"`,
		);
	});

	it('accepts safe dollar-quoted literal', () => {
		expect(() =>
			validateCheckExpression('CHECK (note = $$a;b$$)', 'test check'),
		).not.toThrow();
	});

	it('rejects semicolon outside a literal', () => {
		const sql = 'x = 1); DROP TABLE users; --';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});

	it('rejects semicolon after closing single quote', () => {
		const sql = "x = 'a'; DROP TABLE y";
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});

	it('rejects unterminated single-quoted literal', () => {
		const sql = "x = 'abc";
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: unterminated single-quoted string literal. Value: "${sql}"`,
		);
	});

	it('rejects unterminated dollar-quoted literal', () => {
		const sql = 'x = $$abc';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: unterminated dollar-quoted string literal $$. Value: "${sql}"`,
		);
	});

	it('rejects semicolon after closing dollar quote', () => {
		const sql = 'x = $$a$$; DROP';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});

	it('rejects line-comment marker outside a literal', () => {
		const sql = 'x = 1 -- bypass';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token "--" outside string literal. Value: "${sql}"`,
		);
	});

	it('rejects block-comment opener outside a literal', () => {
		const sql = 'x = 1 /* bypass */';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token "/*" outside string literal. Value: "${sql}"`,
		);
	});

	it('rejects block-comment closer outside a literal', () => {
		const sql = 'x = 1 */ true';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token "*/" outside string literal. Value: "${sql}"`,
		);
	});

	it('does not treat a dollar tag after an identifier as a string literal', () => {
		const sql = 'x = a$t$; DROP TABLE users; $t$';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});

	it('does not treat a dollar tag after a dollar identifier character as a string literal', () => {
		const sql = 'x = a$$tag$; DROP TABLE users; $tag$';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});

	it('does not treat a dollar tag after a non-ASCII identifier character as a string literal', () => {
		const sql = 'xé$tag$; DROP TABLE t$tag$';
		const error = getCheckValidationError(sql);
		expect(error.message).toBe(
			`Unsafe SQL expression in test check: contains forbidden token ";" outside string literal. Value: "${sql}"`,
		);
	});
});

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
			it('rejects forged non-string identifiers before coercion', () => {
				const forgedIdentifier = {
					length: 'users'.length,
					toString: () => 'users',
					replace: () => '"; DROP TABLE x; --',
					includes: () => false,
				};

				expect(() =>
					validateIdentifier(forgedIdentifier as unknown as string, 'alias'),
				).toThrow(
					'Invalid alias identifier: expected a string, received object',
				);
				expect(() => validateIdentifier('users', 'alias')).not.toThrow();
				expect(() => validateIdentifier('bad-name', 'alias')).toThrow(
					InvalidIdentifierError,
				);
			});

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

		it('accepts multi-character glibc locale modifiers like @latin9 and @iso8859-15', () => {
			expect(() =>
				validateCollationName('fr_FR@latin9', 'collation'),
			).not.toThrow();
			expect(() =>
				validateCollationName('en_US@iso8859-15', 'collation'),
			).not.toThrow();
		});

		it('rejects @modifier longer than 10 characters', () => {
			expect(() =>
				validateCollationName('de_DE.utf8@abcdefghijklmnop', 'collation'),
			).toThrow(InvalidIdentifierError);
		});

		it('rejects @modifier containing non-alphanumeric characters other than hyphen', () => {
			expect(() =>
				validateCollationName('de_DE.utf8@has_under', 'collation'),
			).toThrow(InvalidIdentifierError);
		});
	});
});
