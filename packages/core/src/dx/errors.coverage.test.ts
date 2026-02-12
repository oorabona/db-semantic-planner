/**
 * @fileoverview Coverage tests for errors.ts — targeting uncovered branches.
 *
 * The existing errors.test.ts covers basic construction and factory usage.
 * This file specifically targets:
 * - findClosestMatch edge cases (distance thresholds, no-match paths)
 * - levenshteinDistance internal behavior via findClosestMatch
 * - NamingConventionMismatchError (entirely untested)
 * - ColumnNotFoundError threshold=15 truncation
 * - Errors type guards for all error types (most were untested)
 * - Errors.hasCode edge cases (non-Error, non-string code, wrong prefix)
 * - Errors.notFound without hint
 * - RelationNotFoundError without suggestion
 */
import { describe, expect, it } from 'vitest';
import {
	AmbiguousRelationError,
	ColumnNotFoundError,
	ErrorCode,
	Errors,
	ExecutionError,
	findClosestMatch,
	InvalidOperationError,
	NamingConventionMismatchError,
	NotFoundError,
	RelationNotFoundError,
	TableNotFoundError,
	UnsafeOperationError,
} from './errors.js';

// ============================================================================
// findClosestMatch — uncovered branches
// ============================================================================

describe('findClosestMatch (coverage)', () => {
	it('returns undefined when all candidates are too far from target', () => {
		// 'xyz' vs 'abcdefghij' — distance far exceeds Math.max(3, 3) threshold
		const result = findClosestMatch('xyz', ['abcdefghij', 'qrstuvwxyz123']);
		expect(result).toBeUndefined();
	});

	it('returns the best distance match when multiple candidates compete', () => {
		// 'ussr' → 'users' (distance 2), 'posts' (distance 5), 'user' (prefix match wins)
		// Without a prefix match available, the closest distance should win
		const result = findClosestMatch('ussr', ['posts', 'comments', 'users']);
		expect(result).toBe('users');
	});

	it('returns first prefix match encountered (short-circuit)', () => {
		// 'com' is a prefix of both 'comments' and 'companies'
		// Should return the first one encountered
		const result = findClosestMatch('com', ['comments', 'companies']);
		expect(result).toBe('comments');
	});

	it('handles equal strings (distance 0)', () => {
		const result = findClosestMatch('users', ['users', 'posts']);
		// 'users'.startsWith('users') → true, prefix match returns immediately
		expect(result).toBe('users');
	});

	it('handles completely different short strings within threshold', () => {
		// Short target: threshold is Math.max(target.length, 3) = 3
		// 'ab' vs 'xy' → distance 2, threshold 3 → matches
		const result = findClosestMatch('ab', ['xy']);
		expect(result).toBe('xy');
	});

	it('handles single character target', () => {
		// 'a' vs 'b' → distance 1, threshold Math.max(1, 3) = 3 → matches
		const result = findClosestMatch('a', ['b']);
		expect(result).toBe('b');
	});

	it('picks best among multiple candidates within threshold', () => {
		// 'tset' → 'test' (distance 2), 'toast' (distance 3), 'best' (distance 2)
		// 'test' and 'best' both have distance 2 — first encountered wins
		const result = findClosestMatch('tset', ['toast', 'test', 'best']);
		expect(result).toBe('test');
	});

	it('returns undefined when single candidate exceeds threshold', () => {
		// 'a' vs 'completely_different_long_string' — distance >> threshold 3
		const result = findClosestMatch('a', ['completely_different_long_string']);
		expect(result).toBeUndefined();
	});
});

// ============================================================================
// levenshteinDistance — tested indirectly via findClosestMatch
// ============================================================================

describe('levenshteinDistance (via findClosestMatch)', () => {
	it('equal strings have distance 0 (prefix match returns immediately)', () => {
		// Exact match triggers prefix short-circuit
		expect(findClosestMatch('hello', ['hello'])).toBe('hello');
	});

	it('single insertion', () => {
		// 'helo' → 'hello' (distance 1), threshold max(4, 3) = 4
		expect(findClosestMatch('helo', ['hello'])).toBe('hello');
	});

	it('single deletion', () => {
		// 'helllo' → 'hello' (distance 1), threshold max(6, 3) = 6
		expect(findClosestMatch('helllo', ['hello'])).toBe('hello');
	});

	it('single substitution', () => {
		// 'hallo' → 'hello' (distance 1)
		expect(findClosestMatch('hallo', ['hello'])).toBe('hello');
	});

	it('two substitutions', () => {
		// 'haxxy' → 'hello' (distance 3), threshold max(5, 3) = 5 → matches
		expect(findClosestMatch('haxxy', ['hello'])).toBe('hello');
	});

	it('completely different strings exceed threshold for short target', () => {
		// Target 'ab' length 2, threshold = max(2, 3) = 3
		// 'wxyz' distance from 'ab' = 4 > 3 → no match
		const result = findClosestMatch('ab', ['wxyz']);
		expect(result).toBeUndefined();
	});
});

// ============================================================================
// RelationNotFoundError — uncovered branches
// ============================================================================

describe('RelationNotFoundError (coverage)', () => {
	it('has no suggestion when no candidates are close', () => {
		// Target 'zq' has length 2, threshold = max(2, 3) = 3
		// 'posts' distance from 'zq' >> 3, same for 'profile', 'comments'
		// But prefix check: none of them starts with 'zq'
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'zq',
			available: ['posts', 'profile', 'comments'],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).not.toContain('Did you mean');
	});

	it('has name and instanceof after setPrototypeOf', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: [],
		});

		expect(error.name).toBe('RelationNotFoundError');
		expect(error instanceof RelationNotFoundError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

// ============================================================================
// TableNotFoundError — uncovered branches
// ============================================================================

describe('TableNotFoundError (coverage)', () => {
	it('shows exactly 10 tables without truncation suffix', () => {
		const tables = Array.from({ length: 10 }, (_, i) => `table${i}`);
		const error = new TableNotFoundError({
			requested: 'unknown',
			available: tables,
		});

		expect(error.message).not.toContain('more)');
		expect(error.message).toContain('table9');
	});

	it('shows 10 tables + "(and N more)" when > 10', () => {
		const tables = Array.from({ length: 12 }, (_, i) => `table${i}`);
		const error = new TableNotFoundError({
			requested: 'unknown',
			available: tables,
		});

		expect(error.message).toContain('(and 2 more)');
		// table10, table11 should not appear in the list
		expect(error.message).not.toContain('table10');
	});

	it('has no suggestion when target is very short and unrelated', () => {
		// 'zq' length 2, threshold = max(2, 3) = 3
		// distance('zq', 'users') = 5 > 3, distance('zq', 'posts') = 5 > 3
		const error = new TableNotFoundError({
			requested: 'zq',
			available: ['users', 'posts'],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).not.toContain('Did you mean');
	});
});

// ============================================================================
// ColumnNotFoundError — threshold=15 truncation
// ============================================================================

describe('ColumnNotFoundError (coverage)', () => {
	it('shows exactly 15 columns without truncation suffix', () => {
		const columns = Array.from({ length: 15 }, (_, i) => `col${i}`);
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: columns,
		});

		expect(error.message).not.toContain('more)');
		expect(error.message).toContain('col14');
	});

	it('shows 15 columns + "(and N more)" when > 15', () => {
		const columns = Array.from({ length: 20 }, (_, i) => `col${i}`);
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'unknown',
			available: columns,
		});

		expect(error.message).toContain('(and 5 more)');
		expect(error.message).not.toContain('col15');
	});

	it('has no suggestion when target is very short and unrelated', () => {
		// 'zq' length 2, threshold = max(2, 3) = 3
		// distance('zq', 'id') = 2, distance('zq', 'name') = 4 > 3, distance('zq', 'email') = 5 > 3
		// Actually 'id' has distance 2 from 'zq' — still within threshold 3
		// Use candidates that are all longer to ensure distance > 3
		const error = new ColumnNotFoundError({
			table: 'users',
			requested: 'zq',
			available: ['username', 'password', 'created_at'],
		});

		expect(error.suggestion).toBeUndefined();
		expect(error.message).not.toContain('Did you mean');
	});

	it('sets table, requested, available properties correctly', () => {
		const error = new ColumnNotFoundError({
			table: 'orders',
			requested: 'pric',
			available: ['price', 'quantity'],
		});

		expect(error.table).toBe('orders');
		expect(error.requested).toBe('pric');
		expect(error.available).toEqual(['price', 'quantity']);
		expect(error.suggestion).toBe('price');
	});
});

// ============================================================================
// NamingConventionMismatchError — entirely untested
// ============================================================================

describe('NamingConventionMismatchError', () => {
	it('creates error with schemaCasing and adapterCasing properties', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'snake_case',
			adapterCasing: 'preserve',
		});

		expect(error.schemaCasing).toBe('snake_case');
		expect(error.adapterCasing).toBe('preserve');
	});

	it('generates descriptive message', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'camelCase',
			adapterCasing: 'snake_case',
		});

		expect(error.message).toContain("Schema uses 'camelCase'");
		expect(error.message).toContain("adapter uses 'snake_case'");
		expect(error.message).toContain('align them');
	});

	it('has correct name', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'a',
			adapterCasing: 'b',
		});

		expect(error.name).toBe('NamingConventionMismatchError');
	});

	it('works with instanceof check', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'a',
			adapterCasing: 'b',
		});

		expect(error instanceof NamingConventionMismatchError).toBe(true);
		expect(error instanceof Error).toBe(true);
	});
});

// ============================================================================
// Errors.notFound — without hint branch
// ============================================================================

describe('Errors.notFound (coverage)', () => {
	it('creates NotFoundError without hint', () => {
		const error = Errors.notFound('users');

		expect(error).toBeInstanceOf(NotFoundError);
		expect(error.table).toBe('users');
		expect(error.hint).toBeUndefined();
		expect(error.message).toBe("No record found for 'users'");
		expect(error.code).toBe(ErrorCode.NOT_FOUND);
	});
});

// ============================================================================
// Errors type guards — uncovered guards
// ============================================================================

describe('Errors type guards (coverage)', () => {
	it('isAmbiguousRelation identifies AmbiguousRelationError', () => {
		const error = new AmbiguousRelationError('users', 'posts', ['rel1']);
		expect(Errors.isAmbiguousRelation(error)).toBe(true);
	});

	it('isAmbiguousRelation returns false for non-matching error', () => {
		expect(Errors.isAmbiguousRelation(new Error('test'))).toBe(false);
	});

	it('isRelationNotFound identifies RelationNotFoundError', () => {
		const error = new RelationNotFoundError({
			table: 'users',
			requested: 'x',
			available: [],
		});
		expect(Errors.isRelationNotFound(error)).toBe(true);
	});

	it('isRelationNotFound returns false for non-matching error', () => {
		expect(Errors.isRelationNotFound(new Error('test'))).toBe(false);
	});

	it('isInvalidOperation identifies InvalidOperationError', () => {
		const error = new InvalidOperationError('insert', 'no values');
		expect(Errors.isInvalidOperation(error)).toBe(true);
	});

	it('isInvalidOperation returns false for non-matching error', () => {
		expect(Errors.isInvalidOperation(new Error('test'))).toBe(false);
	});

	it('isUnsafeOperation identifies UnsafeOperationError', () => {
		const error = new UnsafeOperationError('update', 'add WHERE');
		expect(Errors.isUnsafeOperation(error)).toBe(true);
	});

	it('isUnsafeOperation returns false for non-matching error', () => {
		expect(Errors.isUnsafeOperation(new Error('test'))).toBe(false);
	});

	it('isTableNotFound identifies TableNotFoundError', () => {
		const error = new TableNotFoundError({ requested: 'x', available: [] });
		expect(Errors.isTableNotFound(error)).toBe(true);
	});

	it('isTableNotFound returns false for non-matching error', () => {
		expect(Errors.isTableNotFound(new Error('test'))).toBe(false);
	});

	it('isColumnNotFound identifies ColumnNotFoundError', () => {
		const error = new ColumnNotFoundError({
			table: 'x',
			requested: 'y',
			available: [],
		});
		expect(Errors.isColumnNotFound(error)).toBe(true);
	});

	it('isColumnNotFound returns false for non-matching error', () => {
		expect(Errors.isColumnNotFound(new Error('test'))).toBe(false);
	});

	it('isNamingConventionMismatch identifies NamingConventionMismatchError', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'a',
			adapterCasing: 'b',
		});
		expect(Errors.isNamingConventionMismatch(error)).toBe(true);
	});

	it('isNamingConventionMismatch returns false for non-matching error', () => {
		expect(Errors.isNamingConventionMismatch(new Error('test'))).toBe(false);
	});

	it('isDbspError returns true for NamingConventionMismatchError', () => {
		const error = new NamingConventionMismatchError({
			schemaCasing: 'a',
			adapterCasing: 'b',
		});
		expect(Errors.isDbspError(error)).toBe(true);
	});

	it('isDbspError returns true for InvalidOperationError', () => {
		expect(Errors.isDbspError(new InvalidOperationError('op', 'reason'))).toBe(
			true,
		);
	});

	it('isDbspError returns true for UnsafeOperationError', () => {
		expect(
			Errors.isDbspError(new UnsafeOperationError('update', 'add WHERE')),
		).toBe(true);
	});

	it('isDbspError returns true for AmbiguousRelationError', () => {
		expect(
			Errors.isDbspError(
				new AmbiguousRelationError('users', 'posts', ['rel1']),
			),
		).toBe(true);
	});

	it('isDbspError returns true for RelationNotFoundError', () => {
		expect(
			Errors.isDbspError(
				new RelationNotFoundError({
					table: 'users',
					requested: 'x',
					available: [],
				}),
			),
		).toBe(true);
	});

	it('isDbspError returns true for ColumnNotFoundError', () => {
		expect(
			Errors.isDbspError(
				new ColumnNotFoundError({
					table: 'users',
					requested: 'x',
					available: [],
				}),
			),
		).toBe(true);
	});

	it('isDbspError returns false for null/undefined', () => {
		expect(Errors.isDbspError(null)).toBe(false);
		expect(Errors.isDbspError(undefined)).toBe(false);
	});

	it('isDbspError returns false for number', () => {
		expect(Errors.isDbspError(42)).toBe(false);
	});
});

// ============================================================================
// Errors.hasCode — edge cases
// ============================================================================

describe('Errors.hasCode (coverage)', () => {
	it('returns true for factory-created error', () => {
		const error = Errors.execution({
			operation: 'x',
			reason: 'y',
			fix: 'z',
		});
		expect(Errors.hasCode(error)).toBe(true);
	});

	it('returns false for raw error class (no code property)', () => {
		const error = new ExecutionError({
			operation: 'x',
			reason: 'y',
			fix: 'z',
		});
		expect(Errors.hasCode(error)).toBe(false);
	});

	it('returns false for non-Error value', () => {
		expect(Errors.hasCode('not an error')).toBe(false);
		expect(Errors.hasCode(42)).toBe(false);
		expect(Errors.hasCode(null)).toBe(false);
		expect(Errors.hasCode(undefined)).toBe(false);
		expect(Errors.hasCode({})).toBe(false);
	});

	it('returns false for Error with non-string code', () => {
		const error = new Error('test');
		Object.assign(error, { code: 123 });
		expect(Errors.hasCode(error)).toBe(false);
	});

	it('returns false for Error with code not starting with DBSP_E', () => {
		const error = new Error('test');
		Object.assign(error, { code: 'OTHER_001' });
		expect(Errors.hasCode(error)).toBe(false);
	});

	it('returns true for all factory methods', () => {
		expect(
			Errors.hasCode(
				Errors.execution({ operation: 'x', reason: 'y', fix: 'z' }),
			),
		).toBe(true);
		expect(Errors.hasCode(Errors.notFound('t'))).toBe(true);
		expect(Errors.hasCode(Errors.ambiguousRelation('a', 'b', ['r']))).toBe(
			true,
		);
		expect(
			Errors.hasCode(
				Errors.relationNotFound({
					table: 't',
					requested: 'r',
					available: [],
				}),
			),
		).toBe(true);
		expect(Errors.hasCode(Errors.invalidOperation('op', 'reason'))).toBe(true);
		expect(Errors.hasCode(Errors.unsafeOperation('op', 'fix'))).toBe(true);
		expect(
			Errors.hasCode(Errors.tableNotFound({ requested: 'x', available: [] })),
		).toBe(true);
		expect(
			Errors.hasCode(
				Errors.columnNotFound({
					table: 't',
					requested: 'c',
					available: [],
				}),
			),
		).toBe(true);
	});
});

// ============================================================================
// InvalidOperationError & UnsafeOperationError — basic coverage
// ============================================================================

describe('InvalidOperationError (coverage)', () => {
	it('sets operation and reason properties', () => {
		const error = new InvalidOperationError('insert', 'empty values array');

		expect(error.operation).toBe('insert');
		expect(error.reason).toBe('empty values array');
		expect(error.message).toBe('Invalid insert: empty values array');
		expect(error.name).toBe('InvalidOperationError');
	});
});

describe('UnsafeOperationError (coverage)', () => {
	it('sets operation and fix properties', () => {
		const error = new UnsafeOperationError(
			'delete',
			'Add WHERE clause or use .all()',
		);

		expect(error.operation).toBe('delete');
		expect(error.fix).toBe('Add WHERE clause or use .all()');
		expect(error.message).toBe('Unsafe delete: Add WHERE clause or use .all()');
		expect(error.name).toBe('UnsafeOperationError');
	});
});

// ============================================================================
// AmbiguousRelationError — empty options edge case
// ============================================================================

describe('AmbiguousRelationError (coverage)', () => {
	it('handles empty options array (fallback firstOption)', () => {
		const error = new AmbiguousRelationError('users', 'posts', []);

		// options[0] ?? 'relationName' → 'relationName'
		expect(error.message).toContain("{ via: 'relationName' }");
		expect(error.options).toEqual([]);
	});
});
