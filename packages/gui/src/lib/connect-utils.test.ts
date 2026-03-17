import { describe, expect, it } from 'vitest';
import { isAuthError } from './connect-utils';

describe('isAuthError', () => {
	it('detects "password authentication failed"', () => {
		expect(
			isAuthError(new Error('password authentication failed for user "app"')),
		).toBe(true);
	});

	it('detects SQLSTATE 28000', () => {
		expect(isAuthError('FATAL: 28000: password authentication failed')).toBe(
			true,
		);
	});

	it('detects SQLSTATE 28P01', () => {
		expect(isAuthError('error 28P01: password required')).toBe(true);
	});

	it('detects "no password supplied"', () => {
		expect(isAuthError(new Error('no password supplied'))).toBe(true);
	});

	it('returns false for DNS errors', () => {
		expect(isAuthError(new Error('getaddrinfo ENOTFOUND db-host'))).toBe(false);
	});

	it('returns false for connection refused', () => {
		expect(isAuthError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(
			false,
		);
	});

	it('returns false for unknown database', () => {
		expect(
			isAuthError(new Error('database "nonexistent" does not exist')),
		).toBe(false);
	});

	it('handles non-string/non-error values', () => {
		expect(isAuthError(42)).toBe(false);
		expect(isAuthError(null)).toBe(false);
		expect(isAuthError(undefined)).toBe(false);
	});
});
