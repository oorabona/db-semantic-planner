// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for ast-compare.ts
 * Focus: Branch coverage for compareAST, normalizeAST, roundtripTest, assertRoundtrip, compareSQLByAST
 */

import { loadModule } from 'pgsql-parser';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertRoundtrip, compareAST, compareSQLByAST, roundtripTest } from './ast-compare.js';

// Ensure the libpg-query WASM module is initialized before any test that
// calls parseSync. Without this, CI workers may race and hit "WASM module
// not initialized. Call `loadModule()` first."
beforeAll(async () => {
	await loadModule();
});

describe('compareAST — coverage', () => {
	it('returns equal for identical primitives', () => {
		const result = compareAST(42, 42);
		expect(result.equal).toBe(true);
		expect(result.differences).toHaveLength(0);
	});

	it('detects difference in primitives', () => {
		const result = compareAST('hello', 'world');
		expect(result.equal).toBe(false);
		expect(result.differences.length).toBeGreaterThan(0);
	});

	it('handles null vs non-null', () => {
		const result = compareAST(null, { a: 1 });
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('null/undefined');
	});

	it('handles non-null vs null', () => {
		const result = compareAST({ a: 1 }, null);
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('null/undefined');
	});

	it('handles undefined vs non-undefined', () => {
		const result = compareAST(undefined, 'text');
		expect(result.equal).toBe(false);
	});

	it('returns equal for both null', () => {
		const result = compareAST(null, null);
		expect(result.equal).toBe(true);
	});

	it('returns equal for both undefined', () => {
		const result = compareAST(undefined, undefined);
		expect(result.equal).toBe(true);
	});

	it('detects array length mismatch', () => {
		const result = compareAST([1, 2], [1, 2, 3]);
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('array length');
	});

	it('detects array vs non-array mismatch', () => {
		const result = compareAST([1], { val: 1 });
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('array mismatch');
	});

	it('detects missing key in right object', () => {
		const result = compareAST({ a: 1, b: 2 }, { a: 1 });
		expect(result.equal).toBe(false);
		expect(result.differences.some((d) => d.includes('missing in right'))).toBe(true);
	});

	it('detects missing key in left object', () => {
		const result = compareAST({ a: 1 }, { a: 1, b: 2 });
		expect(result.equal).toBe(false);
		expect(result.differences.some((d) => d.includes('missing in left'))).toBe(true);
	});

	it('ignores location fields in objects', () => {
		const result = compareAST({ a: 1, location: 10 }, { a: 1, location: 20 });
		expect(result.equal).toBe(true);
	});

	it('ignores stmt_len and stmt_location fields', () => {
		const result = compareAST({ a: 1, stmt_len: 50, stmt_location: 0 }, { a: 1, stmt_len: 100, stmt_location: 5 });
		expect(result.equal).toBe(true);
	});

	it('compares nested objects recursively', () => {
		const result = compareAST({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
		expect(result.equal).toBe(false);
	});

	it('compares arrays of objects', () => {
		const result = compareAST([{ a: 1 }, { b: 2 }], [{ a: 1 }, { b: 2 }]);
		expect(result.equal).toBe(true);
	});

	it('uses custom path in differences', () => {
		const result = compareAST({ x: 1 }, { x: 2 }, 'custom.path');
		expect(result.differences[0]).toContain('custom.path');
	});

	it('handles primitive vs object type mismatch', () => {
		const result = compareAST(42, { x: 42 });
		expect(result.equal).toBe(false);
	});
});

describe('roundtripTest — coverage', () => {
	it('roundtrips simple SELECT', () => {
		const result = roundtripTest('SELECT 1');
		expect(result.comparison.equal).toBe(true);
		expect(result.originalSQL).toBe('SELECT 1');
		expect(result.deparseSQL).toBeDefined();
	});

	it('roundtrips SELECT with WHERE', () => {
		const result = roundtripTest('SELECT * FROM users WHERE id = 1');
		expect(result.comparison.equal).toBe(true);
	});
});

describe('assertRoundtrip — coverage', () => {
	it('succeeds for valid SQL', () => {
		expect(() => assertRoundtrip('SELECT 1')).not.toThrow();
	});

	it('succeeds for complex SELECT', () => {
		expect(() => assertRoundtrip('SELECT id, name FROM users WHERE active = true')).not.toThrow();
	});
});

describe('compareSQLByAST — coverage', () => {
	it('returns equal for semantically identical SQL', () => {
		const result = compareSQLByAST('SELECT 1', 'SELECT 1');
		expect(result.equal).toBe(true);
	});

	it('returns not equal for different SQL', () => {
		const result = compareSQLByAST('SELECT 1', 'SELECT 2');
		expect(result.equal).toBe(false);
	});

	it('returns parse error for invalid SQL', () => {
		const result = compareSQLByAST('NOT VALID SQL AT ALL !!', 'SELECT 1');
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('Parse error');
	});
});
