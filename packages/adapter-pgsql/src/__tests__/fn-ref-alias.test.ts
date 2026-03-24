/**
 * FN-REF-ALIAS regression tests.
 *
 * Verifies that exprRef('col') / string args inside fn() emit an unqualified
 * column reference, not a root-table-qualified one.
 *
 * The pgsql deparser emits unquoted lowercase identifiers for simple column names.
 * So `exprRef('id')` → `id` (no table prefix, no quotes) in normalized SQL.
 * And `exprRef('callee.id')` → `callee.id` (table-qualified, no quotes).
 *
 * Previously the compiler would have emitted `calls.id` (root table qualified).
 */

import { eq, exprRef, fn } from '@dbsp/core';
import type { CustomFnExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

function compileFnExpr(
	expr: ReturnType<typeof fn>,
	rootTable = 'calls',
): string {
	const intent = (expr as unknown as { intent: CustomFnExpressionIntent })
		.intent;
	const plan: SimplifiedPlanReport = {
		rootTable,
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: intent,
				alias: 'result',
			},
		],
	};
	return normalizeSQL(compilePlan(plan).sql);
}

describe('FN-REF-ALIAS: exprRef() inside fn() column qualification', () => {
	it('exprRef("id") without dot → unqualified id, not calls.id', () => {
		const sql = compileFnExpr(fn('array_agg', exprRef('id')));
		// Deparser emits unquoted lowercase: array_agg(id)
		expect(sql).toContain('array_agg(id)');
		// Must NOT have root table prefix
		expect(sql).not.toContain('calls.id');
	});

	it('exprRef("name") without dot → unqualified name', () => {
		const sql = compileFnExpr(fn('array_agg', exprRef('name')));
		expect(sql).toContain('array_agg(name)');
		expect(sql).not.toContain('calls.name');
	});

	it('exprRef("callee.id") with dot → table-qualified callee.id', () => {
		const sql = compileFnExpr(fn('array_agg', exprRef('callee.id')));
		expect(sql).toContain('callee.id');
		// The table prefix should be 'callee', not 'calls' (root table)
		expect(sql).not.toContain('calls.id');
	});

	it('fn() with exprRef() arg + filter: arg is unqualified, filter uses rootTable', () => {
		const expr = fn('array_agg', exprRef('id')).filter(eq('active', true));
		const sql = compileFnExpr(expr);
		// array_agg argument must be unqualified
		expect(sql).toContain('array_agg(id)');
		expect(sql).not.toContain('calls.id');
		// FILTER clause uses root table for plain field refs (expected)
		expect(sql).toContain('filter (where');
	});

	it('string arg shorthand inside fn() → same as exprRef() — unqualified', () => {
		// fn('array_agg', 'id') is equivalent to fn('array_agg', exprRef('id'))
		// toExpressionIntent converts strings to ref kind
		const sql = compileFnExpr(fn('array_agg', 'id'));
		expect(sql).toContain('array_agg(id)');
		expect(sql).not.toContain('calls.id');
	});

	it('nested fn(): inner exprRef() stays unqualified', () => {
		const sql = compileFnExpr(
			fn(
				'coalesce',
				fn('array_agg', exprRef('id')),
				fn('array_agg', exprRef('name')),
			),
		);
		expect(sql).toContain('array_agg(id)');
		expect(sql).toContain('array_agg(name)');
		expect(sql).not.toContain('calls.id');
		expect(sql).not.toContain('calls.name');
	});
});
