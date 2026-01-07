import { describe, expect, it } from 'vitest';
import { InvalidIdentifierError, validateIdentifier } from './errors.js';

describe('InvalidIdentifierError', () => {
	it('should create error with default message', () => {
		const error = new InvalidIdentifierError('bad-name');
		expect(error.message).toBe('Invalid identifier: bad-name');
		expect(error.identifier).toBe('bad-name');
		expect(error.name).toBe('InvalidIdentifierError');
	});

	it('should create error with custom message', () => {
		const error = new InvalidIdentifierError(
			'bad-name',
			'Custom error message',
		);
		expect(error.message).toBe('Custom error message');
		expect(error.identifier).toBe('bad-name');
	});

	it('should be instanceof Error', () => {
		const error = new InvalidIdentifierError('test');
		expect(error).toBeInstanceOf(Error);
		expect(error).toBeInstanceOf(InvalidIdentifierError);
	});
});

describe('validateIdentifier', () => {
	describe('valid identifiers', () => {
		it('should accept simple lowercase names', () => {
			expect(() => validateIdentifier('users')).not.toThrow();
			expect(() => validateIdentifier('products')).not.toThrow();
		});

		it('should accept names starting with underscore', () => {
			expect(() => validateIdentifier('_private')).not.toThrow();
			expect(() => validateIdentifier('_')).not.toThrow();
		});

		it('should accept names with numbers (not at start)', () => {
			expect(() => validateIdentifier('tenant_123')).not.toThrow();
			expect(() => validateIdentifier('user2')).not.toThrow();
			expect(() => validateIdentifier('v1_schema')).not.toThrow();
		});

		it('should accept uppercase letters', () => {
			expect(() => validateIdentifier('Users')).not.toThrow();
			expect(() => validateIdentifier('PRODUCTS')).not.toThrow();
			expect(() => validateIdentifier('MySchema')).not.toThrow();
		});

		it('should accept mixed case with underscores and numbers', () => {
			expect(() => validateIdentifier('Tenant_123_Schema')).not.toThrow();
			expect(() => validateIdentifier('_V1_PROD')).not.toThrow();
		});

		it('should accept 63 character names (PostgreSQL max)', () => {
			const maxLength = 'a'.repeat(63);
			expect(() => validateIdentifier(maxLength)).not.toThrow();
		});
	});

	describe('invalid identifiers', () => {
		it('should reject empty string', () => {
			expect(() => validateIdentifier('')).toThrow(InvalidIdentifierError);
			expect(() => validateIdentifier('')).toThrow(
				/must be a non-empty string/,
			);
		});

		it('should reject names starting with number', () => {
			expect(() => validateIdentifier('123abc')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('1_schema')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('should reject names with hyphens', () => {
			expect(() => validateIdentifier('my-schema')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('tenant-123')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('should reject names with spaces', () => {
			expect(() => validateIdentifier('my schema')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier(' schema')).toThrow(
				InvalidIdentifierError,
			);
		});

		it('should reject names with special characters', () => {
			expect(() => validateIdentifier('schema!')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier('schema@tenant')).toThrow(
				InvalidIdentifierError,
			);
			expect(() => validateIdentifier("schema'; DROP TABLE--")).toThrow(
				InvalidIdentifierError,
			);
		});

		it('should reject names longer than 63 characters', () => {
			const tooLong = 'a'.repeat(64);
			expect(() => validateIdentifier(tooLong)).toThrow(InvalidIdentifierError);
		});

		it('should reject non-string values', () => {
			// @ts-expect-error - Testing runtime validation
			expect(() => validateIdentifier(null)).toThrow(InvalidIdentifierError);
			// @ts-expect-error - Testing runtime validation
			expect(() => validateIdentifier(undefined)).toThrow(
				InvalidIdentifierError,
			);
			// @ts-expect-error - Testing runtime validation
			expect(() => validateIdentifier(123)).toThrow(InvalidIdentifierError);
		});
	});

	describe('custom type in error message', () => {
		it('should include type in error message', () => {
			expect(() => validateIdentifier('bad-name', 'schema')).toThrow(
				/Invalid schema:/,
			);
			expect(() => validateIdentifier('123', 'table')).toThrow(
				/Invalid table:/,
			);
		});

		it('should use "identifier" as default type', () => {
			expect(() => validateIdentifier('bad-name')).toThrow(
				/Invalid identifier:/,
			);
		});
	});

	describe('SQL injection prevention', () => {
		it('should reject SQL injection attempts', () => {
			// Classic SQL injection
			expect(() => validateIdentifier("'; DROP TABLE users;--")).toThrow(
				InvalidIdentifierError,
			);

			// Union-based injection
			expect(() => validateIdentifier("' UNION SELECT * FROM--")).toThrow(
				InvalidIdentifierError,
			);

			// Schema traversal
			expect(() => validateIdentifier('public.users')).toThrow(
				InvalidIdentifierError,
			);

			// Quote escaping
			expect(() => validateIdentifier("schema''")).toThrow(
				InvalidIdentifierError,
			);
		});
	});
});
