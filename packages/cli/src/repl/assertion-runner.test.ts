/**
 * DEMO-E2E: Assertion Runner Tests
 */

import { describe, expect, it } from 'vitest';
import type { AssertionBlock } from './assertion-parser.js';
import { normalizeSQL, runAssertions } from './assertion-runner.js';
import type { BatchResult } from './batch.js';

// Helper to create minimal BatchResult for testing
function createResult(overrides: Partial<BatchResult>): BatchResult {
	return {
		query: 'test query',
		success: true,
		type: 'query',
		...overrides,
	};
}

// Helper to create minimal AssertionBlock for testing
function createBlock(overrides: Partial<AssertionBlock>): AssertionBlock {
	return {
		queryIndex: 0,
		startLine: 1,
		assertions: [],
		...overrides,
	};
}

describe('assertion-runner', () => {
	describe('normalizeSQL', () => {
		it('collapses multiple whitespace', () => {
			const input = 'SELECT   *   FROM   users';
			const expected = 'select * from users';
			expect(normalizeSQL(input)).toBe(expected);
		});

		it('normalizes comma spacing', () => {
			const input = 'SELECT a,b ,c , d FROM users';
			const expected = 'select a, b, c, d from users';
			expect(normalizeSQL(input)).toBe(expected);
		});

		it('removes spaces around parentheses', () => {
			const input = 'SELECT * FROM users WHERE id IN ( 1, 2, 3 )';
			const expected = 'select * from users where id in(1, 2, 3)';
			expect(normalizeSQL(input)).toBe(expected);
		});

		it('trims leading/trailing whitespace', () => {
			const input = '  SELECT * FROM users  ';
			const expected = 'select * from users';
			expect(normalizeSQL(input)).toBe(expected);
		});

		it('lowercases SQL', () => {
			const input = 'SELECT * FROM Users WHERE Id = 1';
			const expected = 'select * from users where id = 1';
			expect(normalizeSQL(input)).toBe(expected);
		});
	});

	describe('runAssertions', () => {
		describe('output.contains', () => {
			it('passes when output contains expected text', () => {
				const results = [
					createResult({ output: 'Tables (5): users, posts, comments' }),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.contains', value: 'Tables (5)', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
				expect(summary.failed).toBe(0);
				expect(summary.results[0].passed).toBe(true);
			});

			it('fails when output does not contain expected text', () => {
				const results = [createResult({ output: 'Tables (3): users, posts' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.contains', value: 'NotFound', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(0);
				expect(summary.failed).toBe(1);
				expect(summary.results[0].passed).toBe(false);
				expect(summary.results[0].assertions[0].message).toContain('contain');
			});
		});

		describe('output.equals', () => {
			it('passes on exact match (with trim)', () => {
				const results = [createResult({ output: '  exact value  ' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.equals', value: 'exact value', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails on mismatch', () => {
				const results = [createResult({ output: 'actual value' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.equals', value: 'expected value', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
			});
		});

		describe('output.matches', () => {
			it('passes when regex matches', () => {
				const results = [createResult({ output: 'Tables (5)' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.matches', value: 'Tables \\(\\d+\\)', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when regex does not match', () => {
				const results = [createResult({ output: 'No tables' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'output.matches', value: 'Tables \\(\\d+\\)', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
			});
		});

		describe('sql.contains', () => {
			it('passes when SQL contains expected text', () => {
				const results = [
					createResult({ sql: 'SELECT * FROM "posts" WHERE "published" = $1' }),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.contains', value: 'WHERE "published"', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('sql.equals', () => {
			it('passes with normalized comparison', () => {
				const results = [createResult({ sql: 'SELECT  *  FROM  "users"' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.equals', value: 'select * from "users"', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('handles case differences', () => {
				const results = [createResult({ sql: 'SELECT * FROM "Users"' })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.equals', value: 'select * from "users"', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('sql.matches', () => {
			it('passes when regex matches SQL', () => {
				const results = [
					createResult({ sql: 'SELECT "t0".* FROM "posts" AS "t0"' }),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.matches', value: 'FROM.*posts', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('params.equals', () => {
			it('passes when params match exactly', () => {
				const results = [createResult({ params: [true, 1, 'test'] })];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'params.equals', value: [true, 1, 'test'], line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when params differ', () => {
				const results = [createResult({ params: [true] })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'params.equals', value: [false], line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
				expect(summary.results[0].assertions[0].message).toContain('mismatch');
			});
		});

		describe('params.length', () => {
			it('passes when length matches', () => {
				const results = [createResult({ params: [1, 2, 3] })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'params.length', value: 3, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when length differs', () => {
				const results = [createResult({ params: [1, 2] })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'params.length', value: 3, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
				expect(summary.results[0].assertions[0].message).toContain(
					'Expected 3 params, got 2',
				);
			});
		});

		describe('plan.contains', () => {
			it('passes when plan output contains text', () => {
				const results = [
					createResult({
						output: 'Query Plan:\n  include-strategy: join\n  table: posts',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{
								type: 'plan.contains',
								value: 'include-strategy: join',
								line: 2,
							},
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('success', () => {
			it('passes when query succeeds and success: true', () => {
				const results = [createResult({ success: true })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'success', value: true, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('passes when query fails and success: false', () => {
				const results = [createResult({ success: false })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'success', value: false, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when success mismatch', () => {
				const results = [createResult({ success: false })];
				const blocks = [
					createBlock({
						assertions: [{ type: 'success', value: true, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
				expect(summary.results[0].assertions[0].message).toContain('succeed');
			});
		});

		describe('error.contains', () => {
			it('passes when error contains expected text', () => {
				const results = [
					createResult({
						success: false,
						error: 'Column "nonexistent" not found in table "users"',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'error.contains', value: 'not found', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('multiple assertions', () => {
			it('runs all assertions in a block', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM "posts" WHERE "published" = $1',
						params: [true],
						success: true,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.contains', value: 'FROM "posts"', line: 2 },
							{ type: 'params.equals', value: [true], line: 3 },
							{ type: 'success', value: true, line: 4 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.total).toBe(3);
				expect(summary.passed).toBe(3);
				expect(summary.failed).toBe(0);
				expect(summary.results[0].assertions).toHaveLength(3);
			});

			it('marks block as failed if any assertion fails', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM "posts"',
						params: [true],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.contains', value: 'FROM "posts"', line: 2 },
							{ type: 'params.equals', value: [false], line: 3 }, // will fail
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
				expect(summary.failed).toBe(1);
				expect(summary.results[0].passed).toBe(false);
			});
		});

		describe('multiple blocks', () => {
			it('runs assertions for multiple queries', () => {
				const results = [
					createResult({
						query: 'posts',
						output: 'posts output',
						success: true,
					}),
					createResult({
						query: 'users',
						output: 'users output',
						success: true,
					}),
				];
				const blocks = [
					createBlock({
						queryIndex: 0,
						assertions: [{ type: 'output.contains', value: 'posts', line: 2 }],
					}),
					createBlock({
						queryIndex: 1,
						assertions: [{ type: 'output.contains', value: 'users', line: 4 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['posts', 'users']);
				expect(summary.total).toBe(2);
				expect(summary.passed).toBe(2);
				expect(summary.results).toHaveLength(2);
			});
		});

		describe('query matching', () => {
			it('matches by queryMatch string', () => {
				const results = [
					createResult({
						query: 'posts where id = 1',
						sql: 'SELECT * FROM posts WHERE id = $1',
					}),
				];
				const blocks = [
					createBlock({
						queryMatch: 'posts where id = 1',
						assertions: [{ type: 'sql.contains', value: 'WHERE id', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['posts where id = 1']);
				expect(summary.passed).toBe(1);
			});

			it('skips blocks with invalid query index', () => {
				const results = [createResult({})];
				const blocks = [
					createBlock({
						queryIndex: 99, // out of bounds
						assertions: [{ type: 'success', value: true, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.total).toBe(0);
				expect(summary.results).toHaveLength(0);
			});
		});

		describe('ERR-05: assertion on failed query', () => {
			it('records query failure status alongside assertion results', () => {
				const results = [
					createResult({
						success: false,
						error: 'Query failed',
						// sql is omitted (will be undefined via the spread)
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'sql.contains', value: 'SELECT', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.results[0].querySuccess).toBe(false);
				// Assertion fails because sql is empty
				expect(summary.failed).toBe(1);
			});
		});
	});
});
