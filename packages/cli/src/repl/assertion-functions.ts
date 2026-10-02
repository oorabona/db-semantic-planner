/**
 * Assertion Functions — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

export {
	assertEquals,
	assertParamsEquals,
	assertParamsType,
	assertSQLEquals,
	normalizeSQL,
} from '@dbsp/core';
export {
	assertContains,
	assertDbColumnExists,
	assertDbOutput,
	assertDbRowsEquals,
	assertDbRowsMax,
	assertDbRowsMin,
	assertDbValueEquals,
	assertIntentHasGroupBy,
	assertIntentHasOrderBy,
	assertIntentHasWhere,
	assertIntentTable,
	assertIntentType,
	assertIntentWith,
	assertMatches,
	assertParamsLength,
	assertParamsValue,
	assertSQLColumn,
	assertSQLJoin,
	assertSQLTable,
	assertSuccess,
} from '@dbsp/core/internal';
