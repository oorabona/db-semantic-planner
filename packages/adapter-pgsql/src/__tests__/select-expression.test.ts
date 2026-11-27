/**
 * Gap 6: orm.selectExpression() — FROM-less SELECT compilation.
 *
 * Exercises:
 *   OrmInstance.selectExpression(expr: ExpressionSpec) →
 *   adapter.compileSelectExpression(intent: ExpressionIntent) →
 *   compileExpressionIntent + selectStmt + deparseQuoted → SQL
 */

import {
	any,
	array,
	arrayAgg,
	boolFn,
	caseWhen,
	cast,
	createOrm,
	distinct,
	ExpressionRef,
	eq,
	exprRef,
	fn,
	gt,
	gte,
	inArray,
	inSubquery,
	isDistinctFrom,
	isNull,
	lag,
	lead,
	like,
	literal,
	NotYetSupportedError,
	namedArg,
	op,
	outerRef,
	param,
	rawExists,
	ref,
	rowNumber,
	SubqueryExpression,
	schema,
	sql,
	subquery,
	unary,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from '@dbsp/core';
import { rawNotExists } from '@dbsp/core/internal';
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

// ============================================================================
// Filter operands follow the leaf rule (ADR 0011, delivery 2)
// ============================================================================

describe('filter operands and object filters (ADR 0011 delivery 2)', () => {
	const filterDb = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			kind: 'text',
			data: 'jsonb',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const orm = createOrm({
		schema: filterDb,
		adapter: createPgCompileOnlyAdapter({ model: filterDb.model }),
		suppressDxWarnings: true,
	});
	const posts = orm.tables.posts;
	const users = orm.tables.users;
	const where = (condition: any) =>
		orm.select('posts').columns(['id']).where(condition).dump();
	const having = (condition: any) =>
		orm
			.select('posts')
			.columns(['id'])
			.groupBy(['id', 'score'])
			.having(condition)
			.dump();
	const inCase = (condition: any) =>
		orm
			.select('posts')
			.columns([caseWhen(condition, literal('y')).else(literal('n')).as('r')])
			.dump();
	const sqlOf = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];

	it('AC1 having subquery left: a SubqueryExpression left operand compiles in HAVING (#1033)', () => {
		const dump = orm
			.select('posts')
			.columns(['id'])
			.groupBy(['id'])
			.having(gt(subquery('posts').count(), 1))
			.dump();
		expect(sqlOf(dump)).toEqual([
			'SELECT posts.id FROM posts GROUP BY posts.id HAVING (SELECT count(*) FROM posts AS posts_1) > $1',
			[1],
		]);
	});

	it('AC1 fn left: an expression left operand is compared as an expression', () => {
		expect(sqlOf(where(eq(fn('upper', exprRef('title')), 'X')))).toEqual([
			'SELECT posts.id FROM posts WHERE upper(posts.title) = $1',
			['X'],
		]);
	});

	it('AC1 asExpr left: a scalar-subquery spec is a left operand', () => {
		expect(sqlOf(where(gt(subquery('posts').count().asExpr('n'), 1)))).toEqual([
			'SELECT posts.id FROM posts WHERE (SELECT count(*) FROM posts AS posts_1) > $1',
			[1],
		]);
	});

	it('AC1 number left: a number left operand is an inlined constant', () => {
		expect(sqlOf(where(eq(5, 1)))).toEqual([
			'SELECT posts.id FROM posts WHERE 5 = $1',
			[1],
		]);
	});

	it('AC1b string and ColumnRef left: the column path is unchanged', () => {
		expect(sqlOf(where(eq('title', 1)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = $1',
			[1],
		]);
		expect(sqlOf(where(eq(posts.title, 'x')))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = $1',
			['x'],
		]);
		expect(sqlOf(where(eq(users.name, 1 as never)))).toEqual([
			'SELECT posts.id FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.user_id = users_exists_0.id AND users_exists_0.name = $1)',
			[1],
		]);
	});

	it('AC1c expression left null: eq and isDistinctFrom normalise null; gt refuses it', () => {
		const upper = () => fn('upper', exprRef('title'));
		expect(sqlOf(where(eq(upper(), null)))).toEqual([
			'SELECT posts.id FROM posts WHERE upper(posts.title) IS NULL',
			[],
		]);
		expect(sqlOf(where(isDistinctFrom(upper(), null)))).toEqual([
			'SELECT posts.id FROM posts WHERE upper(posts.title) IS DISTINCT FROM NULL',
			[],
		]);
		expect(() => where(gt(upper(), null))).toThrow(
			'Operator > cannot compare with literal null; use isNull/isNotNull',
		);
	});

	it.each([
		['eq', '='],
		['neq', '<>'],
		['gt', '>'],
		['gte', '>='],
		['lt', '<'],
		['lte', '<='],
	] as const)(
		'AC2x six ExpressionRef methods SQL: %s inlines a ColumnRef value',
		(method, sqlOp) => {
			expect(sqlOf(where(exprRef('score')[method](posts.id)))).toEqual([
				`SELECT posts.id FROM posts WHERE posts.score ${sqlOp} posts.id`,
				[],
			]);
		},
	);

	it('AC2 ColumnRef right: eq and the object filter inline the column', () => {
		expect(sqlOf(where(eq('title', posts.title)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = posts.title',
			[],
		]);
		expect(sqlOf(where({ title: posts.title }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = posts.title',
			[],
		]);
		expect(sqlOf(where(exprRef('score').eq(posts.id)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.score = posts.id',
			[],
		]);
	});

	it('AC2b ColumnRef other table: a table the query cannot see is refused by the planner', () => {
		expect(() => where(eq('title', users.name))).toThrow(
			"WHERE qualifier 'users' is not visible in this query.",
		);
		expect(() => having(exprRef('id').eq(ref('users.id')))).toThrow(
			"HAVING qualifier 'users' is not visible in this query.",
		);
	});

	it('AC2b ColumnRef same-table body: it names the body row, as exprRef does', () => {
		const viaColumnRef = orm
			.select('users')
			.columns(['id'])
			.where(
				gt('id', subquery('posts').where(eq('title', posts.title)).count()),
			)
			.dump();
		const viaExprRef = orm
			.select('users')
			.columns(['id'])
			.where(
				gt(
					'id',
					subquery('posts')
						.where(eq('title', exprRef('posts.title')))
						.count(),
				),
			)
			.dump();
		expect(sqlOf(viaColumnRef)).toEqual([
			'SELECT users.id FROM users WHERE users.id > (SELECT count(*) FROM posts WHERE posts.title = posts.title)',
			[],
		]);
		expect(sqlOf(viaColumnRef)).toEqual(sqlOf(viaExprRef));
	});

	it('AC2h expression vs expression having: the right operand is inlined in HAVING', () => {
		expect(sqlOf(having(exprRef('score').gt(posts.id)))).toEqual([
			'SELECT posts.id FROM posts GROUP BY posts.id, posts.score HAVING posts.score > posts.id',
			[],
		]);
		expect(
			sqlOf(having(gt(fn('abs', exprRef('score')), subquery('posts').count()))),
		).toEqual([
			'SELECT posts.id FROM posts GROUP BY posts.id, posts.score HAVING abs(posts.score) > (SELECT count(*) FROM posts AS posts_1)',
			[],
		]);
	});

	it('AC2h expression vs expression case: the right operand is inlined in CASE WHEN', () => {
		expect(sqlOf(inCase(exprRef('score').gt(posts.id)))).toEqual([
			"SELECT CASE WHEN posts.score > posts.id THEN 'y' ELSE 'n' END AS r FROM posts",
			[],
		]);
		expect(
			sqlOf(inCase(gt(fn('abs', exprRef('score')), subquery('posts').count()))),
		).toEqual([
			"SELECT CASE WHEN abs(posts.score) > (SELECT count(*) FROM posts AS posts_1) THEN 'y' ELSE 'n' END AS r FROM posts",
			[],
		]);
	});

	it('AC2h schema ref right of expression: ref() is the target column in HAVING', () => {
		expect(sqlOf(having(exprRef('score').gt(ref('posts.id'))))).toEqual([
			'SELECT posts.id FROM posts GROUP BY posts.id, posts.score HAVING posts.score > posts.id',
			[],
		]);
	});

	it('AC2h outerRef right of expression: a projected subquery over a CTE keeps its correlation', () => {
		const dump = orm
			.withCte('chain')
			.fromUnnest({ id: [1, 2] })
			.query(
				orm.select('posts').columns([
					'id',
					subquery('chain')
						.where(exprRef('id').eq(outerRef('id')))
						.count()
						.asExpr('n'),
				]),
			)
			.dump();
		expect(sqlOf(dump)).toEqual([
			'WITH chain AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT posts.id, (SELECT count(*) FROM chain AS chain WHERE id = posts.id) AS n FROM posts',
			[[1, 2]],
		]);
	});

	it('AC3 SubqueryExpression right: comparisons compile a scalar subquery', () => {
		expect(sqlOf(where(gt('score', subquery('posts').count())))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.score > (SELECT count(*) FROM posts AS posts_1)',
			[],
		]);
		expect(
			sqlOf(where(exprRef('score').eq(subquery('posts').count()))),
		).toEqual([
			'SELECT posts.id FROM posts WHERE posts.score = (SELECT count(*) FROM posts AS posts_1)',
			[],
		]);
	});

	it('AC4b SubqueryExpression count in $gt: an object-filter operator compiles as gt() (ADR 0011 delivery 5)', () => {
		expect(sqlOf(where({ score: { $gt: subquery('posts').count() } }))).toEqual(
			[
				'SELECT posts.id FROM posts WHERE posts.score > (SELECT count(*) FROM posts AS posts_1)',
				[],
			],
		);
	});

	it('AC4b SubqueryExpression select in $gte: an object-filter operator compiles as gte() (ADR 0011 delivery 5)', () => {
		expect(
			sqlOf(
				where({
					score: { $gte: subquery('posts').select('score').build() },
				}),
			),
		).toEqual([
			'SELECT posts.id FROM posts WHERE posts.score >= (SELECT posts_1.score FROM posts AS posts_1)',
			[],
		]);
	});

	it('AC4 unchanged value leaves: plain values, markers and null keep their meaning', () => {
		expect(sqlOf(where(eq('title', 'title')))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = $1',
			['title'],
		]);
		expect(sqlOf(where(eq('title', { a: 1 })))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = $1',
			[{ a: 1 }],
		]);
		expect(sqlOf(where(eq('title', exprRef('title'))))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = posts.title',
			[],
		]);
		expect(sqlOf(where(eq('title', param('x'))))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = $1',
			['x'],
		]);
		expect(sqlOf(where(eq('title', literal(5))))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = 5',
			[],
		]);
		expect(
			sqlOf(where(eq('title', subquery('posts').count().asExpr('n')))),
		).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = (SELECT count(*) FROM posts AS posts_1)',
			[],
		]);
		expect(sqlOf(where(eq('title', ref('posts.title'))))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title = posts.title',
			[],
		]);
		expect(sqlOf(where(eq('title', null)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title IS NULL',
			[],
		]);
		expect(() => where(eq('title', undefined))).toThrow(
			'Right comparison operand is undefined; use isNull or param(...)',
		);
		expect(sqlOf(where({ score: { $gte: undefined, $lte: 10 } }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.score <= $1',
			[10],
		]);
		expect(sqlOf(where(eq('id', 5n)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = $1',
			[5n],
		]);
		const day = new Date('2024-01-01');
		const byDate = where(eq('title', day));
		expect(byDate.sql).toBe(
			'SELECT posts.id FROM posts WHERE posts.title = $1',
		);
		expect(byDate.params[0]).toBe(day);
		expect(sqlOf(where(eq('data', [1, 2])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.data = $1',
			[[1, 2]],
		]);
		expect(sqlOf(where({ data: [1, 2] }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.data = $1',
			[[1, 2]],
		]);
		// A JSON value shaped like a subquery is data: only a genuine
		// SubqueryExpression carries the brand.
		expect(sqlOf(where(eq('data', { _type: 'subquery' })))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.data = $1',
			[{ _type: 'subquery' }],
		]);
	});

	it('AC5b param opaque comparison: param() content is bound as given', () => {
		const inner = exprRef('title');
		const dump = where(eq('title', param(inner)));
		expect(dump.sql).toBe('SELECT posts.id FROM posts WHERE posts.title = $1');
		expect(dump.params[0]).toBe(inner);
	});

	it('AC5b param opaque lists: inArray and any bind param() content as the element', () => {
		const inner = exprRef('title');
		const viaIn = where(inArray('id', [param(inner)]));
		expect(viaIn.sql).toBe(
			'SELECT posts.id FROM posts WHERE posts.id = ANY ($1)',
		);
		expect((viaIn.params[0] as unknown[])[0]).toBe(inner);
		const viaAny = where(any('id', [param(inner)]));
		expect(viaAny.sql).toBe(
			'SELECT posts.id FROM posts WHERE posts.id = ANY (CAST($1 AS int4[]))',
		);
		expect((viaAny.params[0] as unknown[])[0]).toBe(inner);
	});

	it('AC5 like plain patterns: strings, param() and escape keep binding', () => {
		expect(sqlOf(where(like('title', 'a%')))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title LIKE $1',
			['a%'],
		]);
		expect(sqlOf(where(like('title', param('x') as never)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title LIKE $1',
			['x'],
		]);
		expect(sqlOf(where(like('title', param(null) as never)))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title LIKE $1',
			[null],
		]);
		expect(sqlOf(where(like('title', 'a\\%', { escape: '\\' })))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title LIKE $1 ESCAPE $2',
			['a\\%', '\\'],
		]);
		expect(sqlOf(where({ title: { $like: 'a%' } }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.title LIKE $1',
			['a%'],
		]);
		expect(() => where(like('title', null as never))).toThrow(
			'Operator like cannot compare with literal null; use isNull/isNotNull',
		);
	});

	it('AC6 any param root: param() elements bind their values in a root WHERE (#1011)', () => {
		expect(sqlOf(where(any('id', [param(1), param(2)])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		]);
	});

	it('AC6 any param having: param() elements bind their values in HAVING', () => {
		expect(sqlOf(having(any('id', [param(1), param(2)])))).toEqual([
			'SELECT posts.id FROM posts GROUP BY posts.id, posts.score HAVING posts.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		]);
	});

	it('AC6 any param case: param() elements bind their values in CASE WHEN', () => {
		expect(sqlOf(inCase(any('id', [param(1), param(2)])))).toEqual([
			"SELECT CASE WHEN posts.id = ANY (CAST($1 AS int4[])) THEN 'y' ELSE 'n' END AS r FROM posts",
			[[1, 2]],
		]);
	});

	it('AC6 any param mutations: update and delete bind the values', () => {
		const update = orm
			.update('posts')
			.set({ score: 1 })
			.where(any('id', [param(1), param(2)]))
			.dump();
		expect([update.sql, update.parameters]).toEqual([
			'UPDATE posts SET score = $1 WHERE posts.id = ANY (CAST($2 AS int4[]))',
			[1, [1, 2]],
		]);
		const remove = orm
			.delete('posts')
			.where(any('id', [param(1), param(2)]))
			.dump();
		expect([remove.sql, remove.parameters]).toEqual([
			'DELETE FROM posts WHERE posts.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		]);
	});

	it('AC6 any plain and JSON object: plain elements and param-shaped data stay as given', () => {
		expect(sqlOf(where(any('id', [1, 2])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		]);
		expect(sqlOf(where(any('data', [{ kind: 'param', value: 'x' }])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.data = ANY (CAST($1 AS jsonb[]))',
			[[{ kind: 'param', value: 'x' }]],
		]);
	});

	it('AC7 inArray and $in elements: param() elements, null and plain lists are unchanged', () => {
		expect(sqlOf(where(inArray('id', [param(1), 2])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = ANY ($1)',
			[[1, 2]],
		]);
		expect(sqlOf(where(inArray('id', [null])))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = ANY ($1)',
			[[null]],
		]);
		expect(sqlOf(where({ id: { $in: [1, 2] } }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.id = ANY ($1)',
			[[1, 2]],
		]);
	});

	it('AC8 kind column filtered: an object filter over a column named kind filters it (#624)', () => {
		expect(sqlOf(where({ kind: 'function' }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.kind = $1',
			['function'],
		]);
		expect(sqlOf(where({ kind: 'comparison' }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.kind = $1',
			['comparison'],
		]);
		expect(sqlOf(where({ kind: 'function', title: 'x' }))).toEqual([
			'SELECT posts.id FROM posts WHERE posts.kind = $1 AND posts.title = $2',
			['function', 'x'],
		]);
	});
});

describe('correlated subquery on the right of a comparison (ADR 0011 delivery 2)', () => {
	const productDb = schema({
		categories: { id: { type: 'integer', primaryKey: true } },
		products: {
			id: { type: 'integer', primaryKey: true },
			categoryId: ref('categories', { as: 'category' }),
			price: 'decimal',
		},
	});
	const orm = createOrm({
		schema: productDb,
		adapter: createPgCompileOnlyAdapter({ model: productDb.model }),
		suppressDxWarnings: true,
	});
	const average = () =>
		subquery('products')
			.where(eq('categoryId', outerRef('categoryId')))
			.avg('price');

	it('AC3c correlated subquery read: gt compiles the correlated body in a SELECT', () => {
		const dump = orm.select('products').where(gt('price', average())).dump();
		expect([dump.sql, dump.params]).toEqual([
			'SELECT products.* FROM products WHERE products.price > (SELECT avg(products_1.price) FROM products AS products_1 WHERE products_1."categoryId" = products."categoryId")',
			[],
		]);
	});

	it('AC3c correlated subquery update: gt compiles the correlated body in an UPDATE', () => {
		const dump = orm
			.update('products')
			.set({ price: 1 })
			.where(gt('price', average()))
			.dump();
		expect([dump.sql, dump.parameters]).toEqual([
			'UPDATE products SET price = $1 WHERE products.price > (SELECT avg(products_1.price) FROM products AS products_1 WHERE products_1."categoryId" = products."categoryId")',
			[1],
		]);
	});
});

// ============================================================================
// orderBy, columns, groupBy, distinctOn, aggregates and windows (ADR 0011, delivery 3)
// ============================================================================

describe('ordering, grouping, aggregate and window leaves (ADR 0011 delivery 3)', () => {
	const d3Db = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			status: 'text',
			score: 'integer',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const orm = createOrm({
		schema: d3Db,
		adapter: createPgCompileOnlyAdapter({ model: d3Db.model }),
		suppressDxWarnings: true,
	});
	const posts = orm.tables.posts;
	const users = orm.tables.users;
	const q = () => orm.select('posts');
	const sqlOf = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];

	it('AC1 orderBy SubqueryExpression: a subquery orders rows (#1032)', () => {
		expect(
			sqlOf(
				q().columns(['id']).orderBy(subquery('posts').count(), 'desc').dump(),
			),
		).toEqual([
			'SELECT posts.id FROM posts ORDER BY (SELECT count(*) FROM posts AS posts_1) DESC',
			[],
		]);
	});

	it('AC2 orderBy ColumnRef: single, list and relation forms order by the qualified column', () => {
		expect(
			sqlOf(q().columns(['id']).orderBy(posts.title, 'desc').dump()),
		).toEqual(['SELECT posts.id FROM posts ORDER BY posts.title DESC', []]);
		expect(
			sqlOf(
				q()
					.columns(['id'])
					.orderBy([{ column: posts.score, direction: 'desc' }])
					.dump(),
			),
		).toEqual(['SELECT posts.id FROM posts ORDER BY posts.score DESC', []]);
		expect(
			sqlOf(
				q().join('author').columns(['id']).orderBy(posts.author.name).dump(),
			),
		).toEqual([
			'SELECT posts.id FROM posts JOIN users AS author ON posts.user_id = author.id ORDER BY author.name ASC',
			[],
		]);
	});

	it('AC2 orderBy ColumnRef with homonymous alias: the qualified column wins over the projection alias', () => {
		expect(
			sqlOf(
				q()
					.columns([exprRef('posts.score').as('id')])
					.orderBy(posts.id)
					.dump(),
			),
		).toEqual([
			'SELECT posts.score AS id FROM posts ORDER BY posts.id ASC',
			[],
		]);
	});

	it('AC3 orderBy number: a positive integer is an output-column position', () => {
		expect(sqlOf(q().columns(['id']).orderBy(2).dump())).toEqual([
			'SELECT posts.id FROM posts ORDER BY 2 ASC',
			[],
		]);
	});

	it('AC3 orderBy expression spec column: the list form keeps direction and nulls', () => {
		expect(
			sqlOf(
				q()
					.columns(['id'])
					.orderBy([
						{
							column: fn('lower', exprRef('title')),
							direction: 'desc',
							nulls: 'last',
						},
					])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id FROM posts ORDER BY lower(title) DESC NULLS LAST',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id'])
					.orderBy([{ column: fn('lower', exprRef('title')) }])
					.dump(),
			),
		).toEqual(['SELECT posts.id FROM posts ORDER BY lower(title) ASC', []]);
	});

	it('AC4 orderBy unchanged forms: strings, records and expressions keep their SQL', () => {
		expect(sqlOf(q().columns(['id']).orderBy('title').dump())).toEqual([
			'SELECT posts.id FROM posts ORDER BY posts.title ASC',
			[],
		]);
		expect(sqlOf(q().columns(['id']).orderBy('posts.title').dump())).toEqual([
			'SELECT posts.id FROM posts ORDER BY posts.title ASC',
			[],
		]);
		expect(
			sqlOf(q().columns(['id']).orderBy({ score: 'desc' }).dump()),
		).toEqual(['SELECT posts.id FROM posts ORDER BY posts.score DESC', []]);
		expect(sqlOf(q().columns(['id']).orderBy(exprRef('title')).dump())).toEqual(
			['SELECT posts.id FROM posts ORDER BY title ASC', []],
		);
		expect(sqlOf(q().columns(['id']).orderBy(param(1)).dump())).toEqual([
			'SELECT posts.id FROM posts ORDER BY $1 ASC',
			[1],
		]);
		expect(sqlOf(q().columns(['id']).orderBy(literal(1)).dump())).toEqual([
			'SELECT posts.id FROM posts ORDER BY 1 ASC',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id'])
					.orderBy(caseWhen(eq('score', 1), literal('a')).else(literal('b')))
					.dump(),
			),
		).toEqual([
			"SELECT posts.id FROM posts ORDER BY CASE WHEN posts.score = $1 THEN 'a' ELSE 'b' END ASC",
			[1],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id'])
					.orderBy(subquery('posts').count().asExpr('n'))
					.dump(),
			),
		).toEqual([
			'SELECT posts.id FROM posts ORDER BY (SELECT count(*) FROM posts AS posts_1) ASC',
			[],
		]);
	});

	it('AC5 columns own-table ColumnRef: a field column', () => {
		expect(sqlOf(q().columns(['id', posts.title]).dump())).toEqual([
			'SELECT posts.id, posts.title FROM posts',
			[],
		]);
		// An ExpressionRef stays an expression column, whatever its intent kind.
		const titleRef = new ExpressionRef({ kind: 'column', column: 'title' });
		expect(
			sqlOf(
				q()
					.columns([titleRef.as('t')])
					.dump(),
			),
		).toEqual(['SELECT posts.title AS t FROM posts', []]);
		expect(() =>
			q().columns([titleRef]).groupBy(['title']).count().dump(),
		).toThrow(/combine only with string columns\(\)/);
	});

	it('AC5 columns other-table ColumnRef: an expression column on a joined table', () => {
		expect(
			sqlOf(
				q()
					.join('users', { on: eq('user_id', exprRef('users.id')) })
					.columns(['id', users.name])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, users.name FROM posts JOIN users AS users ON posts.user_id = users.id',
			[],
		]);
	});

	it('AC5b aliased ColumnRef column: the alias names the column', () => {
		expect(
			sqlOf(
				q()
					.columns(['title', posts.id.as('post_id')])
					.dump(),
			),
		).toEqual(['SELECT posts.title, posts.id AS post_id FROM posts', []]);
	});

	it('AC5c own-table ColumnRef column with aggregate: stays a field column', () => {
		expect(
			sqlOf(q().columns([posts.status]).groupBy(['status']).count().dump()),
		).toEqual([
			'SELECT posts.status, count(*) FROM posts GROUP BY posts.status',
			[],
		]);
	});

	it('AC5d RefDefinition in orderBy and columns: the target column', () => {
		expect(
			sqlOf(q().columns(['id']).orderBy(ref('posts.title')).dump()),
		).toEqual(['SELECT posts.id FROM posts ORDER BY posts.title ASC', []]);
		expect(
			sqlOf(
				q()
					.columns(['id', ref('posts.title')])
					.dump(),
			),
		).toEqual(['SELECT posts.id, posts.title FROM posts', []]);
	});

	it('AC6 groupBy ColumnRef: with and without an aggregate selection', () => {
		expect(
			sqlOf(q().columns(['status']).groupBy([posts.status]).dump()),
		).toEqual(['SELECT posts.status FROM posts GROUP BY posts.status', []]);
		expect(sqlOf(q().groupBy([posts.status]).count('id', 'n').dump())).toEqual([
			'SELECT posts.status, count(posts.id) AS n FROM posts GROUP BY posts.status',
			[],
		]);
	});

	it('AC6 distinctOn ColumnRef qualified: deduplicates on the column, not a homonymous alias', () => {
		expect(
			sqlOf(
				q().columns(['id']).distinctOn(posts.status).orderBy('status').dump(),
			),
		).toEqual([
			'SELECT DISTINCT ON (posts.status) posts.id FROM posts ORDER BY posts.status ASC',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', posts.score.as('status')])
					.distinctOn(posts.status)
					.orderBy(posts.status)
					.dump(),
			),
		).toEqual([
			'SELECT DISTINCT ON (posts.status) posts.id, posts.score AS status FROM posts ORDER BY posts.status ASC',
			[],
		]);
	});

	it('AC6 groupBy relation ColumnRef after join: the join alias', () => {
		expect(
			sqlOf(
				q()
					.join('author')
					.columns(['status'])
					.groupBy([posts.author.name])
					.dump(),
			),
		).toEqual([
			'SELECT posts.status FROM posts JOIN users AS author ON posts.user_id = author.id GROUP BY author.name',
			[],
		]);
	});

	it('AC7 aggregate ColumnRef fields: count, options, sum, avg, min, max', () => {
		expect(sqlOf(q().count(posts.score, 'n').dump())).toEqual([
			'SELECT count(posts.score) AS n FROM posts',
			[],
		]);
		expect(sqlOf(q().count({ field: posts.score, as: 'n' }).dump())).toEqual([
			'SELECT count(posts.score) AS n FROM posts',
			[],
		]);
		expect(sqlOf(q().sum(posts.score).dump())).toEqual([
			'SELECT sum(posts.score) FROM posts',
			[],
		]);
		expect(sqlOf(q().avg(posts.score).dump())).toEqual([
			'SELECT avg(posts.score) FROM posts',
			[],
		]);
		expect(sqlOf(q().min(posts.score).dump())).toEqual([
			'SELECT min(posts.score) FROM posts',
			[],
		]);
		expect(sqlOf(q().max(posts.score).dump())).toEqual([
			'SELECT max(posts.score) FROM posts',
			[],
		]);
	});

	it('AC7 count distinct ColumnRef and fn distinct ColumnRef', () => {
		expect(sqlOf(q().count(distinct(posts.status)).dump())).toEqual([
			'SELECT count(DISTINCT posts.status) FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns([fn('count', distinct(posts.status)).as('n')])
					.dump(),
			),
		).toEqual(['SELECT count(DISTINCT posts.status) AS n FROM posts', []]);
	});

	it('AC7 count unchanged forms', () => {
		expect(sqlOf(q().count().dump())).toEqual([
			'SELECT count(*) FROM posts',
			[],
		]);
		expect(sqlOf(q().count({ as: 'n' }).dump())).toEqual([
			'SELECT count(*) AS n FROM posts',
			[],
		]);
		expect(sqlOf(q().count({ field: 'score', as: 'n' }).dump())).toEqual([
			'SELECT count(posts.score) AS n FROM posts',
			[],
		]);
	});

	it('AC7b empty lists and records stay a no-op', () => {
		expect(sqlOf(q().columns(['id']).orderBy([]).dump())).toEqual([
			'SELECT posts.id FROM posts',
			[],
		]);
		expect(sqlOf(q().columns(['id']).orderBy({}).dump())).toEqual([
			'SELECT posts.id FROM posts',
			[],
		]);
		expect(sqlOf(q().columns(['id']).groupBy([]).dump())).toEqual([
			'SELECT posts.id FROM posts',
			[],
		]);
	});

	it('AC8b alias ignored and DISTINCT kept in column-name positions', () => {
		expect(
			sqlOf(
				q()
					.columns(['status'])
					.groupBy([posts.status.as('s')])
					.dump(),
			),
		).toEqual(['SELECT posts.status FROM posts GROUP BY posts.status', []]);
		expect(sqlOf(q().sum(distinct(posts.score)).dump())).toEqual([
			'SELECT sum(DISTINCT posts.score) FROM posts',
			[],
		]);
		expect(sqlOf(q().avg(distinct(posts.score)).dump())).toEqual([
			'SELECT avg(DISTINCT posts.score) FROM posts',
			[],
		]);
	});

	it('AC8 window helper fields: one row per helper', () => {
		expect(
			sqlOf(
				q()
					.columns(['id', wSum(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, sum(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', wAvg(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, avg(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', wMin(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, min(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', wMax(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, max(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', wCount(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, count(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', lag(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, lag(posts.score) OVER () AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns(['id', lead(posts.score).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, lead(posts.score) OVER () AS w FROM posts',
			[],
		]);
	});

	it('AC8 wCount without field keeps count(*)', () => {
		expect(
			sqlOf(
				q()
					.columns(['id', wCount().as('w')])
					.dump(),
			),
		).toEqual(['SELECT posts.id, count(*) OVER () AS w FROM posts', []]);
	});

	it('AC8 window partition and order unchanged', () => {
		expect(
			sqlOf(
				q()
					.columns([
						'id',
						rowNumber().partitionBy('status').orderBy('score', 'desc').as('w'),
					])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, row_number() OVER (PARTITION BY posts.status ORDER BY posts.score DESC) AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.columns([
						'id',
						rowNumber()
							.partitionBy(posts.status)
							.orderBy(posts.score, 'desc')
							.as('w'),
					])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, row_number() OVER (PARTITION BY posts.status ORDER BY posts.score DESC) AS w FROM posts',
			[],
		]);
		expect(
			sqlOf(
				q()
					.join('author')
					.columns(['id', rowNumber().partitionBy(posts.author.name).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, row_number() OVER (PARTITION BY author.name) AS w FROM posts JOIN users AS author ON posts.user_id = author.id',
			[],
		]);
		expect(
			sqlOf(
				q()
					.join('author')
					.columns(['id', rowNumber().orderBy(posts.author.name).as('w')])
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, row_number() OVER (ORDER BY author.name ASC) AS w FROM posts JOIN users AS author ON posts.user_id = author.id',
			[],
		]);
	});
});

describe('subquery fields and selectExpression leaves (ADR 0011 delivery 6)', () => {
	const d6Db = schema({
		users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			status: 'text',
			score: 'integer',
			user_id: ref('users', { as: 'author' }),
		},
	});
	const orm = createOrm({
		schema: d6Db,
		adapter: createPgCompileOnlyAdapter({ model: d6Db.model }),
		suppressDxWarnings: true,
	});
	const posts = orm.tables.posts;
	const users = orm.tables.users;
	const out = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];
	const sel = (expr: unknown) => {
		const r = orm.selectExpression(expr as never);
		return [r.sql, r.parameters];
	};
	const correlated = () =>
		subquery('posts').where(eq('user_id', outerRef('id')));
	const column = (sq: { asExpr(alias: string): unknown }, alias = 't') =>
		orm
			.select('users')
			.columns(['id', sq.asExpr(alias) as never])
			.dump();
	const notYet = (
		run: () => unknown,
		construct: string,
		position: string,
		issue: number,
	) => {
		let caught: unknown;
		try {
			run();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(NotYetSupportedError);
		const e = caught as NotYetSupportedError;
		expect([e.construct, e.position, e.issue]).toEqual([
			construct,
			position,
			issue,
		]);
	};

	it('AC9 unchanged subquery string forms (astix)', () => {
		expect(out(column(correlated().select('title')))).toEqual([
			'SELECT users.id, (SELECT posts.title FROM posts WHERE posts.user_id = users.id) AS t FROM users',
			[],
		]);
		expect(out(column(subquery('posts').count('score'), 'n'))).toEqual([
			'SELECT users.id, (SELECT count(posts.score) FROM posts) AS n FROM users',
			[],
		]);
		for (const sq of [subquery('posts').count(), subquery('posts').count('*')])
			expect(out(column(sq, 'n'))).toEqual([
				'SELECT users.id, (SELECT count(*) FROM posts) AS n FROM users',
				[],
			]);
		for (const fn of ['sum', 'avg', 'min', 'max'] as const)
			expect(out(column(subquery('posts')[fn]('score'), 'n'))).toEqual([
				`SELECT users.id, (SELECT ${fn}(posts.score) FROM posts) AS n FROM users`,
				[],
			]);
		expect(
			out(
				orm
					.select('users')
					.columns(['id'])
					.where(eq('id', subquery('posts').max('user_id')))
					.dump(),
			),
		).toEqual([
			'SELECT users.id FROM users WHERE users.id = (SELECT max(posts.user_id) FROM posts)',
			[],
		]);
		expect(
			out(
				orm
					.select('users')
					.columns(['id'])
					.where(inSubquery('id', subquery('posts').select('user_id')))
					.dump(),
			),
		).toEqual([
			'SELECT users.id FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id)',
			[],
		]);
	});

	it('AC12 subquery select ColumnRef and expression', () => {
		const body = (s: string) =>
			`SELECT users.id, (SELECT ${s} FROM posts WHERE posts.user_id = users.id) AS t FROM users`;
		expect(out(column(correlated().select(posts.title)))).toEqual([
			body('posts.title'),
			[],
		]);
		expect(
			out(column(correlated().select(fn('lower', exprRef('title'))))),
		).toEqual([body('lower(title)'), []]);
		expect(out(column(correlated().select(2)))).toEqual([body('2'), []]);
		expect(out(column(correlated().select(users.name)))).toEqual([
			body('users.name'),
			[],
		]);
		expect(out(column(correlated().select(param('x'))))).toEqual([
			body('$1'),
			['x'],
		]);
		// The selection survives a later call, and a later select() replaces it.
		expect(
			out(
				column(
					subquery('posts')
						.select(fn('lower', exprRef('title')))
						.where(eq('user_id', outerRef('id'))),
				),
			),
		).toEqual([body('lower(title)'), []]);
		expect(
			out(
				column(
					correlated()
						.select(fn('lower', exprRef('title')))
						.select('title'),
				),
			),
		).toEqual([body('posts.title'), []]);
		expect(
			out(
				column(
					correlated()
						.select('title')
						.select(fn('lower', exprRef('title'))),
				),
			),
		).toEqual([body('lower(title)'), []]);
	});

	it('AC13 subquery aggregate ColumnRef: the same SQL as the string field', () => {
		expect(out(column(subquery('posts').count(posts.score), 'n'))).toEqual([
			'SELECT users.id, (SELECT count(posts.score) FROM posts) AS n FROM users',
			[],
		]);
		for (const fn of ['sum', 'avg', 'min', 'max'] as const)
			expect(out(column(subquery('posts')[fn](posts.score), 'n'))).toEqual([
				`SELECT users.id, (SELECT ${fn}(posts.score) FROM posts) AS n FROM users`,
				[],
			]);
		expect(out(column(subquery('posts').count(users.id), 'n'))).toEqual([
			'SELECT users.id, (SELECT count(users.id) FROM posts) AS n FROM users',
			[],
		]);
		expect(
			out(
				orm
					.select('users')
					.columns(['id'])
					.where(eq('id', subquery('posts').max(posts.user_id)))
					.dump(),
			),
		).toEqual([
			'SELECT users.id FROM users WHERE users.id = (SELECT max(posts.user_id) FROM posts)',
			[],
		]);
	});

	it('AC14 selectExpression leaves: columns, constants, subqueries and expressions', () => {
		// 'title' and posts.title compile to text PostgreSQL rejects in a FROM-less SELECT (#1002).
		expect(sel('title')).toEqual(['SELECT title', []]);
		expect(sel(2)).toEqual(['SELECT 2', []]);
		expect(sel(true)).toEqual(['SELECT true', []]);
		expect(sel(3n)).toEqual(['SELECT 3', []]);
		expect(sel([1, 2])).toEqual(['SELECT $1', [[1, 2]]]);
		const d = new Date('2024-01-01T00:00:00Z');
		const dated = sel(d);
		expect(dated[0]).toBe('SELECT $1');
		expect((dated[1] as unknown[])[0]).toBe(d);
		expect(sel(subquery('posts').count())).toEqual([
			'SELECT (SELECT count(*) FROM posts)',
			[],
		]);
		expect(sel(posts.title)).toEqual(['SELECT posts.title', []]);
		expect(sel(exprRef('title'))).toEqual(['SELECT title', []]);
		expect(sel(fn('lower', exprRef('title')))).toEqual([
			'SELECT lower(title)',
			[],
		]);
		expect(sel(param('x'))).toEqual(['SELECT $1', ['x']]);
	});

	it('AC15 selectExpression alias: the coerced intent names the result column', () => {
		expect(sel(fn('now').as('t'))).toEqual(['SELECT now() AS t', []]);
		expect(sel(literal(1).as('one'))).toEqual(['SELECT 1 AS one', []]);
		expect(sel(subquery('posts').count().asExpr('n'))).toEqual([
			'SELECT (SELECT count(*) FROM posts) AS n',
			[],
		]);
		expect(sel(fn('now').as('Bad Alias'))).toEqual([
			'SELECT now() AS "Bad Alias"',
			[],
		]);
	});

	it('RF7 subquery field refusals', () => {
		const refusal = (helper: string, kind: string) =>
			`Invalid ${helper}: ${kind} is not an expression argument; use literal(null), param(value) or an expression`;
		expect(() => subquery('posts').select(null as never)).toThrow(
			refusal('select', 'null'),
		);
		expect(() => subquery('posts').select(undefined as never)).toThrow(
			refusal('select', 'undefined'),
		);
		expect(() => subquery('posts').select({} as never)).toThrow(
			refusal('select', 'a plain object'),
		);
		expect(() => subquery('posts').count(null as never)).toThrow(
			'Invalid count: null is not a column; use a column name or a ColumnRef',
		);
		notYet(
			() => subquery('posts').sum(exprRef('score') as never),
			'an expression',
			'aggregate field',
			1072,
		);
		notYet(
			() => subquery('posts').max(fn('abs', exprRef('score')) as never),
			'an expression',
			'aggregate field',
			1072,
		);
		notYet(
			() => subquery('posts').count(outerRef('id') as never),
			'outerRef()',
			'aggregate field',
			1072,
		);
		notYet(
			() => subquery('posts').count(orm.select('posts') as never),
			'a query builder',
			'aggregate field',
			1072,
		);
		expect(() => column(subquery('posts').count(posts.author.id), 'n')).toThrow(
			"Declared column 'author.id' is absent from the physical model.",
		);
		notYet(
			() => subquery('posts').select(orm.select('posts') as never),
			'a query builder',
			'expression argument',
			1053,
		);
		expect(() =>
			orm
				.select('users')
				.columns(['id'])
				.where(inSubquery('id', subquery('posts').select(param(1))))
				.dump(),
		).toThrow(
			'IN subquery with expressions SELECT (not supported in IN subquery) is not supported — it would silently change which rows match; restructure the query or use a CTE.',
		);
		const base = orm.select('posts').columns(['id', 'score']);
		const tree = orm.recursive('tree', { base, step: base });
		expect(() =>
			tree.where(eq('id', subquery('tree').select(param(1)).build())).dump(),
		).toThrow(
			'scalar subquery with expressions SELECT (not supported in scalar subquery) is not supported — it would silently change which rows match; restructure the query or use a CTE.',
		);
		expect(
			orm
				.recursive('tree', { base, step: base })
				.where(eq('id', subquery('tree').select('id').build()))
				.dump().sql,
		).toBe(
			'WITH RECURSIVE tree AS (SELECT posts.id, posts.score FROM posts UNION ALL SELECT posts.id, posts.score FROM posts) SELECT tree.* FROM tree WHERE tree.id = (SELECT tree_sq.id FROM tree AS tree_sq)',
		);
	});

	it('RF8 selectExpression refusals', () => {
		const refusal = (kind: string) =>
			`Invalid selectExpression: ${kind} is not an expression argument; use literal(null), param(value) or an expression`;
		expect(() => sel(null)).toThrow(refusal('null'));
		expect(() => sel(undefined)).toThrow(refusal('undefined'));
		expect(() => sel({})).toThrow(refusal('a plain object'));
		expect(() => sel(sql('1'))).toThrow(
			'Invalid selectExpression: sql() is only accepted in set(), values(), doUpdate() and batchSet().set(); use literal(), param() or an expression here',
		);
		notYet(
			() => sel(orm.select('posts')),
			'a query builder',
			'expression argument',
			1053,
		);
		notYet(
			() => sel(outerRef('id')),
			'outerRef()',
			'expression argument',
			1029,
		);
	});
});

describe('subquery leaves (ADR 0011 delivery 5)', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			deletedAt: { type: 'timestamp', nullable: true },
			user_id: ref('users', { as: 'author' }),
		},
	} as const;
	const filteredDb = schema(tables, undefined, {
		defaultFilters: { posts: isNull('deletedAt'), users: isNull('deletedAt') },
	});
	const o = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter({ model: filteredDb.model }),
		suppressDxWarnings: true,
	});
	const sqlOf = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];
	const optout = () =>
		o
			.withoutDefaultFilters()
			.select('posts')
			.where(eq('user_id', outerRef('id')))
			.count({ as: 'n' });
	const own = () =>
		o
			.select('posts')
			.where(eq('user_id', outerRef('id')))
			.count({ as: 'n' });
	const sqb = () =>
		subquery('posts')
			.select('id')
			.where(eq('user_id', outerRef('id')));
	const OPT =
		'(SELECT count(*) AS n FROM posts WHERE posts.user_id = users.id)';
	const OWN =
		'(SELECT count(*) AS n FROM posts WHERE posts."deletedAt" IS NULL AND posts.user_id = users.id)';
	const ROOT = 'FROM users WHERE users."deletedAt" IS NULL';
	const users = () => o.select('users');

	it('AC3 cast: a builder casts as a scalar subquery', () => {
		expect(
			sqlOf(
				users()
					.columns(['id', cast(optout(), 'text').as('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, CAST(${OPT} AS text) AS v ${ROOT}`, []]);
	});

	it('AC3 caseWhen else: a builder as the ELSE result', () => {
		expect(
			sqlOf(
				users()
					.columns([
						'id',
						caseWhen(eq('id', 1), literal(0)).else(optout()).as('v'),
					])
					.dump(),
			),
		).toEqual([
			`SELECT users.id, CASE WHEN users.id = $1 THEN 0 ELSE ${OPT} END AS v ${ROOT}`,
			[1],
		]);
	});

	it('AC3 caseWhen when result: a builder as the THEN result', () => {
		expect(
			sqlOf(
				users()
					.columns(['id', caseWhen(eq('id', 1), optout()).else(0).as('v')])
					.dump(),
			),
		).toEqual([
			`SELECT users.id, CASE WHEN users.id = $1 THEN ${OPT} ELSE 0 END AS v ${ROOT}`,
			[1],
		]);
	});

	it('AC3 orderBy: a builder orders rows', () => {
		expect(
			sqlOf(users().columns(['id']).orderBy(optout(), 'desc').dump()),
		).toEqual([`SELECT users.id ${ROOT} ORDER BY ${OPT} DESC`, []]);
	});

	it('AC3 filter left operand: a builder on the left of gt', () => {
		expect(sqlOf(users().where(gt(optout(), 1)).dump())).toEqual([
			`SELECT users.* ${ROOT} AND ${OPT} > $1`,
			[1],
		]);
	});

	it('AC3 having: a builder in a HAVING comparison', () => {
		expect(
			sqlOf(
				users().columns(['id']).groupBy(['id']).having(gt(optout(), 0)).dump(),
			),
		).toEqual([
			`SELECT users.id ${ROOT} GROUP BY users.id HAVING ${OPT} > $1`,
			[0],
		]);
	});

	it('AC4 eq right operand: a builder as the comparison value', () => {
		expect(sqlOf(users().where(eq('id', optout())).dump())).toEqual([
			`SELECT users.* ${ROOT} AND users.id = ${OPT}`,
			[],
		]);
	});

	it('AC4 object filter direct value: a builder as a field value', () => {
		expect(sqlOf(users().where({ id: optout() }).dump())).toEqual([
			`SELECT users.* ${ROOT} AND users.id = ${OPT}`,
			[],
		]);
	});

	it('AC4 object filter operator: $gte compiles as gte()', () => {
		const expected = [`SELECT users.* ${ROOT} AND users.id >= ${OPT}`, []];
		expect(
			sqlOf(
				users()
					.where({ id: { $gte: optout() } })
					.dump(),
			),
		).toEqual(expected);
		expect(sqlOf(users().where(gte('id', optout())).dump())).toEqual(expected);
	});

	it('AC4 ExpressionRef method: exprRef().eq(builder)', () => {
		expect(sqlOf(users().where(exprRef('id').eq(optout())).dump())).toEqual([
			`SELECT users.* ${ROOT} AND users.id = ${OPT}`,
			[],
		]);
	});

	it('AC4 mutation WHERE: a builder in an update WHERE', () => {
		const dump = o
			.update('users')
			.set({ name: 'x' })
			.where(eq('id', optout()))
			.dump();
		expect([dump.sql, dump.parameters]).toEqual([
			`UPDATE users SET name = $1 WHERE users.id = ${OPT}`,
			['x'],
		]);
	});

	it('AC5 asExpr opt-out: QueryBuilder.asExpr names an unfiltered subquery column', () => {
		expect(
			sqlOf(
				users()
					.columns(['id', optout().asExpr('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, ${OPT} AS v ${ROOT}`, []]);
	});

	it('AC5 asExpr own: QueryBuilder.asExpr keeps the filter', () => {
		expect(
			sqlOf(
				users()
					.columns(['id', own().asExpr('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, ${OWN} AS v ${ROOT}`, []]);
	});

	it('AC6 inSubquery opt-out builder: an IN body without the filter (#994)', () => {
		expect(
			sqlOf(
				users()
					.where(
						inSubquery(
							'id',
							o.withoutDefaultFilters().select('posts').columns(['user_id']),
						),
					)
					.dump(),
			),
		).toEqual([
			`SELECT users.* ${ROOT} AND users.id = ANY (SELECT posts_subq_0.user_id FROM posts AS posts_subq_0)`,
			[],
		]);
	});

	it('AC6 inSubquery own builder: the IN body keeps the filter (#994)', () => {
		expect(
			sqlOf(
				users()
					.where(inSubquery('id', o.select('posts').columns(['user_id'])))
					.dump(),
			),
		).toEqual([
			`SELECT users.* ${ROOT} AND users.id = ANY (SELECT posts_subq_0.user_id FROM posts AS posts_subq_0 WHERE posts_subq_0."deletedAt" IS NULL)`,
			[],
		]);
	});

	it('AC6 inSubquery subquery builder: the EXISTS rewrite is kept', () => {
		expect(
			sqlOf(
				users()
					.where(inSubquery('id', subquery('posts').select('user_id')))
					.dump(),
			),
		).toEqual([
			`SELECT users.* ${ROOT} AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND posts_exists_0."deletedAt" IS NULL)`,
			[],
		]);
	});

	it('AC6 rawExists SubqueryExpression: a SubqueryExpression is an EXISTS body', () => {
		expect(sqlOf(users().where(rawExists(sqb().build())).dump())).toEqual([
			`SELECT users.* ${ROOT} AND EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.user_id = users.id AND posts_sq."deletedAt" IS NULL)`,
			[],
		]);
	});

	it('AC6 rawExists own builder unchanged', () => {
		expect(
			sqlOf(
				users()
					.where(
						rawExists(o.select('posts').where(eq('user_id', outerRef('id')))),
					)
					.dump(),
			),
		).toEqual([
			`SELECT users.* ${ROOT} AND EXISTS (SELECT 1 FROM posts AS posts_sq WHERE posts_sq.user_id = users.id AND posts_sq."deletedAt" IS NULL)`,
			[],
		]);
	});

	it('AC6 rawNotExists SubqueryExpression: a SubqueryExpression is a NOT EXISTS body', () => {
		expect(sqlOf(users().where(rawNotExists(sqb().build())).dump())).toEqual([
			`SELECT users.* ${ROOT} AND NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.user_id = users.id AND posts_sq."deletedAt" IS NULL))`,
			[],
		]);
	});

	it('AC6 rawNotExists opt-out builder: the NOT EXISTS body has no filter', () => {
		expect(
			sqlOf(
				users()
					.where(
						rawNotExists(
							o
								.withoutDefaultFilters()
								.select('posts')
								.where(eq('user_id', outerRef('id'))),
						),
					)
					.dump(),
			),
		).toEqual([
			`SELECT users.* ${ROOT} AND NOT (EXISTS (SELECT 1 FROM posts AS posts_sq WHERE posts_sq.user_id = users.id))`,
			[],
		]);
	});

	it('AC7 caseWhen asExpr and SubqueryExpression: a subquery CASE result (#1034)', () => {
		const expected = [
			`SELECT users.id, CASE WHEN users.id = $1 THEN (SELECT count(*) FROM posts WHERE posts."deletedAt" IS NULL) ELSE 0 END AS v ${ROOT}`,
			[1],
		];
		expect(
			sqlOf(
				users()
					.columns([
						'id',
						caseWhen(eq('id', 1), subquery('posts').count().asExpr('n'))
							.else(0)
							.as('v'),
					])
					.dump(),
			),
		).toEqual(expected);
		expect(
			sqlOf(
				users()
					.columns([
						'id',
						caseWhen(eq('id', 1), subquery('posts').count()).else(0).as('v'),
					])
					.dump(),
			),
		).toEqual(expected);
	});

	it('AC7 cast SubqueryExpression and asExpr: a subquery casts (#1034)', () => {
		const expected = [
			`SELECT users.id, CAST((SELECT count(*) FROM posts WHERE posts."deletedAt" IS NULL) AS text) AS v ${ROOT}`,
			[],
		];
		expect(
			sqlOf(
				users()
					.columns(['id', cast(subquery('posts').count(), 'text').as('v')])
					.dump(),
			),
		).toEqual(expected);
		expect(
			sqlOf(
				users()
					.columns([
						'id',
						cast(subquery('posts').count().asExpr('n'), 'text').as('v'),
					])
					.dump(),
			),
		).toEqual(expected);
	});

	it('AC7 cast param stays opaque', () => {
		expect(
			sqlOf(
				users()
					.columns(['id', cast(param('7'), 'integer').as('v')])
					.dump(),
			),
		).toEqual([`SELECT users.id, CAST($1 AS integer) AS v ${ROOT}`, ['7']]);
	});

	const arity = (n: number) =>
		`scalar subquery body projects ${n} columns; a scalar subquery yields one value.`;
	const NO_PROJECTION =
		'scalar subquery with no projection (scalar subquery must project exactly one column — select one field or one aggregate) is not supported — it would silently change which rows match; restructure the query or use a CTE.';

	it('R6 star body refused: a builder without a projection in fn()', () => {
		expect(() =>
			users()
				.columns(['id', fn('abs', o.select('posts')).as('v')])
				.dump(),
		).toThrow(arity(5));
	});

	it('R6 multi-column body refused: a two-column builder in fn()', () => {
		expect(() =>
			users()
				.columns([
					'id',
					fn('abs', o.select('posts').columns(['id', 'title'])).as('v'),
				])
				.dump(),
		).toThrow(arity(2));
	});

	it('R6b star builder in $eq: refused by the arity check', () => {
		expect(() =>
			users()
				.where({ id: { $eq: o.select('posts').limit(1) } })
				.dump(),
		).toThrow(arity(5));
	});

	it('R6b empty columns builder in $eq: refused by the arity check', () => {
		expect(() =>
			users()
				.where({ id: { $eq: o.select('posts').columns([]).limit(1) } })
				.dump(),
		).toThrow(arity(5));
	});

	it('R6b aggregate plus field builder in $eq: refused by the arity check', () => {
		expect(() =>
			users()
				.where({
					id: { $eq: o.select('posts').columns(['id']).count({ as: 'n' }) },
				})
				.dump(),
		).toThrow(arity(2));
	});

	it('R6b hand-built SubqueryExpression in $gt: refused by the arity check', () => {
		expect(() =>
			users()
				.where({
					id: {
						$gt: new SubqueryExpression({ type: 'select', from: 'posts' }),
					},
				})
				.dump(),
		).toThrow(arity(5));
	});

	it('R6c toWhereIntent absent projection: refused (D9)', () => {
		const sq = new SubqueryExpression({ type: 'select', from: 'posts' });
		expect(() => users().where(sq.toWhereIntent('id', 'gt')).dump()).toThrow(
			NO_PROJECTION,
		);
	});

	it('R6c toWhereIntent all projection: refused (D9)', () => {
		const sq = new SubqueryExpression({
			type: 'select',
			from: 'posts',
			select: { type: 'all' },
		});
		expect(() => users().where(sq.toWhereIntent('id', 'gt')).dump()).toThrow(
			NO_PROJECTION,
		);
	});

	it('R6c mutation WHERE absent projection: refused (D9)', () => {
		const sq = new SubqueryExpression({ type: 'select', from: 'posts' });
		expect(() =>
			o
				.update('users')
				.set({ name: 'x' })
				.where(sq.toWhereIntent('id', 'eq'))
				.dump(),
		).toThrow(NO_PROJECTION);
	});
});
