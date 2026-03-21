// ORDERBY-COMPUTED-EXPR regression test
import { exprRef as ref, op } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { compilePlan, type PlanDecision, type SimplifiedPlanReport } from '../compiler.js';

function compileToSql(plan: SimplifiedPlanReport): { sql: string; parameters: readonly unknown[] } {
	return compilePlan(plan);
}

describe('ORDERBY-COMPUTED-EXPR: orderBy(op(...)) generates correct SQL', () => {
	it('op("-", ref("end_line"), ref("start_line")) produces arithmetic in ORDER BY', () => {
		const expr = op('-', ref('end_line'), ref('start_line'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*', table: 'symbols' },
				{ type: 'orderBy', expressionIntent: expr.intent as Record<string, unknown>, direction: 'ASC', table: 'symbols' } satisfies PlanDecision,
			],
		};
		const result = compileToSql(plan);
		expect(result.sql.toLowerCase()).toMatch(/order\s+by/);
		expect(result.sql).toMatch(/end_line\s*-\s*start_line/i);
		expect(result.sql).not.toContain('__expr');
		expect(result.sql).not.toContain('customOp');
		expect(result.parameters).toHaveLength(0);
	});

	it('ASC direction preserved for op("-") orderBy', () => {
		const expr = op('-', ref('end_line'), ref('start_line'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*', table: 'symbols' },
				{ type: 'orderBy', expressionIntent: expr.intent as Record<string, unknown>, direction: 'ASC', table: 'symbols' } satisfies PlanDecision,
			],
		};
		const result = compileToSql(plan);
		expect(result.sql).toMatch(/end_line\s*-\s*start_line\s+ASC/i);
	});

	it('DESC direction preserved for op("-") orderBy', () => {
		const expr = op('-', ref('end_line'), ref('start_line'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: '*', table: 'symbols' },
				{ type: 'orderBy', expressionIntent: expr.intent as Record<string, unknown>, direction: 'DESC', table: 'symbols' } satisfies PlanDecision,
			],
		};
		const result = compileToSql(plan);
		expect(result.sql).toMatch(/end_line\s*-\s*start_line\s+DESC/i);
	});

	it('op("+") in ORDER BY produces addition expression', () => {
		const expr = op('+', ref('score'), ref('bonus'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'rankings',
			decisions: [
				{ type: 'select', column: '*', table: 'rankings' },
				{ type: 'orderBy', expressionIntent: expr.intent as Record<string, unknown>, direction: 'DESC', table: 'rankings' } satisfies PlanDecision,
			],
		};
		const result = compileToSql(plan);
		expect(result.sql.toLowerCase()).toMatch(/order\s+by/);
		expect(result.sql).toMatch(/score\s*\+\s*bonus/i);
		expect(result.sql).toMatch(/DESC/i);
	});
});
