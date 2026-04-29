import { describe, expect, test } from 'vitest';
import { DEFAULT_REDACTION_PATTERNS, redactParams } from './redact-params.js';

describe('redactParams', () => {
	test('string substring match → replaced', () => {
		const params = ['my-secret-password'];
		const result = redactParams(params, { patterns: ['password'] });
		expect(result).toEqual(['[REDACTED]']);
	});

	test('regex match → replaced', () => {
		const params = ['api-key-12345'];
		const result = redactParams(params, { patterns: [/^api[_-]?key/i] });
		expect(result).toEqual(['[REDACTED]']);
	});

	test('non-matching string → kept', () => {
		const params = ['hello world'];
		const result = redactParams(params, { patterns: ['password', /^token$/] });
		expect(result).toEqual(['hello world']);
	});

	test('non-string values → kept unchanged', () => {
		const params = [42, true, null, undefined];
		const result = redactParams(params, { patterns: ['password', /^.*/] });
		expect(result).toEqual([42, true, null, undefined]);
	});

	test('custom replacement string → uses it instead of [REDACTED]', () => {
		const params = ['super-secret-token-value'];
		const result = redactParams(params, {
			patterns: ['token'],
			replacement: '***',
		});
		expect(result).toEqual(['***']);
	});

	test('DEFAULT_REDACTION_PATTERNS matches email, bearer token, JWT, SSN, credit card', () => {
		const params = [
			'user@example.com',
			'Bearer eyABC.def.ghi',
			'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abc123def456',
			'123-45-6789',
			'4111 1111 1111 1111',
		];
		const result = redactParams(params, {
			patterns: DEFAULT_REDACTION_PATTERNS,
		});
		expect(result).toEqual([
			'[REDACTED]',
			'[REDACTED]',
			'[REDACTED]',
			'[REDACTED]',
			'[REDACTED]',
		]);
	});

	test('mixed config (DEFAULT_REDACTION_PATTERNS + custom string + custom regex) → all forms redact correctly', () => {
		const params = [
			'user@example.com', // matches DEFAULT email pattern
			'my-custom-ssn-value', // matches 'ssn' substring
			'api_key_abc', // matches /^api[_-]?key/i regex
			'safe-value', // no match
			99, // non-string, pass through
		];
		const result = redactParams(params, {
			patterns: [...DEFAULT_REDACTION_PATTERNS, 'ssn', /^api[_-]?key/i],
		});
		expect(result).toEqual([
			'[REDACTED]',
			'[REDACTED]',
			'[REDACTED]',
			'safe-value',
			99,
		]);
	});

	test('input array is not mutated', () => {
		const params = ['password123', 42, 'hello'];
		const original = [...params];
		const result = redactParams(params, { patterns: ['password'] });
		// original array unchanged
		expect(params).toEqual(original);
		expect(params.length).toBe(3);
		// result is a new array
		expect(result).not.toBe(params);
		expect(result[0]).toBe('[REDACTED]');
		expect(Object.is(params[1], 42)).toBe(true);
		expect(Object.is(params[2], 'hello')).toBe(true);
	});

	test('empty patterns array → all values kept', () => {
		const params = ['password123', 'user@example.com', 42];
		const result = redactParams(params, { patterns: [] });
		expect(result).toEqual(['password123', 'user@example.com', 42]);
	});

	test('empty string in patterns → does NOT match all values', () => {
		const params = ['hello', 'world', 'test'];
		const result = redactParams(params, { patterns: [''] });
		// empty string pattern is ignored — no values should be redacted
		expect(result).toEqual(['hello', 'world', 'test']);
	});

	test('case-insensitive substring matching — pattern TOKEN matches value containing token', () => {
		const params = ['my-secret-token', 'not-a-match'];
		const result = redactParams(params, { patterns: ['TOKEN'] });
		// 'TOKEN' (upper) should match 'my-secret-token' (lower) via case-insensitive includes
		expect(result[0]).toBe('[REDACTED]');
		expect(result[1]).toBe('not-a-match');
	});

	test('F3 lock: global-flag regex redacts consistently on repeated calls (lastIndex reset)', () => {
		// Without lastIndex=0 reset, the second call on a /g regex would skip the match
		// because lastIndex is left non-zero from the first successful test().
		const globalRegex = /secret/g;
		const first = redactParams(['has-secret-1'], { patterns: [globalRegex] });
		const second = redactParams(['has-secret-1'], { patterns: [globalRegex] });
		expect(first).toEqual(['[REDACTED]']);
		expect(second).toEqual(['[REDACTED]']);
	});

	test('F4 lock: case-insensitive substring match still works after moving toLowerCase() outside loop', () => {
		// Confirms the pre-computed lowerValue is used correctly for string patterns.
		const result = redactParams(['MyEmailAddr@x.com'], { patterns: ['email'] });
		// 'email' is a substring of 'myemailaddr@x.com' (lowercased), so must be redacted.
		expect(result).toEqual(['[REDACTED]']);
	});

	test('S1 lock: DEFAULT_REDACTION_PATTERNS does not redact a UUID-without-dashes (32 hex chars)', () => {
		const uuid = '550e8400e29b41d4a716446655440000'; // valid UUID v4 without dashes
		const result = redactParams([uuid], { patterns: [...DEFAULT_REDACTION_PATTERNS] });
		expect(result).toEqual([uuid]); // NOT redacted — UUIDs are identifiers, not secrets
	});

	test('S1 lock: DEFAULT_REDACTION_PATTERNS does not redact a 40-char git commit SHA', () => {
		const sha = '17aa207f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d';
		const result = redactParams([sha], { patterns: [...DEFAULT_REDACTION_PATTERNS] });
		expect(result).toEqual([sha]); // NOT redacted
	});
});
