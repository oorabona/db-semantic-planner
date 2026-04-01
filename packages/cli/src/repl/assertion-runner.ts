/**
 * Assertion Runner — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

export type {
	AssertionOutcome,
	AssertionQueryResult,
	AssertionSummary,
	QueryAssertionResult,
} from '@dbsp/core';
export { normalizeSQL, runAssertions } from '@dbsp/core';
