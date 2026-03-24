// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for exists.ts WHERE handler.
 *
 * Covers: existsHandler, notExistsHandler, everyHandler
 * Focus: EXISTS/NOT EXISTS subquery construction, correlation, nested conditions.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision, WhereDispatcher } from '../types.js';
import { createCompilerState } from '../types.js';
import { everyHandler, existsHandler, notExistsHandler } from './exists.js';

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
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: {
				ColumnRef: {
					fields: [{ String: { sval: decision.column ?? 'status' } }],
				},
			},
			rexpr: { A_Const: { sval: { sval: 'approved' } } },
		},
	};
};

// ============================================================================
// existsHandler — EXISTS subquery construction
// ============================================================================

describe('existsHandler', () => {
	const ctx = makeCtx();

	it('builds EXISTS subquery with correlation', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			targetColumn: 'post_id',
		} as Decision;

		const node = existsHandler.compile(decision, ctx, state, mockDispatch);

		// Should return SubLink with EXISTS_SUBLINK
		expect(node).toHaveProperty('SubLink');
		expect(node.SubLink?.subLinkType).toBe('EXISTS_SUBLINK');
	});

	it('uses default FK derivation when targetColumn not provided', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;

		const node = existsHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('SubLink');
		expect(state.aliases.size).toBe(1);
	});

	it('uses custom FK derivation from context', () => {
		const state = createCompilerState();
		const ctxWithDerivation = makeCtx({
			deriveFkColumnName: (table, pk) => `${table}_${pk}`,
		});
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;

		const node = existsHandler.compile(
			decision,
			ctxWithDerivation,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('SubLink');
	});

	it('throws when targetTable is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			sourceColumn: 'id',
		} as Decision;

		expect(() =>
			existsHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('EXISTS handler requires targetTable or relation');
	});

	it('generates unique alias for multiple EXISTS', () => {
		const state = createCompilerState();
		const decision1 = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;
		const decision2 = {
			type: 'where',
			operator: 'exists',
			relation: 'likes',
			targetTable: 'likes',
			sourceColumn: 'id',
		} as Decision;

		existsHandler.compile(decision1, ctx, state, mockDispatch);
		existsHandler.compile(decision2, ctx, state, mockDispatch);

		expect(state.aliases.size).toBe(2);
	});

	it('uses currentAlias from context for source', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'p' });
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;

		const node = existsHandler.compile(
			decision,
			ctxWithAlias,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('SubLink');
	});

	it('builds EXISTS with nested conditions', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
			],
		} as Decision;

		const node = existsHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('SubLink');
		expect(node.SubLink?.subselect).toBeDefined();
	});

	it('builds EXISTS with multiple nested conditions (AND)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
				{
					type: 'where',
					operator: '>',
					column: 'rating',
					value: 3,
				},
			],
		} as Decision;

		const node = existsHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('SubLink');
	});

	it('strips schema from nested condition context', () => {
		const state = createCompilerState();
		const ctxWithSchema = makeCtx({ schema: 'public' });
		let capturedCtx: CompilerContext | undefined;

		const inspectDispatch: WhereDispatcher = (_decision, ctx, _state) => {
			capturedCtx = ctx;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
			],
		} as Decision;

		existsHandler.compile(decision, ctxWithSchema, state, inspectDispatch);

		expect(capturedCtx).toBeDefined();
		expect(capturedCtx!.schema).toBeUndefined();
	});

	it('sets outerAlias in nested condition context', () => {
		const state = createCompilerState();
		let capturedCtx: CompilerContext | undefined;

		const inspectDispatch: WhereDispatcher = (_decision, ctx, _state) => {
			capturedCtx = ctx;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
			],
		} as Decision;

		existsHandler.compile(decision, ctx, state, inspectDispatch);

		expect(capturedCtx).toBeDefined();
		expect(capturedCtx!.outerAlias).toBe('posts');
	});
});

// ============================================================================
// notExistsHandler — NOT EXISTS subquery construction
// ============================================================================

describe('notExistsHandler', () => {
	const ctx = makeCtx();

	it('builds NOT EXISTS subquery with negation', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notExists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;

		const node = notExistsHandler.compile(decision, ctx, state, mockDispatch);

		// Should return BoolExpr with NOT wrapping SubLink
		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(1);
		expect(node.BoolExpr?.args?.[0]).toHaveProperty('SubLink');
	});

	it('handles nested conditions', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notExists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'spam',
				},
			],
		} as Decision;

		const node = notExistsHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
	});
});

// ============================================================================
// everyHandler — NOT EXISTS with inverted condition
// ============================================================================

describe('everyHandler', () => {
	const ctx = makeCtx();

	it('returns true for empty conditions (vacuous truth)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'every',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [],
		} as Decision;

		const node = everyHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.boolval?.boolval).toBe(true);
	});

	it('returns true when conditions is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'every',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as Decision;

		const node = everyHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.boolval?.boolval).toBe(true);
	});

	it('inverts condition and builds NOT EXISTS', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'every',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
			],
		} as Decision;

		const node = everyHandler.compile(decision, ctx, state, mockDispatch);

		// Should return NOT EXISTS with inverted condition
		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
	});

	it('wraps multiple conditions in NOT before inversion', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'every',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'approved',
				},
				{
					type: 'where',
					operator: '>',
					column: 'rating',
					value: 3,
				},
			],
		} as Decision;

		const node = everyHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
	});
});
