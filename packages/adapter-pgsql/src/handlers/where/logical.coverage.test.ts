// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for logical.ts WHERE handler.
 *
 * Covers: andHandler, orHandler, notHandler
 * Focus: logical operator branches, empty conditions, single/multiple conditions.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision, WhereDispatcher } from '../types.js';
import { createCompilerState } from '../types.js';
import { andHandler, notHandler, orHandler } from './logical.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

/** Mock dispatcher for nested conditions */
const mockDispatch: WhereDispatcher = (decision, _ctx, _state) => {
	// Return a simple equality expression
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: {
				ColumnRef: {
					fields: [{ String: { sval: decision.column ?? 'field' } }],
				},
			},
			rexpr: { A_Const: { sval: { sval: 'value' } } },
		},
	};
};

// ============================================================================
// andHandler
// ============================================================================

describe('andHandler', () => {
	const ctx = makeCtx();

	it('throws when conditions is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
		} as Decision;

		expect(() =>
			andHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('AND handler requires conditions array');
	});

	it('throws when conditions is not an array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
			conditions: 'not-an-array',
		} as unknown as Decision;

		expect(() =>
			andHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('AND handler requires conditions array');
	});

	it('returns true for empty conditions array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
			conditions: [],
		} as Decision;

		const node = andHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.boolval?.boolval).toBe(true);
	});

	it('returns single condition without AND wrapper for length 1', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
			],
		} as Decision;

		const node = andHandler.compile(decision, ctx, state, mockDispatch);

		// Should return the dispatched result directly, not wrapped in AND
		expect(node).toHaveProperty('A_Expr');
		expect(node).not.toHaveProperty('BoolExpr');
	});

	it('wraps two conditions in AND', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
				{
					type: 'where',
					operator: '>',
					column: 'age',
					value: 18,
				},
			],
		} as Decision;

		const node = andHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('AND_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(2);
	});

	it('wraps multiple conditions in AND', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'and',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
				{
					type: 'where',
					operator: '>',
					column: 'age',
					value: 18,
				},
				{
					type: 'where',
					operator: '<',
					column: 'score',
					value: 100,
				},
			],
		} as Decision;

		const node = andHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('AND_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(3);
	});

	it('dispatches each condition with correct context', () => {
		const state = createCompilerState();
		let dispatchCount = 0;

		const countingDispatch: WhereDispatcher = (_decision, _ctx, _state) => {
			dispatchCount++;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'and',
			conditions: [
				{ type: 'where', operator: '=', column: 'a', value: 1 },
				{ type: 'where', operator: '=', column: 'b', value: 2 },
				{ type: 'where', operator: '=', column: 'c', value: 3 },
			],
		} as Decision;

		andHandler.compile(decision, ctx, state, countingDispatch);

		expect(dispatchCount).toBe(3);
	});
});

// ============================================================================
// orHandler
// ============================================================================

describe('orHandler', () => {
	const ctx = makeCtx();

	it('throws when conditions is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
		} as Decision;

		expect(() => orHandler.compile(decision, ctx, state, mockDispatch)).toThrow(
			'OR handler requires conditions array',
		);
	});

	it('throws when conditions is not an array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
			conditions: { not: 'array' },
		} as unknown as Decision;

		expect(() => orHandler.compile(decision, ctx, state, mockDispatch)).toThrow(
			'OR handler requires conditions array',
		);
	});

	it('returns false for empty conditions array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
			conditions: [],
		} as Decision;

		const node = orHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.boolval?.boolval).toBe(false);
	});

	it('returns single condition without OR wrapper for length 1', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
			],
		} as Decision;

		const node = orHandler.compile(decision, ctx, state, mockDispatch);

		// Should return the dispatched result directly, not wrapped in OR
		expect(node).toHaveProperty('A_Expr');
		expect(node).not.toHaveProperty('BoolExpr');
	});

	it('wraps two conditions in OR', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'pending',
				},
			],
		} as Decision;

		const node = orHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('OR_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(2);
	});

	it('wraps multiple conditions in OR', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'or',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'active',
				},
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'pending',
				},
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'draft',
				},
			],
		} as Decision;

		const node = orHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('OR_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(3);
	});

	it('dispatches each condition with correct context', () => {
		const state = createCompilerState();
		let dispatchCount = 0;

		const countingDispatch: WhereDispatcher = (_decision, _ctx, _state) => {
			dispatchCount++;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'or',
			conditions: [
				{ type: 'where', operator: '=', column: 'a', value: 1 },
				{ type: 'where', operator: '=', column: 'b', value: 2 },
			],
		} as Decision;

		orHandler.compile(decision, ctx, state, countingDispatch);

		expect(dispatchCount).toBe(2);
	});
});

// ============================================================================
// notHandler
// ============================================================================

describe('notHandler', () => {
	const ctx = makeCtx();

	it('throws when conditions is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'not',
		} as Decision;

		expect(() =>
			notHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('NOT handler requires a condition in conditions[0]');
	});

	it('throws when conditions is empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'not',
			conditions: [],
		} as Decision;

		expect(() =>
			notHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('NOT handler requires a condition in conditions[0]');
	});

	it('wraps single condition in NOT', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'not',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'deleted',
				},
			],
		} as Decision;

		const node = notHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(1);
	});

	it('only uses first condition (ignores rest)', () => {
		const state = createCompilerState();
		let dispatchCount = 0;

		const countingDispatch: WhereDispatcher = (_decision, _ctx, _state) => {
			dispatchCount++;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'not',
			conditions: [
				{ type: 'where', operator: '=', column: 'a', value: 1 },
				{ type: 'where', operator: '=', column: 'b', value: 2 },
				{ type: 'where', operator: '=', column: 'c', value: 3 },
			],
		} as Decision;

		notHandler.compile(decision, ctx, state, countingDispatch);

		// Should only dispatch the first condition
		expect(dispatchCount).toBe(1);
	});

	it('passes context correctly to nested condition', () => {
		const state = createCompilerState();
		let capturedCtx: CompilerContext | undefined;

		const inspectDispatch: WhereDispatcher = (_decision, ctx, _state) => {
			capturedCtx = ctx;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'not',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: false,
				},
			],
		} as Decision;

		notHandler.compile(decision, ctx, state, inspectDispatch);

		expect(capturedCtx).toBeDefined();
		expect(capturedCtx!.rootTable).toBe('posts');
	});
});
