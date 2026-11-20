/**
 * Gap 6: orm.selectExpression() — FROM-less SELECT compilation.
 *
 * Exercises:
 *   OrmInstance.selectExpression(expr: ExpressionSpec) →
 *   adapter.compileSelectExpression(intent: ExpressionIntent) →
 *   compileExpressionIntent + selectStmt + deparseQuoted → SQL
 */

import {
	array,
	arrayAgg,
	boolFn,
	cast,
	createOrm,
	exprRef,
	fn,
	literal,
	namedArg,
	op,
	param,
	ref,
	SubqueryExpression,
	schema,
	subquery,
	unary,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// Minimal schema for ORM integration tests (createOrm requires a schema)
const minimalSchema = schema({
	items: { id: { type: 'integer', primaryKey: true } },
} as const);

// ============================================================================
// PgAdapter.compileSelectExpression() — unit tests
// ============================================================================

describe('PgAdapter.compileSelectExpression()', () => {
	it('compiles nextval() to SELECT nextval(...)', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('nextval', literal('my_seq'));
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual("SELECT nextval('my_seq')");
		expect(parameters).toEqual([]);
	});

	it('compiles now() to SELECT now()', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('now');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT now()');
		expect(parameters).toEqual([]);
	});

	it('compiles parameterized expression: $1 + $2', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = op('+', param(1), param(2));
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT $1 + $2');
		expect(parameters).toEqual([1, 2]);
	});

	it('compiles literal integer: SELECT 42', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = literal(42);
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT 42');
		expect(parameters).toEqual([]);
	});

	it('compiles literal string: SELECT $1', () => {
		// literal('hello') is a SQL string literal — inlined as 'hello'
		const adapter = createPgCompileOnlyAdapter();
		const expr = literal('hello');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		// literal() produces inlined SQL — 'hello' not parameterized
		expect(sql.replace(/\s+/g, ' ').trim()).toEqual("SELECT 'hello'");
		expect(parameters).toEqual([]);
	});

	it('compiles nested function call: pg_catalog.version()', () => {
		const adapter = createPgCompileOnlyAdapter();
		const expr = fn('version');
		const { sql, parameters } = adapter.compileSelectExpression(expr.intent);

		expect(sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT version()');
		expect(parameters).toEqual([]);
	});
});

// ============================================================================
// orm.selectExpression() — ORM integration tests
// ============================================================================

describe('orm.selectExpression()', () => {
	it('accepts the caller model through a snake_case adapter boundary', () => {
		const adapter = createPgCompileOnlyAdapter({ dbCasing: 'snake_case' });

		expect(
			adapter.compileSelectExpression(fn('now').intent, {
				model: minimalSchema.model,
			}).sql,
		).toBe('SELECT now()');
	});

	it('returns { sql, parameters } for a scalar fn() expression', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(fn('nextval', literal('my_seq')));

		expect(result.sql.replace(/\s+/g, ' ').trim()).toEqual(
			"SELECT nextval('my_seq')",
		);
		expect(result.parameters).toEqual([]);
	});

	it('returns { sql, parameters } for a parameterized expression', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(op('+', param(10), param(20)));

		expect(result.sql.replace(/\s+/g, ' ').trim()).toEqual('SELECT $1 + $2');
		expect(result.parameters).toEqual([10, 20]);
	});

	it('exposes execute() method on the result object', () => {
		const adapter = createPgCompileOnlyAdapter();
		const orm = createOrm({ schema: minimalSchema, adapter });

		const result = orm.selectExpression(fn('now'));

		expect(typeof result.execute).toBe('function');
	});
});

// ============================================================================
// Expression-constructor leaves follow the reference rule (ADR 0011)
// ============================================================================

describe('expression-constructor leaves in the SELECT list (ADR 0011)', () => {
	const leafDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const orm = createOrm({
		schema: leafDb,
		adapter: createPgCompileOnlyAdapter({ model: leafDb.model }),
		suppressDxWarnings: true,
	});
	const posts = orm.tables.posts;
	const select = (expr: { as(alias: string): unknown }) =>
		orm
			.select('posts')
			.columns([expr.as('x') as never])
			.dump();

	it('AC1 fn-number: a number argument is inlined', () => {
		const dump = select(fn('round', exprRef('score'), 2));
		expect(dump.sql).toBe('SELECT round(score, 2) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1 fn-boolean: a boolean argument is inlined', () => {
		const dump = select(fn('f', exprRef('score'), true));
		expect(dump.sql).toBe('SELECT f(score, true) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1 op-number: a number operand is inlined', () => {
		const dump = select(op('+', exprRef('score'), 1));
		expect(dump.sql).toBe('SELECT score + 1 AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1 unary-number: a number operand is inlined', () => {
		const dump = select(unary('-', 5));
		expect(dump.sql).toBe('SELECT - 5 AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1 namedArg-number: a number value is inlined', () => {
		const dump = select(fn('f', namedArg('x', 5)));
		expect(dump.sql).toBe('SELECT f(x => 5) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1 array-numbers: number elements are inlined', () => {
		const dump = select(array(1, 2));
		expect(dump.sql).toBe('SELECT ARRAY[1, 2] AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1b bigint-select: 2n is inlined as 2 in the SELECT list', () => {
		const dump = select(fn('f', exprRef('score'), 2n));
		expect(dump.sql).toBe('SELECT f(score, 2) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC1b bigint-where: 2n is inlined in a resolved WHERE', () => {
		const dump = orm
			.select('posts')
			.where(fn('f', exprRef('score'), 2n).eq(1))
			.dump();
		expect(dump.sql).toBe(
			'SELECT posts.* FROM posts WHERE f(posts.score, 2) = $1',
		);
		expect(dump.params).toEqual([1]);
	});

	it('AC1b bigint-large: 2n ** 60n is bound', () => {
		const dump = select(fn('f', exprRef('score'), 2n ** 60n));
		expect(dump.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(dump.params).toEqual([1152921504606846976n]);
	});

	it('AC1c bigint-upper-bound: MAX_SAFE_INTEGER is inlined, one above is bound', () => {
		const inside = select(fn('f', exprRef('score'), 9007199254740991n));
		expect(inside.sql).toBe(
			'SELECT f(score, 9007199254740991) AS x FROM posts',
		);
		expect(inside.params).toEqual([]);
		const outside = select(fn('f', exprRef('score'), 9007199254740992n));
		expect(outside.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(outside.params).toEqual([9007199254740992n]);
	});

	it('AC1c bigint-lower-bound: MIN_SAFE_INTEGER is inlined, one below is bound', () => {
		const inside = select(fn('f', exprRef('score'), -9007199254740991n));
		expect(inside.sql).toBe(
			'SELECT f(score, -9007199254740991) AS x FROM posts',
		);
		expect(inside.params).toEqual([]);
		const outside = select(fn('f', exprRef('score'), -9007199254740992n));
		expect(outside.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(outside.params).toEqual([-9007199254740992n]);
	});

	it('AC1c infinities: Infinity and -Infinity are bound', () => {
		const positive = select(
			fn('f', exprRef('score'), Number.POSITIVE_INFINITY),
		);
		expect(positive.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(positive.params).toEqual([Number.POSITIVE_INFINITY]);
		const negative = select(
			fn('f', exprRef('score'), Number.NEGATIVE_INFINITY),
		);
		expect(negative.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(negative.params).toEqual([Number.NEGATIVE_INFINITY]);
	});

	it('AC1d param-expression-opaque: param(exprRef()) binds the same object', () => {
		const inner = exprRef('title');
		const dump = select(fn('f', param(inner)));
		expect(dump.sql).toBe('SELECT f($1) AS x FROM posts');
		expect(dump.params).toHaveLength(1);
		expect(dump.params[0]).toBe(inner);
	});

	it('AC1d param-object-opaque: param({ a: 1 }) is bound as is', () => {
		const dump = select(fn('f', param({ a: 1 })));
		expect(dump.sql).toBe('SELECT f($1) AS x FROM posts');
		expect(dump.params).toEqual([{ a: 1 }]);
	});

	it('AC2 nan-bound: NaN is bound', () => {
		const dump = select(fn('f', exprRef('score'), Number.NaN));
		expect(dump.sql).toBe('SELECT f(score, $1) AS x FROM posts');
		expect(dump.params).toEqual([Number.NaN]);
	});

	it('AC2 array-bound: an array operand is bound', () => {
		const dump = select(op('<=>', exprRef('score'), [0.1, 0.2]));
		expect(dump.sql).toBe('SELECT score <=> $1 AS x FROM posts');
		expect(dump.params).toEqual([[0.1, 0.2]]);
	});

	it('AC2 date-bound: a Date argument is bound', () => {
		const date = new Date(0);
		const dump = select(fn('age', date));
		expect(dump.sql).toBe('SELECT age($1) AS x FROM posts');
		expect(dump.params).toEqual([date]);
	});

	it('AC4 bare-subquery-expression: a bare SubqueryExpression compiles as a subquery', () => {
		const sqe = new SubqueryExpression({
			type: 'select',
			from: 'posts',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*' }],
			},
		});
		const dump = select(fn('abs', sqe));
		expect(dump.sql).toBe(
			'SELECT abs((SELECT count(*) FROM posts AS posts_1)) AS x FROM posts',
		);
		expect(dump.params).toEqual([]);
	});

	it('AC4 columnref: a table ColumnRef compiles as its qualified column', () => {
		const dump = select(fn('upper', posts.title));
		expect(dump.sql).toBe('SELECT upper(posts.title) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC4 schema-ref: a schema ref() compiles as a column reference', () => {
		const dump = select(fn('upper', ref('title')));
		expect(dump.sql).toBe('SELECT upper(title) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC4b arrayagg-new-leaves: arrayAgg() takes a ColumnRef and a number', () => {
		const column = select(arrayAgg(posts.title));
		expect(column.sql).toBe('SELECT array_agg(posts.title) AS x FROM posts');
		expect(column.params).toEqual([]);
		const constant = select(arrayAgg(1));
		expect(constant.sql).toBe('SELECT array_agg(1) AS x FROM posts');
		expect(constant.params).toEqual([]);
	});

	it("AC4b arrayagg-string-unchanged: arrayAgg('title') is a column", () => {
		const dump = select(arrayAgg('title'));
		expect(dump.sql).toBe('SELECT array_agg(title) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC4d boolfn-new-leaf: boolFn() takes a ColumnRef', () => {
		const dump = orm.select('posts').where(boolFn('f', posts.title)).dump();
		expect(dump.sql).toBe('SELECT posts.* FROM posts WHERE f(posts.title)');
		expect(dump.params).toEqual([]);
	});

	it('AC4c subquery-count: subquery().count() compiles as a subquery', () => {
		const dump = select(fn('abs', subquery('posts').count()));
		expect(dump.sql).toBe(
			'SELECT abs((SELECT count(*) FROM posts AS posts_1)) AS x FROM posts',
		);
		expect(dump.params).toEqual([]);
	});

	it("AC5 cast-string: cast('title', 'text') casts the column", () => {
		const dump = select(cast('title', 'text'));
		expect(dump.sql).toBe('SELECT CAST(title AS text) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});

	it('AC5 cast-exprref-unchanged: cast(exprRef()) is unchanged', () => {
		const dump = select(cast(exprRef('title'), 'text'));
		expect(dump.sql).toBe('SELECT CAST(title AS text) AS x FROM posts');
		expect(dump.params).toEqual([]);
	});
});
