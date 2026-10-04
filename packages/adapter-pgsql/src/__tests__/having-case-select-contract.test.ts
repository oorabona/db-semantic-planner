import {
	and,
	caseWhen,
	createOrm,
	eq,
	exists,
	inSubquery,
	literal,
	op,
	outerRef,
	rangeOverlaps,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { expect, it } from 'vitest';
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
