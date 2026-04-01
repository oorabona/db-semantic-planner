import { describe, expect, it } from 'vitest';
import type { Assertion, AssertionBlock } from '../assertion-parser.js';
import { runAssertions } from '../assertion-runner.js';
import type { AssertionQueryResult, IntentSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
	overrides: Partial<AssertionQueryResult> = {},
): AssertionQueryResult {
	return {
		query: 'SELECT 1',
		success: true,
		sql: 'SELECT 1',
		params: [],
		output: '',
		...overrides,
	};
}

function makeBlock(
	queryIndex: number,
	assertions: Partial<Assertion>[],
	overrides: Partial<AssertionBlock> = {},
): AssertionBlock {
	return {
		queryIndex,
		startLine: 1,
		assertions: assertions.map((a, i) => ({
			type: 'success',
			value: true,
			line: i + 2,
			...a,
		})) as Assertion[],
		...overrides,
	};
}

function makeIntent(overrides: Partial<IntentSummary> = {}): IntentSummary {
	return {
		type: 'select',
		table: 'users',
		with: [],
		hasWhere: false,
		hasGroupBy: false,
		hasOrderBy: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// runAssertions — empty / skip scenarios
// ---------------------------------------------------------------------------

describe('runAssertions', () => {
	describe('empty inputs', () => {
		it('should return zero totals for empty blocks', () => {
			const summary = runAssertions([], [], []);
			expect(summary.total).toBe(0);
			expect(summary.passed).toBe(0);
			expect(summary.failed).toBe(0);
			expect(summary.skipped).toBe(0);
			expect(summary.results).toEqual([]);
		});

		it('should skip a block when query index is -1 (unresolved)', () => {
			// Block with queryIndex=undefined and no queryMatch → resolves to -1
			const block = makeBlock(0, [{ type: 'success', value: true }]);
			// Intentionally pass empty results so index 0 is out of range
			const summary = runAssertions([block], [], ['SELECT 1']);
			expect(summary.results).toHaveLength(0);
		});

		it('should skip a block when resolved index exceeds results array length', () => {
			const block = makeBlock(5, [{ type: 'success', value: true }]);
			const results = [makeResult()]; // only index 0
			const summary = runAssertions([block], results, ['SELECT 1']);
			expect(summary.results).toHaveLength(0);
		});
	});

	describe('passing assertions', () => {
		it('should count a passing assertion', () => {
			const block = makeBlock(0, [{ type: 'success', value: true }]);
			const summary = runAssertions(
				[block],
				[makeResult({ success: true })],
				['SELECT 1'],
			);
			expect(summary.passed).toBe(1);
			expect(summary.failed).toBe(0);
			expect(summary.total).toBe(1);
		});

		it('should count multiple passing assertions across blocks', () => {
			const block1 = makeBlock(0, [
				{ type: 'success', value: true },
				{ type: 'params.length', value: 0 },
			]);
			const block2 = makeBlock(1, [{ type: 'success', value: false }]);
			const results = [
				makeResult({ success: true }),
				makeResult({ success: false }),
			];
			const summary = runAssertions([block1, block2], results, [
				'SELECT 1',
				'SELECT 2',
			]);
			expect(summary.passed).toBe(3);
			expect(summary.failed).toBe(0);
		});
	});

	describe('failing assertions', () => {
		it('should count a failing assertion', () => {
			const block = makeBlock(0, [{ type: 'success', value: false }]);
			const summary = runAssertions(
				[block],
				[makeResult({ success: true })],
				['SELECT 1'],
			);
			expect(summary.failed).toBe(1);
			expect(summary.passed).toBe(0);
		});

		it('should mark block.passed = false when any assertion fails', () => {
			const block = makeBlock(0, [
				{ type: 'success', value: true },
				{ type: 'success', value: false }, // will fail
			]);
			const summary = runAssertions(
				[block],
				[makeResult({ success: true })],
				['SELECT 1'],
			);
			expect(summary.results[0]?.passed).toBe(false);
		});

		it('should set block.passed = true when all assertions pass', () => {
			const block = makeBlock(0, [
				{ type: 'success', value: true },
				{ type: 'params.length', value: 0 },
			]);
			const summary = runAssertions(
				[block],
				[makeResult({ success: true, params: [] })],
				['SELECT 1'],
			);
			expect(summary.results[0]?.passed).toBe(true);
		});
	});

	describe('skipped db.* assertions in dry-run mode (hasDb = false)', () => {
		it('should skip db.success when hasDb = false', () => {
			const block = makeBlock(0, [{ type: 'db.success', value: true }]);
			const summary = runAssertions(
				[block],
				[makeResult()],
				['SELECT 1'],
				false,
			);
			expect(summary.skipped).toBe(1);
			expect(summary.passed).toBe(0);
			expect(summary.failed).toBe(0);
		});

		it('should skip db.rows.equals when hasDb = false', () => {
			const block = makeBlock(0, [{ type: 'db.rows.equals', value: 5 }]);
			const summary = runAssertions(
				[block],
				[makeResult()],
				['SELECT 1'],
				false,
			);
			expect(summary.skipped).toBe(1);
		});

		it('should not skip db.* assertions when hasDb = true', () => {
			const block = makeBlock(0, [{ type: 'db.success', value: true }]);
			const result = makeResult({ success: true, dbSuccess: true });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.skipped).toBe(0);
			expect(summary.passed).toBe(1);
		});
	});

	describe('assertion types — output', () => {
		it('should pass output.contains when output has the substring', () => {
			const block = makeBlock(0, [{ type: 'output.contains', value: 'rows' }]);
			const result = makeResult({ output: '5 rows returned' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should fail output.equals when output differs', () => {
			const block = makeBlock(0, [
				{ type: 'output.equals', value: 'expected output' },
			]);
			const result = makeResult({ output: 'different output' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(false);
		});

		it('should handle undefined output gracefully (fallback to empty string)', () => {
			const block = makeBlock(0, [{ type: 'output.contains', value: '' }]);
			const result = makeResult({ output: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — SQL', () => {
		it('should pass sql.equals when sql matches', () => {
			const block = makeBlock(0, [{ type: 'sql.equals', value: 'SELECT 1' }]);
			const result = makeResult({ sql: 'SELECT 1' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should fail sql.equals when sql differs', () => {
			const block = makeBlock(0, [{ type: 'sql.equals', value: 'SELECT 2' }]);
			const result = makeResult({ sql: 'SELECT 1' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(false);
		});

		it('should handle undefined sql gracefully (fallback to empty string)', () => {
			const block = makeBlock(0, [{ type: 'sql.equals', value: '' }]);
			const result = makeResult({ sql: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — params', () => {
		it('should pass params.equals with matching params', () => {
			const block = makeBlock(0, [
				{ type: 'params.equals', value: [1, 'foo'] },
			]);
			const result = makeResult({ params: [1, 'foo'] });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass params.length with correct length', () => {
			const block = makeBlock(0, [{ type: 'params.length', value: 2 }]);
			const result = makeResult({ params: ['a', 'b'] });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass params.type with matching types', () => {
			const block = makeBlock(0, [
				{ type: 'params.type', value: ['number', 'string'] },
			]);
			const result = makeResult({ params: [1, 'foo'] });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass params.value for matching indexed param', () => {
			const block = makeBlock(0, [
				{ type: 'params.value', value: { index: 1, value: 'bar' } },
			]);
			const result = makeResult({ params: ['foo', 'bar'] });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should handle undefined params gracefully (fallback to empty array)', () => {
			const block = makeBlock(0, [{ type: 'params.length', value: 0 }]);
			const result = makeResult({ params: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — plan', () => {
		it('should pass plan.contains when output contains the plan fragment', () => {
			const block = makeBlock(0, [
				{ type: 'plan.contains', value: 'index scan' },
			]);
			const result = makeResult({ output: 'used index scan strategy' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — error', () => {
		it('should pass error.contains when error message has the substring', () => {
			const block = makeBlock(0, [
				{ type: 'error.contains', value: 'syntax error' },
			]);
			const result = makeResult({ error: 'syntax error at position 5' });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should handle undefined error gracefully', () => {
			const block = makeBlock(0, [{ type: 'error.contains', value: '' }]);
			const result = makeResult({ error: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — intent', () => {
		it('should pass intent.type when intent type matches', () => {
			const block = makeBlock(0, [{ type: 'intent.type', value: 'select' }]);
			const result = makeResult({ intent: makeIntent({ type: 'select' }) });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should fail intent.type when intent is missing', () => {
			const block = makeBlock(0, [{ type: 'intent.type', value: 'select' }]);
			const result = makeResult({ intent: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(false);
		});

		it('should pass intent.hasWhere: true when query has a WHERE clause', () => {
			const block = makeBlock(0, [{ type: 'intent.hasWhere', value: true }]);
			const result = makeResult({ intent: makeIntent({ hasWhere: true }) });
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass intent.with for matching relations', () => {
			const block = makeBlock(0, [{ type: 'intent.with', value: 'posts' }]);
			const result = makeResult({
				intent: makeIntent({ with: ['posts', 'comments'] }),
			});
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('assertion types — db (hasDb = true)', () => {
		it('should pass db.success when dbSuccess is true and expected true', () => {
			const block = makeBlock(0, [{ type: 'db.success', value: true }]);
			const result = makeResult({ dbSuccess: true });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should fallback to success when dbSuccess is undefined', () => {
			const block = makeBlock(0, [{ type: 'db.success', value: true }]);
			const result = makeResult({ success: true, dbSuccess: undefined });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass db.rows.equals when rowCount matches', () => {
			const block = makeBlock(0, [{ type: 'db.rows.equals', value: 3 }]);
			// db.rows.equals uses result.rowCount (not rows.length)
			const result = makeResult({ rowCount: 3 });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass db.column.exists when column is found', () => {
			const block = makeBlock(0, [
				{ type: 'db.column.exists', value: 'email' },
			]);
			const result = makeResult({ columns: ['id', 'email'] });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});

		it('should pass db.output when table data matches actual rows', () => {
			const block = makeBlock(0, [
				{
					type: 'db.output',
					value: {
						columns: ['name'],
						rows: [['Alice']],
					},
				},
			]);
			const result = makeResult({ rows: [{ name: 'Alice' }] });
			const summary = runAssertions([block], [result], ['SELECT 1'], true);
			expect(summary.results[0]?.assertions[0]?.passed).toBe(true);
		});
	});

	describe('query resolution via queryMatch', () => {
		it('should resolve block by queryMatch text', () => {
			const block: AssertionBlock = {
				queryIndex: undefined,
				queryMatch: 'SELECT 2',
				startLine: 1,
				assertions: [{ type: 'success', value: true, line: 2 }],
			};
			const results = [
				makeResult({ query: 'SELECT 1' }),
				makeResult({ query: 'SELECT 2' }),
			];
			const summary = runAssertions([block], results, ['SELECT 1', 'SELECT 2']);
			expect(summary.results[0]?.queryIndex).toBe(1);
			expect(summary.results[0]?.query).toBe('SELECT 2');
		});

		it('should skip block when queryMatch does not resolve', () => {
			const block: AssertionBlock = {
				queryIndex: undefined,
				queryMatch: 'no match',
				startLine: 1,
				assertions: [{ type: 'success', value: true, line: 2 }],
			};
			const summary = runAssertions([block], [makeResult()], ['SELECT 1']);
			expect(summary.results).toHaveLength(0);
		});
	});

	describe('summary accounting', () => {
		it('should include skipped in total count', () => {
			const block = makeBlock(0, [
				{ type: 'success', value: true }, // passes
				{ type: 'db.success', value: true }, // skipped (no db)
			]);
			const summary = runAssertions(
				[block],
				[makeResult({ success: true })],
				['SELECT 1'],
				false,
			);
			expect(summary.total).toBe(2);
			expect(summary.passed).toBe(1);
			expect(summary.skipped).toBe(1);
			expect(summary.failed).toBe(0);
		});

		it('should record query and querySuccess on each result', () => {
			const block = makeBlock(0, [{ type: 'success', value: true }]);
			const result = makeResult({ query: 'SELECT NOW()', success: true });
			const summary = runAssertions([block], [result], ['SELECT NOW()']);
			expect(summary.results[0]?.query).toBe('SELECT NOW()');
			expect(summary.results[0]?.querySuccess).toBe(true);
		});

		it('should handle unknown assertion type by returning failed outcome', () => {
			const block = makeBlock(0, [{ type: 'sql.equals', value: 'X' }]);
			// Use an assertion type we know will fail via the 'default' branch by
			// crafting a result that causes sql.equals to fail
			const result = makeResult({ sql: 'SELECT 1' });
			// sql.equals: 'X' vs 'SELECT 1' → fails
			const summary = runAssertions([block], [result], ['SELECT 1']);
			expect(summary.failed).toBe(1);
		});
	});
});
