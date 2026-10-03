import {
	and,
	any,
	caseWhen,
	createOrm,
	eq,
	every,
	exists,
	fn,
	inArray,
	like,
	namedArg,
	neq,
	none,
	not,
	notExists,
	or,
	planRecursive,
	rangeOverlaps,
	rawExists,
	ref,
	schema,
	some,
	subquery,
	unsafeAsPredicate,
} from '@dbsp/core';
import type { RecursiveIntent, WhereIntent } from '@dbsp/types';
import { markNqlTrustedRelationFilter } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const columns = {
	id: { type: 'integer', primaryKey: true },
	name: { type: 'text' },
	score: { type: 'integer' },
	period: { type: 'daterange' },
	data: { type: 'jsonb' },
	__depth: { type: 'integer' },
	__visited: { type: 'integer' },
	__path: { type: 'integer' },
	is_cycle: { type: 'integer' },
	__cycle_path: { type: 'integer' },
} as const;
const db = schema({
	users: columns,
	posts: {
		...columns,
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		...columns,
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	seeds: columns,
	edges: {
		...columns,
		id: { type: 'integer', primaryKey: true },
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
function intent(where: WhereIntent, adjacency = false): RecursiveIntent {
	return {
		type: 'recursive',
		cteName: 'tree',
		start: { from: 'users', nodeIdExpr: { kind: 'column', name: 'id' }, where },
		traversal: adjacency
			? {
					kind: 'adjacency',
					nodeTable: 'users',
					nodeId: 'id',
					parentId: 'score',
					direction: 'descendants',
				}
			: {
					kind: 'edge-table',
					nodeTable: 'users',
					nodeId: 'id',
					edgeTable: 'edges',
					edgeFrom: 'from_id',
					edgeTo: 'to_id',
					direction: 'out',
				},
		maxDepth: 2,
	};
}
function compile(where: WhereIntent, adjacency = false) {
	return adapter.compileRecursive(
		planRecursive(intent(where, adjacency), db.model),
		db.model,
	);
}
function edgeSql(condition: string) {
	return `WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE ${condition} UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree`;
}
function postsSql(condition: string, negative = false) {
	const sql = `EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0."authorId" AND ${condition})`;
	return negative ? `NOT (${sql})` : sql;
}
const escaped = like('name', 'a!%', { escape: '!' });
const leaves: readonly [string, WhereIntent, string, readonly unknown[]][] = [
	[
		'escaped LIKE',
		escaped,
		'posts_exists_0.name LIKE $1 ESCAPE $2',
		['a!%', '!'],
	],
	[
		'range cast',
		rangeOverlaps('period', { lower: '2026-01-01', upper: '2026-02-01' }),
		'posts_exists_0.period && CAST($1 AS daterange)',
		['[2026-01-01,2026-02-01)'],
	],
	[
		'scalar subquery',
		{
			kind: 'subquery',
			field: 'score',
			operator: 'eq',
			subquery: {
				type: 'select',
				from: 'comments',
				select: { type: 'fields', fields: ['score'] },
				where: eq('id', 4),
			},
		},
		'posts_exists_0.score = (SELECT comments_subq_1.score FROM comments AS comments_subq_1 WHERE comments_subq_1.id = $1)',
		[4],
	],
	[
		'raw EXISTS',
		rawExists(subquery('comments').select('id').where(eq('score', 4))),
		'EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq.score = $1)',
		[4],
	],
	[
		'nested relation filter',
		some(orm.tables.posts.comments, () => like('name', 'a!%', { escape: '!' })),
		'EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.name LIKE $1 ESCAPE $2)',
		['a!%', '!'],
	],
];
describe('#891 recursive anchor review repairs', () => {
	for (const [name, leaf, sql, params] of leaves) {
		for (const negative of [false, true]) {
			it(`COR1 ${negative ? 'notExists' : 'exists'} descendant ${name}`, () => {
				const result = compile(
					negative
						? notExists('posts', { where: leaf })
						: exists('posts', { where: leaf }),
				);
				expect(result.sql).toBe(edgeSql(postsSql(sql, negative)));
				expect(result.parameters).toEqual(params);
			});
		}
	}
	for (const [name, where, condition, params] of [
		[
			'logical groups',
			exists('posts', { where: and(eq('id', 7), not(or(escaped))) }),
			postsSql(
				'posts_exists_0.id = $1 AND NOT (posts_exists_0.name LIKE $2 ESCAPE $3)',
			),
			[7, 'a!%', '!'],
		],
		[
			'some',
			some(orm.tables.users.posts, () => escaped),
			postsSql('posts_exists_0.name LIKE $1 ESCAPE $2'),
			['a!%', '!'],
		],
		[
			'none',
			none(orm.tables.users.posts, () => escaped),
			postsSql('posts_exists_0.name LIKE $1 ESCAPE $2', true),
			['a!%', '!'],
		],
		[
			'every',
			every(orm.tables.users.posts, () => escaped),
			postsSql('NOT (posts_exists_0.name LIKE $1 ESCAPE $2)', true),
			['a!%', '!'],
		],
	] as const) {
		it(`COR1 ${name} descendants`, () => {
			const result = compile(where);
			expect(result.sql).toBe(edgeSql(condition));
			expect(result.parameters).toEqual(params);
		});
	}
	for (const [name, where, condition, params] of [
		[
			'JSON path',
			{
				kind: 'comparison',
				field: 'data',
				operator: 'eq',
				value: 'yes',
				jsonPath: ['active'],
				jsonMode: 'text',
			},
			'(__n.data ->> $1) = $2',
			['active', 'yes'],
		],
		[
			'field reference',
			eq('score', { kind: 'fieldRef', column: 'id', scope: 'inner' }),
			'__n.score = __n.id',
			[],
		],
		['literal null', eq('score', null), '__n.score IS NULL', []],
		['legacy inequality', neq('score', 7), '__n.score != $1', [7]],
		['qualified root', eq('users.score', 7), '__n.score = $1', [7]],
	] as const) {
		it(`${name === 'qualified root' ? 'EDGE1' : 'COR2'} ${name}`, () => {
			const result = compile(where);
			expect(result.sql).toBe(edgeSql(condition));
			expect(result.parameters).toEqual(params);
		});
	}
	it('EDGE2 planning refuses mismatched start table', () => {
		const query = intent(eq('score', 7));
		expect(() =>
			planRecursive(
				{ ...query, start: { ...query.start, from: 'seeds' } },
				db.model,
			),
		).toThrow(
			"Recursive start.from 'seeds' must match traversal.nodeTable 'users'.",
		);
	});
	it('EDGE2 compilation refuses mismatched start table independently', () => {
		const report = planRecursive(intent(eq('score', 7)), db.model);
		expect(() =>
			adapter.compileRecursive(
				{
					...report,
					intent: {
						...report.intent,
						start: { ...report.intent.start, from: 'seeds' },
					},
				},
				db.model,
			),
		).toThrow(
			"Recursive start.from 'seeds' must match traversal.nodeTable 'users'.",
		);
	});
	it('EDGE2 omitted start.from falls back to the node table', () => {
		const query = intent(eq('score', 7));
		Reflect.deleteProperty(query.start, 'from');
		const result = adapter.compileRecursive(
			planRecursive(query, db.model),
			db.model,
		);
		expect(result.sql).toBe(edgeSql('__n.score = $1'));
		expect(result.parameters).toEqual([7]);
	});
	for (const direction of ['descendants', 'ancestors'] as const) {
		for (const [name, where, condition, params] of [
			['eq', eq('id', 1), '__n.id = $1', [1]],
			['inArray', inArray('id', [1, 2]), '__n.id = ANY ($1)', [[1, 2]]],
			['whole table', undefined, undefined, []],
		] as const) {
			it(`COR1 standalone adjacency ${direction} ${name} binds ranges and filters anchor`, () => {
				const base = intent(eq('id', 1), true);
				const query: RecursiveIntent = {
					...base,
					start: {
						from: 'users',
						nodeIdExpr: { kind: 'column', name: 'id' },
						...(where !== undefined && { where }),
					},
					traversal: {
						kind: 'adjacency',
						nodeTable: 'users',
						nodeId: 'id',
						parentId: 'score',
						direction,
					},
				};
				const result = adapter.compileRecursive(
					planRecursive(query, db.model),
					db.model,
				);
				const parent = direction === 'ancestors' ? ', __n.score AS score' : '';
				const join =
					direction === 'ancestors'
						? '__n.id = tree.score'
						: '__n.score = tree.id';
				// Ancestor steps need the parent column carried through the CTE.
				expect(result.sql).toBe(
					`WITH RECURSIVE tree AS (SELECT __n.id AS id${parent}, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n${condition ? ` WHERE ${condition}` : ''} UNION ALL SELECT __n.id AS id${parent}, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN users AS __n ON ${join} WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree`,
				);
				expect(result.parameters).toEqual(params);
			});
		}
	}
	for (const predicate of [exists, notExists]) {
		const kind = predicate === exists ? 'exists' : 'notExists';
		for (const nested of [false, true]) {
			it(`SEC1 ${kind} recursive options refused at depth ${nested ? 2 : 1}`, () => {
				const leaf = predicate(nested ? 'comments' : 'posts', {
					recursive: { direction: 'down', through: 'posts', maxDepth: 3 },
					where: eq('score', 71),
				});
				const where = nested
					? exists('posts', { where: and(not(or(leaf))) })
					: leaf;
				expect(() => compile(where)).toThrow(
					new Error(
						`start.where ${kind}('${nested ? 'comments' : 'posts'}'): recursive relation predicates are not supported in a recursive anchor.`,
					),
				);
			});
		}
	}
	for (const predicate of [exists, notExists]) {
		it(`SEC1 ${predicate === exists ? 'exists' : 'notExists'} recursive options refused inside an anchor subquery`, () => {
			const where = rawExists(
				subquery('posts')
					.select('id')
					.where(
						predicate('comments', {
							recursive: {
								direction: 'down',
								through: 'comments',
								maxDepth: 3,
							},
							where: eq('score', 71),
						}),
					),
			);
			expect(() => compile(where)).toThrow(
				new Error(
					`start.where ${predicate === exists ? 'exists' : 'notExists'}('comments'): recursive relation predicates are not supported in a recursive anchor.`,
				),
			);
		});
	}
	for (const predicate of [exists, notExists]) {
		for (const nested of [false, true]) {
			it(`SEC1 CASE ${predicate === exists ? 'exists' : 'notExists'} nested=${nested}`, () => {
				const leaf = predicate('posts', {
					recursive: { direction: 'down', through: 'posts', maxDepth: 3 },
					where: eq('score', 71),
				});
				const condition: WhereIntent = nested
					? {
							kind: 'expression',
							expr: unsafeAsPredicate(caseWhen(leaf, true).else(false)).intent,
						}
					: leaf;
				expect(() =>
					compile({
						kind: 'expression',
						expr: unsafeAsPredicate(caseWhen(condition, true).else(false))
							.intent,
					}),
				).toThrow(
					new Error(
						`start.where ${predicate === exists ? 'exists' : 'notExists'}('posts'): recursive relation predicates are not supported in a recursive anchor.`,
					),
				);
			});
		}
	}
	it('SEC1 CASE inside named function argument and subquery HAVING refuses trusted recursion', () => {
		const leaf = markNqlTrustedRelationFilter(
			{
				kind: 'relationFilter' as const,
				relation: 'posts',
				mode: 'some' as const,
				where: and(),
			},
			{
				relation: 'posts',
				targetTable: 'posts',
				sourceColumn: ['id'],
				targetColumn: ['authorId'],
				hops: [],
				selectedColumn: 'id',
				cardinality: 'many',
				relationType: 'hasMany',
				recursive: {
					direction: 'down',
					maxDepth: 3,
					selfRefColumn: 'authorId',
					targetKeyColumn: 'id',
				},
			},
		);
		const expr = fn(
			'coalesce',
			namedArg('arg', caseWhen(leaf, true).else(false)),
		);
		const condition: WhereIntent = {
			kind: 'expression',
			expr: expr.intent,
			operator: 'eq',
			value: true,
		};
		for (const where of [
			condition,
			{
				kind: 'rawExists',
				subquery: { type: 'select', from: 'posts', having: condition },
			},
		] as WhereIntent[]) {
			expect(() => compile(where)).toThrow(
				new Error(
					"start.where relationFilter('posts'): recursive relation predicates are not supported in a recursive anchor.",
				),
			);
		}
	});
	it('SEC1 bound JSON resembling a recursive predicate remains data', () => {
		const value = {
			kind: 'exists',
			relation: 'posts',
			recursive: { maxDepth: 3 },
		};
		expect(compile(eq('data', value)).parameters).toEqual([value]);
	});
	for (const mode of ['some', 'every', 'none'] as const) {
		for (const nested of [false, true]) {
			it(`SEC1 ${mode} relation filter recursive options refused at depth ${nested ? 2 : 1}`, () => {
				const leaf = {
					kind: 'relationFilter',
					relation: nested ? 'comments' : 'posts',
					mode,
					where: and(),
					recursive: { direction: 'down', maxDepth: 3 },
				} as const;
				expect(() =>
					compile(nested ? exists('posts', { where: leaf }) : leaf),
				).toThrow(
					new Error(
						`start.where relationFilter('${nested ? 'comments' : 'posts'}'): recursive relation predicates are not supported in a recursive anchor.`,
					),
				);
			});
		}
	}
	for (const [name, predicate, condition, params] of [
		[
			'empty ANY',
			(field: string) => any(field, []),
			'__n.score = ANY (CAST($1 AS int4[]))',
			[[]],
		],
		[
			'range',
			(field: string) =>
				rangeOverlaps(field, { lower: '2026-01-01', upper: '2026-02-01' }),
			'__n.period && CAST($1 AS daterange)',
			['[2026-01-01,2026-02-01)'],
		],
	] as const) {
		it(`EDGE1 qualified ${name} preserves type authority`, () => {
			const field = name === 'range' ? 'period' : 'score';
			for (const spelling of [field, `users.${field}`]) {
				const result = compile(predicate(spelling));
				expect(result.sql).toBe(edgeSql(condition));
				expect(result.parameters).toEqual(params);
			}
		});
	}
	it('EDGE1 invisible qualifier refused', () => {
		expect(() => compile(any('invisible.score', []))).toThrow(
			new Error(
				"start.where qualifier 'invisible' is not visible in the recursive anchor scope.",
			),
		);
	});
	function namedOuter(alias: string) {
		return exists('posts', {
			where: exists('comments', {
				where: eq('score', {
					kind: 'fieldRef',
					column: 'id',
					scope: 'outer',
					alias,
				}),
			}),
		});
	}
	it('CTR1 named outer alias resolves the root binding', () => {
		const result = compile(namedOuter('users'));
		expect(result.sql).toBe(
			edgeSql(
				postsSql(
					'EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.score = __n.id)',
				),
			),
		);
		expect(result.parameters).toEqual([]);
	});
	it('CTR1 invisible outer alias refused', () => {
		expect(() => compile(namedOuter('invisible'))).toThrow(
			new Error(
				"start.where qualifier 'invisible' is not visible in the recursive anchor scope.",
			),
		);
	});
});
