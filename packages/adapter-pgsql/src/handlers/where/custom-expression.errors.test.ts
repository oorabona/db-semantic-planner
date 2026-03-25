/**
 * Error path tests for customExpressionWhereHandler.
 *
 * Verifies that unsupported comparison operators throw rather than silently
 * passing raw strings through to the generated SQL (F-004 audit finding).
 */

import { describe, expect, it } from 'vitest';
import { compilePlan, type SimplifiedPlanReport } from '../../compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compileWhereExpr(
	expressionIntent: Record<string, unknown>,
	operator: string,
	value: unknown = 0,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'items',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				operator: 'expression',
				expressionIntent,
				value,
				subqueryOperator: operator,
			},
		],
	};
	return compilePlan(plan);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('customExpressionWhereHandler — operator validation', () => {
	it('throws for an unmapped operator (injection attempt)', () => {
		const expr = { kind: 'ref', column: 'price' };
		expect(() => compileWhereExpr(expr, 'LIKE')).toThrow(
			'customExpressionWhereHandler: unsupported comparison operator: LIKE',
		);
	});

	it('throws for a completely unknown operator', () => {
		const expr = { kind: 'ref', column: 'score' };
		expect(() => compileWhereExpr(expr, '??')).toThrow(
			'customExpressionWhereHandler: unsupported comparison operator: ??',
		);
	});

	it('throws for an empty string operator', () => {
		const expr = { kind: 'ref', column: 'score' };
		expect(() => compileWhereExpr(expr, '')).toThrow(
			'customExpressionWhereHandler: unsupported comparison operator: ',
		);
	});

	it('does not throw for all mapped operators', () => {
		const expr = { kind: 'ref', column: 'price' };
		const validOps = [
			'eq',
			'neq',
			'gt',
			'gte',
			'lt',
			'lte',
			'=',
			'!=',
			'>',
			'>=',
			'<',
			'<=',
		];
		for (const op of validOps) {
			expect(() => compileWhereExpr(expr, op, 42)).not.toThrow();
		}
	});
});
