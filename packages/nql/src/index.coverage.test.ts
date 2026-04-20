/**
 * Coverage tests for index.ts — exercises uncovered branches in
 * parse(), compile(), and hasColumnValidatorShape().
 */

import { describe, expect, it } from 'vitest';
import { NqlErrorCodes } from './errors/types.js';
import { compile, parse } from './index.js';

// ============================================================================
// parse()
// ============================================================================

describe('parse()', () => {
	it('returns success for valid simple query', () => {
		const result = parse('users');
		expect(result.success).toBe(true);
		expect(result.ast).toBeDefined();
		expect(result.ast?.type).toBe('program');
		expect(result.errors).toEqual([]);
	});

	it('returns success with AST for query with clauses', () => {
		const result = parse('users | where active = true | select id, name');
		expect(result.success).toBe(true);
		expect(result.ast).toBeDefined();
		expect(result.ast?.statements).toHaveLength(1);
	});

	it('returns failure for invalid input', () => {
		const result = parse('!!!invalid');
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.warnings).toEqual([]);
	});

	it('error has location when token is available', () => {
		// Partial query that produces a parse error with token info
		const result = parse('users | where');
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
		// Error code should be PARSE_UNEXPECTED_TOKEN
		expect(result.errors[0]?.code).toBe('ERR-PARSE-001');
	});

	it('returns success for empty input (empty program)', () => {
		// An empty string produces a valid program with no statements
		const result = parse('');
		expect(result.success).toBe(true);
		expect(result.ast?.statements).toHaveLength(0);
	});

	it('propagates warnings from CST-to-AST conversion', () => {
		// A well-formed query should produce no warnings
		const result = parse('users | select id');
		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it('accepts options parameter without error', () => {
		const result = parse('users', { strictMode: true });
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// compile()
// ============================================================================

describe('compile()', () => {
	// Schema satisfying ColumnValidatorSchema shape
	const validSchema = {
		getTable(name: string) {
			const tables: Record<string, { columns: { name: string }[] }> = {
				users: {
					columns: [
						{ name: 'id' },
						{ name: 'name' },
						{ name: 'email' },
						{ name: 'active' },
					],
				},
				posts: {
					columns: [{ name: 'id' }, { name: 'title' }, { name: 'body' }],
				},
			};
			return tables[name];
		},
		getRelationsFrom() {
			return [];
		},
		getRelationsTo() {
			return [];
		},
	};

	it('returns success for valid query with schema', () => {
		const result = compile('users', validSchema);
		expect(result.success).toBe(true);
		expect(result.ast).toBeDefined();
		expect(result.ast?.query).toBeDefined();
		expect(result.errors).toEqual([]);
	});

	it('returns success for valid query with null schema', () => {
		const result = compile('users', null);
		expect(result.success).toBe(true);
		expect(result.ast).toBeDefined();
		expect(result.ast?.query?.from).toBe('users');
	});

	it('returns failure when parse fails', () => {
		const result = compile('!!!invalid', null);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('returns failure with parse errors propagated', () => {
		const result = compile('users | where', validSchema);
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('propagates warnings from parse to compile result', () => {
		const result = compile('users | select id', validSchema);
		expect(result.success).toBe(true);
		expect(result.warnings).toEqual([]);
	});

	it('validates columns against schema (valid column)', () => {
		const result = compile("users | where name = 'test'", validSchema);
		expect(result.success).toBe(true);
	});

	it('returns error for unknown column with schema', () => {
		const result = compile("users | where nonexistent = 'test'", validSchema);
		expect(result.success).toBe(false);
		expect(result.errors[0]?.code).toBe(NqlErrorCodes.SEM_UNKNOWN_COLUMN);
	});

	it('handles schema without getTable (not ColumnValidatorSchema)', () => {
		// Object that doesn't satisfy ColumnValidatorSchema shape
		const notASchema = { someProp: true };
		const result = compile('users', notASchema);
		expect(result.success).toBe(true);
		// Should compile without validation
		expect(result.ast?.query?.from).toBe('users');
	});

	it('handles undefined schema', () => {
		const result = compile('users', undefined);
		expect(result.success).toBe(true);
		expect(result.ast?.query?.from).toBe('users');
	});

	it('handles schema with getTable but no getRelationsFrom', () => {
		const partialSchema = {
			getTable: () => ({ columns: [{ name: 'id' }] }),
			// Missing getRelationsFrom
		};
		const result = compile('users', partialSchema);
		expect(result.success).toBe(true);
	});

	it('catches compilation errors and returns them', () => {
		// A query that references an unknown table triggers validation error
		const result = compile("unknown_table | where col = 'val'", validSchema);
		// The table 'unknown_table' is not in the schema → validation error
		expect(result.success).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('compiles query with select clause', () => {
		const result = compile('users | select id, name', validSchema);
		expect(result.success).toBe(true);
		expect(result.ast?.query?.select).toBeDefined();
	});

	it('accepts compilerOptions parameter', () => {
		const result = compile('users', validSchema, undefined, {
			pseudoColumnKeywords: ['parent', 'children'],
		});
		expect(result.success).toBe(true);
	});
});

// ============================================================================
// hasColumnValidatorShape (indirectly through compile)
// ============================================================================

describe('hasColumnValidatorShape (via compile)', () => {
	it('null schema → no validation', () => {
		const result = compile("users | where anything = 'val'", null);
		expect(result.success).toBe(true);
	});

	it('non-object schema → no validation', () => {
		const result = compile("users | where anything = 'val'", 42);
		expect(result.success).toBe(true);
	});

	it('string schema → no validation', () => {
		const result = compile("users | where anything = 'val'", 'not-a-schema');
		expect(result.success).toBe(true);
	});

	it('object without getTable → no validation', () => {
		const result = compile("users | where anything = 'val'", {
			getRelationsFrom: () => [],
		});
		expect(result.success).toBe(true);
	});

	it('object without getRelationsFrom → no validation', () => {
		const result = compile("users | where anything = 'val'", {
			getTable: () => ({ columns: [] }),
		});
		expect(result.success).toBe(true);
	});

	it('object with getTable non-function → no validation', () => {
		const result = compile("users | where anything = 'val'", {
			getTable: 'not-a-function',
			getRelationsFrom: () => [],
		});
		expect(result.success).toBe(true);
	});

	it('object with getRelationsFrom non-function → no validation', () => {
		const result = compile("users | where anything = 'val'", {
			getTable: () => ({ columns: [] }),
			getRelationsFrom: 'not-a-function',
		});
		expect(result.success).toBe(true);
	});

	it('valid schema shape → validation enabled', () => {
		const schema = {
			getTable(name: string) {
				if (name === 'users') {
					return { columns: [{ name: 'id' }, { name: 'name' }] };
				}
				return undefined;
			},
			getRelationsFrom() {
				return [];
			},
		};
		// Valid column → passes
		const good = compile("users | where name = 'test'", schema);
		expect(good.success).toBe(true);

		// Invalid column → fails
		const bad = compile("users | where bogus = 'test'", schema);
		expect(bad.success).toBe(false);
	});
});

// ============================================================================
// compile() with mutations
// ============================================================================

describe('compile() with mutations', () => {
	it('compiles insert statement', () => {
		const result = compile(
			"insert into users set name = 'John', email = 'john@test.com'",
			null,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.mutation).toBeDefined();
	});

	it('compiles update statement', () => {
		const result = compile("update users set name = 'Jane' where id = 1", null);
		expect(result.success).toBe(true);
		expect(result.ast?.mutation).toBeDefined();
	});

	it('compiles delete statement', () => {
		const result = compile('delete from users where id = 1', null);
		expect(result.success).toBe(true);
		expect(result.ast?.mutation).toBeDefined();
	});
});

// ============================================================================
// compile() with set operations
// ============================================================================

describe('compile() set operations through full pipeline', () => {
	it('compiles UNION', () => {
		const result = compile(
			'users | select id | union (users | select id)',
			null,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation).toBeDefined();
		expect(result.ast?.setOperation?.op).toBe('union');
	});

	it('compiles INTERSECT', () => {
		const result = compile(
			'users | select id | intersect (users | select id)',
			null,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation?.op).toBe('intersect');
	});

	it('compiles EXCEPT', () => {
		const result = compile(
			'users | select id | except (users | select id)',
			null,
		);
		expect(result.success).toBe(true);
		expect(result.ast?.setOperation?.op).toBe('except');
	});
});
