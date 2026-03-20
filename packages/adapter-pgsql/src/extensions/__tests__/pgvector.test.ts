/**
 * pgvector Extension Integration Tests
 *
 * Tests the pgvector wrappers (cosineDistance, rawDistance, l2Distance, innerProduct)
 * using the compile-only adapter with the full intent pipeline.
 *
 * Uses compilePlan directly for precise control over decisions.
 */

import { cast, exprRef, op, param } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../../compiler.js';
import {
	cosineDistance,
	innerProduct,
	l2Distance,
	rawDistance,
} from '../pgvector.js';

// ---------------------------------------------------------------------------
// Helper: compile a selectCustomExpression from an ExpressionRef
// ---------------------------------------------------------------------------

type ExprRef = ReturnType<typeof cosineDistance>;

function compileSelectExpr(
	expr: ExprRef,
	alias?: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
		decisions: [
			{
				type: 'selectCustomExpression',
				// ExpressionRef exposes .intent for the underlying ExpressionIntent
				expressionIntent: (expr as unknown as { intent: unknown }).intent,
				alias: alias ?? expr.as,
			},
		],
	};
	return compilePlan(plan);
}

// Build a plan with an alias applied directly
function compileSelectExprWithAlias(
	expr: ExprRef,
	alias: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
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

// Build a plan with WHERE expression
function compileWhereExpr(whereIntent: Record<string, unknown>): {
	sql: string;
	parameters: readonly unknown[];
} {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				operator: 'expression',
				expressionIntent: whereIntent,
				value: 0.5,
				subqueryOperator: '>=',
			},
		],
	};
	return compilePlan(plan);
}

// Build a plan with ORDER BY expression
function compileOrderByExpr(
	expressionIntent: unknown,
	direction: 'ASC' | 'DESC' = 'ASC',
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'embeddings',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'orderBy',
				expressionIntent,
				direction,
			},
		],
	};
	return compilePlan(plan);
}

const QV = [0.1, 0.2, 0.3];

// ---------------------------------------------------------------------------
// cosineDistance
// ---------------------------------------------------------------------------

describe('cosineDistance', () => {
	it('produces correct SQL in SELECT with alias', () => {
		const expr = cosineDistance('vector', QV);
		const result = compileSelectExprWithAlias(expr, 'score');
		const sql = normalizeSQL(result.sql);

		// Should contain the <=> operator
		expect(sql).toContain('<=>');
		// Should contain the subtraction for 1 - distance
		expect(sql).toContain('-');
		// Should contain the vector cast
		expect(sql.toLowerCase()).toContain('vector');
		// Should contain the alias
		expect(sql).toContain('score');
		// Should bind the query vector as a parameter
		expect(result.parameters).toHaveLength(1);
		expect(result.parameters[0]).toEqual(QV);
	});

	it('binds exactly one parameter', () => {
		const expr = cosineDistance('vector', QV);
		const result = compileSelectExprWithAlias(expr, 'score');
		expect(result.parameters).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// rawDistance
// ---------------------------------------------------------------------------

describe('rawDistance', () => {
	it('produces correct SQL in SELECT', () => {
		const expr = rawDistance('vector', QV);
		const result = compileSelectExprWithAlias(expr, 'dist');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<=>');
		expect(sql.toLowerCase()).toContain('vector');
		expect(sql).toContain('dist');
		expect(result.parameters[0]).toEqual(QV);
	});

	it('produces correct SQL for ORDER BY', () => {
		const expr = rawDistance('vector', QV);
		const intent = (expr as unknown as { intent: unknown }).intent;
		const result = compileOrderByExpr(intent, 'ASC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<=>');
		expect(sql).toContain('order by');
		expect(sql).toContain('asc');
		expect(result.parameters[0]).toEqual(QV);
	});
});

// ---------------------------------------------------------------------------
// l2Distance
// ---------------------------------------------------------------------------

describe('l2Distance', () => {
	it('uses <-> operator', () => {
		const expr = l2Distance('vector', QV);
		const result = compileSelectExprWithAlias(expr, 'l2');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<->');
		expect(result.parameters[0]).toEqual(QV);
	});
});

// ---------------------------------------------------------------------------
// innerProduct
// ---------------------------------------------------------------------------

describe('innerProduct', () => {
	it('uses <#> operator', () => {
		const expr = innerProduct('vector', QV);
		const result = compileSelectExprWithAlias(expr, 'ip');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<#>');
		expect(result.parameters[0]).toEqual(QV);
	});
});

// ---------------------------------------------------------------------------
// WHERE with expression comparison
// ---------------------------------------------------------------------------

describe('WHERE with expression comparison', () => {
	it('compiles cosineDistance.gte() as WHERE clause', () => {
		// Build expression intent directly from ExpressionRef
		const expr = cosineDistance('vector', QV);
		const whereIntent = (expr as unknown as { intent: unknown }).intent;
		const result = compileWhereExpr(whereIntent as Record<string, unknown>);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('where');
		expect(sql).toContain('<=>');
		expect(sql).toContain('>=');
		// params: [QV, 0.5]
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toEqual(QV);
		expect(result.parameters[1]).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// ORDER BY with expression
// ---------------------------------------------------------------------------

describe('ORDER BY with expression', () => {
	it('compiles rawDistance in ORDER BY ASC', () => {
		const expr = rawDistance('vector', QV);
		const intent = (expr as unknown as { intent: unknown }).intent;
		const result = compileOrderByExpr(intent, 'ASC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('order by');
		expect(sql).toContain('<=>');
		expect(sql).toContain('asc');
		expect(result.parameters[0]).toEqual(QV);
	});

	it('compiles l2Distance in ORDER BY ASC', () => {
		const expr = l2Distance('vector', QV);
		const intent = (expr as unknown as { intent: unknown }).intent;
		const result = compileOrderByExpr(intent, 'ASC');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<->');
		expect(sql).toContain('order by');
	});
});

// ---------------------------------------------------------------------------
// Full integration: SELECT + WHERE + ORDER BY + LIMIT
// ---------------------------------------------------------------------------

describe('full integration', () => {
	it('compiles SELECT + ORDER BY + LIMIT for ANN search', () => {
		const qv = [0.1, 0.2, 0.3];
		const distExpr = rawDistance('vector', qv);
		const distIntent = (distExpr as unknown as { intent: unknown }).intent;

		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{ type: 'select', column: 'id' },
				{ type: 'select', column: 'content' },
				{
					type: 'selectCustomExpression',
					expressionIntent: (
						cosineDistance('vector', qv) as unknown as {
							intent: unknown;
						}
					).intent,
					alias: 'score',
				},
				{
					type: 'orderBy',
					expressionIntent: distIntent,
					direction: 'ASC',
				},
				{ type: 'limit', limit: 10 },
			],
		};

		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('select');
		expect(sql).toContain('id');
		expect(sql).toContain('content');
		expect(sql).toContain('<=>');
		expect(sql).toContain('score');
		expect(sql).toContain('order by');
		expect(sql).toContain('limit');
		// Two params: one for cosineDistance SELECT, one for rawDistance ORDER BY
		expect(result.parameters).toHaveLength(2);
		expect(result.parameters[0]).toEqual(qv);
		expect(result.parameters[1]).toEqual(qv);
	});
});

// ---------------------------------------------------------------------------
// Column vs column (no params)
// ---------------------------------------------------------------------------

describe('column-vs-column', () => {
	it('op(<=> ref ref) produces no params', () => {
		const expr = op('<=>', exprRef('e1.vector'), exprRef('e2.vector'));
		const intent = (expr as unknown as { intent: unknown }).intent;

		const plan: SimplifiedPlanReport = {
			rootTable: 'embeddings',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'dist',
				},
			],
		};
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<=>');
		expect(sql).toContain('e1');
		expect(sql).toContain('e2');
		expect(result.parameters).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// raw op/cast/param composition
// ---------------------------------------------------------------------------

describe('raw expression composition', () => {
	it('op/ref/cast/param composes correctly', () => {
		const qv = [0.5, 0.6];
		// op('<=>', exprRef('vec'), cast(param(qv), 'vector'))
		const expr = op('<=>', exprRef('vec'), cast(param(qv), 'vector'));
		const intent = (expr as unknown as { intent: unknown }).intent;

		const plan: SimplifiedPlanReport = {
			rootTable: 'docs',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: intent,
					alias: 'd',
				},
			],
		};
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('<=>');
		expect(sql.toLowerCase()).toContain('vector');
		expect(result.parameters[0]).toEqual(qv);
	});
});
