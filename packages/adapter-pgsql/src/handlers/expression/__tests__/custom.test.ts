/**
 * Custom Expression Handler Tests
 *
 * Tests the compiled SQL of each expression kind through the public entries:
 * customOp, customFn, ref, param, cast, literal, unary, namedArg, star, array.
 * Every query goes through a model-carrying ORM (or adapter) and `.dump()`.
 */

import {
	array,
	cast,
	createOrm,
	exprRef,
	fn,
	literal,
	op,
	param,
	schema,
	star,
	unary,
} from '@dbsp/core';
import type { WhereComparisonIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../../../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Fixture: a model-carrying ORM over an items table
// ---------------------------------------------------------------------------

const db = schema({
	items: {
		id: { type: 'integer', primaryKey: true },
		price: 'integer',
		name: 'text',
		kind: 'text',
		total: 'integer',
		vector: { type: 'text', dbType: 'vector(2)' },
		geom: 'text',
		vec: { type: 'text', dbType: 'vector(2)' },
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter, suppressDxWarnings: true });

type Expr = ReturnType<typeof exprRef>;

/** Dump `SELECT <expr>[ AS <alias>] FROM items`. */
function dumpExpr(
	expr: Expr,
	alias?: string,
): { sql: string; params: readonly unknown[] } {
	const { sql, params } = orm
		.select('items')
		.columns([alias === undefined ? expr : expr.as(alias)])
		.dump();
	return { sql, params };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileExpressionIntent', () => {
	describe('literal kind', () => {
		it('compiles null literal', () => {
			expect(dumpExpr(literal(null))).toEqual({
				sql: 'SELECT NULL FROM items',
				params: [],
			});
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
			// Emitted as a SQL constant with the quote doubled, not as a bound parameter.
			expect(dumpExpr(literal(injectionAttempt))).toEqual({
				sql: "SELECT 'a''); DROP TABLE users; --' FROM items",
				params: [],
			});
		});
	});

	describe('cast kind', () => {
		it('compiles a cast expression', () => {
			expect(dumpExpr(cast(param([0.1, 0.2]), 'vector'))).toEqual({
				sql: 'SELECT CAST($1 AS vector) FROM items',
				params: [[0.1, 0.2]],
			});
		});
	});

	describe('customOp kind', () => {
		it('escapes a newline in a rejected custom operator', () => {
			// op() refuses the newline in core; only a raw intent reaches the
			// adapter's own guard, through the public compileSelectExpression().
			expect(() =>
				adapter.compileSelectExpression({
					kind: 'customOp',
					operator: 'invalid\nFAKE',
					left: { kind: 'ref', column: 'a' },
					right: { kind: 'param', value: 1 },
				}),
			).toThrow(
				new Error(
					'Invalid operator "invalid\\nFAKE". Operator must consist only of symbolic characters (e.g. <=>, <->, @@, @>, <@, &&, ||, ~).',
				),
			);
		});

		it('compiles a binary custom operator', () => {
			expect(
				dumpExpr(
					op('<=>', exprRef('vector'), cast(param([0.1, 0.2]), 'vector')),
				),
			).toEqual({
				sql: 'SELECT vector <=> CAST($1 AS vector) FROM items',
				params: [[0.1, 0.2]],
			});
		});

		it('compiles nested binary operators (1 - (col <=> cast($1 as vector)))', () => {
			expect(
				dumpExpr(
					op(
						'-',
						literal(1),
						op('<=>', exprRef('vector'), cast(param([0.1]), 'vector')),
					),
					'score',
				),
			).toEqual({
				sql: 'SELECT 1 - (vector <=> CAST($1 AS vector)) AS score FROM items',
				params: [[0.1]],
			});
		});

		it('compiles col-vs-col with no params', () => {
			const selfJoinOn: WhereComparisonIntent = {
				kind: 'comparison',
				field: 'items.id',
				operator: 'lt',
				value: { kind: 'fieldRef', column: 'id', scope: 'outer' },
			};
			const { sql, params } = orm
				.select('items')
				.join('items', { on: selfJoinOn, as: 'e2', type: 'inner' })
				.columns([op('<=>', exprRef('items.vector'), exprRef('e2.vector'))])
				.dump();
			expect({ sql, params }).toEqual({
				sql: 'SELECT items.vector <=> e2.vector FROM items JOIN items AS e2 ON items.id < e2.id',
				params: [],
			});
		});
	});

	describe('customFn kind', () => {
		it('compiles a schema-qualified function call', () => {
			expect(dumpExpr(fn('paradedb.score'))).toEqual({
				sql: 'SELECT paradedb.score() FROM items',
				params: [],
			});
		});

		it('preserves intentionally-cased builder custom function names', () => {
			expect(dumpExpr(fn('ST_DWithin', exprRef('geom')))).toEqual({
				sql: 'SELECT "ST_DWithin"(geom) FROM items',
				params: [],
			});
		});
	});

	describe('unary kind', () => {
		it('compiles a unary minus', () => {
			expect(dumpExpr(unary('-', exprRef('price')))).toEqual({
				sql: 'SELECT - price FROM items',
				params: [],
			});
		});
	});
});

describe('json_build_object pattern (FN-JSON-BUILD)', () => {
	it('compiles multi-arg fn() with literal keys and ref values', () => {
		// json_build_object('name', "name", 'kind', "kind")
		// literal() produces SQL string constant; ref() produces column reference
		expect(
			dumpExpr(
				fn(
					'json_build_object',
					literal('name'),
					exprRef('name'),
					literal('kind'),
					exprRef('kind'),
				),
			),
		).toEqual({
			sql: "SELECT json_build_object('name', name, 'kind', kind) FROM items",
			params: [],
		});
	});

	it('compiles nested fn() — json_agg wrapping json_build_object', () => {
		// json_agg(json_build_object('name', "name"))
		expect(
			dumpExpr(
				fn(
					'json_agg',
					fn('json_build_object', literal('name'), exprRef('name')),
				),
			),
		).toEqual({
			sql: "SELECT json_agg(json_build_object('name', name)) FROM items",
			params: [],
		});
	});

	it('compiles 6-arg json_build_object (3 key-value pairs)', () => {
		expect(
			dumpExpr(
				fn(
					'json_build_object',
					literal('id'),
					exprRef('id'),
					literal('name'),
					exprRef('name'),
					literal('score'),
					param(42),
				),
			),
		).toEqual({
			sql: "SELECT json_build_object('id', id, 'name', name, 'score', $1) FROM items",
			params: [42],
		});
	});

	it('implicit string args become column refs (not string literals) — use literal() for keys', () => {
		// This documents the implicit conversion: bare string → ref (column reference)
		// If the user writes fn('json_build_object', 'name', ref('name')):
		//   'name' (string) → ref('name') → "name" column ref, NOT 'name' SQL literal
		const resultWithImplicitString = dumpExpr(
			fn('json_build_object', 'name', exprRef('name')),
		);
		// Both are column refs — this is WRONG for json_build_object keys
		expect(resultWithImplicitString).toEqual({
			sql: 'SELECT json_build_object(name, name) FROM items',
			params: [],
		});
		// Correct pattern: use literal() for string keys
		const resultWithLiteral = dumpExpr(
			fn('json_build_object', literal('name'), exprRef('name')),
		);
		expect(resultWithLiteral).toEqual({
			sql: "SELECT json_build_object('name', name) FROM items",
			params: [],
		});
	});
});

// ============================================================================
// star() compiler tests
// ============================================================================

describe('star() expression', () => {
	it('compiles star() to unquoted *', () => {
		const { sql, params } = orm.select('items').columns([star()]).dump();
		expect({ sql, params }).toEqual({ sql: 'SELECT * FROM items', params: [] });
	});
});

// ============================================================================
// array() compiler tests
// ============================================================================

describe('array() expression', () => {
	it('compiles array() with params', () => {
		expect(dumpExpr(array(param('a'), param('b')))).toEqual({
			sql: 'SELECT ARRAY[$1, $2] FROM items',
			params: ['a', 'b'],
		});
	});

	it('compiles nested array in fn (unnest pattern)', () => {
		expect(dumpExpr(fn('unnest', array(literal(1), literal(2))))).toEqual({
			sql: 'SELECT unnest(ARRAY[1, 2]) FROM items',
			params: [],
		});
	});
});
