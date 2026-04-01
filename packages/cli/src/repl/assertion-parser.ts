/**
 * Assertion Parser — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

export type {
	Assertion,
	AssertionBlock,
	AssertionType,
	ParseError,
	ParseResult,
	TableAssertionData,
} from '@dbsp/core';
export {
	ASSERTION_TYPES,
	parseAssertionFile,
	requiresDatabase,
	resolveQueryIndex,
	validateAssertionBlocks,
} from '@dbsp/core';
