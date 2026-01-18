/**
 * DEMO-E2E: Assertion Runner
 *
 * Runs assertions against query results and collects pass/fail outcomes.
 */

import type {
	Assertion,
	AssertionBlock,
	AssertionType,
} from './assertion-parser.js';
import { resolveQueryIndex } from './assertion-parser.js';
import type { BatchResult } from './batch.js';

/**
 * Result of running a single assertion
 */
export interface AssertionOutcome {
	type: AssertionType;
	expected: string | number | boolean | unknown[];
	actual: string | number | boolean | unknown[] | undefined;
	passed: boolean;
	message: string | undefined;
}

/**
 * Result of running all assertions for a single query
 */
export interface QueryAssertionResult {
	queryIndex: number;
	query: string;
	querySuccess: boolean;
	assertions: AssertionOutcome[];
	passed: boolean;
}

/**
 * Summary of all assertion results
 */
export interface AssertionSummary {
	total: number;
	passed: number;
	failed: number;
	results: QueryAssertionResult[];
}

/**
 * Normalize SQL for comparison by collapsing whitespace
 * This handles formatting differences between generated and expected SQL
 */
export function normalizeSQL(sql: string): string {
	return sql
		.replace(/\s+/g, ' ') // Collapse multiple whitespace to single space
		.replace(/\s*,\s*/g, ', ') // Normalize comma spacing
		.replace(/\s*\(\s*/g, '(') // Remove spaces around opening parens
		.replace(/\s*\)\s*/g, ')') // Remove spaces around closing parens
		.trim()
		.toLowerCase();
}

/**
 * Run all assertion blocks against query results
 *
 * @param blocks - Parsed assertion blocks
 * @param results - Query execution results
 * @param queries - Original query strings (for matching)
 * @returns Summary with detailed results
 */
export function runAssertions(
	blocks: AssertionBlock[],
	results: BatchResult[],
	queries: string[],
): AssertionSummary {
	const queryResults: QueryAssertionResult[] = [];
	let totalPassed = 0;
	let totalFailed = 0;

	for (const block of blocks) {
		const queryIndex = resolveQueryIndex(block, queries);

		// Skip if query index couldn't be resolved (validation should catch this earlier)
		if (queryIndex === -1 || queryIndex >= results.length) {
			continue;
		}

		const result = results[queryIndex];
		if (!result) {
			continue;
		}

		const outcomes: AssertionOutcome[] = [];
		let allPassed = true;

		for (const assertion of block.assertions) {
			const outcome = runSingleAssertion(assertion, result);
			outcomes.push(outcome);

			if (outcome.passed) {
				totalPassed++;
			} else {
				totalFailed++;
				allPassed = false;
			}
		}

		queryResults.push({
			queryIndex,
			query: result.query,
			querySuccess: result.success,
			assertions: outcomes,
			passed: allPassed,
		});
	}

	return {
		total: totalPassed + totalFailed,
		passed: totalPassed,
		failed: totalFailed,
		results: queryResults,
	};
}

/**
 * Run a single assertion against a query result
 */
function runSingleAssertion(
	assertion: Assertion,
	result: BatchResult,
): AssertionOutcome {
	const { type, value } = assertion;

	switch (type) {
		// Output assertions
		case 'output.contains':
			return assertContains('output', result.output ?? '', value as string);

		case 'output.equals':
			return assertEquals('output', result.output ?? '', value as string);

		case 'output.matches':
			return assertMatches('output', result.output ?? '', value as string);

		// SQL assertions
		case 'sql.contains':
			return assertContains('sql', result.sql ?? '', value as string);

		case 'sql.equals':
			return assertSQLEquals(result.sql ?? '', value as string);

		case 'sql.matches':
			return assertMatches('sql', result.sql ?? '', value as string);

		// Params assertions
		case 'params.equals':
			return assertParamsEquals(result.params ?? [], value as unknown[]);

		case 'params.length':
			return assertParamsLength(result.params ?? [], value as number);

		// Plan assertion (plan info is in output)
		case 'plan.contains':
			return assertContains('plan', result.output ?? '', value as string);

		// Success assertion
		case 'success':
			return assertSuccess(result.success, value as boolean);

		// Error assertion
		case 'error.contains':
			return assertContains('error', result.error ?? '', value as string);

		default:
			return {
				type,
				expected: value,
				actual: undefined,
				passed: false,
				message: `Unknown assertion type: ${type}`,
			};
	}
}

/**
 * Assert that a string contains a substring
 */
function assertContains(
	field: string,
	actual: string,
	expected: string,
): AssertionOutcome {
	const passed = actual.includes(expected);
	return {
		type: `${field}.contains` as AssertionType,
		expected,
		actual: passed
			? undefined
			: actual.slice(0, 200) + (actual.length > 200 ? '...' : ''),
		passed,
		message: passed ? undefined : `Expected ${field} to contain "${expected}"`,
	};
}

/**
 * Assert exact string equality
 */
function assertEquals(
	field: string,
	actual: string,
	expected: string,
): AssertionOutcome {
	const passed = actual.trim() === expected.trim();
	return {
		type: `${field}.equals` as AssertionType,
		expected,
		actual: passed
			? undefined
			: actual.slice(0, 200) + (actual.length > 200 ? '...' : ''),
		passed,
		message: passed ? undefined : `Expected ${field} to equal "${expected}"`,
	};
}

/**
 * Assert SQL equality with normalization
 */
function assertSQLEquals(actual: string, expected: string): AssertionOutcome {
	const normalizedActual = normalizeSQL(actual);
	const normalizedExpected = normalizeSQL(expected);
	const passed = normalizedActual === normalizedExpected;

	return {
		type: 'sql.equals',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `SQL mismatch:\n  Expected: ${expected}\n  Actual:   ${actual}`,
	};
}

/**
 * Assert string matches regex
 */
function assertMatches(
	field: string,
	actual: string,
	pattern: string,
): AssertionOutcome {
	const regex = new RegExp(pattern);
	const passed = regex.test(actual);
	return {
		type: `${field}.matches` as AssertionType,
		expected: pattern,
		actual: passed
			? undefined
			: actual.slice(0, 200) + (actual.length > 200 ? '...' : ''),
		passed,
		message: passed ? undefined : `Expected ${field} to match /${pattern}/`,
	};
}

/**
 * Assert params array equality
 */
function assertParamsEquals(
	actual: readonly unknown[],
	expected: unknown[],
): AssertionOutcome {
	const actualStr = JSON.stringify(actual);
	const expectedStr = JSON.stringify(expected);
	const passed = actualStr === expectedStr;

	return {
		type: 'params.equals',
		expected,
		actual: passed ? undefined : [...actual],
		passed,
		message: passed
			? undefined
			: `Params mismatch:\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}`,
	};
}

/**
 * Assert params array length
 */
function assertParamsLength(
	actual: readonly unknown[],
	expected: number,
): AssertionOutcome {
	const passed = actual.length === expected;
	return {
		type: 'params.length',
		expected,
		actual: passed ? undefined : actual.length,
		passed,
		message: passed
			? undefined
			: `Expected ${expected} params, got ${actual.length}`,
	};
}

/**
 * Assert query success/failure
 */
function assertSuccess(actual: boolean, expected: boolean): AssertionOutcome {
	const passed = actual === expected;
	return {
		type: 'success',
		expected,
		actual: passed ? undefined : actual,
		passed,
		message: passed
			? undefined
			: `Expected query to ${expected ? 'succeed' : 'fail'}, but it ${actual ? 'succeeded' : 'failed'}`,
	};
}
