
/**
 * Tests for FILTER (WHERE ...) clause support on fn() custom function expressions.
 *
 * Covers: fn('array_agg', ...).filter(condition) and fn('json_agg', ...).filter(condition)
 * at the ExpressionRef API level, compileExpressionIntent unit level,
 * and the full compilePlan pipeline.
 */

import { eq, exprRef, fn, isNotNull } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import type { CustomFnExpressionIntent } from '@dbsp/types';

// ============================================================================
// Helpers
// ============================================================================

function getExprIntent(
	expr: ReturnType<typeof fn>,
): CustomFnExpressionIntent {
	return (expr as unknown as { intent: CustomFnExpressionIntent }).intent;
}

function compilePlanFromExpr(
	expr: ReturnType<typeof fn>,
	alias: string,
	rootTable = 'users',
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable,
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: getExprIntent(expr),
				alias,
			},
		],
	};
	return compilePlan(plan);
}

// ============================================================================
// ExpressionRef.filter() — API-level unit tests
// ============================================================================

describe('ExpressionRef.filter()', () => {
	it('fn().filter() returns a new ExpressionRef with filter set', () => {
		const expr = fn('array_agg', exprRef('name'));
		const filtered = expr.filter(eq('active', true));

		const intent = getExprIntent(filtered);
		expect(intent.kind).toBe('customFn');
		expect(intent.name).toBe('array_agg');
		expect(intent.filter).toBeDefined();
		// eq() produces kind:'comparison' (WhereComparisonIntent)
		expect(intent.filter?.kind).toBe('comparison');
	});

	it('fn().filter() does not mutate the original ExpressionRef', () => {
		const expr = fn('array_agg', exprRef('name'));
		expr.filter(eq('active', true));

		const origIntent = getExprIntent(expr);
		expect(origIntent.filter).toBeUndefined();
	});

	it('fn().filter().as() chains correctly', () => {
		const expr = fn('array_agg', exprRef('name'))
			.filter(eq('active', true))
			.as('names');

		const intent = getExprIntent(expr);
		expect(intent.as).toBe('names');
		expect(intent.filter).toBeDefined();
	});

	it('fn().as().filter() chains correctly', () => {
		const expr = fn('array_agg', exprRef('name'))
			.as('names')
			.filter(eq('active', true));

		const intent = getExprIntent(expr);
		expect(intent.as).toBe('names');
		expect(intent.filter).toBeDefined();
	});

	it('filter() throws on non-customFn ExpressionRef (exprRef)', () => {
		const expr = exprRef('name');
		expect(() => expr.filter(eq('active', true))).toThrow(
			"filter() can only be used on function expressions created with fn()",
		);
	});
});

// ============================================================================
// Additional compiler pipeline tests — filter variants
// ============================================================================
// Note: FILTER compilation is handled in compiler.ts (selectCustomExpression branch)
// to avoid circular deps with the WHERE dispatcher. Testing is done via compilePlan.

describe('compilePlan: fn().filter() — additional variants', () => {
	it('fn() without filter does NOT produce FILTER clause', () => {
		const expr = fn('array_agg', exprRef('name'));
		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: getExprIntent(expr),
					alias: 'names',
				},
			],
		};
		const result = compilePlan(plan);
		expect(normalizeSQL(result.sql)).not.toContain('filter');
		expect(result.parameters).toEqual([]);
	});

	it('schema-qualified fn with filter: my_schema.my_agg(col) FILTER (WHERE ...)', () => {
		const expr = fn('my_schema.my_agg', exprRef('value')).filter(
			eq('status', 'active'),
		);
		const plan: SimplifiedPlanReport = {
			rootTable: 'items',
			decisions: [
				{
					type: 'selectCustomExpression',
					expressionIntent: getExprIntent(expr),
					alias: 'result',
				},
			],
		};
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('filter (where');
		expect(result.parameters).toEqual(['active']);
	});
});

// ============================================================================
// Full compilePlan pipeline tests — SQL output via pgsql-deparser
// ============================================================================

describe('compilePlan: fn().filter() produces FILTER clause in SQL', () => {
	it('array_agg(name) FILTER (WHERE active = $1) AS names', () => {
		const expr = fn('array_agg', exprRef('name'))
			.filter(eq('active', true))
			.as('names');

		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('filter (where users.active = $1)');
		expect(sql).toContain('array_agg');
		expect(sql).toContain('from users');
		expect(result.parameters).toEqual([true]);
	});

	it('json_agg(data) FILTER (WHERE data IS NOT NULL) AS items', () => {
		const expr = fn('json_agg', exprRef('data'))
			.filter(isNotNull('data'))
			.as('items');

		const result = compilePlanFromExpr(expr, 'items');
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('filter (where');
		expect(sql).toContain('is not null');
		expect(sql).toContain('json_agg');
	});

	it('fn() without filter produces no FILTER clause', () => {
		const expr = fn('array_agg', exprRef('name')).as('names');

		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);

		expect(sql).not.toContain('filter');
		expect(result.parameters).toEqual([]);
	});

	it('multiple decisions: filter uses correct $N param index', () => {
		const filterExpr = fn('array_agg', exprRef('tag'))
			.filter(eq('active', true))
			.as('tags');

		const plan: SimplifiedPlanReport = {
			rootTable: 'users',
			decisions: [
				{ type: 'select', column: 'id' },
				{
					type: 'selectCustomExpression',
					expressionIntent: getExprIntent(filterExpr),
					alias: 'tags',
				},
			],
		};
		const result = compilePlan(plan);
		const sql = normalizeSQL(result.sql);

		expect(sql).toContain('filter (where');
		expect(result.parameters).toEqual([true]);
	});
});
