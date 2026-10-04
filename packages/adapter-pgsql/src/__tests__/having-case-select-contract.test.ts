import {
	and,
	caseWhen,
	createOrm,
	ExpressionRef,
	eq,
	exists,
	fn,
	inSubquery,
	literal,
	op,
	outerRef,
	rangeOverlaps,
	ref,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
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
		'SELECT (SELECT (SELECT count(*) FROM calls AS calls WHERE calls."symbolId" = symbols.id AND calls.score = $1) AS "callCount" FROM symbols AS symbols)',
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
		'SELECT (SELECT (SELECT (SELECT CASE WHEN calls_sq.period && CAST($1 AS tsrange) AND calls_sq.score = $2 THEN 1 ELSE 0 END AS rank FROM calls AS calls_sq) FROM symbols AS symbols) FROM calls AS calls)',
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
		'SELECT (SELECT (SELECT calls.period FROM calls AS calls GROUP BY calls.period HAVING calls.period && CAST($1 AS tsrange)) FROM symbols AS symbols)',
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
