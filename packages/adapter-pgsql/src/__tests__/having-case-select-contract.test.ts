import {
	and,
	caseWhen,
	createOrm,
	ExpressionRef,
	eq,
	exists,
	exprRef,
	fn,
	gt,
	inSubquery,
	isNull,
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
it('HAVING alias preserves its operator refusal', () => {
	expect(() =>
		orm
			.select('symbols')
			.count({ as: 'n' })
			.groupBy(['id'])
			.having(rangeOverlaps('n', { lower: '2026-01-01', upper: '2026-02-01' }))
			.dump(),
	).toThrow("Declared column 'symbols.*' is absent from the physical model.");
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

		it(`AC18 HAVING dotted fields keep main's route (${name})`, () => {
			const on = o === filtered;
			const users = () => o.select('users').groupBy(['id']);
			const dotted = () => eq('posts.title', 'x');
			expect(users().count('id', 'n').having(dotted()).dump()).toMatchObject({
				sql: `SELECT users.id, count(users.id) AS n FROM users GROUP BY users.id HAVING ${on ? titled(true) : 'posts.title = $1'}`,
				params: ['x'],
			});
			expect(
				users().having(fn('count', star()).filter(dotted()).gt(19)).dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE ${on ? titled(true) : 'posts.title = $1'}) > $2`,
				params: ['x', 19],
			});
			expect(
				o.nql`users | group by id | where posts.title = 'x'`.dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING ${on ? titled(true) : 'posts.title = $1'}`,
				params: ['x'],
			});
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
			expect(
				users()
					.columns(['id', literal('x').as('posts.title')])
					.having(dotted())
					.dump(),
			).toMatchObject({
				sql: `SELECT users.id, 'x' AS "posts.title" FROM users GROUP BY users.id HAVING ${on ? titled(true) : 'posts.title = $1'}`,
				params: ['x'],
			});
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
	}

	for (const [name, o] of orms)
		it(`AC18 a CASE in a HAVING expression keeps main's route for a dotted path (${name})`, () => {
			expect(
				o
					.select('users')
					.groupBy(['id'])
					.having(
						caseWhen(eq('posts.title', 'x'), literal(1)).else(literal(0)).eq(1),
					)
					.dump(),
			).toMatchObject({
				sql: `SELECT users.* FROM users GROUP BY users.id HAVING CASE WHEN ${o === filtered ? titled(true) : 'posts.title = $1'} THEN 1 ELSE 0 END = $2`,
				params: ['x', 1],
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

	it('AC17 ambiguous and invisible qualifiers are refused with the position label in CASE WHEN and FILTER', () => {
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
		// HAVING dotted fields keep main's output (AC18).
		expect(
			joined().groupBy(['id']).count('id', 'n').having(ambiguous()).dump().sql,
		).toBe(
			'SELECT posts.id, count(posts.id) AS n FROM posts JOIN users AS author ON posts."authorId" = author.id JOIN users AS editor ON posts."editorId" = editor.id GROUP BY posts.id HAVING author.name = $1',
		);
		expect(() =>
			joined().groupBy(['id']).count('id', 'n').having(invisible()).dump(),
		).toThrow("Declared column 'nope.id' is absent from the physical model.");
		// A scalar comparison with a dotted field in HAVING keeps main's route too.
		expect(
			joined()
				.groupBy(['id', 'author.id', 'editor.id'])
				.having({
					kind: 'subquery',
					field: 'users.score',
					operator: 'gt',
					subquery: subquery('posts').max('score').toIntent(),
				} as WhereIntent)
				.dump().sql,
		).toBe(
			'SELECT posts.* FROM posts JOIN users AS author ON posts."authorId" = author.id JOIN users AS editor ON posts."editorId" = editor.id GROUP BY posts.id, author.id, editor.id HAVING author.score > (SELECT max(posts_subq_2.score) FROM posts AS posts_subq_2)',
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
