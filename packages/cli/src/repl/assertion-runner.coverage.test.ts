// @ts-nocheck — coverage test: runtime assertions
import { describe, expect, it } from 'vitest';
import type { AssertionBlock } from './assertion-parser.js';
import { runAssertions } from './assertion-runner.js';
import type { BatchResult } from './batch.js';

/**
 * Coverage test for assertion-runner.ts — targets UNCOVERED branches only.
 * The existing assertion-runner.test.ts covers most happy paths.
 * This file focuses on:
 *  - db.success routing (dbSuccess ?? success fallback)
 *  - db.output.contains routing
 *  - default/unknown assertion type
 *  - intent.* assertion routing through runSingleAssertion
 *  - edge cases: undefined result, query index -1, missing result fields
 */

function createResult(overrides: Partial<BatchResult>): BatchResult {
	return {
		query: 'test query',
		success: true,
		type: 'query',
		...overrides,
	};
}

function createBlock(overrides: Partial<AssertionBlock>): AssertionBlock {
	return {
		queryIndex: 0,
		startLine: 1,
		assertions: [],
		...overrides,
	};
}

describe('assertion-runner coverage', () => {
	describe('db.success assertion', () => {
		it('uses dbSuccess when available', () => {
			const results = [createResult({ success: true, dbSuccess: false })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.success', value: false, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('falls back to success when dbSuccess undefined', () => {
			const results = [createResult({ success: true })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.success', value: true, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('fails when dbSuccess mismatches', () => {
			const results = [createResult({ success: true, dbSuccess: true })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.success', value: false, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
		});
	});

	describe('db.output.contains assertion', () => {
		it('passes when output contains expected text', () => {
			const results = [createResult({ output: 'Alice and Bob' })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.output.contains', value: 'Alice', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('fails when output does not contain text', () => {
			const results = [createResult({ output: 'Alice and Bob' })];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'db.output.contains', value: 'Charlie', line: 2 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
		});

		it('uses empty string when output is undefined', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'db.output.contains', value: 'anything', line: 2 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.failed).toBe(1);
		});
	});

	describe('unknown assertion type', () => {
		it('returns failure with unknown type message', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [{ type: 'totally.unknown' as any, value: 'x', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.failed).toBe(1);
			expect(summary.results[0]!.assertions[0]!.message).toContain(
				'Unknown assertion type',
			);
		});
	});

	describe('intent.* assertions routed through runner', () => {
		const intent = {
			type: 'query',
			table: 'posts',
			with: ['comments'],
			hasWhere: true,
			hasGroupBy: false,
			hasOrderBy: true,
		};

		it('routes intent.type', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.type', value: 'query', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('routes intent.table', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.table', value: 'posts', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('routes intent.with', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.with', value: 'comments', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('routes intent.hasWhere', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.hasWhere', value: true, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('routes intent.hasGroupBy', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.hasGroupBy', value: false, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('routes intent.hasOrderBy', () => {
			const results = [createResult({ intent })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'intent.hasOrderBy', value: true, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});
	});

	describe('edge cases in runAssertions', () => {
		it('skips block when queryIndex resolves to -1', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					queryIndex: undefined,
					queryMatch: 'nonexistent',
					assertions: [{ type: 'success', value: true, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['real query']);
			expect(summary.total).toBe(0);
			expect(summary.results).toHaveLength(0);
		});

		it('skips block when result at index is undefined', () => {
			// Create a sparse array scenario — results[0] is valid but results[1] isn't
			const results = [createResult({})];
			const blocks = [
				createBlock({
					queryIndex: 1,
					assertions: [{ type: 'success', value: true, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['q0', 'q1']);
			expect(summary.total).toBe(0);
		});

		it('handles output.* with undefined output (falls back to empty string)', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [{ type: 'output.contains', value: 'test', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.failed).toBe(1);
		});

		it('handles sql.* with undefined sql', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [{ type: 'sql.equals', value: 'SELECT 1', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.failed).toBe(1);
		});

		it('handles params.* with undefined params (falls back to empty array)', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [{ type: 'params.length', value: 0, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles error.contains with undefined error', () => {
			const results = [createResult({})];
			const blocks = [
				createBlock({
					assertions: [{ type: 'error.contains', value: 'something', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.failed).toBe(1);
		});

		it('handles db.* skip counting alongside non-db passes', () => {
			const results = [createResult({ output: 'hello' })];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'output.contains', value: 'hello', line: 2 },
						{ type: 'db.rows.equals', value: 1, line: 3 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], false);
			expect(summary.passed).toBe(1);
			expect(summary.skipped).toBe(1);
			expect(summary.failed).toBe(0);
			// Block counts skipped as passed for block-level assessment
			expect(summary.results[0]!.passed).toBe(true);
		});

		it('handles sql.table and sql.column routing', () => {
			const results = [
				createResult({
					sql: 'SELECT "created_at" FROM "users"',
				}),
			];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'sql.table', value: 'users', line: 2 },
						{ type: 'sql.column', value: 'createdAt', line: 3 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(2);
		});

		it('handles sql.join routing', () => {
			const results = [
				createResult({
					sql: 'SELECT * FROM posts LEFT JOIN "users" ON p.uid = u.id',
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

		it('handles params.type routing', () => {
			const results = [createResult({ params: ['a', 1] })];
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'params.type',
							value: ['string', 'number'],
							line: 2,
						},
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles params.value routing', () => {
			const results = [createResult({ params: [42] })];
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'params.value',
							value: { index: 0, value: 42 },
							line: 2,
						},
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles plan.contains routing', () => {
			const results = [createResult({ output: 'strategy: join' })];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'plan.contains', value: 'strategy: join', line: 2 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles db.output routing', () => {
			const results = [
				createResult({
					rows: [{ id: '1' }],
				}),
			];
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.output',
							value: { columns: ['id'], rows: [['1']] },
							line: 2,
						},
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('handles db.value.equals routing', () => {
			const results = [
				createResult({
					rows: [{ id: 1, name: 'Alice' }],
				}),
			];
			const blocks = [
				createBlock({
					assertions: [
						{
							type: 'db.value.equals',
							value: { row: 0, column: 'name', value: 'Alice' },
							line: 2,
						},
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('handles db.column.exists routing', () => {
			const results = [
				createResult({
					columns: ['id', 'name'],
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

		it('handles db.rows.min routing', () => {
			const results = [createResult({ rowCount: 5 })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.rows.min', value: 3, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('handles db.rows.max routing', () => {
			const results = [createResult({ rowCount: 5 })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'db.rows.max', value: 10, line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query'], true);
			expect(summary.passed).toBe(1);
		});

		it('handles sql.matches routing', () => {
			const results = [
				createResult({
					sql: 'SELECT * FROM "users"',
				}),
			];
			const blocks = [
				createBlock({
					assertions: [{ type: 'sql.matches', value: 'FROM.*users', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles output.equals routing', () => {
			const results = [createResult({ output: 'exact' })];
			const blocks = [
				createBlock({
					assertions: [{ type: 'output.equals', value: 'exact', line: 2 }],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});

		it('handles output.matches routing', () => {
			const results = [createResult({ output: '42 items' })];
			const blocks = [
				createBlock({
					assertions: [
						{ type: 'output.matches', value: '\\d+ items', line: 2 },
					],
				}),
			];
			const summary = runAssertions(blocks, results, ['query']);
			expect(summary.passed).toBe(1);
		});
	});
});
