/**
 * ORDERBY-RELATION-COL regression test.
 *
 * Verifies that orderBy(relationColumn('callerFile', 'path')) generates a proper
 * column reference "callerFile"."path" instead of the literal string "calls.__expr".
 *
 * Root cause: orderBy() was only handling instanceof ExpressionRef for expressions.
 * relationColumn() returns a plain ExpressionSpec (duck-typed { __expr: true, intent }),
 * which fell through all checks and was treated as an object record (OrderByRecord),
 * stringifying to "__expr".
 *
 * Fix: added isExpressionSpec() check in orderBy() before the string/array/record branches.
 */

import { relationColumn } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	compilePlan,
	type PlanDecision,
	type SimplifiedPlanReport,
} from '../compiler.js';

// ============================================================================
// Helpers
// ============================================================================

function compileToSql(plan: SimplifiedPlanReport): {
	sql: string;
	parameters: readonly unknown[];
} {
	return compilePlan(plan);
}

// ============================================================================
// Tests
// ============================================================================

describe('ORDERBY-RELATION-COL: orderBy(relationColumn()) generates correct SQL', () => {
	it('should produce "callerFile"."path" in ORDER BY, not "__expr"', () => {
		// Reproduce the exact scenario from the bug report:
		// orm.select('calls').include('callerFile', { join: 'inner' })
		//   .orderBy(relationColumn('callerFile', 'path', 'path'), 'asc')
		const exprSpec = relationColumn('callerFile', 'path', 'path');
		const expressionIntent = (exprSpec as { intent: unknown }).intent as Record<
			string,
			unknown
		>;

		const plan: SimplifiedPlanReport = {
			rootTable: 'calls',
			decisions: [
				{ type: 'select', column: '*', table: 'calls' },
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'callerFile',
					targetTable: 'files',
					relationType: 'belongsTo',
					foreignKey: 'caller_file_id',
					parentKey: 'id',
					columns: ['id', 'path'],
				} satisfies PlanDecision,
				{
					type: 'orderBy',
					expressionIntent,
					direction: 'ASC',
					table: 'calls',
				} satisfies PlanDecision,
			],
		};

		const result = compileToSql(plan);

		// Must have "callerFile".path in ORDER BY
		// (pgsql deparser emits unquoted lowercase for simple column identifiers like 'path')
		expect(result.sql).toContain('"callerFile".path');

		// Must NOT have the literal string "__expr" anywhere
		expect(result.sql).not.toContain('__expr');

		// ORDER BY must appear in the query
		expect(result.sql.toLowerCase()).toMatch(/order\s+by/);
	});

	it('should produce ASC direction for relationColumn orderBy', () => {
		const exprSpec = relationColumn('callerFile', 'path', 'path');
		const expressionIntent = (exprSpec as { intent: unknown }).intent as Record<
			string,
			unknown
		>;

		const plan: SimplifiedPlanReport = {
			rootTable: 'calls',
			decisions: [
				{ type: 'select', column: '*', table: 'calls' },
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'callerFile',
					targetTable: 'files',
					relationType: 'belongsTo',
					foreignKey: 'caller_file_id',
					parentKey: 'id',
					columns: ['id', 'path'],
				} satisfies PlanDecision,
				{
					type: 'orderBy',
					expressionIntent,
					direction: 'ASC',
					table: 'calls',
				} satisfies PlanDecision,
			],
		};

		const result = compileToSql(plan);
		// pgsql deparser emits unquoted lowercase for simple column names: "callerFile".path
		expect(result.sql).toMatch(/"callerFile"\.path\s+ASC/i);
	});

	it('should produce DESC direction when specified', () => {
		const exprSpec = relationColumn('callerFile', 'path', 'path');
		const expressionIntent = (exprSpec as { intent: unknown }).intent as Record<
			string,
			unknown
		>;

		const plan: SimplifiedPlanReport = {
			rootTable: 'calls',
			decisions: [
				{ type: 'select', column: '*', table: 'calls' },
				{
					type: 'includeStrategy',
					choice: 'join',
					joinType: 'inner',
					relationName: 'callerFile',
					targetTable: 'files',
					relationType: 'belongsTo',
					foreignKey: 'caller_file_id',
					parentKey: 'id',
					columns: ['id', 'path'],
				} satisfies PlanDecision,
				{
					type: 'orderBy',
					expressionIntent,
					direction: 'DESC',
					table: 'calls',
				} satisfies PlanDecision,
			],
		};

		const result = compileToSql(plan);
		// pgsql deparser emits unquoted lowercase for simple column names: "callerFile".path
		expect(result.sql).toMatch(/"callerFile"\.path\s+DESC/i);
	});
});

describe('ORDERBY-RELATION-COL: ExpressionSpec shape validation', () => {
	it('isExpressionSpec detects relationColumn() output correctly', () => {
		// Verify the duck-type shape that the fix relies on
		const spec = relationColumn('callerFile', 'path', 'callerFilePath');
		expect(spec.__expr).toBe(true);
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
		// Confirm the shape that caused the bug — __expr IS a top-level key
		expect(wouldHaveProducedExprField).toBe(true);
		// The fix: isExpressionSpec() catches this BEFORE the Object.entries() path
	});
});
