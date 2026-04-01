/**
 * Edge case tests for deparseBoolExpr — uncovered nullish-coalescing paths.
 *
 * deparseBoolExpr uses `node.args ?? []` so null/undefined args fall back to
 * an empty array. These tests verify the exact output for each branch:
 *
 * Path #1: AND_EXPR with args=null/undefined → '' (join of empty parts array)
 * Path #3: OR_EXPR with args=null/undefined  → ''
 * Path #5: NOT_EXPR with args=null/undefined → 'NOT ()'
 * Path #7: NOT_EXPR with args=[] (falsy args[0]) → 'NOT ()'
 * Path #2: NOT_EXPR with args[0] present     → 'NOT (<deparse(args[0])>)'
 */

import type { Node } from '@pgsql/types';
import { describe, expect, it } from 'vitest';
import { deparse } from '../pgsql-deparser.js';

// ---------------------------------------------------------------------------
// Helper — build a BoolExpr Node wrapper as deparse() expects
// ---------------------------------------------------------------------------

type BoolOp = 'AND_EXPR' | 'OR_EXPR' | 'NOT_EXPR';

function boolExprNode(boolop: BoolOp, args?: Node[] | null): Node {
	return {
		BoolExpr: {
			boolop,
			// Use the exact nullish values to exercise the `args ?? []` branch
			...(args === undefined ? {} : { args }),
		},
	} as unknown as Node;
}

// A simple leaf node for use in args
function trueConst(): Node {
	return { A_Const: { boolval: { boolval: true } } } as unknown as Node;
}

function falseConst(): Node {
	return { A_Const: { boolval: { boolval: false } } } as unknown as Node;
}

function paramRefNode(n: number): Node {
	return { ParamRef: { number: n } } as unknown as Node;
}

// ---------------------------------------------------------------------------
// NOT_EXPR edge cases
// ---------------------------------------------------------------------------

describe('deparseBoolExpr — NOT_EXPR edge cases', () => {
	it('should return "NOT ()" when args is undefined (nullish coalescing → empty array)', () => {
		// args field absent → args ?? [] = [] → args[0] is undefined (falsy)
		const node = boolExprNode('NOT_EXPR', undefined);
		const result = deparse(node);
		expect(result).toBe('NOT ()');
	});

	it('should return "NOT ()" when args is an empty array', () => {
		// args=[] → args[0] is undefined (falsy) → deparse(args[0]) skipped → ''
		const node = boolExprNode('NOT_EXPR', []);
		const result = deparse(node);
		expect(result).toBe('NOT ()');
	});

	it('should return "NOT (true)" when args[0] is a boolean-true constant', () => {
		const node = boolExprNode('NOT_EXPR', [trueConst()]);
		const result = deparse(node);
		expect(result).toBe('NOT (true)');
	});

	it('should return "NOT (false)" when args[0] is a boolean-false constant', () => {
		const node = boolExprNode('NOT_EXPR', [falseConst()]);
		const result = deparse(node);
		expect(result).toBe('NOT (false)');
	});

	it('should return "NOT ($1)" when args[0] is a ParamRef', () => {
		const node = boolExprNode('NOT_EXPR', [paramRefNode(1)]);
		const result = deparse(node);
		expect(result).toBe('NOT ($1)');
	});

	it('should ignore extra args beyond the first in NOT_EXPR', () => {
		// PostgreSQL NOT only applies to one operand; only args[0] is used
		const node = boolExprNode('NOT_EXPR', [trueConst(), falseConst()]);
		const result = deparse(node);
		expect(result).toBe('NOT (true)');
	});
});

// ---------------------------------------------------------------------------
// AND_EXPR edge cases
// ---------------------------------------------------------------------------

describe('deparseBoolExpr — AND_EXPR edge cases', () => {
	it('should return empty string when args is undefined (nullish coalescing → empty array)', () => {
		const node = boolExprNode('AND_EXPR', undefined);
		const result = deparse(node);
		// parts = [] → parts.join(' AND ') = ''
		expect(result).toBe('');
	});

	it('should return empty string when args is an empty array', () => {
		const node = boolExprNode('AND_EXPR', []);
		const result = deparse(node);
		expect(result).toBe('');
	});

	it('should return single operand string without AND when args has one element', () => {
		const node = boolExprNode('AND_EXPR', [paramRefNode(1)]);
		const result = deparse(node);
		expect(result).toBe('$1');
	});

	it('should return "$1 AND $2" when args has two ParamRef elements', () => {
		const node = boolExprNode('AND_EXPR', [paramRefNode(1), paramRefNode(2)]);
		const result = deparse(node);
		expect(result).toBe('$1 AND $2');
	});

	it('should wrap an OR child in parens when nested inside AND to preserve precedence', () => {
		// AND wrapping an OR child must emit (a OR b) AND c
		const orChild = boolExprNode('OR_EXPR', [paramRefNode(1), paramRefNode(2)]);
		const andNode = boolExprNode('AND_EXPR', [orChild, paramRefNode(3)]);
		const result = deparse(andNode);
		expect(result).toBe('($1 OR $2) AND $3');
	});

	it('should NOT wrap an AND child in parens when nested inside AND', () => {
		// AND wrapping another AND — no extra parens needed
		const innerAnd = boolExprNode('AND_EXPR', [
			paramRefNode(1),
			paramRefNode(2),
		]);
		const outerAnd = boolExprNode('AND_EXPR', [innerAnd, paramRefNode(3)]);
		const result = deparse(outerAnd);
		// The inner AND has no special wrapping from the outer AND
		expect(result).toBe('$1 AND $2 AND $3');
	});
});

// ---------------------------------------------------------------------------
// OR_EXPR edge cases
// ---------------------------------------------------------------------------

describe('deparseBoolExpr — OR_EXPR edge cases', () => {
	it('should return empty string when args is undefined (nullish coalescing → empty array)', () => {
		const node = boolExprNode('OR_EXPR', undefined);
		const result = deparse(node);
		expect(result).toBe('');
	});

	it('should return empty string when args is an empty array', () => {
		const node = boolExprNode('OR_EXPR', []);
		const result = deparse(node);
		expect(result).toBe('');
	});

	it('should return single operand string without OR when args has one element', () => {
		const node = boolExprNode('OR_EXPR', [paramRefNode(5)]);
		const result = deparse(node);
		expect(result).toBe('$5');
	});

	it('should return "$1 OR $2" when args has two ParamRef elements', () => {
		const node = boolExprNode('OR_EXPR', [paramRefNode(1), paramRefNode(2)]);
		const result = deparse(node);
		expect(result).toBe('$1 OR $2');
	});

	it('should NOT wrap an OR child in extra parens when nested inside OR', () => {
		// OR is left-associative, no precedence wrapping for OR-inside-OR
		const innerOr = boolExprNode('OR_EXPR', [paramRefNode(1), paramRefNode(2)]);
		const outerOr = boolExprNode('OR_EXPR', [innerOr, paramRefNode(3)]);
		const result = deparse(outerOr);
		expect(result).toBe('$1 OR $2 OR $3');
	});
});
