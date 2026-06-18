/**
 * Unit tests for validateTypeName() — structured grammar validator.
 *
 * Covers:
 * - SQL injection strings that must be rejected
 * - Valid type names that must pass (simple, schema-qualified, modifier, array, multi-word)
 * - Grammar boundary conditions (double-array, invalid modifier content, empty string)
 */

import { describe, expect, it } from 'vitest';
import { validateTypeName } from '../batch-values.js';

// ---------------------------------------------------------------------------
// Injection / rejection cases
// ---------------------------------------------------------------------------

describe('validateTypeName — injection strings are rejected', () => {
	it('rejects the JOIN-injection string (DEFECT-1 canonical case)', () => {
		expect(() =>
			validateTypeName(
				'int[])) AS b(id) JOIN users u ON true JOIN unnest(CAST(NULL AS int',
			),
		).toThrow(/invalid type name/i);
	});

	it('rejects "int4) ; DROP TABLE x; --" (semicolon in modifier)', () => {
		expect(() => validateTypeName('int4) ; DROP TABLE x; --')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects "foo\'bar" (single quote is not a valid identifier char)', () => {
		expect(() => validateTypeName("foo'bar")).toThrow(/invalid type name/i);
	});

	it('rejects "int4[][]" (double array suffix not allowed as raw type input)', () => {
		expect(() => validateTypeName('int4[][]')).toThrow(/invalid type name/i);
	});

	it('rejects empty string', () => {
		expect(() => validateTypeName('')).toThrow(/must not be empty/i);
	});

	it('rejects whitespace-only string', () => {
		expect(() => validateTypeName('   ')).toThrow(/must not be empty/i);
	});

	it('rejects type with double-quoted identifier', () => {
		expect(() => validateTypeName('"text"')).toThrow(/invalid type name/i);
	});

	it('rejects type with semicolon', () => {
		expect(() => validateTypeName('text; DROP TABLE x')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects type with comment sequence "--"', () => {
		expect(() => validateTypeName('text--comment')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects keyword suffix injection after a valid base type', () => {
		expect(() => validateTypeName('boolean or true')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects UNION injection after a valid base type', () => {
		expect(() => validateTypeName('text UNION SELECT')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects type with invalid modifier content (non-digit in parens)', () => {
		// "(255px)" is not a valid modifier — only digits or digits,digits allowed
		expect(() => validateTypeName('varchar(255px)')).toThrow(
			/invalid type name/i,
		);
	});

	it('rejects type with extra closing paren after modifier', () => {
		// "int4(5))" — the trailing ")" is not consumed by modifier parsing
		expect(() => validateTypeName('int4(5))')).toThrow(/invalid type name/i);
	});

	it('rejects triple-qualified type (too many dots)', () => {
		expect(() => validateTypeName('a.b.c')).toThrow(/invalid type name/i);
	});

	it('rejects type starting with a digit', () => {
		expect(() => validateTypeName('4int')).toThrow(/invalid type name/i);
	});
});

// ---------------------------------------------------------------------------
// Valid type names that must pass
// ---------------------------------------------------------------------------

describe('validateTypeName — valid types pass the structured grammar', () => {
	it('accepts simple base types: int4, text, uuid', () => {
		expect(() => validateTypeName('int4')).not.toThrow();
		expect(() => validateTypeName('text')).not.toThrow();
		expect(() => validateTypeName('uuid')).not.toThrow();
	});

	it('accepts "numeric(10,2)" — two-part modifier', () => {
		expect(() => validateTypeName('numeric(10,2)')).not.toThrow();
	});

	it('accepts "varchar(255)" — single-part modifier', () => {
		expect(() => validateTypeName('varchar(255)')).not.toThrow();
	});

	it('accepts "timestamp with time zone" — multi-word allowlist', () => {
		expect(() => validateTypeName('timestamp with time zone')).not.toThrow();
	});

	it('accepts "timestamp without time zone" — multi-word allowlist', () => {
		expect(() => validateTypeName('timestamp without time zone')).not.toThrow();
	});

	it('accepts "time with time zone" — multi-word allowlist', () => {
		expect(() => validateTypeName('time with time zone')).not.toThrow();
	});

	it('accepts "time without time zone" — multi-word allowlist', () => {
		expect(() => validateTypeName('time without time zone')).not.toThrow();
	});

	it('accepts "double precision" — multi-word allowlist', () => {
		expect(() => validateTypeName('double precision')).not.toThrow();
	});

	it('accepts "character varying" — multi-word allowlist', () => {
		expect(() => validateTypeName('character varying')).not.toThrow();
	});

	it('accepts "bit varying" — multi-word allowlist', () => {
		expect(() => validateTypeName('bit varying')).not.toThrow();
	});

	it('accepts multi-word types case-insensitively', () => {
		expect(() => validateTypeName('TIMESTAMP WITH TIME ZONE')).not.toThrow();
		expect(() => validateTypeName('Double Precision')).not.toThrow();
	});

	it('accepts schema-qualified type "myschema.myenum"', () => {
		expect(() => validateTypeName('myschema.myenum')).not.toThrow();
	});

	it('accepts "int4[]" — single array suffix', () => {
		expect(() => validateTypeName('int4[]')).not.toThrow();
	});

	it('accepts "numeric(10,2)[]" — modifier with array suffix', () => {
		expect(() => validateTypeName('numeric(10,2)[]')).not.toThrow();
	});

	it('accepts leading/trailing whitespace (trimmed before parse)', () => {
		expect(() => validateTypeName('  int4  ')).not.toThrow();
		expect(() => validateTypeName(' varchar(255) ')).not.toThrow();
	});
});
