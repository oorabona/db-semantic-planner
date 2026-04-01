// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * @fileoverview Branch coverage for case-when-builder.ts
 *
 * Targets all 8 uncovered branches in toResultIntent():
 * - L7: instanceof ExpressionRef (true/false)
 * - L10: value === null || value === undefined (true/false, both sides of ||)
 * - L13: typeof value === "string" (true/false)
 * And CaseBuilder class methods: when(), else(), as(), toExpr()
 * And full-text-search.ts: textScore() default arg branch
 */

import { describe, expect, it } from 'vitest';
import { caseWhen } from './case-when-builder.js';
import { ref } from './expressions.js';
import { eq } from './filters.js';
import { textScore } from './full-text-search.js';

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

	it('accepts undefined as thenValue (undefined branch)', () => {
		// undefined → toResultIntent returns { kind: 'literal', value: null }
		const expr = caseWhen(eq('status', 'a'), undefined).else('fallback');
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
