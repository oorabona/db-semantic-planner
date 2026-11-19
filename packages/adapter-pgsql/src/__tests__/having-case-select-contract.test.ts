import {
	and,
	any,
	caseWhen,
	createOrm,
	distinct,
	ExpressionRef,
	eq,
	exists,
	exprRef,
	fn,
	gt,
	inArray,
	inSubquery,
	isNull,
	like,
	literal,
	not,
	op,
	outerRef,
	rangeOverlaps,
	rawExists,
	ref,
	SubqueryExpression,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import type { QueryIntent, WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { resolveCaseValue } from '../handlers/expression/case-value.js';
import { createCompilerState } from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	symbols: { id: { type: 'integer', primaryKey: true }, period: 'daterange' },
	calls: {
		id: { type: 'integer', primaryKey: true },
		symbolId: ref('symbols', { as: 'symbol' }),
		score: 'integer',
		period: 'tsrange',
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const correlated = () =>
	subquery('calls')
		.where(and(eq('symbolId', outerRef('id')), eq('score', 7)))
		.count()
		.asExpr('callCount');

it('columns scalar subquery binds the enclosing range', () => {
	const result = orm.select('symbols').columns(['id', correlated()]).dump();
	expect(result.sql).toBe(
		'SELECT symbols.id, (SELECT count(*) FROM calls AS calls WHERE calls."symbolId" = symbols.id AND calls.score = $1) AS "callCount" FROM symbols',
	);
	expect(result.params).toEqual([7]);
});
it('op nested scalar subquery binds the enclosing range', () => {
	const result = orm
		.select('symbols')
		.columns([op('+', correlated(), literal(1)).as('next')])
		.dump();
	expect(result.sql).toBe(
		'SELECT (SELECT count(*) FROM calls AS calls WHERE calls."symbolId" = symbols.id AND calls.score = $1) + 1 AS next FROM symbols',
	);
	expect(result.params).toEqual([7]);
});
it('compileSelectExpression nested scalar binds its enclosing subquery range', () => {
	const result = adapter.compileSelectExpression({
		kind: 'subquery',
		query: {
			type: 'select',
			from: 'symbols',
			select: { type: 'expressions', columns: [correlated().intent] },
		},
	});
	expect(result.sql).toBe(
		'SELECT (SELECT (SELECT count(*) FROM calls AS calls WHERE calls."symbolId" = symbols.id AND calls.score = $1) AS "callCount" FROM symbols)',
	);
	expect(result.parameters).toEqual([7]);
});
it('SELECT expression ambiguous qualified outerRef is refused', () => {
	const expr = subquery('calls')
		.where(eq('symbolId', outerRef('symbols.id')))
		.count()
		.asExpr('n');
	expect(() =>
		orm
			.select('calls')
			.join('symbols', { as: 'caller', on: eq('calls.id', 1) })
			.join('symbols', { as: 'callee', on: eq('calls.id', 2) })
			.columns([expr])
			.dump(),
	).toThrow(
		"outerRef qualifier 'symbols' is ambiguous between 'callee', 'caller' in an enclosing query.",
	);
});
it('HAVING alias refuses a range condition', () => {
	expect(() =>
		orm
			.select('symbols')
			.count({ as: 'n' })
			.groupBy(['id'])
			.having(rangeOverlaps('n', { lower: '2026-01-01', upper: '2026-02-01' }))
			.dump(),
	).toThrow(
		"HAVING alias 'n' names an aggregate; a range condition does not apply to it.",
	);
});
for (const position of ['columns', 'orderBy'] as const) {
	it(`CASE WHEN ${position} retains the range column cast`, () => {
		const expr = caseWhen(
			and(
				rangeOverlaps('period', { lower: '2026-01-01', upper: '2026-02-01' }),
				eq('id', 3),
			),
			literal(1),
		)
			.else(literal(0))
			.as('rank');
		const query = orm.select('symbols');
		const result = (
			position === 'columns' ? query.columns([expr]) : query.orderBy(expr)
		).dump();
		expect(result.sql).toContain('symbols.period && CAST($1 AS daterange)');
		expect(result.params).toEqual(['[2026-01-01,2026-02-01)', 3]);
	});
}

it('CASE in a subquery body uses the child logical source and emitted alias', () => {
	const condition = caseWhen(
		and(
			rangeOverlaps('period', { lower: '2026-01-01', upper: '2026-02-01' }),
			eq('score', 4),
		),
		literal(1),
	).else(literal(0));
	const result = orm
		.select('symbols')
		.where(
			inSubquery(
				'id',
				subquery('calls').select('symbolId').where(condition.eq(1)),
			),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT symbols.* FROM symbols WHERE EXISTS (SELECT 1 FROM calls AS calls_exists_0 WHERE symbols.id = calls_exists_0."symbolId" AND CASE WHEN calls_exists_0.period && CAST($1 AS tsrange) AND calls_exists_0.score = $2 THEN 1 ELSE 0 END = $3)',
	);
	expect(result.params).toEqual(['[2026-01-01,2026-02-01)', 4, 1]);
});
it('nested SELECT CASE uses its own source and reserved alias', () => {
	const condition = rangeOverlaps('period', {
		lower: '2026-01-01',
		upper: '2026-02-01',
	});
	const result = adapter.compileSelectExpression({
		kind: 'subquery',
		query: {
			type: 'select',
			from: 'calls',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'subquery',
						query: {
							type: 'select',
							from: 'symbols',
							select: {
								type: 'expressions',
								columns: [
									{
										kind: 'subquery',
										query: {
											type: 'select',
											from: 'calls',
											select: {
												type: 'expressions',
												columns: [
													caseWhen(and(condition, eq('score', 4)), literal(1))
														.else(literal(0))
														.as('rank').intent,
												],
											},
										},
									},
								],
							},
						},
					},
				],
			},
		},
	});
	expect(result.sql).toBe(
		'SELECT (SELECT (SELECT (SELECT CASE WHEN calls_sq.period && CAST($1 AS tsrange) AND calls_sq.score = $2 THEN 1 ELSE 0 END AS rank FROM calls AS calls_sq) FROM symbols AS symbols) FROM calls)',
	);
	expect(result.parameters).toEqual(['[2026-01-01,2026-02-01)', 4]);
});

it('nested SELECT HAVING uses its own logical source', () => {
	const condition = rangeOverlaps('period', {
		lower: '2026-01-01',
		upper: '2026-02-01',
	});
	const result = adapter.compileSelectExpression({
		kind: 'subquery',
		query: {
			type: 'select',
			from: 'symbols',
			select: {
				type: 'expressions',
				columns: [
					{
						kind: 'subquery',
						query: {
							type: 'select',
							from: 'calls',
							select: { type: 'fields', fields: ['period'] },
							groupBy: ['period'],
							having: condition,
						},
					},
				],
			},
		},
	});
	expect(result.sql).toBe(
		'SELECT (SELECT (SELECT calls.period FROM calls AS calls GROUP BY calls.period HAVING calls.period && CAST($1 AS tsrange)) FROM symbols)',
	);
	expect(result.parameters).toEqual(['[2026-01-01,2026-02-01)']);
});

for (const field of ['id', 'calls.id']) {
	it(`FROM-less SELECT refuses outerRef('${field}') without an enclosing query`, () => {
		expect(() =>
			adapter.compileSelectExpression(
				subquery('calls')
					.where(eq('symbolId', outerRef(field)))
					.count()
					.asExpr('n').intent,
			),
		).toThrow('outerRef() requires an enclosing query range.');
	});
}
it('HAVING alias resolves through nested CASE conditions', () => {
	const condition = caseWhen(eq('n', 1), literal(true)).else(literal(false));
	const result = orm
		.select('symbols')
		.count({ as: 'n' })
		.groupBy(['id'])
		.having(
			caseWhen(condition.eq(true), literal(true)).else(literal(false)).eq(true),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT symbols.id, count(*) AS n FROM symbols GROUP BY symbols.id HAVING CASE WHEN CASE WHEN count(*) = CAST($1 AS bigint) THEN true ELSE false END = $2 THEN true ELSE false END = $3',
	);
	expect(result.params).toEqual([1, true, true]);
});
it('CASE outside HAVING refuses an aggregate alias', () => {
	expect(() =>
		orm
			.select('symbols')
			.count({ as: 'n' })
			.orderBy(
				caseWhen(eq('n', 1), literal(true)).else(literal(false)).as('flag'),
			)
			.dump(),
	).toThrow("Declared column 'symbols.n' is absent from the physical model.");
});
for (const position of ['HAVING', 'CASE WHEN'] as const) {
	it(`${position} recursive condition refusal names its position`, () => {
		const condition = exists('calls', {
			recursive: { direction: 'down', through: 'calls', maxDepth: 2 },
		});
		expect(() =>
			position === 'HAVING'
				? adapter.compileSelectExpression({
						kind: 'subquery',
						query: { type: 'select', from: 'symbols', having: condition },
					})
				: orm
						.select('symbols')
						.columns([
							caseWhen(condition, literal(1)).else(literal(0)).as('flag'),
						])
						.dump(),
		).toThrow(
			`${position} exists('calls'): recursive relation predicates are not supported inside ${position}.`,
		);
	});
}

for (const position of ['HAVING', 'CASE WHEN'] as const) {
	it(`${position} operator refusal names its position`, () => {
		const condition = {
			...eq('id', 1),
			operator: 'invalid',
		} as unknown as ReturnType<typeof eq>;
		expect(() =>
			position === 'HAVING'
				? orm
						.select('symbols')
						.count({ as: 'n' })
						.groupBy(['id'])
						.having(condition)
						.dump()
				: orm
						.select('symbols')
						.columns([
							caseWhen(condition, literal(1)).else(literal(0)).as('flag'),
						])
						.dump(),
		).toThrow(`No ${position} handler registered for operator: invalid`);
	});
}

for (const position of ['CASE', 'HAVING', 'FILTER'] as const) {
	it(`${position} outer references resolve across an inner table collision and reject ambiguity`, () => {
		for (const qualifier of ['symbols', 'caller', undefined]) {
			const condition = eq(
				'id',
				outerRef(qualifier ? `${qualifier}.id` : 'id'),
			);
			const inner = {
				type: 'select' as const,
				from: 'symbols',
				...(position === 'CASE'
					? {
							where: caseWhen(condition, literal(true))
								.else(literal(false))
								.eq(true),
						}
					: {}),
				...(position === 'HAVING' ? { having: condition } : {}),
				select: {
					type: 'expressions' as const,
					columns: [
						position === 'FILTER'
							? fn('count', star()).filter(condition).intent
							: fn('count', star()).intent,
					],
				},
			};
			const expr = new ExpressionRef({ kind: 'subquery', query: inner }).as(
				'n',
			);
			const query = orm
				.select('calls')
				.join('symbols', { as: 'caller', on: eq('calls.id', 1) });
			const result = query.columns([expr]).dump();
			const sql =
				position === 'CASE'
					? 'SELECT (SELECT count(*) FROM symbols AS symbols WHERE CASE WHEN symbols.id = caller.id THEN true ELSE false END = $1) AS n FROM calls JOIN symbols AS caller ON calls.id = $2'
					: position === 'HAVING'
						? 'SELECT (SELECT count(*) FROM symbols AS symbols HAVING symbols.id = caller.id) AS n FROM calls JOIN symbols AS caller ON calls.id = $1'
						: 'SELECT (SELECT count(*) FILTER (WHERE symbols.id = caller.id) FROM symbols AS symbols) AS n FROM calls JOIN symbols AS caller ON calls.id = $1';
			expect
				.soft(result.sql)
				.toBe(qualifier ? sql : sql.replace('caller.id', 'calls.id'));
			expect.soft(result.params).toEqual(position === 'CASE' ? [true, 1] : [1]);
			if (qualifier === 'symbols') {
				expect
					.soft(() =>
						query
							.join('symbols', { as: 'callee', on: eq('calls.id', 2) })
							.columns([expr])
							.dump(),
					)
					.toThrow(
						"outerRef qualifier 'symbols' is ambiguous between 'callee', 'caller' in an enclosing query.",
					);
			}
		}
	});
}
it('CASE THEN ELSE multi-branch and nested values refuse all non-finite numbers', () => {
	for (const value of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	]) {
		for (const branch of ['THEN', 'ELSE', 'multi', 'nested'] as const) {
			const safe = caseWhen(eq('id', 1), literal(0));
			const expr =
				branch === 'THEN'
					? caseWhen(eq('id', 1), literal(value)).else(literal(0))
					: branch === 'ELSE'
						? safe.else(literal(value))
						: branch === 'multi'
							? safe.when(eq('id', 2), literal(value)).else(literal(0))
							: safe.else(
									caseWhen(eq('id', 2), literal(value)).else(literal(0)),
								);
			expect
				.soft(() =>
					orm
						.select('symbols')
						.columns([op('+', expr, literal(1)).as('n')])
						.dump(),
				)
				.toThrow(
					`literal(): numeric value must be finite; got ${value}. Use param() for computed values.`,
				);
		}
	}
});
it('CASE arithmetic refuses forged string and object operators', () => {
	for (const operator of [
		'+ (SELECT pg_sleep(1)) +',
		'||',
		{ toString: () => '+' },
	]) {
		const forged = {
			kind: 'arithmetic' as const,
			operator,
			left: literal(1).intent,
			right: literal(2).intent,
		};
		expect
			.soft(() =>
				orm
					.select('symbols')
					.columns([
						caseWhen(
							eq('id', 1),
							new ExpressionRef(
								forged as unknown as ConstructorParameters<
									typeof ExpressionRef
								>[0],
							),
						)
							.else(literal(0))
							.as('n'),
					])
					.dump(),
			)
			.toThrow(
				typeof operator === 'string'
					? 'Invalid arithmetic operator. Only +, -, *, /, % are allowed.'
					: 'Invalid arithmetic operator: expected a string, got object. Operator must be a plain string value.',
			);
	}
});
it('CASE arithmetic snapshots the operator once', () => {
	let reads = 0;
	const forged = {
		kind: 'arithmetic' as const,
		get operator() {
			return ++reads === 1 ? '+' : '+ (SELECT pg_sleep(1)) +';
		},
		left: literal(1).intent,
		right: literal(2).intent,
	};
	const result = resolveCaseValue(
		forged,
		'symbols',
		undefined,
		undefined,
		createCompilerState(),
	);
	expect(result).toHaveProperty('A_Expr.name', [{ String: { sval: '+' } }]);
	expect(reads).toBe(1);
});
it('FILTER nested in HAVING labels recursive refusal FILTER', () => {
	const condition = exists('calls', {
		recursive: { direction: 'down', through: 'calls', maxDepth: 2 },
	});
	expect
		.soft(() =>
			orm
				.select('symbols')
				.groupBy(['id'])
				.having(fn('count', star()).filter(condition).gt(1))
				.dump(),
		)
		.toThrow(
			"FILTER exists('calls'): recursive relation predicates are not supported inside FILTER.",
		);
});

it('CASE structured comparison branch is refused by kind instead of bound', () => {
	const comparisonIntent = {
		kind: 'comparison' as const,
		column: 'id',
		operator: '>' as const,
		value: 0,
	};
	expect(() =>
		orm
			.select('symbols')
			.columns([
				op(
					'+',
					caseWhen(eq('id', 1), new ExpressionRef(comparisonIntent)).else(0),
					literal(1),
				).as('n'),
			])
			.dump(),
	).toThrow(
		"compileExpressionIntent: unsupported expression kind 'comparison'",
	);
});

it('CASE JSON object literal branch binds as one parameter', () => {
	const value = { kind: 'comparison', column: 'id', operator: '>', value: 0 };
	const result = orm
		.select('symbols')
		.columns([
			op(
				'+',
				caseWhen(
					eq('id', 1),
					// Exercise the resolver's JSON literal contract beyond the scalar DX type.
					new ExpressionRef({
						kind: 'literal',
						value,
					} as unknown as ConstructorParameters<typeof ExpressionRef>[0]),
				).else(0),
				literal(1),
			).as('n'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT CASE WHEN symbols.id = $1 THEN $2 ELSE 0 END + 1 AS n FROM symbols',
	);
	expect(result.params).toEqual([1, value]);
});

it('FILTER nested in HAVING labels invalid operator refusal FILTER', () => {
	const condition = {
		...eq('id', 1),
		operator: 'invalid',
	} as unknown as ReturnType<typeof eq>;
	expect(() =>
		orm
			.select('symbols')
			.groupBy(['id'])
			.having(fn('count', star()).filter(condition).gt(1))
			.dump(),
	).toThrow('No FILTER handler registered for operator: invalid');
});

describe('#891 slice 3: labels, qualifiers and HAVING dotted fields', () => {
	const tables = {
		users: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			authorId: ref('users', { as: 'author', inverse: 'posts' }),
		},
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			deletedAt: { type: 'timestamp', nullable: true },
			parentId: ref('categories', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	} as const;
	const plainDb = schema(tables);
	const filteredDb = schema(tables, undefined, {
		defaultFilters: {
			posts: isNull('deletedAt'),
			categories: isNull('deletedAt'),
		},
	});
	const plain = createOrm({
		schema: plainDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	const filtered = createOrm({
		schema: filteredDb,
		adapter: createPgCompileOnlyAdapter(),
		suppressDxWarnings: true,
	});
	const orms = [
		['plain', plain],
		['default filters', filtered],
	] as const;
	const recursive = () =>
		exists('children', {
			recursive: { direction: 'down', through: 'children' },
		}) as WhereIntent;
	const refusal = (label: string) =>
		`${label} exists('children'): recursive relation predicates are not supported inside ${label}.`;
	const titled = (on: boolean) =>
		`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId"${on ? ' AND posts_exists_0."deletedAt" IS NULL' : ''} AND posts_exists_0.title = $1)`;

	for (const [name, o] of orms) {
		it(`AC4 refusals name the innermost condition root (${name})`, () => {
			const categories = () => o.select('categories');
			expect(() =>
				categories()
					.groupBy(['id'])
					.count('id', 'n')
					.having(recursive())
					.dump(),
			).toThrow(refusal('HAVING'));
			expect(() =>
				categories()
					.columns([caseWhen(recursive(), literal(1)).else(literal(0)).as('f')])
					.dump(),
			).toThrow(refusal('CASE WHEN'));
			expect(() =>
				categories()
					.columns([fn('count', star()).filter(recursive()).as('n')])
					.dump(),
			).toThrow(refusal('FILTER'));
			expect(() =>
				categories()
					.groupBy(['id'])
					.having(fn('count', star()).filter(recursive()).gt(1))
					.dump(),
			).toThrow(refusal('FILTER'));
			// A CASE inside a relation body inside a FILTER takes the FILTER's label.
			expect(() =>
				categories()
					.columns([
						fn('count', star())
							.filter(
								exists('children', {
									where: caseWhen(recursive(), literal(1))
										.else(literal(0))
										.eq(1),
								}),
							)
							.as('n'),
					])
					.dump(),
			).toThrow(refusal('FILTER'));
			// A FILTER wrapping not(...) inside a CASE condition is the innermost root.
			expect(() =>
				categories()
					.groupBy(['id'])
					.columns([
						'id',
						caseWhen(
							fn('count', star()).filter(not(recursive())).gt(1),
							literal(1),
						)
							.else(literal(0))
							.as('f'),
					])
					.dump(),
			).toThrow(refusal('FILTER'));
			// A CASE absorbed as the right operand of a resolved dotted comparison.
			expect(() =>
				categories()
					.columns([
						fn('count', star())
							.filter(
								eq(
									'categories.id',
									caseWhen(recursive(), literal(1)).else(literal(0)),
								),
							)
							.as('n'),
					])
					.dump(),
			).toThrow(refusal('FILTER'));
		});

		it(`AC1 a dotted HAVING field compiles to the root WHERE's EXISTS (${name})`, () => {
			const on = o === filtered;
			const users = () => o.select('users').groupBy(['id']);
			const dotted = () => eq('posts.title', 'x');
			expect(users().having(dotted()).dump()).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING ${titled(on)}`,
				params: ['x'],
			});
			expect(users().count('id', 'n').having(dotted()).dump()).toMatchObject({
				sql: `SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING ${titled(on)}`,
				params: ['x'],
			});
			expect(
				users().having(fn('count', star()).filter(dotted()).gt(19)).dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE ${titled(on)}) > $2`,
				params: ['x', 19],
			});
			expect(
				o.nql`users | group by id | where posts.title = 'x'`.dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING ${titled(on)}`,
				params: ['x'],
			});
		});

		it(`AC2 a dotted path in a CASE in HAVING compiles to the root WHERE's EXISTS (${name})`, () => {
			expect(
				o
					.select('users')
					.groupBy(['id'])
					.having(
						caseWhen(eq('posts.title', 'x'), literal(1)).else(literal(0)).eq(1),
					)
					.dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING CASE WHEN ${titled(o === filtered)} THEN 1 ELSE 0 END = $2`,
				params: ['x', 1],
			});
		});

		it(`AC3 an aggregate alias names its aggregate before a range or a path (${name})`, () => {
			const users = () => o.select('users').groupBy(['id']);
			for (const alias of ['stats.total', 'users.id']) {
				expect(
					users().count('id', alias).having(gt(alias, 1)).dump(),
				).toMatchObject({
					sql: `SELECT users.id, count(users.id) AS "${alias}" FROM users GROUP BY users.id HAVING count(users.id) > CAST($1 AS bigint)`,
					params: [1],
				});
				expect(
					users()
						.count('id', alias)
						.having(
							caseWhen(gt(alias, 1), literal(true))
								.else(literal(false))
								.eq(true),
						)
						.dump(),
				).toMatchObject({
					sql: `SELECT users.id, count(users.id) AS "${alias}" FROM users GROUP BY users.id HAVING CASE WHEN count(users.id) > CAST($1 AS bigint) THEN true ELSE false END = $2`,
					params: [1, true],
				});
			}
			// Inside a CASE in a qualified comparison's operand.
			expect(
				users()
					.count('id', 'stats.total')
					.having(
						eq(
							'users.id',
							caseWhen(gt('stats.total', 1), literal(1)).else(literal(0)),
						),
					)
					.dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(users.id) AS "stats.total" FROM users GROUP BY users.id HAVING users.id = CASE WHEN count(users.id) > CAST($1 AS bigint) THEN 1 ELSE 0 END',
				params: [1],
			});
			// An aggregate column of the select names its aggregate too.
			expect(
				users()
					.columns([
						'id',
						new ExpressionRef({
							kind: 'aggregate',
							function: 'count',
							field: 'id',
							as: 'stats.total',
						}),
					])
					.having(gt('stats.total', 1))
					.dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(users.id) AS "stats.total" FROM users GROUP BY users.id HAVING count(users.id) > CAST($1 AS bigint)',
				params: [1],
			});
		});

		it(`AC3 a DISTINCT count alias keeps DISTINCT in HAVING, from the builder and from a column (${name})`, () => {
			const expected = {
				sql: 'SELECT users.id, count(DISTINCT users.name) AS n FROM users GROUP BY users.id HAVING count(DISTINCT users.name) > CAST($1 AS bigint)',
				params: [1],
			};
			expect(
				o
					.select('users')
					.groupBy(['id'])
					.count(distinct('name'), 'n')
					.having(gt('n', 1))
					.dump(),
			).toMatchObject(expected);
			expect(
				o
					.select('users')
					.columns([
						'id',
						new ExpressionRef({
							kind: 'aggregate',
							function: 'count',
							field: 'name',
							distinct: true,
							as: 'n',
						}),
					])
					.groupBy(['id'])
					.having(gt('n', 1))
					.dump(),
			).toMatchObject(expected);
		});

		it(`AC4 a literal SELECT alias spelled like a path resolves as the path (${name})`, () => {
			expect(
				o
					.select('users')
					.groupBy(['id'])
					.columns(['id', literal('x').as('posts.title')])
					.having(eq('posts.title', 'x'))
					.dump(),
			).toMatchObject({
				sql: `SELECT users.id, 'x' AS "posts.title" FROM users GROUP BY users.id HAVING ${titled(o === filtered)}`,
				params: ['x'],
			});
		});

		it(`AC5 a dotted HAVING field naming the root keeps its column (${name})`, () => {
			expect(
				o.select('users').groupBy(['id']).having(eq('users.name', 'x')).dump(),
			).toMatchObject({
				sql: 'SELECT users.* FROM users GROUP BY users.id HAVING users.name = $1',
				params: ['x'],
			});
		});

		it(`AC8 a shared object naming an alias in HAVING and a column in an ORDER BY CASE keeps its SQL (${name})`, () => {
			const users = () => o.select('users').groupBy(['id']);
			const shared = gt('users.id', 1);
			const expected = {
				sql: 'SELECT users.id, count(users.id) AS "users.id" FROM users GROUP BY users.id HAVING count(users.id) > CAST($1 AS bigint) ORDER BY CASE WHEN users.id > $2 THEN 1 ELSE 0 END ASC',
				params: [1, 1],
			};
			expect(
				users()
					.count('id', 'users.id')
					.having(shared)
					.orderBy(caseWhen(shared, literal(1)).else(literal(0)))
					.dump(),
			).toMatchObject(expected);
			expect(
				users()
					.count('id', 'users.id')
					.having(gt('users.id', 1))
					.orderBy(caseWhen(gt('users.id', 1), literal(1)).else(literal(0)))
					.dump(),
			).toMatchObject(expected);
		});

		it(`AC8 a repeated dotted path in one HAVING compiles both occurrences as EXISTS (${name})`, () => {
			const c = eq('posts.title', 'x');
			const exists = (index: number, param: number) =>
				titled(o === filtered)
					.replaceAll('posts_exists_0', `posts_exists_${index}`)
					.replace('$1', `$${param}`);
			expect(
				o.select('users').groupBy(['id']).having(and(c, c)).dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING ${exists(0, 1)} AND ${exists(1, 2)}`,
				params: ['x', 'x'],
			});
		});
	}

	describe('aggregate aliases in HAVING (#1005)', () => {
		const users = () => plain.select('users').groupBy(['id']);
		const filteredCount = () =>
			new ExpressionRef({
				kind: 'aggregate',
				function: 'count',
				field: '*',
				as: 'n',
				filter: eq('score', 1),
			});

		it('AC3c a filtered aggregate alias compares with its FILTER', () => {
			expect(
				users().columns(['id', filteredCount()]).having(gt('n', 0)).dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(*) FILTER (WHERE users.score = $1) AS n FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE users.score = $2) > CAST($3 AS bigint)',
				params: [1, 1, 0],
			});
			expect(
				users()
					.columns(['id', filteredCount()])
					.having(inArray('n', [1, 2]))
					.dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(*) FILTER (WHERE users.score = $1) AS n FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE users.score = $2) = ANY (CAST($3 AS bigint[]))',
				params: [1, 1, [1, 2]],
			});
		});

		it('AC3c an expression operand naming an alias compiles to that aggregate', () => {
			expect(
				users()
					.columns([
						'id',
						new ExpressionRef({
							kind: 'aggregate',
							function: 'count',
							field: 'id',
							as: 'n',
						}),
						new ExpressionRef({
							kind: 'aggregate',
							function: 'sum',
							field: 'score',
							as: 's',
						}),
					])
					.having(gt('n', exprRef('s')))
					.dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(users.id) AS n, sum(users.score) AS s FROM users GROUP BY users.id HAVING count(users.id) > sum(users.score)',
				params: [],
			});
		});

		it('AC3b every filter operator on an aggregate alias takes the aggregate as left operand', () => {
			for (const alias of ['stats.total', 'n']) {
				const head = `SELECT users.id, count(users.id) AS ${alias === 'n' ? 'n' : `"${alias}"`} FROM users GROUP BY users.id HAVING`;
				const counted = () => users().count('id', alias);
				expect(
					counted()
						.having(inArray(alias, [1, 2]))
						.dump(),
				).toMatchObject({
					sql: `${head} count(users.id) = ANY (CAST($1 AS bigint[]))`,
					params: [[1, 2]],
				});
				expect(
					counted()
						.having(any(alias, [1, 2]))
						.dump(),
				).toMatchObject({
					sql: `${head} count(users.id) = ANY (CAST($1 AS bigint[]))`,
					params: [[1, 2]],
				});
				expect(counted().having(isNull(alias)).dump()).toMatchObject({
					sql: `${head} count(users.id) IS NULL`,
					params: [],
				});
				expect(
					counted()
						.having(inSubquery(alias, subquery('posts').select('authorId')))
						.dump(),
				).toMatchObject({
					sql: `${head} count(users.id) = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0)`,
					params: [],
				});
				expect(
					counted()
						.having({
							kind: 'subquery',
							field: alias,
							operator: 'gt',
							subquery: subquery('posts').max('id').toIntent(),
						} as WhereIntent)
						.dump(),
				).toMatchObject({
					sql: `${head} count(users.id) > (SELECT max(posts_subq_0.id) FROM posts AS posts_subq_0)`,
					params: [],
				});
			}
		});

		it('AC3b a field-less count alias is count(*)', () => {
			expect(
				users().count({ as: 'n' }).having(gt('n', 1)).dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(*) AS n FROM users GROUP BY users.id HAVING count(*) > CAST($1 AS bigint)',
				params: [1],
			});
		});

		it('AC3b like, range and JSON conditions on an aggregate alias are refused', () => {
			const refusal = (kind: string) =>
				`HAVING alias 'n' names an aggregate; a ${kind} condition does not apply to it.`;
			const counted = () => users().count('id', 'n');
			expect(() => counted().having(like('n', '1%')).dump()).toThrow(
				refusal('like'),
			);
			expect(() =>
				counted()
					.having(rangeOverlaps('n', { lower: 1, upper: 3 }))
					.dump(),
			).toThrow(refusal('range'));
			expect(() =>
				counted()
					.having({
						kind: 'jsonContains',
						field: 'n',
						value: { a: 1 },
						reversed: false,
					} as WhereIntent)
					.dump(),
			).toThrow(refusal('jsonContains'));
			expect(() =>
				counted()
					.having({ kind: 'jsonExists', field: 'n', key: 'a' } as WhereIntent)
					.dump(),
			).toThrow(refusal('jsonExists'));
		});

		it('AC3b an aggregate alias inside a FILTER in HAVING gets the root WHERE refusal', () => {
			const whereRefusal =
				"exists('stats'): no relation 'stats' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.";
			expect(() =>
				plain.select('users').where(eq('stats.total', 1)).dump(),
			).toThrow(whereRefusal);
			expect(() =>
				users()
					.count('id', 'stats.total')
					.having(fn('count', star()).filter(gt('stats.total', 1)).gt(1))
					.dump(),
			).toThrow(whereRefusal);
		});

		it('AC3b a name equal to an aggregate alias inside a subquery body is the body column', () => {
			expect(
				users()
					.count('id', 'title')
					.having(
						inSubquery(
							'title',
							subquery('posts').select('authorId').where(eq('title', 'x')),
						),
					)
					.dump(),
			).toMatchObject({
				sql: 'SELECT users.id, count(users.id) AS title FROM users GROUP BY users.id HAVING count(users.id) = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0 WHERE posts_subq_0.title = $1)',
				params: ['x'],
			});
		});

		it('AC3d a refusal inside a CASE in HAVING carries CASE WHEN, absorbed or not', () => {
			const refusal =
				"CASE WHEN qualifier 'nope' is not visible in this query.";
			const kase = () =>
				caseWhen(eq('users.id', exprRef('nope.id')), literal(1)).else(
					literal(0),
				);
			expect(() => users().having(kase().eq(1)).dump()).toThrow(refusal);
			expect(() => users().having(eq('users.id', kase())).dump()).toThrow(
				refusal,
			);
		});

		it('AC6 an unknown dotted HAVING field gets the root WHERE refusal', () => {
			const refusal =
				"exists('nope'): no relation 'nope' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.";
			expect(() => plain.select('users').where(eq('nope.x', 1)).dump()).toThrow(
				refusal,
			);
			expect(() => users().having(eq('nope.x', 1)).dump()).toThrow(refusal);
		});

		it('AC8 a HAVING condition that is the root default filter compiles like a separate object', () => {
			const c = eq('id', 1);
			const o = createOrm({
				schema: schema(tables, undefined, { defaultFilters: { users: c } }),
				adapter: createPgCompileOnlyAdapter(),
				suppressDxWarnings: true,
			});
			const expected = {
				sql: 'SELECT users.* FROM users WHERE users.id = $1 GROUP BY users.id HAVING users.id = $2',
				params: [1, 1],
			};
			expect(o.select('users').groupBy(['id']).having(c).dump()).toMatchObject(
				expected,
			);
			expect(
				o.select('users').groupBy(['id']).having(eq('id', 1)).dump(),
			).toMatchObject(expected);
		});
	});

	describe('a shared condition compiles per occurrence (#1005)', () => {
		const users = () => plain.select('users');
		const title = () => eq('posts.title', 'x');
		/** Same SQL and parameters whether one object fills both positions or two do. */
		const samePerOccurrence = (
			build: (
				first: WhereIntent,
				second: WhereIntent,
			) => {
				dump(): { sql: string; params: readonly unknown[] };
			},
			expected: string,
		) => {
			const shared = title();
			const one = build(shared, shared).dump();
			const two = build(title(), title()).dump();
			expect(one).toMatchObject({ sql: expected, params: ['x', 'x'] });
			expect(two).toMatchObject({ sql: expected, params: ['x', 'x'] });
		};
		const at = (index: number, param: number) =>
			`EXISTS (SELECT 1 FROM posts AS posts_exists_${index} WHERE users.id = posts_exists_${index}."authorId" AND posts_exists_${index}.title = $${param})`;

		it('AC7 WHERE and HAVING', () => {
			samePerOccurrence(
				(a, b) => users().where(a).groupBy(['id']).having(b),
				`SELECT users.* FROM users WHERE ${at(0, 1)} GROUP BY users.id HAVING ${at(1, 2)}`,
			);
		});

		it('AC7 HAVING and an aggregate FILTER', () => {
			samePerOccurrence(
				(a, b) =>
					users()
						.groupBy(['id'])
						.columns(['id', fn('count', star()).filter(a).as('n')])
						.having(b),
				`SELECT users.id, count(*) FILTER (WHERE ${at(0, 1)}) AS n FROM users GROUP BY users.id HAVING ${at(1, 2)}`,
			);
		});

		it('AC7 HAVING and a CASE in ORDER BY', () => {
			samePerOccurrence(
				(a, b) =>
					users()
						.groupBy(['id'])
						.having(a)
						.orderBy(caseWhen(b, literal(1)).else(literal(0))),
				`SELECT users.* FROM users GROUP BY users.id HAVING ${at(1, 1)} ORDER BY CASE WHEN ${at(0, 2)} THEN 1 ELSE 0 END ASC`,
			);
		});

		it('AC7 HAVING and a frozen CASE expression holding the condition', () => {
			const kase = (c: WhereIntent) => caseWhen(c, literal(1)).else(literal(0));
			expect(Object.isFrozen(kase(title()).intent)).toBe(true);
			samePerOccurrence(
				(a, b) => users().groupBy(['id']).having(a).orderBy(kase(b)),
				`SELECT users.* FROM users GROUP BY users.id HAVING ${at(1, 1)} ORDER BY CASE WHEN ${at(0, 2)} THEN 1 ELSE 0 END ASC`,
			);
		});

		it('AC7 a CASE in SELECT and an aggregate FILTER', () => {
			samePerOccurrence(
				(a, b) =>
					users()
						.groupBy(['id'])
						.columns([
							'id',
							caseWhen(a, literal(1)).else(literal(0)).as('f'),
							fn('count', star()).filter(b).as('n'),
						]),
				`SELECT users.id, CASE WHEN ${at(0, 1)} THEN 1 ELSE 0 END AS f, count(*) FILTER (WHERE ${at(1, 2)}) AS n FROM users GROUP BY users.id`,
			);
		});

		it('AC7 on a CTE source, an alias condition shared by HAVING and an ORDER BY CASE', () => {
			const query = (having: WhereIntent, order: WhereIntent) =>
				(plain as unknown as { withCte(name: string): any })
					.withCte('d')
					.fromUnnest({ id: [1, 2], score: [3, 4] })
					.query(
						plain
							.select('d' as 'users')
							.groupBy(['id'])
							.count('id', 'score')
							.having(having)
							.orderBy(caseWhen(order, literal(1)).else(literal(0))),
					);
			const expected = {
				sql: 'WITH d AS (SELECT t.id AS id, t.score AS score FROM unnest(CAST($1 AS int4[]), CAST($2 AS int4[])) AS t(id, score)) SELECT d.id, count(d.id) AS score FROM d GROUP BY d.id HAVING count(d.id) > CAST($3 AS bigint) ORDER BY CASE WHEN d.score > $4 THEN 1 ELSE 0 END ASC',
				params: [[1, 2], [3, 4], 1, 1],
			};
			const shared = gt('score', 1);
			expect(query(shared, shared).dump()).toMatchObject(expected);
			expect(query(gt('score', 1), gt('score', 1)).dump()).toMatchObject(
				expected,
			);
		});

		it("AC8 compiling leaves the caller's intent unchanged", () => {
			const shared = title();
			const query = users()
				.groupBy(['id'])
				.columns(['id', fn('count', star()).filter(shared).as('n')])
				.having(shared);
			const intent = (
				query as unknown as { buildIntent(): QueryIntent }
			).buildIntent();
			const before = JSON.stringify(intent);
			const dump = query.dump();
			expect(JSON.stringify(dump.plan?.intent)).toBe(before);
			expect(dump.plan?.intent.having).toBe(shared);
			const select = dump.plan?.intent.select as unknown as {
				columns: { intent?: { filter?: unknown }; filter?: unknown }[];
			};
			expect(
				select.columns[1]?.filter ?? select.columns[1]?.intent?.filter,
			).toBe(shared);
		});
	});

	it("AC18 an exempted HAVING node keeps its issued body's filter under an opted-out outer ORM", () => {
		const body = (
			rawExists(
				filtered.select('posts').columns(['authorId']) as unknown as Parameters<
					typeof rawExists
				>[0],
			) as { subquery: QueryIntent }
		).subquery;
		expect(
			filtered
				.withoutDefaultFilters()
				.select('users')
				.columns(['id'])
				.groupBy(['id'])
				.having(inSubquery('users.id', new SubqueryExpression(body)))
				.dump().sql,
		).toBe(
			'SELECT users.id FROM users GROUP BY users.id HAVING users.id = ANY (SELECT posts_subq_0."authorId" FROM posts AS posts_subq_0 WHERE posts_subq_0."deletedAt" IS NULL)',
		);
	});

	it('AC17 ambiguous and invisible qualifiers are refused with the position label in CASE WHEN, FILTER and HAVING', () => {
		const editedDb = schema({
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'text',
				score: 'integer',
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: 'text',
				score: 'integer',
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
				editorId: ref('users', { as: 'editor', inverse: 'edited' }),
			},
		} as const);
		const editedOrm = createOrm({
			schema: editedDb,
			adapter: createPgCompileOnlyAdapter(),
			suppressDxWarnings: true,
		});
		const joined = () =>
			editedOrm.select('posts').join('author').join('editor');
		const ambiguous = () => eq('users.name', 'x');
		const invisible = () => eq('posts.id', exprRef('nope.id'));
		const inCase = (c: WhereIntent) =>
			joined()
				.columns([caseWhen(c, literal(1)).else(literal(0)).as('f')])
				.dump();
		const inFilter = (c: WhereIntent) =>
			joined()
				.columns([fn('count', star()).filter(c).as('n')])
				.dump();
		expect(() => inCase(ambiguous())).toThrow(
			"CASE WHEN qualifier 'users' is ambiguous between 'author', 'editor'.",
		);
		expect(() => inFilter(ambiguous())).toThrow(
			"FILTER qualifier 'users' is ambiguous between 'author', 'editor'.",
		);
		expect(() => inCase(invisible())).toThrow(
			"CASE WHEN qualifier 'nope' is not visible in this query.",
		);
		expect(() => inFilter(invisible())).toThrow(
			"FILTER qualifier 'nope' is not visible in this query.",
		);
		// AC6: an ambiguous dotted HAVING qualifier is refused as in WHERE, the
		// scalar comparison included.
		const ambiguousHaving =
			"HAVING qualifier 'users' is ambiguous between 'author', 'editor'.";
		expect(() =>
			joined().groupBy(['id']).count('id', 'n').having(ambiguous()).dump(),
		).toThrow(ambiguousHaving);
		expect(() =>
			joined()
				.groupBy(['id', 'author.id', 'editor.id'])
				.having({
					kind: 'subquery',
					field: 'users.score',
					operator: 'gt',
					subquery: subquery('posts').max('score').toIntent(),
				} as WhereIntent)
				.dump(),
		).toThrow(ambiguousHaving);
		// AC9: an operand qualifier naming no visible range is refused in HAVING,
		// CASE WHEN and FILTER; a visible join alias keeps its SQL.
		const posts = () => editedOrm.select('posts');
		for (const name of ['nope.name', 'users.name']) {
			const qualifier = name.split('.')[0];
			const operand = () => eq('title', exprRef(name));
			expect(() => posts().groupBy(['id']).having(operand()).dump()).toThrow(
				`HAVING qualifier '${qualifier}' is not visible in this query.`,
			);
			expect(() =>
				posts()
					.columns([
						'id',
						caseWhen(operand(), literal(1)).else(literal(0)).as('c'),
					])
					.dump(),
			).toThrow(
				`CASE WHEN qualifier '${qualifier}' is not visible in this query.`,
			);
			expect(() =>
				posts()
					.columns([fn('count', star()).filter(operand()).as('n')])
					.dump(),
			).toThrow(
				`FILTER qualifier '${qualifier}' is not visible in this query.`,
			);
		}
		expect(() =>
			joined().groupBy(['id']).count('id', 'n').having(invisible()).dump(),
		).toThrow("HAVING qualifier 'nope' is not visible in this query.");
		const joins =
			'FROM posts JOIN users AS author ON posts."authorId" = author.id JOIN users AS editor ON posts."editorId" = editor.id';
		const editor = () => eq('title', exprRef('editor.name'));
		expect(joined().groupBy(['id']).having(editor()).dump().sql).toBe(
			`SELECT posts.* ${joins} GROUP BY posts.id HAVING posts.title = editor.name`,
		);
		expect(
			joined()
				.columns([
					'id',
					caseWhen(editor(), literal(1)).else(literal(0)).as('c'),
				])
				.dump().sql,
		).toBe(
			`SELECT posts.id, CASE WHEN posts.title = editor.name THEN 1 ELSE 0 END AS c ${joins}`,
		);
		expect(
			joined()
				.columns([fn('count', star()).filter(editor()).as('n')])
				.dump().sql,
		).toBe(
			`SELECT count(*) FILTER (WHERE posts.title = editor.name) AS n ${joins}`,
		);
	});

	it('C1 a condition shared with a body inside HAVING still resolves in a CASE', () => {
		const sharedTables = {
			users: {
				id: { type: 'integer', primaryKey: true },
				name: 'text',
				deletedAt: { type: 'timestamp', nullable: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				title: 'text',
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
		} as const;
		for (const on of [false, true]) {
			const db = on
				? schema(sharedTables, undefined, {
						defaultFilters: { users: isNull('deletedAt') },
					})
				: schema(sharedTables);
			const o = createOrm({
				schema: db,
				adapter: createPgCompileOnlyAdapter(),
				suppressDxWarnings: true,
			});
			const c = eq('author.name', 'x');
			const filter = (alias: string) =>
				on ? ` AND ${alias}."deletedAt" IS NULL` : '';
			expect(
				o
					.select('posts')
					.columns(['id', caseWhen(c, literal(1)).else(literal(0)).as('f')])
					.groupBy(['id'])
					.having(rawExists(subquery('posts').select('id').where(c)))
					.dump(),
			).toMatchObject({
				sql: `SELECT posts.id, CASE WHEN EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id${filter('users_exists_0')} AND users_exists_0.name = $1) THEN 1 ELSE 0 END AS f FROM posts GROUP BY posts.id HAVING EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM users AS users_exists_1 WHERE posts_sq."authorId" = users_exists_1.id${filter('users_exists_1')} AND users_exists_1.name = $2))`,
				params: ['x', 'x'],
			});
		}
	});
});
