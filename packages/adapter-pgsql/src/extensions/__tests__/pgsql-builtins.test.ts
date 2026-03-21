
/**
 * pgsql-builtins Extension Tests
 *
 * Tests generateSeries and nextval using the compile-only adapter
 * with the full intent pipeline. Follows the same pattern as pgvector.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { compilePlan, type SimplifiedPlanReport } from '../../compiler.js';
import { generateSeries, nextval } from '../pgsql-builtins.js';

type ExprRef = ReturnType<typeof generateSeries>;

function compileSelectExpr(
	expr: ExprRef,
	alias: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'items',
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: (expr as unknown as { intent: unknown }).intent,
				alias,
			},
		],
	};
	return compilePlan(plan);
}

describe('generateSeries', () => {
	it('compiles generate_series(start, stop) without step', () => {
		const expr = generateSeries(1, 100);
		const { sql } = compileSelectExpr(expr, 'n');
		expect(sql).toContain('generate_series');
		expect(sql).toContain('1');
		expect(sql).toContain('100');
	});

	it('compiles generate_series(start, stop, step) with step', () => {
		const expr = generateSeries(0, 50, 5);
		const { sql } = compileSelectExpr(expr, 'n');
		expect(sql).toContain('generate_series');
		expect(sql).toContain('0');
		expect(sql).toContain('50');
		expect(sql).toContain('5');
	});
});

describe('nextval', () => {
	it('compiles nextval with sequence name', () => {
		const expr = nextval('my_seq');
		const { sql } = compileSelectExpr(expr, 'id');
		expect(sql).toContain('nextval');
		expect(sql).toContain('my_seq');
	});
});
