/**
 * Custom Expression Handler Tests
 *
 * Tests compileExpressionIntent for each expression kind:
 * customOp, customFn, ref, param, cast, literal, unary
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../../../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../../../compiler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function compileCustomExpr(
	expressionIntent: Record<string, unknown>,
	alias?: string,
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable: 'items',
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent,
				alias,
			},
		],
	};
	return compilePlan(plan);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileExpressionIntent', () => {
	describe('ref kind', () => {
		it('compiles a simple column ref', () => {
			const result = compileCustomExpr({ kind: 'ref', column: 'price' });
			expect(normalizeSQL(result.sql)).toBe('select price from items');
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles a table.column ref', () => {
			const result = compileCustomExpr({
				kind: 'ref',
				column: 'items.price',
			});
			expect(normalizeSQL(result.sql)).toBe('select items.price from items');
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('param kind', () => {
		it('compiles a param and binds value', () => {
			const result = compileCustomExpr({ kind: 'param', value: 42 });
			expect(normalizeSQL(result.sql)).toBe('select $1 from items');
			expect(result.parameters).toEqual([42]);
		});

		it('compiles an array param', () => {
			const result = compileCustomExpr({
				kind: 'param',
				value: [0.1, 0.2, 0.3],
			});
			expect(normalizeSQL(result.sql)).toBe('select $1 from items');
			expect(result.parameters[0]).toEqual([0.1, 0.2, 0.3]);
		});
	});

	describe('literal kind', () => {
		it('compiles integer literal inline (no param)', () => {
			const result = compileCustomExpr({ kind: 'literal', value: 1 });
			expect(normalizeSQL(result.sql)).toBe('select 1 from items');
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles string literal inline', () => {
			const result = compileCustomExpr({
				kind: 'literal',
				value: 'hello',
			});
			expect(normalizeSQL(result.sql)).toBe("select 'hello' from items");
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles boolean literal', () => {
			const result = compileCustomExpr({ kind: 'literal', value: true });
			expect(normalizeSQL(result.sql)).toBe('select true from items');
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles null literal', () => {
			const result = compileCustomExpr({ kind: 'literal', value: null });
			expect(normalizeSQL(result.sql)).toBe('select null from items');
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('cast kind', () => {
		it('compiles a cast expression', () => {
			const result = compileCustomExpr({
				kind: 'cast',
				expr: { kind: 'param', value: [0.1, 0.2] },
				typeName: 'vector',
			});
			expect(normalizeSQL(result.sql)).toBe(
				'select cast($1 as vector) from items',
			);
			expect(result.parameters[0]).toEqual([0.1, 0.2]);
		});
	});

	describe('customOp kind', () => {
		it('compiles a binary custom operator', () => {
			const result = compileCustomExpr({
				kind: 'customOp',
				operator: '<=>',
				left: { kind: 'ref', column: 'vector' },
				right: {
					kind: 'cast',
					expr: { kind: 'param', value: [0.1, 0.2] },
					typeName: 'vector',
				},
			});
			expect(normalizeSQL(result.sql)).toBe(
				'select vector <=> cast($1 as vector) from items',
			);
			expect(result.parameters[0]).toEqual([0.1, 0.2]);
		});

		it('compiles nested binary operators (1 - (col <=> cast($1 as vector)))', () => {
			const result = compileCustomExpr(
				{
					kind: 'customOp',
					operator: '-',
					left: { kind: 'literal', value: 1 },
					right: {
						kind: 'customOp',
						operator: '<=>',
						left: { kind: 'ref', column: 'vector' },
						right: {
							kind: 'cast',
							expr: { kind: 'param', value: [0.1] },
							typeName: 'vector',
						},
					},
				},
				'score',
			);
			expect(normalizeSQL(result.sql)).toBe(
				'select 1 - (vector <=> cast($1 as vector)) as score from items',
			);
			expect(result.parameters[0]).toEqual([0.1]);
		});

		it('compiles col-vs-col with no params', () => {
			const result = compileCustomExpr({
				kind: 'customOp',
				operator: '<=>',
				left: { kind: 'ref', column: 'e1.vector' },
				right: { kind: 'ref', column: 'e2.vector' },
			});
			expect(normalizeSQL(result.sql)).toBe(
				'select e1.vector <=> e2.vector from items',
			);
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('customFn kind', () => {
		it('compiles a simple function call', () => {
			const result = compileCustomExpr({
				kind: 'customFn',
				name: 'my_func',
				args: [{ kind: 'ref', column: 'id' }],
			});
			expect(normalizeSQL(result.sql)).toBe('select my_func(id) from items');
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles a schema-qualified function call', () => {
			const result = compileCustomExpr({
				kind: 'customFn',
				name: 'paradedb.score',
				args: [],
			});
			expect(normalizeSQL(result.sql)).toBe(
				'select paradedb.score() from items',
			);
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('unary kind', () => {
		it('compiles a unary minus', () => {
			const result = compileCustomExpr({
				kind: 'unary',
				operator: '-',
				operand: { kind: 'ref', column: 'price' },
			});
			expect(normalizeSQL(result.sql)).toBe('select - price from items');
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('alias', () => {
		it('applies alias to SELECT target', () => {
			const result = compileCustomExpr(
				{ kind: 'ref', column: 'total' },
				'total_amount',
			);
			expect(normalizeSQL(result.sql)).toBe(
				'select total as total_amount from items',
			);
			expect(result.parameters).toHaveLength(0);
		});
	});

	describe('namedArg', () => {
		it('compiles namedArg with literal value to name => value SQL', () => {
			const result = compileCustomExpr({
				kind: 'namedArg',
				name: 'field',
				value: { kind: 'literal', value: 'name_searchable' },
			});
			expect(normalizeSQL(result.sql)).toContain("field => 'name_searchable'");
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles namedArg with param value to name => $N SQL', () => {
			const result = compileCustomExpr({
				kind: 'namedArg',
				name: 'query_string',
				value: { kind: 'param', value: 'hello world' },
			});
			expect(normalizeSQL(result.sql)).toContain('query_string => $1');
			expect(result.parameters).toHaveLength(1);
			expect(result.parameters[0]).toBe('hello world');
		});

		it('compiles namedArg inside customFn (paradedb.parse pattern)', () => {
			const result = compileCustomExpr({
				kind: 'customFn',
				name: 'paradedb.parse',
				args: [
					{ kind: 'namedArg', name: 'field', value: { kind: 'literal', value: 'name' } },
					{ kind: 'namedArg', name: 'query_string', value: { kind: 'param', value: 'test' } },
				],
			});
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('paradedb.parse');
			expect(sql).toContain("field => 'name'");
			expect(sql).toContain('query_string => $1');
			expect(result.parameters).toHaveLength(1);
			expect(result.parameters[0]).toBe('test');
		});
	});
});
