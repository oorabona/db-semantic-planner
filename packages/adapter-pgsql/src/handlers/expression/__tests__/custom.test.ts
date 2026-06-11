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

		it('escapes single quotes in string literals — SQL injection attempt doubled (FIX-4b)', () => {
			// The value below contains a SQL injection attempt with an embedded
			// single quote that would break out of a naive string literal.
			// The deparser must double the quote ('' not ') so the output is a
			// syntactically valid, self-contained SQL string constant.
			//
			// Mutation this test catches: if quoteString() stops doubling single
			// quotes (e.g. reverts to raw interpolation), the output would contain
			// the unescaped sequence `');` which breaks the string boundary.
			const injectionAttempt = "a'); DROP TABLE users; --";
			const result = compileCustomExpr({
				kind: 'literal',
				value: injectionAttempt,
			});

			// normalizeSQL lower-cases but does not strip quotes.
			const sql = normalizeSQL(result.sql);

			// Assert the doubled-quote form IS present — single quotes doubled to ''.
			expect(sql).toContain("'a''); drop table users; --'");

			// Assert the UNESCAPED break-out pattern is NOT present.
			// The injection value `a'); DROP TABLE users; --` must be rendered with
			// the single quote doubled: `a'')`, NOT as a raw `');`.
			// A lone `');` (quote not preceded by another quote) means the string
			// boundary was broken. The regex matches `');` only when not preceded
			// by another `'` (i.e. the unescaped, dangerous form).
			expect(sql).not.toMatch(/(?<!')'(\);)/);

			// Confirm it is emitted as a SQL constant, not a bound parameter.
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

		it('preserves intentionally-cased builder custom function names', () => {
			const result = compileCustomExpr({
				kind: 'customFn',
				name: 'ST_DWithin',
				args: [{ kind: 'ref', column: 'geom' }],
			});
			expect(result.sql.replace(/\s+/g, ' ').trim()).toBe(
				'SELECT "ST_DWithin"(geom) FROM items',
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
					{
						kind: 'namedArg',
						name: 'field',
						value: { kind: 'literal', value: 'name' },
					},
					{
						kind: 'namedArg',
						name: 'query_string',
						value: { kind: 'param', value: 'test' },
					},
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

describe('json_build_object pattern (FN-JSON-BUILD)', () => {
	it('compiles multi-arg fn() with literal keys and ref values', () => {
		// json_build_object('name', "name", 'kind', "kind")
		// literal() produces SQL string constant; ref() produces column reference
		const result = compileCustomExpr({
			kind: 'customFn',
			name: 'json_build_object',
			args: [
				{ kind: 'literal', value: 'name' },
				{ kind: 'ref', column: 'name' },
				{ kind: 'literal', value: 'kind' },
				{ kind: 'ref', column: 'kind' },
			],
		});
		expect(normalizeSQL(result.sql)).toBe(
			"select json_build_object('name', name, 'kind', kind) from items",
		);
		expect(result.parameters).toHaveLength(0);
	});

	it('compiles nested fn() — json_agg wrapping json_build_object', () => {
		// json_agg(json_build_object('name', "name"))
		const result = compileCustomExpr({
			kind: 'customFn',
			name: 'json_agg',
			args: [
				{
					kind: 'customFn',
					name: 'json_build_object',
					args: [
						{ kind: 'literal', value: 'name' },
						{ kind: 'ref', column: 'name' },
					],
				},
			],
		});
		expect(normalizeSQL(result.sql)).toBe(
			"select json_agg(json_build_object('name', name)) from items",
		);
		expect(result.parameters).toHaveLength(0);
	});

	it('compiles 6-arg json_build_object (3 key-value pairs)', () => {
		const result = compileCustomExpr({
			kind: 'customFn',
			name: 'json_build_object',
			args: [
				{ kind: 'literal', value: 'id' },
				{ kind: 'ref', column: 'id' },
				{ kind: 'literal', value: 'name' },
				{ kind: 'ref', column: 'name' },
				{ kind: 'literal', value: 'score' },
				{ kind: 'param', value: 42 },
			],
		});
		expect(normalizeSQL(result.sql)).toBe(
			"select json_build_object('id', id, 'name', name, 'score', $1) from items",
		);
		expect(result.parameters).toEqual([42]);
	});

	it('implicit string args become column refs (not string literals) — use literal() for keys', () => {
		// This documents the implicit conversion: bare string → ref (column reference)
		// If the user writes fn('json_build_object', 'name', ref('name')):
		//   'name' (string) → ref('name') → "name" column ref, NOT 'name' SQL literal
		const resultWithImplicitString = compileCustomExpr({
			kind: 'customFn',
			name: 'json_build_object',
			args: [
				{ kind: 'ref', column: 'name' }, // implicit string conversion produces this
				{ kind: 'ref', column: 'name' },
			],
		});
		// Both are column refs — this is WRONG for json_build_object keys
		expect(normalizeSQL(resultWithImplicitString.sql)).toBe(
			'select json_build_object(name, name) from items',
		);
		// Correct pattern: use literal() for string keys
		const resultWithLiteral = compileCustomExpr({
			kind: 'customFn',
			name: 'json_build_object',
			args: [
				{ kind: 'literal', value: 'name' }, // literal() keeps it as SQL string
				{ kind: 'ref', column: 'name' },
			],
		});
		expect(normalizeSQL(resultWithLiteral.sql)).toBe(
			"select json_build_object('name', name) from items",
		);
	});
});

// ============================================================================
// star() compiler tests
// ============================================================================

describe('star() expression', () => {
	it('compiles star() to unquoted *', () => {
		const result = compileCustomExpr({ kind: 'star' });
		expect(normalizeSQL(result.sql)).toBe('select * from items');
		expect(result.parameters).toHaveLength(0);
	});

	it('compiles COUNT(*) via fn + star', () => {
		const result = compileCustomExpr({
			kind: 'customFn',
			name: 'count',
			args: [{ kind: 'star' }],
		});
		expect(normalizeSQL(result.sql)).toBe('select count(*) from items');
		expect(result.parameters).toHaveLength(0);
	});

	it('compiles COUNT(*) with alias', () => {
		const result = compileCustomExpr(
			{ kind: 'customFn', name: 'count', args: [{ kind: 'star' }] },
			'total',
		);
		expect(normalizeSQL(result.sql)).toBe(
			'select count(*) as total from items',
		);
	});
});

// ============================================================================
// array() compiler tests
// ============================================================================

describe('array() expression', () => {
	it('compiles array() to ARRAY[...]', () => {
		const result = compileCustomExpr({
			kind: 'array',
			elements: [
				{ kind: 'literal', value: 1 },
				{ kind: 'literal', value: 2 },
			],
		});
		expect(normalizeSQL(result.sql)).toBe('select array[1, 2] from items');
		expect(result.parameters).toHaveLength(0);
	});

	it('compiles array() with params', () => {
		const result = compileCustomExpr({
			kind: 'array',
			elements: [
				{ kind: 'param', value: 'a' },
				{ kind: 'param', value: 'b' },
			],
		});
		expect(normalizeSQL(result.sql)).toBe('select array[$1, $2] from items');
		expect(result.parameters).toEqual(['a', 'b']);
	});

	it('compiles nested array in fn (unnest pattern)', () => {
		const result = compileCustomExpr({
			kind: 'customFn',
			name: 'unnest',
			args: [
				{
					kind: 'array',
					elements: [
						{ kind: 'literal', value: 1 },
						{ kind: 'literal', value: 2 },
					],
				},
			],
		});
		expect(normalizeSQL(result.sql)).toBe(
			'select unnest(array[1, 2]) from items',
		);
	});

	it('compiles empty array', () => {
		const result = compileCustomExpr({ kind: 'array', elements: [] });
		expect(normalizeSQL(result.sql)).toBe('select array[] from items');
	});
});
