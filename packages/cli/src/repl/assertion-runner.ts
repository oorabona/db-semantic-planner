/**
 * DEMO-E2E: Assertion Runner
 *
 * Runs assertions against query results and collects pass/fail outcomes.
 */

import {
	assertContains,
	assertDbColumnExists,
	assertDbOutput,
	assertDbRowsEquals,
	assertDbRowsMax,
	assertDbRowsMin,
	assertDbValueEquals,
	assertEquals,
	assertIntentHasGroupBy,
	assertIntentHasOrderBy,
	assertIntentHasWhere,
	assertIntentTable,
	assertIntentType,
	assertIntentWith,
	assertMatches,
	assertParamsEquals,
	assertParamsLength,
	assertParamsType,
	assertParamsValue,
	assertSQLColumn,
	assertSQLEquals,
	assertSQLJoin,
	assertSQLTable,
	assertSuccess,
} from './assertion-functions.js';
import type {
	Assertion,
	AssertionBlock,
	AssertionType,
	TableAssertionData,
} from './assertion-parser.js';
import { resolveQueryIndex } from './assertion-parser.js';
import type { BatchResult } from './batch.js';

// Re-export normalizeSQL from assertion-functions (public API)
export { normalizeSQL } from './assertion-functions.js';

/**
 * Result of running a single assertion
 */
export interface AssertionOutcome {
	type: AssertionType;
	expected: unknown;
	actual: unknown;
	passed: boolean;
	message: string | undefined;
	/** True if assertion was skipped (e.g., db.* without DB connection) */
	skipped?: boolean;
	/** Reason for skipping */
	skipReason?: string;
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
	skipped: number;
	results: QueryAssertionResult[];
}

/**
 * Run all assertion blocks against query results
 *
 * @param blocks - Parsed assertion blocks
 * @param results - Query execution results
 * @param queries - Original query strings (for matching)
 * @param hasDb - Whether a database connection is available (for db.* assertions)
 * @returns Summary with detailed results
 */
export function runAssertions(
	blocks: AssertionBlock[],
	results: BatchResult[],
	queries: string[],
	hasDb = false,
): AssertionSummary {
	const queryResults: QueryAssertionResult[] = [];
	let totalPassed = 0;
	let totalFailed = 0;
	let totalSkipped = 0;

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
			const outcome = runSingleAssertion(assertion, result, hasDb);
			outcomes.push(outcome);

			if (outcome.skipped) {
				totalSkipped++;
			} else if (outcome.passed) {
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
		total: totalPassed + totalFailed + totalSkipped,
		passed: totalPassed,
		failed: totalFailed,
		skipped: totalSkipped,
		results: queryResults,
	};
}

/**
 * Run a single assertion against a query result
 */
function runSingleAssertion(
	assertion: Assertion,
	result: BatchResult,
	hasDb: boolean,
): AssertionOutcome {
	const { type, value } = assertion;

	// Skip db.* assertions when no database connection
	if (type.startsWith('db.') && !hasDb) {
		return {
			type,
			expected: value,
			actual: undefined,
			passed: true, // Consider skipped as not-failed
			message: undefined,
			skipped: true,
			skipReason: 'No database connection (dry-run mode)',
		};
	}

	switch (type) {
		// Output assertions
		case 'output.contains':
			return assertContains('output', result.output ?? '', value as string);

		case 'output.equals':
			return assertEquals('output', result.output ?? '', value as string);

		case 'output.matches':
			return assertMatches('output', result.output ?? '', value as string);

		// SQL assertions
		case 'sql.equals':
			return assertSQLEquals(result.sql ?? '', value as string);

		case 'sql.matches':
			return assertMatches('sql', result.sql ?? '', value as string);

		// NEW: sql.table - matches table name (logical or physical)
		case 'sql.table':
			return assertSQLTable(result.sql ?? '', value as string);

		// NEW: sql.column - matches column name in SQL
		case 'sql.column':
			return assertSQLColumn(result.sql ?? '', value as string);

		// NEW: sql.join - checks for JOIN clause
		case 'sql.join':
			return assertSQLJoin(result.sql ?? '', value as string);

		// Params assertions
		case 'params.equals':
			return assertParamsEquals(result.params ?? [], value as unknown[]);

		case 'params.length':
			return assertParamsLength(result.params ?? [], value as number);

		// NEW: params.type - validates parameter types
		case 'params.type':
			return assertParamsType(result.params ?? [], value as string[]);

		// NEW: params.value - validates specific param value by index
		case 'params.value':
			return assertParamsValue(result.params ?? [], value as unknown);

		// Plan assertion (plan info is in output)
		case 'plan.contains':
			return assertContains('plan', result.output ?? '', value as string);

		// Success assertion
		case 'success':
			return assertSuccess(result.success, value as boolean);

		// Error assertion
		case 'error.contains':
			return assertContains('error', result.error ?? '', value as string);

		// DB assertions (require database connection)
		case 'db.success':
			// Use dbSuccess if available, fall back to success for backwards compatibility
			return assertSuccess(
				result.dbSuccess ?? result.success,
				value as boolean,
			);

		case 'db.output':
			return assertDbOutput(result, value as TableAssertionData);

		case 'db.output.contains':
			return assertContains(
				'output',
				result.output ?? '',
				value as string,
				'db.output.contains',
			);

		case 'db.rows.equals':
			return assertDbRowsEquals(result, value as number);

		case 'db.rows.min':
			return assertDbRowsMin(result, value as number);

		case 'db.rows.max':
			return assertDbRowsMax(result, value as number);

		case 'db.column.exists':
			return assertDbColumnExists(result, value as string);

		case 'db.value.equals':
			return assertDbValueEquals(result, value as unknown);

		// Intent AST assertions
		case 'intent.type':
			return assertIntentType(result, value as string);

		case 'intent.table':
			return assertIntentTable(result, value as string);

		case 'intent.with':
			return assertIntentWith(result, value as string | string[]);

		case 'intent.hasWhere':
			return assertIntentHasWhere(result, value as boolean);

		case 'intent.hasGroupBy':
			return assertIntentHasGroupBy(result, value as boolean);

		case 'intent.hasOrderBy':
			return assertIntentHasOrderBy(result, value as boolean);

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
