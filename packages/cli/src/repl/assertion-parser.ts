/**
 * Assertion Parser — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

export type { Assertion, ParseError, ParseResult } from '@dbsp/core';
export { parseAssertionFile, validateAssertionBlocks } from '@dbsp/core';
export type { AssertionBlock } from '@dbsp/core/internal';
export {
	ASSERTION_TYPES,
	requiresDatabase,
	resolveQueryIndex,
} from '@dbsp/core/internal';
