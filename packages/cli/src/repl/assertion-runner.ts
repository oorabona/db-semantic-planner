/**
 * Assertion Runner — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

export { normalizeSQL, runAssertions } from '@dbsp/core';

export type {
	AssertionOutcome,
	AssertionQueryResult,
	AssertionSummary,
	QueryAssertionResult,
} from '@dbsp/core';
