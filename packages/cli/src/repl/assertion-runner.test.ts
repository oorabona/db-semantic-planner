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
				expect(summary.results[0]!.passed).toBe(true);
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
				expect(summary.results[0]!.passed).toBe(false);
				expect(summary.results[0]!.assertions[0]!.message).toContain('contain');
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
				expect(summary.results[0]!.assertions[0]!.message).toContain(
					'mismatch',
				);
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
				expect(summary.results[0]!.assertions[0]!.message).toContain(
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
				expect(summary.results[0]!.assertions[0]!.message).toContain('succeed');
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
							{
								type: 'sql.equals',
								value: 'SELECT * FROM "posts" WHERE "published" = $1',
								line: 2,
							},
							{ type: 'params.equals', value: [true], line: 3 },
							{ type: 'success', value: true, line: 4 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.total).toBe(3);
				expect(summary.passed).toBe(3);
				expect(summary.failed).toBe(0);
				expect(summary.results[0]!.assertions).toHaveLength(3);
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
							{ type: 'sql.equals', value: 'SELECT * FROM "posts"', line: 2 },
							{ type: 'params.equals', value: [false], line: 3 }, // will fail
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
				expect(summary.failed).toBe(1);
				expect(summary.results[0]!.passed).toBe(false);
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
						assertions: [
							{
								type: 'sql.equals',
								value: 'SELECT * FROM posts WHERE id = $1',
								line: 2,
							},
						],
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
						assertions: [{ type: 'sql.equals', value: 'SELECT', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.results[0]!.querySuccess).toBe(false);
				// Assertion fails because sql is empty
				expect(summary.failed).toBe(1);
			});
		});

		// ============================================================
		// NEW TYPED ASSERTIONS (CLI-ASSERT)
		// ============================================================

		describe('sql.table (logical/physical naming)', () => {
			it('matches snake_case table name from camelCase', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM "product_images" WHERE id = $1',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.table', value: 'productImages', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
				expect(summary.failed).toBe(0);
			});

			it('matches table name with schema prefix', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM "ch6_pimdam"."product_images"',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.table', value: 'productImages', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('is case insensitive', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM PRODUCTIMAGES',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'sql.table', value: 'ProductImages', line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when table not found', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM users',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'sql.table', value: 'posts', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
			});
		});

		describe('sql.column', () => {
			it('matches column name with snake_case conversion', () => {
				const results = [
					createResult({
						sql: 'SELECT created_at FROM users',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'sql.column', value: 'createdAt', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('sql.join', () => {
			it('verifies JOIN with table name', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM posts INNER JOIN users ON posts.user_id = users.id',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'sql.join', value: 'users', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('fails when JOIN not found', () => {
				const results = [
					createResult({
						sql: 'SELECT * FROM posts WHERE id = 1',
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'sql.join', value: 'users', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
			});
		});

		describe('params.type', () => {
			it('validates primitive types correctly', () => {
				const results = [
					createResult({
						params: ['hello', 42, true],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{
								type: 'params.type',
								value: ['string', 'number', 'boolean'],
								line: 2,
							},
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});

			it('detects object where primitive expected', () => {
				const results = [
					createResult({
						params: [{ $ref: 'value' }, 42],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'params.type', value: ['string', 'number'], line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.failed).toBe(1);
				expect(summary.results[0]!.assertions[0]!.message).toContain('object');
			});

			it('handles null type', () => {
				const results = [
					createResult({
						params: ['hello', null],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{ type: 'params.type', value: ['string', 'null'], line: 2 },
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('params.value', () => {
			it('validates specific param by index', () => {
				const results = [
					createResult({
						params: ['test', 42, true],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{
								type: 'params.value',
								value: { index: 1, value: 42 } as any,
								line: 2,
							},
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query']);
				expect(summary.passed).toBe(1);
			});
		});

		describe('db.* assertions with hasDb flag', () => {
			it('skips db.* assertions when hasDb=false', () => {
				const results = [
					createResult({
						rowCount: 5,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.equals', value: 5, line: 2 }],
					}),
				];

				// hasDb = false (default)
				const summary = runAssertions(blocks, results, ['query'], false);
				expect(summary.skipped).toBe(1);
				expect(summary.passed).toBe(0);
				expect(summary.failed).toBe(0);
				expect(summary.results[0]!.assertions[0]!.skipped).toBe(true);
				expect(summary.results[0]!.assertions[0]!.skipReason).toContain(
					'dry-run',
				);
			});

			it('runs db.* assertions when hasDb=true', () => {
				const results = [
					createResult({
						rowCount: 5,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.equals', value: 5, line: 2 }],
					}),
				];

				// hasDb = true
				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.skipped).toBe(0);
				expect(summary.passed).toBe(1);
			});

			it('fails db.rows.equals on count mismatch', () => {
				const results = [
					createResult({
						rowCount: 3,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.equals', value: 5, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.failed).toBe(1);
				expect(summary.results[0]!.assertions[0]!.message).toBe(
					'Expected 5 rows, got 3',
				);
			});

			it('validates db.rows.min correctly', () => {
				const results = [
					createResult({
						rowCount: 5,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.min', value: 3, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.passed).toBe(1);
			});

			it('fails db.rows.min below threshold', () => {
				const results = [
					createResult({
						rowCount: 1,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.min', value: 3, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.failed).toBe(1);
				expect(summary.results[0]!.assertions[0]!.message).toBe(
					'Expected at least 3 rows, got 1',
				);
			});

			it('validates db.rows.max correctly', () => {
				const results = [
					createResult({
						rowCount: 2,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.max', value: 5, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.passed).toBe(1);
			});

			it('handles db.rows.equals with zero rows', () => {
				const results = [
					createResult({
						rowCount: 0,
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.rows.equals', value: 0, line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.passed).toBe(1);
			});
		});

		describe('db.column.exists', () => {
			it('passes when column exists in result', () => {
				const results = [
					createResult({
						columns: ['id', 'name', 'email'],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.column.exists', value: 'name', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.passed).toBe(1);
			});

			it('fails when column missing', () => {
				const results = [
					createResult({
						columns: ['id', 'email'],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [{ type: 'db.column.exists', value: 'name', line: 2 }],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.failed).toBe(1);
			});
		});

		describe('db.value.equals', () => {
			it('validates specific cell value', () => {
				const results = [
					createResult({
						rows: [
							{ id: 1, name: 'Alice' },
							{ id: 2, name: 'Bob' },
						],
					}),
				];
				const blocks = [
					createBlock({
						assertions: [
							{
								type: 'db.value.equals',
								value: { row: 0, column: 'name', value: 'Alice' } as any,
								line: 2,
							},
						],
					}),
				];

				const summary = runAssertions(blocks, results, ['query'], true);
				expect(summary.passed).toBe(1);
			});
		});
	});

	describe('db.output table assertion', () => {
		it('passes when rows match exactly', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'name'],
								rows: [
									['1', 'Alice'],
									['2', 'Bob'],
								],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [
						{ id: '1', name: 'Alice' },
						{ id: '2', name: 'Bob' },
					],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
			expect(summary.failed).toBe(0);
		});

		it('fails on row count mismatch', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id'],
								rows: [['1'], ['2']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [{ id: '1' }, { id: '2' }, { id: '3' }],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
			const outcome = summary.results[0]!.assertions[0]!;
			expect(outcome.message).toContain('Expected 2 rows, got 3');
		});

		it('fails on column value mismatch', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'name'],
								rows: [['1', 'Alice']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [{ id: '1', name: 'Bob' }],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
			const outcome = summary.results[0]!.assertions[0]!;
			expect(outcome.message).toContain('column "name"');
			expect(outcome.message).toContain('Alice');
			expect(outcome.message).toContain('Bob');
		});

		it('handles NULL matching', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'bio'],
								rows: [['1', 'NULL']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [{ id: '1', bio: null }],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('checks only listed columns (ignores extra)', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'name'],
								rows: [['1', 'Alice']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [
						{
							id: '1',
							name: 'Alice',
							email: 'alice@test.com',
							created_at: '2026-01-01',
						},
					],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('fails when expected column not in results', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'nonexistent'],
								rows: [['1', 'val']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [
				createResult({
					rows: [{ id: '1', name: 'Alice' }],
				}),
			];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
			const outcome = summary.results[0]!.assertions[0]!;
			expect(outcome.message).toContain('nonexistent');
		});

		it('skips in dry-run mode (no DB)', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id'],
								rows: [['1']],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [createResult({})];

			const summary = runAssertions(blocks, results, ['query'], false);
			expect(summary.skipped).toBe(1);
		});

		it('handles empty expected rows (header only)', () => {
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: {
								columns: ['id', 'name'],
								rows: [],
							},
							line: 1,
						},
					],
				}),
			];
			const results = [createResult({ rows: [] })];

			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});
	});
});
