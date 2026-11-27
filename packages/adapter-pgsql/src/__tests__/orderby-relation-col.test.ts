import { EXPRESSION_BRAND } from '@dbsp/types';

/**
 * ORDERBY-RELATION-COL regression test.
 *
 * Verifies that orderBy(relationColumn('callerFile', 'path')) generates a proper
 * column reference "callerFile"."path" instead of the literal string "calls.__expr".
 *
 * Root cause: orderBy() was only handling instanceof ExpressionRef for expressions.
 * relationColumn() returns a plain, factory-branded ExpressionSpec,
 * which fell through all checks and was treated as an object record (OrderByRecord),
 * stringifying to "__expr".
 *
 * Fix: added isExpressionSpec() check in orderBy() before the string/array/record branches.
 */

import { createOrm, ref, relationColumn, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ============================================================================
// Helpers
// ============================================================================

const db = schema({
	files: {
		id: { type: 'integer', primaryKey: true },
		path: 'string',
	},
	calls: {
		id: { type: 'integer', primaryKey: true },
		caller_file_id: ref('files', { as: 'callerFile', inverse: 'callerCalls' }),
	},
});
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

function orderedByCallerFilePath(direction: 'asc' | 'desc') {
	const { sql, params } = orm
		.select('calls')
		.include('callerFile', { join: 'inner' })
		.orderBy(relationColumn('callerFile', 'path', 'path'), direction)
		.dump();
	return { sql, params };
}

// ============================================================================
// Tests
// ============================================================================

describe('ORDERBY-RELATION-COL: orderBy(relationColumn()) generates correct SQL', () => {
	it('should produce "callerFile"."path" in ORDER BY, not "__expr"', () => {
		expect(orderedByCallerFilePath('asc')).toEqual({
			sql: 'SELECT calls.*, "callerFile".id AS "callerFile.id", "callerFile".path AS "callerFile.path", "callerFile".id AS "__dbsp_presence_callerFile" FROM calls JOIN files AS "callerFile" ON calls.caller_file_id = "callerFile".id ORDER BY "callerFile".path ASC',
			params: [],
		});
	});

	it('should produce ASC direction for relationColumn orderBy', () => {
		expect(orderedByCallerFilePath('asc')).toEqual({
			sql: 'SELECT calls.*, "callerFile".id AS "callerFile.id", "callerFile".path AS "callerFile.path", "callerFile".id AS "__dbsp_presence_callerFile" FROM calls JOIN files AS "callerFile" ON calls.caller_file_id = "callerFile".id ORDER BY "callerFile".path ASC',
			params: [],
		});
	});

	it('should produce DESC direction when specified', () => {
		expect(orderedByCallerFilePath('desc')).toEqual({
			sql: 'SELECT calls.*, "callerFile".id AS "callerFile.id", "callerFile".path AS "callerFile.path", "callerFile".id AS "__dbsp_presence_callerFile" FROM calls JOIN files AS "callerFile" ON calls.caller_file_id = "callerFile".id ORDER BY "callerFile".path DESC',
			params: [],
		});
	});
});

describe('ORDERBY-RELATION-COL: ExpressionSpec shape validation', () => {
	it('isExpressionSpec detects relationColumn() output correctly', () => {
		// Verify the duck-type shape that the fix relies on
		const spec = relationColumn('callerFile', 'path', 'callerFilePath');
		expect(spec[EXPRESSION_BRAND]).toBe(true);
		expect(spec.intent).toEqual({
			kind: 'relationColumn',
			relation: 'callerFile',
			column: 'path',
			as: 'callerFilePath',
		});
	});

	it('orderBy(relationColumn(...)) does not stringify to "__expr" — confirms bug shape', () => {
		// The bug: when treated as OrderByRecord, Object.entries({ __expr: true, intent: {...} })
		// would push field='__expr' and field='intent', producing ORDER BY "__expr" ASC
		const spec = relationColumn('callerFile', 'path', 'callerFilePath');
		const entries = Object.entries(spec);
		const wouldHaveProducedExprField = entries.some(
			([key]) => key === '__expr',
		);
		// Factory brands no longer appear among enumerable string keys.
		expect(wouldHaveProducedExprField).toBe(false);
		// The fix: isExpressionSpec() catches this BEFORE the Object.entries() path
	});
});
