// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for relation-filter.ts WHERE handler.
 *
 * Covers: relationFilterHandler, hasRelationHandler, hasNoRelationHandler
 * Focus: all filter modes (some, none, every, is, isNot), nested conditions, JOIN construction.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision, WhereDispatcher } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	hasNoRelationHandler,
	hasRelationHandler,
	relationFilterHandler,
} from './relation-filter.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

/** Minimal dispatcher that returns a boolean const for nested conditions */
const mockDispatch: WhereDispatcher = (decision, _ctx, _state) => {
	// For EXISTS-style delegation, return true
	if (
		decision.operator === 'exists' ||
		decision.operator === 'notExists' ||
		decision.operator === 'every'
	) {
		return { A_Const: { boolval: { boolval: true } } };
	}
	// For nested conditions in is/isNot mode
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: { ColumnRef: { fields: [{ String: { sval: 'mock' } }] } },
			rexpr: { A_Const: { ival: { ival: 1 } } },
		},
	};
};

// ============================================================================
// relationFilterHandler — mode: some (delegates to EXISTS)
// ============================================================================

describe('relationFilterHandler mode:some', () => {
	const ctx = makeCtx();

	it('delegates to EXISTS handler for "some" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'some',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should delegate to EXISTS, which returns a boolean const in our mock
		expect(node).toHaveProperty('A_Const');
	});

	it('delegates to EXISTS handler for "exists" operator alias', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'exists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Const');
	});
});

// ============================================================================
// relationFilterHandler — mode: none (delegates to NOT EXISTS)
// ============================================================================

describe('relationFilterHandler mode:none', () => {
	const ctx = makeCtx();

	it('delegates to NOT EXISTS handler for "none" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'none',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Const');
	});

	it('delegates to NOT EXISTS handler for "notExists" operator alias', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notExists',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Const');
	});
});

// ============================================================================
// relationFilterHandler — mode: every (delegates to EXISTS with NOT)
// ============================================================================

describe('relationFilterHandler mode:every', () => {
	const ctx = makeCtx();

	it('delegates to EXISTS handler for "every" operator', () => {
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
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should delegate to EXISTS (via mockDispatch which returns true for exists/notExists)
		expect(node).toHaveProperty('A_Const');
	});
});

// ============================================================================
// relationFilterHandler — mode: is (JOIN-based)
// ============================================================================

describe('relationFilterHandler mode:is', () => {
	const ctx = makeCtx();

	it('builds JOIN for "is" operator with default FK derivation', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return a boolean const (TRUE) since no conditions
		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.boolval?.boolval).toBe(true);

		// Should have registered a JOIN in state
		expect(state.joins).toHaveLength(1);
		expect(state.joins[0]).toHaveProperty('JoinExpr');
	});

	it('builds JOIN with custom FK derivation function', () => {
		const state = createCompilerState();
		const ctxWithDerivation = makeCtx({
			deriveFkColumnName: (table, pk) => `${table}_${pk}`,
		});
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
		} as CompilerDecision;

		relationFilterHandler.compile(
			decision,
			ctxWithDerivation,
			state,
			mockDispatch,
		);

		expect(state.joins).toHaveLength(1);
		const join = state.joins[0]!.JoinExpr;
		expect(join).toBeDefined();
	});

	it('builds JOIN with explicit targetColumn', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
			targetColumn: 'id',
		} as CompilerDecision;

		relationFilterHandler.compile(decision, ctx, state, mockDispatch);

		expect(state.joins).toHaveLength(1);
	});

	it('throws error when targetTable is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'is',
			sourceColumn: 'author_id',
		} as CompilerDecision;

		expect(() =>
			relationFilterHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('Relation filter requires targetTable');
	});

	it('generates unique alias for multiple joins', () => {
		const state = createCompilerState();
		const decision1 = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
		} as CompilerDecision;
		const decision2 = {
			type: 'where',
			operator: 'is',
			relation: 'category',
			targetTable: 'categories',
			sourceColumn: 'category_id',
		} as CompilerDecision;

		relationFilterHandler.compile(decision1, ctx, state, mockDispatch);
		relationFilterHandler.compile(decision2, ctx, state, mockDispatch);

		expect(state.aliases.size).toBe(2);
		expect(state.joins).toHaveLength(2);
	});

	it('uses currentAlias from ctx when available', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'p' });
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
		} as CompilerDecision;

		relationFilterHandler.compile(decision, ctxWithAlias, state, mockDispatch);

		expect(state.joins).toHaveLength(1);
	});
});

// ============================================================================
// relationFilterHandler — mode: is with conditions
// ============================================================================

describe('relationFilterHandler mode:is with conditions', () => {
	const ctx = makeCtx();

	it('compiles single condition', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
			],
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return the compiled condition (from mockDispatch)
		expect(node).toHaveProperty('A_Expr');
	});

	it('compiles multiple conditions with AND', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
				{
					type: 'where',
					operator: '>',
					column: 'posts_count',
					value: 10,
				},
			],
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return AND expression
		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('AND_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(2);
	});

	it('passes correct sub-context to nested conditions', () => {
		const state = createCompilerState();
		let capturedCtx: CompilerContext | undefined;

		const inspectDispatch: WhereDispatcher = (_decision, ctx, _state) => {
			capturedCtx = ctx;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'is',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
			],
		} as CompilerDecision;

		relationFilterHandler.compile(decision, ctx, state, inspectDispatch);

		expect(capturedCtx).toBeDefined();
		expect(capturedCtx!.rootTable).toBe('authors');
		expect(capturedCtx!.currentAlias).toMatch(/^authors_rel_/);
	});
});

// ============================================================================
// relationFilterHandler — mode: isNot (negated JOIN)
// ============================================================================

describe('relationFilterHandler mode:isNot', () => {
	const ctx = makeCtx();

	it('negates the JOIN filter with NOT', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'isNot',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return NOT expression
		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
		expect(node.BoolExpr?.args).toHaveLength(1);
	});

	it('negates JOIN with conditions', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'isNot',
			relation: 'author',
			targetTable: 'authors',
			sourceColumn: 'author_id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
			],
		} as CompilerDecision;

		const node = relationFilterHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return NOT expression wrapping the condition
		expect(node).toHaveProperty('BoolExpr');
		expect(node.BoolExpr?.boolop).toBe('NOT_EXPR');
	});
});

// ============================================================================
// hasRelationHandler (sugar for "some")
// ============================================================================

describe('hasRelationHandler', () => {
	const ctx = makeCtx();

	it('delegates to EXISTS for "has" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'has',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = hasRelationHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
	});

	it('delegates to EXISTS for "hasRelation" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'hasRelation',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = hasRelationHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('A_Const');
	});
});

// ============================================================================
// hasNoRelationHandler (sugar for "none")
// ============================================================================

describe('hasNoRelationHandler', () => {
	const ctx = makeCtx();

	it('delegates to NOT EXISTS for "hasNo" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'hasNo',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = hasNoRelationHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Const');
	});

	it('delegates to NOT EXISTS for "hasNoRelation" operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'hasNoRelation',
			relation: 'comments',
			targetTable: 'comments',
			sourceColumn: 'id',
		} as CompilerDecision;

		const node = hasNoRelationHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Const');
	});
});
