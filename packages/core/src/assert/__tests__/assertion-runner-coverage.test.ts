/**
 * @fileoverview Branch coverage tests for assertion-runner.ts
 * Targets uncovered switch-case branches in runSingleAssertion.
 *
 * Rules:
 * - NEVER .toContain() — always .toEqual() or .toBe()
 * - Test uncovered branches only (no duplication of existing coverage)
 */

import { describe, expect, it } from 'vitest';
import type { Assertion, AssertionBlock } from '../assertion-parser.js';
import { runAssertions } from '../assertion-runner.js';
import type { AssertionQueryResult, IntentSummary } from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeResult(overrides: Partial<AssertionQueryResult> = {}): AssertionQueryResult {
	return {
		query: 'SELECT 1',
		success: true,
		sql: 'SELECT "users"."id" FROM "users"',
		params: [1, 'Alice'],
		output: 'output text',
		...overrides,
	};
}

function makeBlock(queryIndex: number, assertions: Partial<Assertion>[]): AssertionBlock {
	return {
		queryIndex,
		startLine: 1,
		assertions: assertions.map((a, i) => ({
			type: 'success',
			value: true,
			line: i + 2,
			...a,
		})) as Assertion[],
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

function run(type: string, value: unknown, resultOverrides: Partial<AssertionQueryResult> = {}) {
	const block = makeBlock(0, [{ type: type as Assertion['type'], value }]);
	const results = [makeResult(resultOverrides)];
	return runAssertions([block], results, ['SELECT 1'], true);
}

// ============================================================================
// output.equals
// ============================================================================

describe('output.equals branch', () => {
	it('passes when output matches exactly', () => {
		const summary = run('output.equals', 'output text');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when output does not match', () => {
		const summary = run('output.equals', 'wrong text');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.output is null', () => {
		const summary = run('output.equals', '', { output: undefined });
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// output.matches
// ============================================================================

describe('output.matches branch', () => {
	it('passes when output matches regex', () => {
		const summary = run('output.matches', 'output.*');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when output does not match regex', () => {
		const summary = run('output.matches', 'nomatch.*');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.output is undefined', () => {
		const summary = run('output.matches', '^$', { output: undefined });
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// sql.matches
// ============================================================================

describe('sql.matches branch', () => {
	it('passes when sql matches regex', () => {
		const summary = run('sql.matches', 'FROM.*users');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when sql does not match regex', () => {
		const summary = run('sql.matches', 'INSERT INTO.*');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.sql is undefined', () => {
		const summary = run('sql.matches', '^$', { sql: undefined });
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// sql.table
// ============================================================================

describe('sql.table branch', () => {
	it('passes when table is present in sql', () => {
		const summary = run('sql.table', 'users');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when table is not present in sql', () => {
		const summary = run('sql.table', 'posts');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.sql is undefined', () => {
		const summary = run('sql.table', 'users', { sql: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// sql.column
// ============================================================================

describe('sql.column branch', () => {
	it('passes when column is present in sql', () => {
		const summary = run('sql.column', 'id');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when column is not present in sql', () => {
		const summary = run('sql.column', 'nonexistent_col');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.sql is undefined', () => {
		const summary = run('sql.column', 'id', { sql: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// sql.join
// ============================================================================

describe('sql.join branch', () => {
	it('passes when join table is present in sql', () => {
		const sqlWithJoin = 'SELECT * FROM "users" JOIN "posts" ON "posts"."author_id" = "users"."id"';
		const summary = run('sql.join', 'posts', { sql: sqlWithJoin });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when join table is not present in sql', () => {
		const summary = run('sql.join', 'orders');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when result.sql is undefined', () => {
		const summary = run('sql.join', 'posts', { sql: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// params.equals with null/undefined params (??-evaluate-right path)
// ============================================================================

describe('params.equals ??-evaluate-right branch', () => {
	it('uses empty array when result.params is undefined', () => {
		const summary = run('params.equals', [], { params: undefined });
		expect(summary.passed).toBe(1);
	});

	it('fails when params do not match', () => {
		const summary = run('params.equals', [99], { params: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// params.type with undefined params
// ============================================================================

describe('params.type ??-evaluate-right branch', () => {
	it('uses empty array when result.params is undefined', () => {
		const summary = run('params.type', [], { params: undefined });
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// params.value with undefined params
// ============================================================================

describe('params.value ??-evaluate-right branch', () => {
	it('uses empty array when result.params is undefined', () => {
		// params.value checks if specific value exists in params array
		const summary = run('params.value', 1, { params: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// plan.contains with undefined output
// ============================================================================

describe('plan.contains ??-evaluate-right branch', () => {
	it('uses empty string when result.output is undefined', () => {
		const summary = run('plan.contains', 'anything', { output: undefined });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('passes when plan output contains expected string', () => {
		const summary = run('plan.contains', 'output');
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// db.output.contains (with hasDb=true)
// ============================================================================

describe('db.output.contains branch', () => {
	it('passes when db output contains expected string', () => {
		const summary = run('db.output.contains', 'output text');
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when db output does not contain expected string', () => {
		const summary = run('db.output.contains', 'missing string');
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('uses empty string when output is undefined', () => {
		const summary = run('db.output.contains', '', { output: undefined });
		expect(summary.passed).toBe(1);
	});
});

// ============================================================================
// db.rows.min / db.rows.max
// ============================================================================

describe('db.rows.min branch', () => {
	it('passes when rowCount >= min', () => {
		// AssertionQueryResult uses rowCount (not dbRowCount)
		const summary = run('db.rows.min', 2, { rowCount: 5 });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when rowCount < min', () => {
		const summary = run('db.rows.min', 10, { rowCount: 3 });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

describe('db.rows.max branch', () => {
	it('passes when rowCount <= max', () => {
		const summary = run('db.rows.max', 10, { rowCount: 3 });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when rowCount > max', () => {
		const summary = run('db.rows.max', 2, { rowCount: 5 });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// db.value.equals
// ============================================================================

describe('db.value.equals branch', () => {
	it('passes when spec value matches row cell', () => {
		// assertDbValueEquals takes spec { row, column, value } and checks result.rows
		const spec = { row: 0, column: 'id', value: 42 };
		const summary = run('db.value.equals', spec, { rows: [{ id: 42 }] });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when spec value does not match row cell', () => {
		const spec = { row: 0, column: 'id', value: 99 };
		const summary = run('db.value.equals', spec, { rows: [{ id: 42 }] });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});

	it('fails when row index is out of range', () => {
		const spec = { row: 5, column: 'id', value: 42 };
		const summary = run('db.value.equals', spec, { rows: [{ id: 42 }] });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// intent.table
// ============================================================================

describe('intent.table branch', () => {
	it('passes when intent.table matches', () => {
		const summary = run('intent.table', 'users', { intent: makeIntent({ table: 'users' }) });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when intent.table does not match', () => {
		const summary = run('intent.table', 'posts', { intent: makeIntent({ table: 'users' }) });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// intent.hasGroupBy / intent.hasOrderBy
// ============================================================================

describe('intent.hasGroupBy branch', () => {
	it('passes when intent.hasGroupBy matches true', () => {
		const summary = run('intent.hasGroupBy', true, { intent: makeIntent({ hasGroupBy: true }) });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('passes when intent.hasGroupBy matches false', () => {
		const summary = run('intent.hasGroupBy', false, { intent: makeIntent({ hasGroupBy: false }) });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when intent.hasGroupBy does not match', () => {
		const summary = run('intent.hasGroupBy', true, { intent: makeIntent({ hasGroupBy: false }) });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

describe('intent.hasOrderBy branch', () => {
	it('passes when intent.hasOrderBy matches true', () => {
		const summary = run('intent.hasOrderBy', true, { intent: makeIntent({ hasOrderBy: true }) });
		expect(summary.passed).toBe(1);
		expect(summary.failed).toBe(0);
	});

	it('fails when intent.hasOrderBy does not match', () => {
		const summary = run('intent.hasOrderBy', true, { intent: makeIntent({ hasOrderBy: false }) });
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(1);
	});
});

// ============================================================================
// default branch (unknown assertion type)
// ============================================================================

describe('runSingleAssertion default branch', () => {
	it('returns failed outcome for unknown assertion type', () => {
		const block = makeBlock(0, [{ type: 'unknown.type' as Assertion['type'], value: 'test' }]);
		const results = [makeResult()];
		const summary = runAssertions([block], results, ['SELECT 1'], true);
		expect(summary.failed).toBe(1);
		const outcome = summary.results[0]?.assertions[0];
		expect(outcome?.passed).toBe(false);
		expect(outcome?.message).toBe('Unknown assertion type: unknown.type');
	});
});

// ============================================================================
// db.* with hasDb=false → skipped (not-hasDb path)
// ============================================================================

describe('db.* with hasDb=false → skipped', () => {
	it('skips db.rows.min when hasDb=false', () => {
		const block = makeBlock(0, [{ type: 'db.rows.min', value: 1 }]);
		const results = [makeResult()];
		const summary = runAssertions([block], results, ['SELECT 1'], false);
		expect(summary.skipped).toBe(1);
		expect(summary.passed).toBe(0);
		expect(summary.failed).toBe(0);
	});

	it('skips db.value.equals when hasDb=false', () => {
		const block = makeBlock(0, [{ type: 'db.value.equals', value: 42 }]);
		const results = [makeResult()];
		const summary = runAssertions([block], results, ['SELECT 1'], false);
		expect(summary.skipped).toBe(1);
	});
});
