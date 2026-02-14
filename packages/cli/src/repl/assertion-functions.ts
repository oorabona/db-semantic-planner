/**
 * Assertion Functions — re-exported from @dbsp/core.
 *
 * CLI consumers continue importing from this path.
 * Implementation lives in packages/core/src/assert/.
 */

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
	normalizeSQL,
} from '@dbsp/core';
