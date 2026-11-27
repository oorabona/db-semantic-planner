/**
 * SQL output spot-check for range helpers.
 * Verifies the compiled SQL and params match the documented API.
 */

import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import {
	NotYetSupportedError,
	type RangeValue,
	type WhereIntent,
} from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	caseWhen,
	eq,
	exists,
	exprRef,
	fn,
	gt,
	InvalidOperationError,
	literal,
	op,
	outerRef,
	param,
	rawExists,
	ref,
	some,
	sql,
	star,
	subquery,
} from '../index.js';
import { createOrm } from '../orm.js';
import { rangeContainedBy, rangeContains, rangeOverlaps } from '../range.js';
import { schema } from '../schema.js';
import { whereExpression } from '../test-compat/issue-442.js';

const db = schema({
	bookings: { id: 'integer', period: 'string' },
	events: { id: 'integer', dateRange: 'string' },
} as const);

const orm = createOrm({ schema: db, adapter: createPgCompileOnlyAdapter() });

describe('range helpers SQL output', () => {
	it('rangeOverlaps compiles to col && daterange($1, $2)', () => {
		const { sql, params } = whereExpression(
			orm.select('bookings'),
			rangeOverlaps('period', ['2024-01-01', '2024-01-31']),
		).dump();
		expect(sql).toContain('period && daterange($1, $2)');
		expect(params).toEqual(['2024-01-01', '2024-01-31']);
	});

	it('rangeContains compiles to col @> daterange($1, $2)', () => {
		const { sql, params } = whereExpression(
			orm.select('events'),
			rangeContains('dateRange', ['2024-06-15', '2024-06-15']),
		).dump();
		expect(sql).toContain('"dateRange" @> daterange($1, $2)');
		expect(params).toEqual(['2024-06-15', '2024-06-15']);
	});

	it('rangeContainedBy compiles to col <@ daterange($1, $2)', () => {
		const { sql, params } = whereExpression(
			orm.select('events'),
			rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31']),
		).dump();
		expect(sql).toContain('"dateRange" <@ daterange($1, $2)');
		expect(params).toEqual(['2024-01-01', '2024-12-31']);
	});

	it('rangeOverlaps with int4range produces int4range constructor', () => {
		const db2 = schema({ spans: { id: 'integer', span: 'string' } } as const);
		const orm2 = createOrm({
			schema: db2,
			adapter: createPgCompileOnlyAdapter(),
		});
		const { sql } = whereExpression(
			orm2.select('spans'),
			rangeOverlaps('span', [1, 100], 'int4range'),
		).dump();
		expect(sql).toContain('span && int4range($1, $2)');
	});
});

// ============================================================================
// ADR 0011 delivery 6: range helper leaves and range values (#1047)
// ============================================================================

describe('range helper leaves and range values (ADR 0011 delivery 6)', () => {
	const d6Db = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			span: { type: 'int4range' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			status: 'text',
			score: 'integer',
			period: { type: 'daterange' },
			span: { type: 'int4range' },
			user_id: ref('users', { as: 'author' }),
		},
	});
	const d6 = createOrm({
		schema: d6Db,
		adapter: createPgCompileOnlyAdapter({ model: d6Db.model }),
		suppressDxWarnings: true,
	});
	const posts = d6.tables.posts;
	const q = () => d6.select('posts').columns(['id']);
	const out = (dump: { sql: string; params: readonly unknown[] }) => [
		dump.sql,
		dump.params,
	];
	const where = (sqlWhere: string) =>
		`SELECT posts.id FROM posts WHERE ${sqlWhere}`;
	const RV = { lower: 1, upper: 5 };

	it('AC4 tuple expression bound: an expression bound is compiled, a plain one bound', () => {
		expect(
			out(
				q()
					.where(rangeOverlaps('span', [exprRef('score'), 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span && int4range(posts.score, $1)'), [5]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', [param(1), 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span && int4range($1, $2)'), [1, 5]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', [null, 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span && int4range($1, $2)'), [null, 5]]);
		const d = new Date('2024-01-01T00:00:00Z');
		const dated = q()
			.where(rangeOverlaps('period', [d, '2024-02-01']))
			.dump();
		expect(dated.sql).toBe(where('posts.period && daterange($1, $2)'));
		expect(dated.params[0]).toBe(d);
		expect(dated.params[1]).toBe('2024-02-01');
	});

	it('AC5 tuple ColumnRef column: the qualified column for each operator', () => {
		expect(
			out(
				q()
					.where(rangeOverlaps(posts.span, [1, 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span && int4range($1, $2)'), [1, 5]]);
		expect(
			out(
				q()
					.where(rangeContains(posts.span, [1, 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span @> int4range($1, $2)'), [1, 5]]);
		expect(
			out(
				q()
					.where(rangeContainedBy(posts.span, [1, 5], 'int4range'))
					.dump(),
			),
		).toEqual([where('posts.span <@ int4range($1, $2)'), [1, 5]]);
	});

	it('AC6 RangeValue bounds honoured: each bounds form is the constructor third argument (#1047)', () => {
		for (const bounds of ['[]', '()', '(]', '[)'] as const) {
			expect(
				out(
					q()
						.where(rangeOverlaps('span', { lower: 1, upper: 5, bounds }))
						.dump(),
				),
			).toEqual([
				where(`posts.span && int4range($1, $2, '${bounds}')`),
				[1, 5],
			]);
		}
		expect(out(q().where(rangeOverlaps('span', RV)).dump())).toEqual([
			where("posts.span && int4range($1, $2, '[)')"),
			[1, 5],
		]);
		expect(out(q().where(rangeContains('span', RV)).dump())).toEqual([
			where("posts.span @> int4range($1, $2, '[)')"),
			[1, 5],
		]);
		expect(out(q().where(rangeContainedBy('span', RV)).dump())).toEqual([
			where("posts.span <@ int4range($1, $2, '[)')"),
			[1, 5],
		]);
	});

	it('AC7 RangeValue bound kinds: Date, missing sides, expression, param and comma strings', () => {
		const d = new Date('2024-01-01T00:00:00Z');
		const dated = q()
			.where(rangeOverlaps('period', { lower: d, upper: null }))
			.dump();
		expect(dated.sql).toBe(where("posts.period && daterange($1, $2, '[)')"));
		expect(dated.params).toEqual([d, null]);
		expect(dated.params[0]).toBe(d);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: null, upper: 5 }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, $2, '[)')"), [null, 5]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: undefined, upper: undefined }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, $2, '[)')"), [null, null]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: 1 } as RangeValue))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, $2, '[)')"), [1, null]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: exprRef('score'), upper: 5 }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range(posts.score, $1, '[)')"), [5]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: param(1), upper: 5 }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, $2, '[)')"), [1, 5]]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: '1,2', upper: 5 }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, $2, '[)')"), ['1,2', 5]]);
	});

	it('AC7u expression upper bound: the upper side follows the same rule', () => {
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: 1, upper: exprRef('score') }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range($1, posts.score, '[)')"), [1]]);
	});

	it('AC8 RangeValue in other positions: CASE in a WHERE op, EXISTS, mutations, include and relation fields', () => {
		expect(
			out(
				q()
					.where(
						op(
							'=',
							caseWhen(rangeOverlaps('span', RV), literal(1)).else(literal(0)),
							1,
						),
					)
					.dump(),
			),
		).toEqual([
			where(
				"CASE WHEN posts.span && int4range($1, $2, '[)') THEN 1 ELSE 0 END = 1",
			),
			[1, 5],
		]);
		expect(
			out(
				d6
					.select('users')
					.columns(['id'])
					.where(exists('posts', { where: rangeOverlaps('span', RV) }))
					.dump(),
			),
		).toEqual([
			"SELECT users.id FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND posts_exists_0.span && int4range($1, $2, '[)'))",
			[1, 5],
		]);
		const update = d6
			.update('posts')
			.set({ title: 'b' })
			.where(rangeOverlaps('span', RV))
			.dump();
		expect([update.sql, update.parameters]).toEqual([
			"UPDATE posts SET title = $1 WHERE posts.span && int4range($2, $3, '[)')",
			['b', 1, 5],
		]);
		const del = d6.delete('posts').where(rangeOverlaps('span', RV)).dump();
		expect([del.sql, del.parameters]).toEqual([
			"DELETE FROM posts WHERE posts.span && int4range($1, $2, '[)')",
			[1, 5],
		]);
		const upsert = d6
			.upsert('posts')
			.values({ id: 1, title: 'a' })
			.onConflict(['id'])
			.doUpdate({ title: 'b' }, rangeOverlaps('span', RV))
			.dump();
		expect([upsert.sql, upsert.parameters]).toEqual([
			"INSERT INTO posts (id, title) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = $3 WHERE posts.span && int4range($4, $5, '[)')",
			[1, 'a', 'b', 1, 5],
		]);
		expect(
			out(
				q()
					.include('author', {
						join: 'inner',
						where: rangeOverlaps('span', RV),
					})
					.dump(),
			),
		).toEqual([
			'SELECT posts.id, author.id AS "author.id", author.name AS "author.name", author.span AS "author.span", author.id AS __dbsp_presence_author FROM posts JOIN users AS author ON posts.user_id = author.id WHERE author.span && int4range($1, $2, \'[)\')',
			[1, 5],
		]);
		expect(out(q().where(rangeOverlaps('author.span', RV)).dump())).toEqual([
			"SELECT posts.id FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts.user_id = users_exists_0.id AND users_exists_0.span && int4range($1, $2, '[)'))",
			[1, 5],
		]);
	});

	it('AC8L and RF12 CASE, FILTER and HAVING give the constructor form', () => {
		const positions = [
			(c: WhereIntent) =>
				q()
					.columns(['id', caseWhen(c, literal(1)).else(literal(0)).as('x')])
					.dump(),
			(c: WhereIntent) =>
				q()
					.orderBy(caseWhen(c, literal(1)).else(literal(0)))
					.dump(),
			(c: WhereIntent) =>
				d6
					.select('posts')
					.columns([fn('count', star()).filter(c).as('n')])
					.dump(),
			(c: WhereIntent) =>
				d6
					.select('posts')
					.columns(['status', fn('count', star()).as('n')])
					.groupBy(['status'])
					.having(c)
					.dump(),
		];
		const sqlAt = [
			(p: string) =>
				`SELECT posts.id, CASE WHEN ${p} THEN 1 ELSE 0 END AS x FROM posts`,
			(p: string) =>
				`SELECT posts.id FROM posts ORDER BY CASE WHEN ${p} THEN 1 ELSE 0 END ASC`,
			(p: string) => `SELECT count(*) FILTER (WHERE ${p}) AS n FROM posts`,
			(p: string) =>
				`SELECT posts.status, count(*) AS n FROM posts GROUP BY posts.status HAVING ${p}`,
		];
		const cases: [WhereIntent, string, unknown[]][] = [
			[
				rangeOverlaps('span', RV),
				"posts.span && int4range($1, $2, '[)')",
				[1, 5],
			],
			[
				rangeOverlaps('span', { ...RV, bounds: '[]' }),
				"posts.span && int4range($1, $2, '[]')",
				[1, 5],
			],
			[
				rangeOverlaps('span', { ...RV, bounds: '()' }),
				"posts.span && int4range($1, $2, '()')",
				[1, 5],
			],
			[
				rangeOverlaps('span', { ...RV, bounds: '(]' }),
				"posts.span && int4range($1, $2, '(]')",
				[1, 5],
			],
			[
				rangeOverlaps('period', { lower: '2024-01-01', upper: '2024-02-01' }),
				"posts.period && daterange($1, $2, '[)')",
				['2024-01-01', '2024-02-01'],
			],
			[
				rangeOverlaps('period', {
					lower: new Date('2024-01-01T00:00:00Z'),
					upper: null,
				}),
				"posts.period && daterange($1, $2, '[)')",
				[new Date('2024-01-01T00:00:00Z'), null],
			],
			[
				rangeOverlaps('span', { lower: exprRef('score'), upper: 5 }),
				"posts.span && int4range(posts.score, $1, '[)')",
				[5],
			],
			[
				rangeOverlaps('period', { lower: '', upper: '2024-02-01' }),
				"posts.period && daterange($1, $2, '[)')",
				['', '2024-02-01'],
			],
			[
				rangeOverlaps('span', { lower: '1,2', upper: 5 }),
				"posts.span && int4range($1, $2, '[)')",
				['1,2', 5],
			],
		];
		positions.forEach((at, i) => {
			for (const [condition, predicate, params] of cases)
				expect(out(at(condition))).toEqual([sqlAt[i]?.(predicate), params]);
		});
	});

	it('AC9 unchanged range forms: scalar, range literal and string tuple', () => {
		expect(out(q().where(rangeContains('span', 3)).dump())).toEqual([
			where('posts.span @> CAST($1 AS integer)'),
			[3],
		]);
		expect(out(q().where(rangeContains('span', '[1,5)')).dump())).toEqual([
			where('posts.span @> CAST($1 AS int4range)'),
			['[1,5)'],
		]);
		expect(
			out(
				q()
					.where(rangeOverlaps('period', ['2024-01-01', '2024-02-01']))
					.dump(),
			),
		).toEqual([
			where('posts.period && daterange($1, $2)'),
			['2024-01-01', '2024-02-01'],
		]);
	});

	it('AC10 scalar range operand: param() takes its value cast, expressions inline', () => {
		expect(
			out(
				q()
					.where(rangeContains('span', param(3)))
					.dump(),
			),
		).toEqual([where('posts.span @> CAST($1 AS integer)'), [3]]);
		expect(
			out(
				q()
					.where(rangeContains('span', param('[1,5)')))
					.dump(),
			),
		).toEqual([where('posts.span @> CAST($1 AS int4range)'), ['[1,5)']]);
		expect(
			out(
				q()
					.where(rangeContains('span', param({ lower: 1, upper: 5 })))
					.dump(),
			),
		).toEqual([
			where('posts.span @> CAST($1 AS int4range)'),
			[{ lower: 1, upper: 5 }],
		]);
		const d = new Date('2024-01-01T00:00:00Z');
		const dated = q()
			.where(rangeContains('period', param(d)))
			.dump();
		expect(dated.sql).toBe(where('posts.period @> CAST($1 AS date)'));
		expect(dated.params[0]).toBe(d);
		expect(
			out(
				q()
					.where(rangeContains('span', exprRef('score')))
					.dump(),
			),
		).toEqual([where('posts.span @> posts.score'), []]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', exprRef('score')))
					.dump(),
			),
		).toEqual([where('posts.span && posts.score'), []]);
		expect(
			out(
				q()
					.where(rangeContainedBy('span', exprRef('score')))
					.dump(),
			),
		).toEqual([where('posts.span <@ posts.score'), []]);
		expect(
			out(
				q()
					.where(rangeOverlaps('span', fn('int4range', 1, 5)))
					.dump(),
			),
		).toEqual([where('posts.span && int4range(1, 5)'), []]);
		expect(out(q().where(rangeContains('span', posts.score)).dump())).toEqual([
			where('posts.span @> posts.score'),
			[],
		]);
	});

	it('AC11 RangeValue ColumnRef column: the qualified column', () => {
		expect(out(q().where(rangeOverlaps(posts.span, RV)).dump())).toEqual([
			where("posts.span && int4range($1, $2, '[)')"),
			[1, 5],
		]);
	});

	it('AC18 hand-built WhereRangeIntent: core lowers an expression bound', () => {
		const intent = {
			kind: 'range',
			field: 'span',
			operator: 'overlaps',
			value: { lower: exprRef('score'), upper: 5, bounds: '[]' },
		} as unknown as WhereIntent;
		expect(out(q().where(intent).dump())).toEqual([
			where("posts.span && int4range(posts.score, $1, '[]')"),
			[5],
		]);
	});

	it('AC19 RangeValue bounds follow the right-operand rule: ref(), outerRef() and subqueries', () => {
		expect(
			out(
				q()
					.where(rangeOverlaps('span', { lower: ref('score'), upper: 5 }))
					.dump(),
			),
		).toEqual([where("posts.span && int4range(posts.score, $1, '[)')"), [5]]);
		const hand = {
			kind: 'range',
			field: 'span',
			operator: 'overlaps',
			value: { lower: ref('score'), upper: 5 },
		} as unknown as WhereIntent;
		expect(out(q().where(hand).dump())).toEqual([
			where("posts.span && int4range(posts.score, $1, '[)')"),
			[5],
		]);
		expect(
			out(
				d6
					.select('users')
					.columns([
						'id',
						subquery('posts')
							.where(rangeOverlaps('span', { lower: outerRef('id'), upper: 5 }))
							.count()
							.asExpr('n'),
					])
					.dump(),
			),
		).toEqual([
			"SELECT users.id, (SELECT count(*) FROM posts WHERE posts.span && int4range(users.id, $1, '[)')) AS n FROM users",
			[5],
		]);
		expect(
			out(
				q()
					.where(rangeContains('span', ref('score')))
					.dump(),
			),
		).toEqual([where('posts.span @> posts.score'), []]);
		expect(
			out(
				q()
					.where(
						rangeOverlaps('span', {
							lower: subquery('users').where(gt('id', 0)).max('id'),
							upper: 5,
						}),
					)
					.dump(),
			),
		).toEqual([
			where(
				"posts.span && int4range((SELECT max(users.id) FROM users WHERE users.id > $1), $2, '[)')",
			),
			[0, 5],
		]);
	});

	it('AC20 declared SQL range types name the constructor', () => {
		const typed = schema({
			t: {
				id: { type: 'integer', primaryKey: true },
				custom: { type: 'string', dbType: 'ipspan' },
				qualified: { type: 'string', dbType: 'public.ipspan' },
				builtin: { type: 'string', dbType: 'int4range' },
				short: 'int4range',
				folded: { type: 'string', dbType: 'MyRange' },
				quoted: { type: 'string', dbType: '"MyRange"' },
				schemaQuoted: { type: 'string', dbType: '"My Schema".ipspan' },
				big: 'int8range',
				num: 'numrange',
				ts: 'tsrange',
				tstz: 'tstzrange',
				parenSchema: { type: 'string', dbType: '"Reporting (EU)".ipspan' },
				parenName: { type: 'string', dbType: '"ip(span)"' },
				catalog: { type: 'string', dbType: 'pg_catalog.int4range' },
			},
		});
		const torm = createOrm({
			schema: typed,
			adapter: createPgCompileOnlyAdapter({ model: typed.model }),
			suppressDxWarnings: true,
		});
		const sqlFor = (column: string) =>
			out(
				torm
					.select('t')
					.columns(['id'])
					.where(rangeOverlaps(column, RV))
					.dump(),
			);
		const expected = (column: string, ctor: string) => [
			`SELECT t.id FROM t WHERE t.${column} && ${ctor}($1, $2, '[)')`,
			[1, 5],
		];
		expect(sqlFor('custom')).toEqual(expected('custom', 'ipspan'));
		expect(sqlFor('qualified')).toEqual(expected('qualified', 'public.ipspan'));
		expect(sqlFor('builtin')).toEqual(expected('builtin', 'int4range'));
		expect(sqlFor('short')).toEqual(expected('short', 'int4range'));
		// An unquoted MyRange names the type PostgreSQL folds to myrange, as its cast does.
		expect(sqlFor('folded')).toEqual(expected('folded', 'myrange'));
		expect(sqlFor('quoted')).toEqual(expected('quoted', '"MyRange"'));
		for (const [column, ctor] of [
			['big', 'int8range'],
			['num', 'numrange'],
			['ts', 'tsrange'],
			['tstz', 'tstzrange'],
		] as const)
			expect(sqlFor(column)).toEqual(expected(column, ctor));
		// A parenthesis inside a quoted identifier is not a type modifier.
		expect(sqlFor('parenSchema')).toEqual([
			`SELECT t.id FROM t WHERE t."parenSchema" && "Reporting (EU)".ipspan($1, $2, '[)')`,
			[1, 5],
		]);
		expect(sqlFor('parenName')).toEqual([
			`SELECT t.id FROM t WHERE t."parenName" && "ip(span)"($1, $2, '[)')`,
			[1, 5],
		]);
		expect(sqlFor('catalog')).toEqual(
			expected('catalog', 'pg_catalog.int4range'),
		);
		expect(sqlFor('schemaQuoted')).toEqual([
			`SELECT t.id FROM t WHERE t."schemaQuoted" && "My Schema".ipspan($1, $2, '[)')`,
			[1, 5],
		]);
	});

	it('AC21 default filter with an own-table bound: accepted and compiled', () => {
		const filtered = schema(
			{
				posts: {
					id: { type: 'integer', primaryKey: true },
					score: 'integer',
					span: { type: 'int4range' },
				},
			},
			undefined,
			{
				defaultFilters: {
					posts: rangeOverlaps('span', { lower: exprRef('score'), upper: 5 }),
				},
			},
		);
		const form = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
			suppressDxWarnings: true,
		});
		expect(out(form.select('posts').columns(['id']).dump())).toEqual([
			"SELECT posts.id FROM posts WHERE posts.span && int4range(posts.score, $1, '[)')",
			[5],
		]);
	});
});

describe('range helper refusals (ADR 0011 delivery 6)', () => {
	const d6Db = schema({
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			span: { type: 'int4range' },
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			status: 'text',
			score: 'integer',
			period: { type: 'daterange' },
			span: { type: 'int4range' },
			user_id: ref('users', { as: 'author' }),
		},
	});
	const d6 = createOrm({
		schema: d6Db,
		adapter: createPgCompileOnlyAdapter({ model: d6Db.model }),
		suppressDxWarnings: true,
	});
	const posts = d6.tables.posts;
	const q = () => d6.select('posts').columns(['id']);
	const RV = { lower: 1, upper: 5 };
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
	const invalid = (run: () => unknown, message: string) => {
		expect(run).toThrow(InvalidOperationError);
		expect(run).toThrow(message);
	};
	const referenceRefusal = (helper: string, kind: string) =>
		`Invalid ${helper}: ${kind} is not an expression argument; use literal(null), param(value) or an expression`;

	it('RF3 range column refusals: plain values, relation and callback ColumnRefs, expressions in the object form', () => {
		for (const [leaf, kind] of [
			[null, 'null'],
			[undefined, 'undefined'],
			[{}, 'a plain object'],
		] as const)
			invalid(
				() => rangeOverlaps(leaf as never, [1, 5], 'int4range'),
				referenceRefusal('rangeOverlaps', kind),
			);
		notYet(
			() => rangeOverlaps(posts.author.span, [1, 5], 'int4range'),
			'a relation-reached ColumnRef',
			'expression argument',
			1052,
		);
		notYet(
			() => rangeOverlaps(exprRef('span') as never, RV),
			'an expression',
			'range column',
			1065,
		);
		notYet(
			() => rangeOverlaps(fn('lower', 'title') as never, RV),
			'an expression',
			'range column',
			1065,
		);
		notYet(
			() => rangeOverlaps(null as never, RV),
			'null',
			'range column',
			1065,
		);
		notYet(
			() => rangeOverlaps(posts.author.span, RV),
			'a relation-reached ColumnRef',
			'range column',
			1052,
		);
		let captured: unknown;
		some(d6.tables.users.posts, (p) => {
			captured = p.span;
			return eq('id', 1);
		});
		notYet(
			() => rangeOverlaps(captured as never, RV),
			'a callback-scoped ColumnRef',
			'range column',
			1052,
		);
	});

	it('RF4 bounds refusal: anything but the four PostgreSQL forms', () => {
		invalid(
			() => rangeOverlaps('span', { ...RV, bounds: 'bogus' as never }),
			`Invalid rangeOverlaps: bounds must be one of '[)', '[]', '()', '(]'; got "bogus"`,
		);
		invalid(
			() => rangeOverlaps('span', { ...RV, bounds: '[[' as never }),
			`Invalid rangeOverlaps: bounds must be one of '[)', '[]', '()', '(]'; got "[["`,
		);
		invalid(
			() => rangeOverlaps('span', { ...RV, bounds: 3 as never }),
			`Invalid rangeOverlaps: bounds must be one of '[)', '[]', '()', '(]'; got 3`,
		);
	});

	it('RF5 range bound refusals: sql(), unfinished caseWhen, builders, relation refs and outerRef()', () => {
		const unfinished = caseWhen(eq('score', 1), literal('a'));
		for (const bound of [
			(b: unknown) => rangeOverlaps('span', [b, 5], 'int4range'),
			(b: unknown) => rangeOverlaps('span', { lower: b, upper: 5 }),
		]) {
			invalid(
				() => bound(sql('1')),
				'Invalid rangeOverlaps: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here',
			);
			invalid(
				() => bound(unfinished),
				'Invalid rangeOverlaps: caseWhen() is unfinished; complete it with .else(value) before using it as a value',
			);
			notYet(
				() => bound(d6.select('posts')),
				'a query builder',
				'expression argument',
				1053,
			);
			notYet(
				() => bound(posts.author.name),
				'a relation-reached ColumnRef',
				'expression argument',
				1052,
			);
		}
		notYet(
			() => rangeOverlaps('span', [outerRef('id'), 5], 'int4range'),
			'outerRef()',
			'expression argument',
			1029,
		);
		expect(() =>
			q()
				.where(rangeOverlaps('span', { lower: outerRef('id'), upper: 5 }))
				.dump(),
		).toThrow('outerRef() requires an enclosing query range.');
	});

	it('RF5i subquery bound in include where: include mode refuses a subquery', () => {
		const message =
			"compileExpressionIntent: 'subquery' expression kind requires ctx.compileSubquery to be set.";
		expect(() =>
			q()
				.include('author', {
					join: 'inner',
					where: rangeOverlaps('span', {
						lower: subquery('posts').max('score'),
						upper: 5,
					}),
				})
				.dump(),
		).toThrow(message);
		expect(() =>
			q()
				.include('author', {
					join: 'inner',
					where: rangeOverlaps('span', {
						lower: subquery('posts').count().asExpr('n'),
						upper: 5,
					}),
				})
				.dump(),
		).toThrow(message);
	});

	it('RF6 column refused by the range-type rule: no type, a non-range type, a multirange, arrays and modifiers', () => {
		const msg = (field: string, detail: string) =>
			`A range value { lower, upper } needs a column declared with a range type; '${field}' ${detail}. Declare the column's range type, or use the tuple form with a rangeType.`;
		const base = d6.select('posts').columns(['id', 'score']);
		expect(() =>
			d6
				.recursive('tree', { base, step: base })
				.where(rangeOverlaps('score', RV))
				.dump(),
		).toThrow(msg('score', 'has no declared type'));
		expect(() => q().where(rangeOverlaps('score', RV)).dump()).toThrow(
			msg('score', "is declared 'integer'"),
		);
		const typed = schema({
			t: {
				id: { type: 'integer', primaryKey: true },
				multi: { type: 'string', dbType: 'int4multirange' },
				customMulti: { type: 'string', dbType: 'ipmultirange' },
				int: { type: 'string', dbType: 'integer' },
				arr: { type: 'string', dbType: 'int4range[]' },
				mod: { type: 'string', dbType: 'ipspan(3)' },
			},
		});
		const torm = createOrm({
			schema: typed,
			adapter: createPgCompileOnlyAdapter({ model: typed.model }),
			suppressDxWarnings: true,
		});
		const compile = (column: string) => () =>
			torm.select('t').columns(['id']).where(rangeOverlaps(column, RV)).dump();
		expect(compile('multi')).toThrow(
			msg('multi', "is declared 'int4multirange'"),
		);
		expect(compile('customMulti')).toThrow(
			msg('customMulti', "is declared 'ipmultirange'"),
		);
		expect(compile('int')).toThrow(msg('int', "is declared 'integer'"));
		expect(compile('arr')).toThrow(msg('arr', "is declared 'int4range[]'"));
		expect(compile('mod')).toThrow(msg('mod', "is declared 'ipspan(3)'"));
	});

	it('RF11 default filter with a foreign bound: a subquery or another table is refused', () => {
		const tables = {
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				score: 'integer',
				span: { type: 'int4range' },
			},
		} as const;
		expect(() =>
			schema(tables, undefined, {
				defaultFilters: {
					posts: rangeOverlaps('span', {
						lower: subquery('posts').max('score'),
						upper: 5,
					}),
				},
			}),
		).toThrow("Default filter for table 'posts': forbidden operand 'subquery'");
		expect(() =>
			schema(tables, undefined, {
				defaultFilters: {
					posts: rangeOverlaps('span', {
						lower: exprRef('users.id'),
						upper: 5,
					}),
				},
			}),
		).toThrow(
			"Default filter for table 'posts': WHERE qualifier 'users' is not visible in this query.",
		);
	});

	it('RF14 unplanned read with a subquery bound: the default-filter walker refuses it', () => {
		const tables = {
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				score: 'integer',
				span: { type: 'int4range' },
			},
		} as const;
		const filtered = schema(tables, undefined, {
			defaultFilters: { users: eq('id', 7) },
		});
		const form = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
			suppressDxWarnings: true,
		});
		const base = form.select('posts').columns(['id', 'score', 'span']);
		const step = (bound: unknown) =>
			form
				.select('tree' as never)
				.columns(['id', 'score', 'span'])
				.where(
					rawExists(
						subquery('posts')
							.select('id')
							.where(rangeOverlaps('span', { lower: bound, upper: 6 })),
					),
				);
		expect(() =>
			form.recursive('tree', { base, step: step(subquery('users').max('id')) }),
		).toThrow("Default filter for table 'users' is not supported at raw CTE.");
		expect(
			form.recursive('tree', { base, step: step(param(5)) }).dump().params,
		).toEqual([5, 6]);
	});

	it('RF5 helper names: rangeContains and rangeContainedBy name themselves in their refusals', () => {
		for (const [helper, name] of [
			[rangeOverlaps, 'rangeOverlaps'],
			[rangeContains, 'rangeContains'],
			[rangeContainedBy, 'rangeContainedBy'],
		] as const) {
			const call = helper as (
				column: unknown,
				value: unknown,
				type?: string,
			) => unknown;
			invalid(
				() => call(null, [1, 5], 'int4range'),
				referenceRefusal(name, 'null'),
			);
			invalid(
				() => call('span', { ...RV, bounds: 'bogus' }),
				`Invalid ${name}: bounds must be one of '[)', '[]', '()', '(]'; got "bogus"`,
			);
			invalid(
				() => call('span', [sql('1'), 5], 'int4range'),
				`Invalid ${name}: sql() is only accepted as an update or upsert value; use literal(), param() or an expression here`,
			);
		}
	});

	it('RF6 refusal names the field as written and recognises qualified built-in and quoted multirange types', () => {
		const msg = (field: string, detail: string) =>
			`A range value { lower, upper } needs a column declared with a range type; '${field}' ${detail}. Declare the column's range type, or use the tuple form with a rangeType.`;
		expect(() => q().where(rangeOverlaps('posts.score', RV)).dump()).toThrow(
			msg('posts.score', "is declared 'integer'"),
		);
		const typed = schema({
			t: {
				id: { type: 'integer', primaryKey: true },
				catalogInt: { type: 'string', dbType: 'pg_catalog.int4' },
				quotedMulti: { type: 'string', dbType: '"Multirange"' },
			},
		});
		const torm = createOrm({
			schema: typed,
			adapter: createPgCompileOnlyAdapter({ model: typed.model }),
			suppressDxWarnings: true,
		});
		const compile = (column: string) => () =>
			torm.select('t').columns(['id']).where(rangeOverlaps(column, RV)).dump();
		expect(compile('catalogInt')).toThrow(
			msg('catalogInt', "is declared 'pg_catalog.int4'"),
		);
		expect(compile('quotedMulti')).toThrow(
			msg('quotedMulti', `is declared '"Multirange"'`),
		);
	});

	it('range bound ColumnRef in a nested relation body keeps the #1014 refusal', () => {
		const nodesDb = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				score: 'integer',
				span: { type: 'int4range' },
				parent_id: ref('nodes', {
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const norm = createOrm({
			schema: nodesDb,
			adapter: createPgCompileOnlyAdapter({ model: nodesDb.model }),
			suppressDxWarnings: true,
		});
		const nodes = norm.tables.nodes;
		const bound = caseWhen(eq(nodes.parent.score, 1), literal(1)).else(
			literal(2),
		);
		const refusal =
			"ColumnRef 'parent.score' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1014).";
		expect(() =>
			norm
				.select('nodes')
				.columns(['id'])
				.where(
					exists('children', {
						where: rangeOverlaps('span', { lower: bound, upper: 5 }),
					}),
				)
				.dump(),
		).toThrow(refusal);
		expect(() =>
			norm
				.update('nodes')
				.set({ score: 2 })
				.where(
					exists('children', {
						where: rangeOverlaps('span', { lower: 1, upper: bound }),
					}),
				)
				.dump(),
		).toThrow(refusal);
	});

	it('RF14 a plain bound object is data for the unplanned-read walker', () => {
		const tables = {
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				score: 'integer',
				span: { type: 'int4range' },
			},
		} as const;
		const filtered = schema(tables, undefined, {
			defaultFilters: { users: eq('id', 7) },
		});
		const form = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
			suppressDxWarnings: true,
		});
		const base = form.select('posts').columns(['id', 'score', 'span']);
		const bound = { from: 'users', table: 'users', value: 1 };
		const step = form
			.select('tree' as never)
			.columns(['id', 'score', 'span'])
			.where(
				rawExists(
					subquery('posts')
						.select('id')
						.where(rangeOverlaps('span', { lower: bound, upper: 6 })),
				),
			);
		expect(form.recursive('tree', { base, step }).dump().params).toEqual([
			bound,
			6,
		]);
	});
});
