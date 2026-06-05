// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for subquery.ts WHERE handler.
 *
 * Covers: scalarSubqueryHandler, inSubqueryHandler, notInSubqueryHandler
 * Focus: scalar comparisons, IN/NOT IN subqueries, aggregates, ORDER BY, LIMIT.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision, WhereDispatcher } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	inSubqueryHandler,
	notInSubqueryHandler,
	scalarSubqueryHandler,
} from './subquery.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

/** Mock dispatcher for nested conditions */
const mockDispatch: WhereDispatcher = (_decision, _ctx, _state) => {
	return {
		A_Expr: {
			kind: 'AEXPR_OP',
			name: [{ String: { sval: '=' } }],
			lexpr: { ColumnRef: { fields: [{ String: { sval: 'status' } }] } },
			rexpr: { A_Const: { sval: { sval: 'active' } } },
		},
	};
};

// ============================================================================
// scalarSubqueryHandler — scalar comparison with subquery
// ============================================================================

describe('scalarSubqueryHandler', () => {
	const ctx = makeCtx();

	it('builds scalar subquery with = operator', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			subqueryOperator: '=',
			targetTable: 'products',
			selectColumn: 'price',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return A_Expr with SubLink on rexpr
		expect(node).toHaveProperty('A_Expr');
		const expr = node.A_Expr;
		expect(expr?.rexpr).toHaveProperty('SubLink');
		expect(expr?.rexpr?.SubLink?.subLinkType).toBe('EXPR_SUBLINK');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			targetTable: 'products',
			selectColumn: 'price',
		} as Decision;

		expect(() =>
			scalarSubqueryHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('Scalar subquery requires column');
	});

	it('throws when targetTable is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			selectColumn: 'price',
		} as Decision;

		expect(() =>
			scalarSubqueryHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('Subquery handler requires targetTable');
	});

	it('defaults to = operator when subqueryOperator not provided', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			targetTable: 'products',
			selectColumn: 'price',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		const expr = node.A_Expr;
		expect(expr?.name?.[0]?.String?.sval).toBe('=');
	});

	it('supports all comparison operators', () => {
		const operators = ['!=', '<', '<=', '>', '>='];

		for (const op of operators) {
			const state = createCompilerState();
			const decision = {
				type: 'where',
				operator: 'scalarSubquery',
				column: 'price',
				subqueryOperator: op,
				targetTable: 'products',
				selectColumn: 'price',
			} as Decision;

			const node = scalarSubqueryHandler.compile(
				decision,
				ctx,
				state,
				mockDispatch,
			);

			const expr = node.A_Expr;
			const expectedOp = op === '!=' ? '<>' : op;
			expect(expr?.name?.[0]?.String?.sval).toBe(expectedOp);
		}
	});

	it('builds subquery with aggregate function', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			subqueryOperator: '>',
			targetTable: 'products',
			selectColumn: 'price',
			aggregate: 'AVG',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
		const subLink = node.A_Expr?.rexpr?.SubLink;
		expect(subLink?.subselect).toBeDefined();
	});

	it('builds aggregate with star (COUNT(*))', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'comment_count',
			targetTable: 'comments',
			selectColumn: '*',
			aggregate: 'COUNT',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds aggregate with specific column', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'avg_rating',
			targetTable: 'reviews',
			selectColumn: 'rating',
			aggregate: 'AVG',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds subquery without aggregate (simple SELECT)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'author_id',
			targetTable: 'users',
			selectColumn: 'id',
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds subquery with single nested condition', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			targetTable: 'products',
			selectColumn: 'price',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'category',
					value: 'electronics',
				},
			],
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds subquery with multiple conditions (AND)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			targetTable: 'products',
			selectColumn: 'price',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'category',
					value: 'electronics',
				},
				{
					type: 'where',
					operator: '>',
					column: 'stock',
					value: 0,
				},
			],
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('propagates schema into nested condition context (regression lock for schema-scoping bug)', () => {
		// Schema must NOT be stripped from subCtx — nested conditions need the schema
		// to qualify their own FROM tables if they dispatch nested EXISTS or subquery.
		// Previously schema was stripped here which would cause inner FROM tables to be
		// unqualified when a schema-scoped query was composed.
		const state = createCompilerState();
		const ctxWithSchema = makeCtx({ schema: 'public' });
		let capturedCtx: CompilerContext | undefined;

		const inspectDispatch: WhereDispatcher = (_decision, ctx, _state) => {
			capturedCtx = ctx;
			return { A_Const: { boolval: { boolval: true } } };
		};

		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			targetTable: 'products',
			selectColumn: 'price',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
			],
		} as Decision;

		scalarSubqueryHandler.compile(
			decision,
			ctxWithSchema,
			state,
			inspectDispatch,
		);

		expect(capturedCtx).toBeDefined();
		// Schema is propagated — nested dispatch receives the same schema
		expect(capturedCtx!.schema).toBe('public');
	});

	it('builds subquery with ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'latest_price',
			targetTable: 'prices',
			selectColumn: 'amount',
			orderBy: [{ column: 'created_at', direction: 'DESC' as const }],
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds subquery with LIMIT as number', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'top_price',
			targetTable: 'products',
			selectColumn: 'price',
			limit: 1,
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('builds subquery with LIMIT as paramIndex object', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'top_price',
			targetTable: 'products',
			selectColumn: 'price',
			limit: { paramIndex: 5 },
		} as Decision;

		const node = scalarSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('A_Expr');
	});

	it('throws when limit.paramIndex is not a number', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'top_price',
			targetTable: 'products',
			selectColumn: 'price',
			limit: { paramIndex: 'invalid' },
		} as unknown as Decision;

		expect(() =>
			scalarSubqueryHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('limit.paramIndex must be a number');
	});

	it('generates unique alias for multiple subqueries', () => {
		const state = createCompilerState();
		const decision1 = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'price',
			targetTable: 'products',
			selectColumn: 'price',
		} as Decision;
		const decision2 = {
			type: 'where',
			operator: 'scalarSubquery',
			column: 'rating',
			targetTable: 'reviews',
			selectColumn: 'rating',
		} as Decision;

		scalarSubqueryHandler.compile(decision1, ctx, state, mockDispatch);
		scalarSubqueryHandler.compile(decision2, ctx, state, mockDispatch);

		expect(state.aliases.size).toBe(2);
	});
});

// ============================================================================
// inSubqueryHandler — IN (SELECT ...)
// ============================================================================

describe('inSubqueryHandler', () => {
	const ctx = makeCtx();

	it('builds IN subquery', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'inSubquery',
			column: 'author_id',
			targetTable: 'active_users',
			selectColumn: 'id',
		} as Decision;

		const node = inSubqueryHandler.compile(decision, ctx, state, mockDispatch);

		// Should return SubLink with ANY_SUBLINK
		expect(node).toHaveProperty('SubLink');
		expect(node.SubLink?.subLinkType).toBe('ANY_SUBLINK');
		expect(node.SubLink?.testexpr).toBeDefined();
		expect(node.SubLink?.operName?.[0]?.String?.sval).toBe('=');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'inSubquery',
			targetTable: 'active_users',
			selectColumn: 'id',
		} as Decision;

		expect(() =>
			inSubqueryHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('IN subquery requires column');
	});

	it('uses currentAlias from context', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'p' });
		const decision = {
			type: 'where',
			operator: 'inSubquery',
			column: 'author_id',
			targetTable: 'active_users',
			selectColumn: 'id',
		} as Decision;

		const node = inSubqueryHandler.compile(
			decision,
			ctxWithAlias,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('SubLink');
	});

	it('builds IN subquery with conditions', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'inSubquery',
			column: 'author_id',
			targetTable: 'users',
			selectColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'active',
					value: true,
				},
			],
		} as Decision;

		const node = inSubqueryHandler.compile(decision, ctx, state, mockDispatch);

		expect(node).toHaveProperty('SubLink');
	});
});

// ============================================================================
// notInSubqueryHandler — NOT IN (SELECT ...)
// ============================================================================

describe('notInSubqueryHandler', () => {
	const ctx = makeCtx();

	it('builds NOT IN subquery', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notInSubquery',
			column: 'author_id',
			targetTable: 'banned_users',
			selectColumn: 'id',
		} as Decision;

		const node = notInSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		// Should return SubLink with ALL_SUBLINK and <> operator
		expect(node).toHaveProperty('SubLink');
		expect(node.SubLink?.subLinkType).toBe('ALL_SUBLINK');
		expect(node.SubLink?.testexpr).toBeDefined();
		expect(node.SubLink?.operName?.[0]?.String?.sval).toBe('<>');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notInSubquery',
			targetTable: 'banned_users',
			selectColumn: 'id',
		} as Decision;

		expect(() =>
			notInSubqueryHandler.compile(decision, ctx, state, mockDispatch),
		).toThrow('NOT IN subquery requires column');
	});

	it('builds NOT IN subquery with conditions', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'notInSubquery',
			column: 'author_id',
			targetTable: 'users',
			selectColumn: 'id',
			conditions: [
				{
					type: 'where',
					operator: '=',
					column: 'status',
					value: 'banned',
				},
			],
		} as Decision;

		const node = notInSubqueryHandler.compile(
			decision,
			ctx,
			state,
			mockDispatch,
		);

		expect(node).toHaveProperty('SubLink');
	});
});
