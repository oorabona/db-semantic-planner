import {
	and,
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	not,
	notExists,
	outerRef,
	rangeOverlaps,
	rawExists,
	ref,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compilePlan } from '../compiler.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		period: { type: 'daterange' },
		score: { type: 'integer' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		score: { type: 'integer' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		parentId: ref('posts', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
} as const);
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
const range = rangeOverlaps('period', {
	lower: '2026-01-01',
	upper: '2026-02-01',
});
const aggregate = (condition: WhereIntent) =>
	fn('count', star()).filter(condition);

describe('condition compiler FILTER (#891, #296)', () => {
	it("FILTER exists('typo') rejects the undeclared relation name without convention-FK fallback", () => {
		const message =
			"exists('typo'): no relation 'typo' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.";
		expect(() => orm.select('users').where(exists('typo')).dump()).toThrow(
			message,
		);
		expect(() =>
			orm
				.select('users')
				.columns([aggregate(exists('typo')).as('n')])
				.dump(),
		).toThrow(new Error(message));
	});
	it('FILTER rangeOverlaps on daterange emits CAST($1 AS daterange) and preserves parameter order', () => {
		const result = orm
			.select('users')
			.columns([aggregate(and(range, eq('score', 7))).as('n')])
			.where(eq('id', 9))
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE users.period && CAST($1 AS daterange) AND users.score = $2) AS n FROM users WHERE users.id = $3',
		);
		expect(result.params).toEqual(['[2026-01-01,2026-02-01)', 7, 9]);
	});
	it('declared relation uses its declared key', () => {
		const result = orm
			.select('users')
			.columns([aggregate(exists('posts', { where: eq('score', 7) })).as('n')])
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.score = $1)) AS n FROM users',
		);
		expect(result.params).toEqual([7]);
	});
	it('FILTER in HAVING and ORDER BY keeps range casts and parameters', () => {
		const result = orm
			.select('users')
			.groupBy(['id'])
			.having(aggregate(range).gt(3))
			.orderBy(aggregate(and(range, eq('score', 7))))
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users GROUP BY users.id HAVING count(*) FILTER (WHERE users.period && CAST($1 AS daterange)) > $2 ORDER BY count(*) FILTER (WHERE users.period && CAST($3 AS daterange) AND users.score = $4) ASC',
		);
		expect(result.params).toEqual([
			'[2026-01-01,2026-02-01)',
			3,
			'[2026-01-01,2026-02-01)',
			7,
		]);
	});
	it('posts-root correlated FILTER subquery reads the outer posts row through a distinct inner alias', () => {
		const result = orm
			.select('posts')
			.columns([
				aggregate(exists('children', { where: eq('score', 7) })).as('n'),
			])
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE posts.id = posts_exists_0."parentId" AND posts_exists_0.score = $1)) AS n FROM posts',
		);
		expect(result.params).toEqual([7]);
	});
	it('scalar, IN and raw EXISTS FILTER bodies keep aliases and share the predicate allocator', () => {
		const scalar: WhereIntent = {
			kind: 'subquery',
			field: 'score',
			operator: 'eq',
			subquery: {
				type: 'select',
				from: 'posts',
				select: { type: 'fields', fields: ['score'] },
				where: eq('score', 5),
			},
		};
		const condition = and(
			scalar,
			inSubquery('id', subquery('posts').select('id').where(eq('score', 6))),
			rawExists(subquery('posts').select('id').where(eq('score', 7))),
		);
		const result = orm
			.select('posts')
			.columns([aggregate(condition).as('n')])
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE posts.score = (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE posts_subq_0.score = $1) AND posts.id = ANY (SELECT posts_subq_1.id FROM posts AS posts_subq_1 WHERE posts_subq_1.score = $2) AND EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = $3)) AS n FROM posts',
		);
		expect(result.params).toEqual([5, 6, 7]);
	});
	for (const [kind, condition, predicate] of [
		[
			'scalar',
			{
				kind: 'subquery',
				field: 'score',
				operator: 'eq',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['score'] },
					where: eq('score', 5),
				},
			} as WhereIntent,
			'posts.score = (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE posts_subq_0.score = $1)',
		],
		[
			'IN',
			inSubquery('id', subquery('posts').select('id').where(eq('score', 5))),
			'posts.id = ANY (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE posts_subq_0.score = $1)',
		],
		[
			'rawExists',
			rawExists(subquery('posts').select('id').where(eq('score', 5))),
			'EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = $1)',
		],
		[
			'rawNotExists',
			{
				kind: 'rawNotExists',
				subquery: subquery('posts')
					.select('id')
					.where(eq('score', 5))
					.build()
					.toIntent(),
			} as WhereIntent,
			'NOT (EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = $1))',
		],
	] as const) {
		it(`${kind} FILTER in HAVING and ORDER BY retains select WHERE aliases`, () => {
			const having = orm
				.select('posts')
				.groupBy(['id'])
				.having(aggregate(condition).gt(3))
				.dump();
			expect(having.sql).toBe(
				`SELECT posts.* FROM posts GROUP BY posts.id HAVING count(*) FILTER (WHERE ${predicate}) > $2`,
			);
			expect(having.params).toEqual([5, 3]);
			const ordered = orm.select('posts').orderBy(aggregate(condition)).dump();
			expect(ordered.sql).toBe(
				`SELECT posts.* FROM posts ORDER BY count(*) FILTER (WHERE ${predicate}) ASC`,
			);
			expect(ordered.params).toEqual([5]);
		});
	}
});

describe('FILTER context repair regressions', () => {
	for (const operator of ['eq', 'in'] as const) {
		it(`${operator} retains subquery ordering and limit`, () => {
			const scalar: WhereIntent = {
				kind: 'subquery',
				field: 'id',
				operator: 'eq',
				subquery: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['id'] },
					where: eq('score', 5),
					orderBy: [{ field: 'score', direction: 'desc' }],
					limit: 1,
				},
			};
			const condition =
				operator === 'eq'
					? scalar
					: { kind: 'in' as const, field: 'id', subquery: scalar.subquery };
			const result = orm
				.select('users')
				.columns([aggregate(condition).as('n')])
				.dump();
			expect(result.sql).toBe(
				`SELECT count(*) FILTER (WHERE users.id ${operator === 'eq' ? '=' : '= ANY'} (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE posts_subq_0.score = $1 ORDER BY posts_subq_0.score DESC LIMIT 1)) AS n FROM users`,
			);
			expect(result.params).toEqual([5]);
		});
	}
	it('configured key authorities reach FILTER correlation', () => {
		const result = compilePlan(
			{
				rootTable: 'users',
				decisions: [
					{
						type: 'selectCustomExpression',
						alias: 'n',
						expressionIntent: aggregate(
							exists('posts', { where: eq('score', 7) }),
						).intent,
					},
				],
			},
			{
				defaultPkColumnName: 'custom_pk',
				deriveFkColumnName: (table, pk) => `z_${table}_${pk}`,
			},
		);
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.custom_pk = posts_exists_0.z_users_custom_pk AND posts_exists_0.score = $1)) AS n FROM users',
		);
		expect(result.parameters).toEqual([7]);
	});
	it('model-backed FILTER retains custom keys through logical nesting', () => {
		const customColumns = {
			id: { type: 'integer', primaryKey: true },
			score: { type: 'integer' },
			custom_pk: { type: 'integer' },
			z_users_custom_pk: { type: 'integer' },
		} as const;
		const customDb = schema({
			users: customColumns,
			posts: {
				...customColumns,
				authorId: ref('users', { as: 'author', inverse: 'posts' }),
			},
		} as const);
		const customOrm = createOrm({
			schema: customDb,
			adapter: createPgCompileOnlyAdapter({
				model: customDb.model,
				defaultPkColumnName: 'custom_pk',
				deriveFkColumnName: (table, pk) => `z_${table}_${pk}`,
			}),
		});
		const condition = and(
			eq('score', 1),
			not(exists('posts', { where: eq('score', 7) })),
		);
		const result = customOrm
			.select('users')
			.columns([aggregate(condition).as('n')])
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE users.score = $1 AND NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0.score = $2))) AS n FROM users',
		);
		expect(result.params).toEqual([1, 7]);
	});
	it('expression subquery retains its compiler authority', () => {
		const condition: WhereIntent = {
			kind: 'expression',
			expr: subquery('posts').select('score').where(eq('score', 5)).asExpr('s')
				.intent,
			operator: 'gt',
			value: 0,
		};
		const result = orm
			.select('users')
			.columns([aggregate(condition).as('n')])
			.dump();
		expect(result.sql).toBe(
			'SELECT count(*) FILTER (WHERE (SELECT posts.score FROM posts WHERE posts.score = $1) > $2) AS n FROM users',
		);
		expect(result.params).toEqual([5, 0]);
	});
	for (const predicate of [exists, notExists]) {
		it(`${predicate.name} refuses recursive FILTER predicates`, () => {
			const condition = predicate('posts', {
				recursive: {
					maxDepth: 5,
					direction: 'down',
					through: 'children',
				},
			});
			for (const wrapped of [condition, and(eq('id', 1), not(condition))]) {
				expect(() =>
					orm
						.select('users')
						.columns([aggregate(wrapped).as('n')])
						.dump(),
				).toThrow(
					new Error(
						`FILTER ${predicate === exists ? 'exists' : 'notExists'}('posts'): recursive relation predicates are not supported inside FILTER.`,
					),
				);
			}
		});
	}
});

// No implicit primary key: adapter authorities only fill missing model metadata.
for (const custom of [false, true]) {
	it(`public FILTER without a declared PK uses ${custom ? 'configured' : 'default'} fallback`, () => {
		const noPk = schema(
			{
				users: {
					id: { type: 'integer', unique: true },
					custom_pk: { type: 'integer', unique: true },
				},
				posts: {
					id: { type: 'integer', unique: true },
					score: { type: 'integer' },
					authorId: ref('users', {
						as: 'author',
						inverse: 'posts',
						references: [custom ? 'custom_pk' : 'id'],
					}),
				},
			} as const,
			undefined,
			{ defaultPkColumnName: null },
		);
		const noPkOrm = createOrm({
			schema: noPk,
			adapter: createPgCompileOnlyAdapter({
				model: noPk.model,
				...(custom
					? {
							defaultPkColumnName: 'custom_pk',
							deriveFkColumnName: (table: string, pk: string) =>
								`z_${table}_${pk}`,
						}
					: {}),
			}),
		});
		const result = noPkOrm
			.select('users')
			.columns([aggregate(exists('posts', { where: eq('score', 7) })).as('n')])
			.dump();
		expect(result.sql).toBe(
			`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.${custom ? 'custom_pk' : 'id'} = posts_exists_0."authorId" AND posts_exists_0.score = $1)) AS n FROM users`,
		);
		expect(result.params).toEqual([7]);
	});
}

it('FILTER inside a nested expression retains range casting', () => {
	const result = orm
		.select('users')
		.columns([fn('abs', aggregate(range)).as('n')])
		.dump();
	expect(result.sql).toBe(
		'SELECT abs(count(*) FILTER (WHERE users.period && CAST($1 AS daterange))) AS n FROM users',
	);
	expect(result.params).toEqual(['[2026-01-01,2026-02-01)']);
});
it('multi-hop FILTER resolves each raw relation in its own scope', () => {
	const result = orm
		.select('users')
		.columns([
			aggregate({
				kind: 'relationFilter',
				relation: ['posts', 'children'],
				mode: 'some',
				where: eq('score', 7),
			}).as('n'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE posts_exists_0.id = posts_exists_1."parentId" AND posts_exists_1.score = $1))) AS n FROM users',
	);
	expect(result.params).toEqual([7]);
});
it('belongsTo FILTER resolves the referenced table key and source foreign key', () => {
	const customOrm = createOrm({
		schema: db,
		adapter: createPgCompileOnlyAdapter({
			model: db.model,
			defaultPkColumnName: 'custom_pk',
			deriveFkColumnName: (table, pk) => `z_${table}_${pk}`,
		}),
	});
	const result = customOrm
		.select('posts')
		.columns([aggregate(exists('author', { where: eq('score', 7) })).as('n')])
		.dump();
	expect(result.sql).toBe(
		'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.score = $1)) AS n FROM posts',
	);
	expect(result.params).toEqual([7]);
});

for (const [operator, sql] of [
	['eq', '='],
	['neq', '!='],
	['gt', '>'],
	['gte', '>='],
	['lt', '<'],
	['lte', '<='],
	['isDistinctFrom', 'IS DISTINCT FROM'],
	['=', '='],
	['!=', '!='],
	['>', '>'],
	['>=', '>='],
	['<', '<'],
	['<=', '<='],
] as const) {
	it(`FILTER outerRef ${operator} is a column without parameters`, () => {
		const condition = {
			kind: 'comparison',
			field: 'authorId',
			operator,
			value: outerRef('id'),
		} as WhereIntent;
		const result = orm
			.select('users')
			.columns([aggregate(exists('posts', { where: condition })).as('n')])
			.dump();
		expect(result.sql).toBe(
			`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."authorId" ${sql} users.id)) AS n FROM users`,
		);
		expect(result.params).toEqual([]);
	});
}
for (const predicate of [exists, notExists]) {
	it(`nested FILTER ${predicate.name} outerRef uses its immediate outer scope`, () => {
		const condition = exists('posts', {
			where: predicate('children', { where: eq('parentId', outerRef('id')) }),
		});
		const result = orm
			.select('users')
			.columns([aggregate(condition).as('n')])
			.dump();
		const inner =
			'EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE posts_exists_0.id = posts_exists_1."parentId" AND posts_exists_1."parentId" = posts_exists_0.id)';
		expect(result.sql).toBe(
			`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND ${predicate === exists ? inner : `NOT (${inner})`})) AS n FROM users`,
		);
		expect(result.params).toEqual([]);
	});
}
it('multi-hop FILTER relationFilter preserves outerRef', () => {
	const result = orm
		.select('users')
		.columns([
			aggregate({
				kind: 'relationFilter',
				relation: ['posts', 'children'],
				mode: 'some',
				where: eq('parentId', outerRef('id')),
			}).as('n'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND EXISTS (SELECT 1 FROM posts AS posts_exists_1 WHERE posts_exists_0.id = posts_exists_1."parentId" AND posts_exists_1."parentId" = posts_exists_0.id))) AS n FROM users',
	);
	expect(result.params).toEqual([]);
});

const includeDb = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		categoryId: ref('categories', { as: 'category', inverse: 'posts' }),
	},
	categories: { id: { type: 'integer', primaryKey: true } },
} as const);
const includeOrm = createOrm({
	schema: includeDb,
	adapter: createPgCompileOnlyAdapter({
		model: includeDb.model,
		defaultPkColumnName: 'custom_pk',
	}),
});
it('FILTER include belongsTo uses the declared target PK', () => {
	const result = includeOrm
		.select('users')
		.columns([
			aggregate(
				exists('posts', { include: { category: { join: 'inner' } } }),
			).as('n'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN categories AS category ON posts_exists_0."categoryId" = category.id WHERE users.id = posts_exists_0."authorId")) AS n FROM users',
	);
	expect(result.params).toEqual([]);
});
it('FILTER include hasMany resolves keys from the intermediate source table', () => {
	const result = includeOrm
		.select('users')
		.columns([
			aggregate(
				exists('posts', {
					include: { category: { join: 'inner' }, posts: { join: 'inner' } },
				}),
			).as('n'),
		])
		.dump();
	expect(result.sql).toBe(
		'SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN categories AS category ON posts_exists_0."categoryId" = category.id JOIN posts AS posts ON category.id = posts."categoryId" WHERE users.id = posts_exists_0."authorId")) AS n FROM users',
	);
	expect(result.params).toEqual([]);
});
it('FILTER include refuses an undeclared model relation', () => {
	expect(() =>
		includeOrm
			.select('users')
			.columns([
				aggregate(exists('posts', { include: { typo: { join: 'inner' } } })).as(
					'n',
				),
			])
			.dump(),
	).toThrow(
		new Error(
			"FILTER include('typo'): no relation 'typo' is declared on table 'posts'.",
		),
	);
});
