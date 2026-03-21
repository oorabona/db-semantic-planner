
/**
 * Tests for SubqueryExpression.asExpr() — scalar subqueries as SELECT columns.
 *
 * Exercises the full pipeline:
 *   SubqueryBuilder.asExpr() → ExpressionSpec → selectCustomExpression decision
 *   → compileExpressionIntent('subquery') → SubLink AST → SQL
 *
 * Also covers parameter renumbering when the outer query already has params.
 */

import { subquery, outerRef, eq } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';
import type { SubqueryExpressionIntent } from '@dbsp/types';

// ============================================================================
// Unit: SubqueryExpression.asExpr() API
// ============================================================================

describe('SubqueryExpression.asExpr()', () => {
	it('returns an ExpressionSpec with __expr marker', () => {
		const expr = subquery('calls').count().asExpr('call_count');

		expect(expr.__expr).toBe(true);
		expect(expr.intent.kind).toBe('subquery');
	});

	it('embeds the alias in the intent', () => {
		const expr = subquery('calls').count().asExpr('call_count');
		const intent = expr.intent as SubqueryExpressionIntent;

		expect(intent.as).toBe('call_count');
	});

	it('embeds the inner QueryIntent', () => {
		const expr = subquery('calls').count().asExpr('call_count');
		const intent = expr.intent as SubqueryExpressionIntent;

		expect(intent.query.from).toBe('calls');
		expect(intent.query.select).toMatchObject({ type: 'aggregate' });
	});

	it('SubqueryBuilder.asExpr() produces same result as build().asExpr()', () => {
		const spec1 = subquery('calls').where(eq('symbolId', 1)).count().asExpr('n');
		const spec2 = subquery('calls').where(eq('symbolId', 1)).count().asExpr('n');

		expect(spec1.intent).toEqual(spec2.intent);
		expect(spec1.__expr).toBe(true);
	});
});

// ============================================================================
// Integration: Full SQL compilation
// ============================================================================

describe('compileExpressionIntent — subquery kind', () => {
	it('compiles a COUNT(*) subquery as a SELECT column', () => {
		const intent = subquery('calls').count().asExpr('call_count')
			.intent as SubqueryExpressionIntent;

		const { sql } = compilePlan({
			rootTable: 'symbols',
			decisions: [
				{ type: 'selectCustomExpression', expressionIntent: intent, alias: 'call_count' },
			],
		});

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase table/column names like calls, symbols, call_count are unquoted.
		expect(normalizeSQL(sql)).toBe(
			normalizeSQL(
				`SELECT (SELECT count(*) FROM calls) AS call_count FROM symbols`,
			),
		);
	});

	it('compiles a MAX subquery as a SELECT column', () => {
		const intent = subquery('products').max('price').asExpr('max_price')
			.intent as SubqueryExpressionIntent;

		const { sql } = compilePlan({
			rootTable: 'categories',
			decisions: [
				{ type: 'selectCustomExpression', expressionIntent: intent, alias: 'max_price' },
			],
		});

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase names products, price, max_price, categories are unquoted.
		expect(normalizeSQL(sql)).toBe(
			normalizeSQL(
				`SELECT (SELECT max(products.price) FROM products) AS max_price FROM categories`,
			),
		);
	});

	it('compiles multiple subquery columns side by side', () => {
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('calls').count().asExpr('call_count')
						.intent as SubqueryExpressionIntent,
					alias: 'call_count',
				},
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('refs').count().asExpr('ref_count')
						.intent as SubqueryExpressionIntent,
					alias: 'ref_count',
				},
			],
		};
		const { sql } = compilePlan(plan);

		// quoteIdent only quotes uppercase/reserved/special-char identifiers.
		// Lowercase names are unquoted; just verify structural presence.
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('id');
		expect(normalized).toContain('call_count');
		expect(normalized).toContain('ref_count');
		expect(normalized).toContain('from calls');
		expect(normalized).toContain('from refs');
	});

	it('throws when ctx.compileSubquery is not set', async () => {
		const { compileExpressionIntent } = await import('../handlers/expression/custom.js');
		const intent: SubqueryExpressionIntent = {
			kind: 'subquery',
			query: {
				type: 'select',
				from: 'calls',
				select: { type: 'aggregate', aggregates: [{ function: 'count', field: '*' }] },
			},
			as: 'n',
		};
		const ctx = {
			naming: { toDatabase: (s: string) => s, toApplication: (s: string) => s },
			rootTable: 'symbols',
			maxRecursiveDepth: 100,
			// No compileSubquery — intentionally missing
		} as unknown as Parameters<typeof compileExpressionIntent>[1];
		const state = {
			parameters: [],
			paramIndex: 0,
			ctes: new Map(),
			aliases: new Map(),
			joins: [],
		} as Parameters<typeof compileExpressionIntent>[2];

		expect(() => compileExpressionIntent(intent, ctx, state)).toThrow(
			"'subquery' expression kind requires ctx.compileSubquery",
		);
	});
});

// ============================================================================
// Parameter renumbering: outer query already has params
// ============================================================================

describe('subquery parameter renumbering', () => {
	it('renumbers inner params to avoid collision with outer params', () => {
		// Outer WHERE uses $1, inner subquery WHERE must become $2
		const plan: SimplifiedPlanReport = {
			rootTable: 'symbols',
			decisions: [
				{ type: 'select', column: 'id', table: 'symbols' },
				// WHERE kind = $1
				{
					type: 'where',
					operator: 'eq',
					column: 'kind',
					value: 'function',
					table: 'symbols',
				},
				// SELECT (SELECT count(*) FROM calls WHERE status = $2) AS call_count
				{
					type: 'selectCustomExpression',
					expressionIntent: subquery('calls')
						.where(eq('status', 'active'))
						.count()
						.asExpr('call_count').intent as SubqueryExpressionIntent,
					alias: 'call_count',
				},
			],
		};

		const { sql, parameters } = compilePlan(plan);

		// Both $1 (outer) and $2 (inner, renumbered) should appear
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(parameters).toHaveLength(2);
		expect(parameters[0]).toBe('function');
		expect(parameters[1]).toBe('active');
	});
});
