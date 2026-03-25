/**
 * Assertion system for .assert.dbsp files.
 *
 * Barrel re-exports for parser, runner, evaluators, and types.
 * Used by CLI and GUI sidecar.
 */

// Individual assertion functions (for custom runners)
export {
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
export type {
	Assertion,
	AssertionBlock,
	AssertionType,
	ParseError,
	ParseResult,
	TableAssertionData,
} from './assertion-parser.js';
// Parser
export {
	ASSERTION_TYPES,
	parseAssertionFile,
	requiresDatabase,
	resolveQueryIndex,
	validateAssertionBlocks,
} from './assertion-parser.js';

// Runner
export { runAssertions } from './assertion-runner.js';
// Types
export type {
	AssertionOutcome,
	AssertionQueryResult,
	AssertionSummary,
	IntentSummary,
	QueryAssertionResult,
} from './types.js';
