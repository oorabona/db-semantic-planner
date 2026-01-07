/**
 * @module redact.test
 * Tests for parameter redaction utilities.
 * ADAPTER-004: Enhanced Observability
 */

import { describe, expect, it } from 'vitest';
import { redactParams } from './redact.js';
import { REDACTED_PLACEHOLDER } from './types.js';

describe('redactParams', () => {
	describe('Scenario 3.1: redactParams with field hints', () => {
		it('should redact fields matching default patterns', () => {
			// Given
			const params = ['john@example.com', 'secret123', 42];
			const fieldHints = ['email', 'password', 'userId'];

			// When
			const result = redactParams(params, fieldHints);

			// Then
			expect(result).toEqual(['john@example.com', REDACTED_PLACEHOLDER, 42]);
		});

		it('should NOT modify original params array', () => {
			// Given
			const params = ['value', 'secret123'];
			const fieldHints = ['field', 'password'];
			const originalParams = [...params];

			// When
			redactParams(params, fieldHints);

			// Then - original unchanged
			expect(params).toEqual(originalParams);
		});
	});

	describe('Scenario 3.2: Default patterns auto-redact', () => {
		it('should redact api_token matching default pattern', () => {
			// Given
			const params = ['value1', 'mytoken', 'value3'];
			const fieldHints = ['field1', 'api_token', 'field3'];

			// When
			const result = redactParams(params, fieldHints);

			// Then
			expect(result).toEqual(['value1', REDACTED_PLACEHOLDER, 'value3']);
		});

		it('should redact all default patterns', () => {
			const testCases = [
				{ field: 'user_password', expected: REDACTED_PLACEHOLDER },
				{ field: 'api_secret', expected: REDACTED_PLACEHOLDER },
				{ field: 'access_token', expected: REDACTED_PLACEHOLDER },
				{ field: 'private_key', expected: REDACTED_PLACEHOLDER },
				{ field: 'auth_header', expected: REDACTED_PLACEHOLDER },
				{ field: 'credential_id', expected: REDACTED_PLACEHOLDER },
				{ field: 'api_key', expected: REDACTED_PLACEHOLDER },
				{ field: 'apikey', expected: REDACTED_PLACEHOLDER },
				{ field: 'private_data', expected: REDACTED_PLACEHOLDER },
				{ field: 'username', expected: 'value' }, // should NOT be redacted
			];

			for (const { field, expected } of testCases) {
				const result = redactParams(['value'], [field]);
				expect(result[0]).toBe(expected);
			}
		});
	});

	describe('Scenario 3.3: Custom redaction patterns', () => {
		it('should use custom patterns when provided', () => {
			// Given
			const params = ['123-45-6789', '1990-01-01', 'normal'];
			const fieldHints = ['ssn', 'dob', 'name'];

			// When
			const result = redactParams(params, fieldHints, {
				patterns: ['ssn', 'dob'],
			});

			// Then
			expect(result).toEqual([
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
				'normal',
			]);
		});

		it('should add additional patterns to defaults', () => {
			// Given
			const params = ['value1', 'value2', 'secret'];
			const fieldHints = ['ssn', 'normal', 'password'];

			// When
			const result = redactParams(params, fieldHints, {
				additionalPatterns: ['ssn'],
			});

			// Then - ssn and password both redacted
			expect(result).toEqual([
				REDACTED_PLACEHOLDER,
				'value2',
				REDACTED_PLACEHOLDER,
			]);
		});

		it('should respect whitelist', () => {
			// Given
			const params = ['api-key-123', 'secret123'];
			const fieldHints = ['public_api_key', 'password'];

			// When
			const result = redactParams(params, fieldHints, {
				whitelist: ['public_api_key'],
			});

			// Then - whitelisted field NOT redacted
			expect(result).toEqual(['api-key-123', REDACTED_PLACEHOLDER]);
		});
	});

	describe('Scenario 3.4: Empty params returns empty array', () => {
		it('should return empty array for empty params', () => {
			// Given
			const params: unknown[] = [];
			const fieldHints: string[] = [];

			// When
			const result = redactParams(params, fieldHints);

			// Then
			expect(result).toEqual([]);
		});
	});

	describe('Scenario 3.5: Case-insensitive pattern matching', () => {
		it('should match patterns case-insensitively', () => {
			const testCases = [
				{ field: 'PASSWORD', expected: REDACTED_PLACEHOLDER },
				{ field: 'Password', expected: REDACTED_PLACEHOLDER },
				{ field: 'passWORD', expected: REDACTED_PLACEHOLDER },
				{ field: 'USER_PASSWORD', expected: REDACTED_PLACEHOLDER },
			];

			for (const { field, expected } of testCases) {
				const result = redactParams(['secret'], [field]);
				expect(result[0]).toBe(expected);
			}
		});
	});

	describe('Edge cases', () => {
		it('should handle missing field hints', () => {
			// Given - more params than hints
			const params = ['value1', 'value2', 'value3'];
			const fieldHints = ['field1'];

			// When
			const result = redactParams(params, fieldHints);

			// Then - values without hints pass through
			expect(result).toEqual(['value1', 'value2', 'value3']);
		});

		it('should handle various value types', () => {
			// Given
			const params = ['string', 123, true, null, { obj: 'value' }, ['array']];
			const fieldHints = [
				'password',
				'secret_number',
				'token_flag',
				'key_null',
				'auth_obj',
				'credential_arr',
			];

			// When
			const result = redactParams(params, fieldHints);

			// Then - all matching fields redacted regardless of type
			expect(result).toEqual([
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
				REDACTED_PLACEHOLDER,
			]);
		});
	});
});
