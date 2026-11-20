// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Branch coverage for case-when-builder.ts
 *
 * Targets the branches of toResultIntent(): the null normalisation, then
 * the shared reference-leaf rule (coerceReference) for every other result.
 * And CaseBuilder class methods: when(), else(), as(), toExpr()
 * And full-text-search.ts: textScore() default arg branch
 */

import { describe, expect, it } from 'vitest';
import { caseWhen } from './case-when-builder.js';
import { literal, ref } from './expressions.js';
import { eq } from './filters.js';
import { textScore } from './full-text-search.js';
import { subquery } from './subquery-builder.js';

// ============================================================================
// toResultIntent() branches via caseWhen(condition, thenValue)
// caseWhen() takes condition + thenValue as first branch, then chains .when()
// ============================================================================

describe('caseWhen() — toResultIntent branches', () => {
	it('accepts ExpressionRef as thenValue (instanceof ExpressionRef branch)', () => {
		// Passes ExpressionRef → toResultIntent returns value.intent
		const expr = caseWhen(eq('status', 'a'), ref('name')).else('fallback');
		const intent = expr.intent;
		expect(intent.kind).toBe('case');
		expect(intent.when[0].result.kind).toBe('ref');
		expect(intent.when[0].result.column).toBe('name');
	});

	it('accepts null as thenValue (null/undefined branch)', () => {
		// null → toResultIntent returns { kind: 'literal', value: null }
		const expr = caseWhen(eq('status', 'a'), null).else('fallback');
		const intent = expr.intent;
		expect(intent.when[0].result.kind).toBe('literal');
		expect(intent.when[0].result.value).toBeNull();
	});

	it('accepts string as thenValue (typeof === string branch)', () => {
		// string → toResultIntent returns { kind: 'ref', column: value }
		const expr = caseWhen(eq('status', 'a'), 'Active').else('Inactive');
		const intent = expr.intent;
		expect(intent.when[0].result.kind).toBe('ref');
		expect(intent.when[0].result.column).toBe('Active');
	});

	it('accepts number as thenValue (literal fallback branch)', () => {
		// number → toResultIntent returns { kind: 'literal', value: 42 }
		const expr = caseWhen(eq('count', 0), 42).else(0);
		const intent = expr.intent;
		expect(intent.when[0].result.kind).toBe('literal');
		expect(intent.when[0].result.value).toBe(42);
	});

	it('accepts boolean as thenValue (literal fallback branch)', () => {
		// boolean → toResultIntent returns { kind: 'literal', value: true }
		const expr = caseWhen(eq('active', true), true).else(false);
		const intent = expr.intent;
		expect(intent.when[0].result.kind).toBe('literal');
		expect(intent.when[0].result.value).toBe(true);
	});

	it('elseValue can be ExpressionRef (instanceof branch in else path)', () => {
		const expr = caseWhen(eq('x', 1), 'one').else(ref('default_val'));
		const intent = expr.intent;
		expect(intent.else.kind).toBe('ref');
		expect(intent.else.column).toBe('default_val');
	});

	it('elseValue can be null (null branch in else path)', () => {
		const expr = caseWhen(eq('x', 1), 'one').else(null);
		const intent = expr.intent;
		expect(intent.else.kind).toBe('literal');
		expect(intent.else.value).toBeNull();
	});
});

// ============================================================================
// CASE results follow the reference-leaf rule (ADR 0011)
// ============================================================================

describe('caseWhen() — reference-leaf results', () => {
	it('literal() result keeps its literal intent', () => {
		const expr = caseWhen(eq('score', 1), literal('A')).else(literal('B'));
		expect(expr.intent.when[0].result).toEqual({ kind: 'literal', value: 'A' });
		expect(expr.intent.else).toEqual({ kind: 'literal', value: 'B' });
	});

	it('an asExpr() subquery in a .when() branch is its subquery intent', () => {
		const n = subquery('posts').count().asExpr('n');
		const expr = caseWhen(eq('score', 1), 0).when(eq('score', 2), n).else(1);
		expect(expr.intent.when[1].result).toEqual({
			kind: 'subquery',
			query: {
				type: 'select',
				from: 'posts',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*' }],
				},
			},
			as: 'n',
		});
	});

	it('a NaN result is a parameter', () => {
		const expr = caseWhen(eq('score', 1), Number.NaN).else(0);
		expect(expr.intent.when[0].result).toEqual({
			kind: 'param',
			value: Number.NaN,
		});
	});

	it('array and Date results are parameters', () => {
		const date = new Date(0);
		const expr = caseWhen(eq('score', 1), [1, 2]).else(date);
		expect(expr.intent.when[0].result).toEqual({
			kind: 'param',
			value: [1, 2],
		});
		expect(expr.intent.else).toEqual({ kind: 'param', value: date });
	});

	it('a safe bigint result is an inlined number literal', () => {
		const expr = caseWhen(eq('score', 1), 2n).else(0);
		expect(expr.intent.when[0].result).toEqual({ kind: 'literal', value: 2 });
	});
});

// ============================================================================
// CaseBuilder.when() — chaining additional branches
// ============================================================================

describe('CaseBuilder.when() chaining', () => {
	it('chains multiple when() branches', () => {
		// caseWhen(c1, v1) creates first branch, .when(c2, v2) adds second, etc.
		const expr = caseWhen(eq('status', 'a'), 'Active')
			.when(eq('status', 'i'), 'Inactive')
			.when(eq('status', 'p'), 'Pending')
			.else('Unknown');
		const intent = expr.intent;
		expect(intent.when).toHaveLength(3);
		expect(intent.when[0].result.column).toBe('Active');
		expect(intent.when[1].result.column).toBe('Inactive');
		expect(intent.when[2].result.column).toBe('Pending');
	});
});

// ============================================================================
// CaseBuilder.as() and toExpr()
// ============================================================================

describe('CaseBuilder.as() and toExpr()', () => {
	it('as() returns ExpressionRef with alias stored under intent.as', () => {
		// CaseBuilder.as() calls toExpr().as(alias)
		// ExpressionRef.as() stores alias under the `as` key in intent
		const expr = caseWhen(eq('status', 'a'), 'Active').as('status_label');
		expect(expr.intent.as).toBe('status_label');
		expect(expr.intent.kind).toBe('case');
	});

	it('toExpr() returns ExpressionRef without alias', () => {
		const expr = caseWhen(eq('status', 'a'), 'Active').toExpr();
		expect(expr.intent.kind).toBe('case');
		expect(expr.intent.as).toBeUndefined();
	});

	it('toExpr() without else has no else field in intent', () => {
		const expr = caseWhen(eq('n', 1), 10).toExpr();
		expect(expr.intent.else).toBeUndefined();
	});
});

// ============================================================================
// full-text-search.ts: textScore() default arg branch
// ============================================================================

describe('textScore() default arg', () => {
	it('uses "id" as default keyField when called with no args', () => {
		const expr = textScore();
		// fn('paradedb.score', ref('id'))
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('paradedb.score');
		expect(expr.intent.args[0].column).toBe('id');
	});

	it('uses custom keyField when provided', () => {
		const expr = textScore('doc_id');
		expect(expr.intent.args[0].column).toBe('doc_id');
	});
});
