import {
	and,
	any,
	caseWhen,
	createOrm,
	eq,
	every,
	exists,
	exprRef,
	fn,
	inArray,
	inSubquery,
	isNull,
	like,
	literal,
	manyToMany,
	namedArg,
	neq,
	none,
	not,
	notExists,
	or,
	outerRef,
	param,
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
import { NotYetSupportedError } from '@dbsp/types';
import { markNqlTrustedRelationFilter } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const columns = {
	id: { type: 'integer', primaryKey: true },
	name: { type: 'text' },
	score: { type: 'integer' },
	period: { type: 'daterange' },
	data: { type: 'jsonb' },
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
		['inequality', neq('score', 7), '__n.score <> $1', [7]],
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
						`start.where ${kind}('${nested ? 'comments' : 'posts'}'): recursive relation predicates are not supported inside start.where.`,
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
					`start.where ${predicate === exists ? 'exists' : 'notExists'}('comments'): recursive relation predicates are not supported inside start.where.`,
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
						`start.where ${predicate === exists ? 'exists' : 'notExists'}('posts'): recursive relation predicates are not supported inside start.where.`,
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
		expect(() => compile(condition)).toThrow(
			new Error(
				"start.where relationFilter('posts'): recursive relation predicates are not supported inside start.where.",
			),
		);
		expect(() =>
			compile({
				kind: 'rawExists',
				subquery: { type: 'select', from: 'posts', having: condition },
			}),
		).toThrow(
			new NotYetSupportedError('HAVING', 'rawExists subquery body', 1087),
		);
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
						`start.where relationFilter('${nested ? 'comments' : 'posts'}'): recursive relation predicates are not supported inside start.where.`,
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
				"exists('invisible'): no relation 'invisible' is declared on table 'users'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
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
				"outerRef qualifier 'invisible' is not visible in an enclosing query.",
			),
		);
	});
});
it('unknown traversal kinds retain their named refusal', () => {
	const report = planRecursive(intent(eq('id', 1)), db.model);
	const unknown = {
		...report.intent,
		traversal: { kind: 'unknownTraversal' },
	} as unknown as RecursiveIntent;
	expect(() =>
		adapter.compileRecursive({ ...report, intent: unknown }, db.model),
	).toThrow("Unsupported traversal kind 'unknownTraversal'");
});

for (const kind of ['rawExists', 'rawNotExists'] as const) {
	for (const adjacency of [false, true]) {
		it(`${kind} anchor body keeps model array typing adjacency ${adjacency}`, () => {
			const result = compile(
				{
					...rawExists(subquery('posts').select('id').where(any('score', []))),
					kind,
				},
				adjacency,
			);
			const condition = `${kind === 'rawNotExists' ? 'NOT (' : ''}EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = ANY (CAST($1 AS int4[])))${kind === 'rawNotExists' ? ')' : ''}`;
			expect(result.sql).toBe(
				adjacency
					? edgeSql(condition).replace(
							'tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id',
							'tree JOIN users AS __n ON __n.score = tree.id',
						)
					: edgeSql(condition),
			);
			expect(result.parameters).toEqual([[]]);
		});
	}
}

describe('start.where resolves through core (#891 slice 4)', () => {
	const tables = {
		categories: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
			data: { type: 'json', dbType: 'jsonb' },
			deletedAt: { type: 'timestamp', nullable: true },
			parentId: ref('categories', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
		posts: {
			id: { type: 'integer', primaryKey: true },
			title: 'text',
			score: 'integer',
			deletedAt: { type: 'timestamp', nullable: true },
			categoryId: ref('categories', { as: 'category', inverse: 'posts' }),
		},
		comments: {
			id: { type: 'integer', primaryKey: true },
			postId: ref('posts', { as: 'post', inverse: 'comments' }),
		},
		archive: {
			id: { type: 'integer', primaryKey: true },
			name: 'text',
			score: 'integer',
		},
	} as const;
	const filters = {
		categories: isNull('deletedAt'),
		posts: isNull('deletedAt'),
	};
	const plain = schema(tables);
	const filtered = schema(tables, undefined, { defaultFilters: filters });
	const typed = schema({
		...tables,
		categories: {
			...tables.categories,
			id: { type: 'integer', primaryKey: true, dbType: 'int4' },
		},
	});
	const tagged = schema(
		{
			...tables,
			tags: { id: { type: 'integer', primaryKey: true } },
			catTags: { categoryId: ref('categories'), tagId: ref('tags') },
		},
		undefined,
		{
			relations: {
				categories: {
					tags: manyToMany('tags', {
						through: 'catTags',
						inverse: 'categories',
						sourceForeignKey: ['categoryId'],
						targetForeignKey: ['tagId'],
					}),
				},
			},
		},
	);
	type Db = Pick<typeof plain, 'model' | 'defaultFilters'>;
	// rawExists() accepts an ORM builder at runtime but not in its type (#994).
	const issuedBody = (builder: unknown) =>
		builder as Parameters<typeof rawExists>[0];
	const local = createPgCompileOnlyAdapter();
	const plainOrm = createOrm({ schema: plain, adapter: local });
	const filteredOrm = createOrm({ schema: filtered, adapter: local });
	const deleted = ' AND __n."deletedAt" IS NULL';
	function walk(where: WhereIntent, adjacency = true): RecursiveIntent {
		return {
			type: 'recursive',
			cteName: 'tree',
			start: {
				from: 'categories',
				nodeIdExpr: { kind: 'column', name: 'id' },
				where,
			},
			traversal: adjacency
				? {
						kind: 'adjacency',
						nodeTable: 'categories',
						nodeId: 'id',
						parentId: 'parentId',
						direction: 'descendants',
					}
				: {
						kind: 'edge-table',
						nodeTable: 'categories',
						nodeId: 'id',
						edgeTable: 'archive',
						edgeFrom: 'id',
						edgeTo: 'score',
						direction: 'out',
					},
			maxDepth: 2,
		};
	}
	function plan(db: Db, where: WhereIntent, adjacency = true) {
		return planRecursive(
			walk(where, adjacency),
			db.model,
			db.defaultFilters ? { defaultFilters: db.defaultFilters } : {},
		);
	}
	function run(db: Db, where: WhereIntent, adjacency = true) {
		return local.compileRecursive(plan(db, where, adjacency), db.model);
	}
	function sql(anchor: string, adjacency = true, filter = false) {
		const join = adjacency
			? 'JOIN categories AS __n ON __n."parentId" = tree.id'
			: 'JOIN archive AS __e ON __e.id = tree.id JOIN categories AS __n ON __n.id = __e.score';
		return `WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM categories AS __n WHERE ${anchor}${filter ? deleted : ''} UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree ${join} WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)${filter ? deleted : ''}) SELECT tree.id AS id FROM tree`;
	}
	const rel = (filter: boolean) =>
		`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0."categoryId"${filter ? ' AND posts_exists_0."deletedAt" IS NULL' : ''} AND posts_exists_0.title = $1)`;
	const raw = (filter: boolean) =>
		`EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.title = $1${filter ? ' AND posts_sq."deletedAt" IS NULL' : ''})`;
	const forms: readonly [
		string,
		(orm: typeof plainOrm) => WhereIntent,
		(filter: boolean) => string,
		readonly unknown[],
	][] = [
		['rel', () => exists('posts', { where: eq('title', 'x') }), rel, ['x']],
		[
			'some',
			(orm) => some(orm.tables.categories.posts, () => eq('title', 'x')),
			rel,
			['x'],
		],
		[
			'none',
			(orm) => none(orm.tables.categories.posts, () => eq('title', 'x')),
			(filter) => `NOT (${rel(filter)})`,
			['x'],
		],
		[
			'rawexists',
			() => rawExists(subquery('posts').select('id').where(eq('title', 'x'))),
			raw,
			['x'],
		],
		[
			'issued',
			(orm) =>
				rawExists(
					issuedBody(
						orm.select('posts').columns(['id']).where(eq('title', 'x')),
					),
				),
			raw,
			['x'],
		],
		[
			'insub',
			() => inSubquery('id', subquery('posts').select('categoryId')),
			(filter) =>
				`__n.id = ANY (SELECT posts_subq_0."categoryId" FROM posts AS posts_subq_0${filter ? ' WHERE posts_subq_0."deletedAt" IS NULL' : ''})`,
			[],
		],
	];
	for (const adjacency of [true, false]) {
		const walkName = adjacency ? 'adjacency' : 'edge-table';
		for (const [name, where, anchor, params] of forms) {
			it(`AC1 ${name}-filtered ${walkName}: the default filter reaches the body`, () => {
				const result = run(filtered, where(filteredOrm), adjacency);
				expect(result.sql).toBe(sql(anchor(true), adjacency, true));
				expect(result.parameters).toEqual(params);
			});
			it(`AC3 plain-unchanged ${name} ${walkName}`, () => {
				const result = run(plain, where(plainOrm), adjacency);
				expect(result.sql).toBe(sql(anchor(false), adjacency));
				expect(result.parameters).toEqual(params);
			});
		}
		for (const [name, where, anchor, params] of [
			['eq', eq('score', 1), '__n.score = $1', [1]],
			['like', like('name', 'x%'), '__n.name LIKE $1', ['x%']],
		] as const) {
			it(`AC3 plain-unchanged ${name} ${walkName}`, () => {
				const result = run(plain, where, adjacency);
				expect(result.sql).toBe(sql(anchor, adjacency));
				expect(result.parameters).toEqual(params);
			});
			it(`AC3 filtered-eq-like ${name} ${walkName}: the condition precedes the anchor filter`, () => {
				const result = run(filtered, where, adjacency);
				expect(result.sql).toBe(sql(anchor, adjacency, true));
				expect(result.parameters).toEqual(params);
			});
		}
	}
	it('AC1 scalar-filtered: a scalar subquery body takes the filter', () => {
		const result = run(filtered, {
			kind: 'expression',
			expr: {
				kind: 'subquery',
				query: {
					...subquery('posts')
						.select('score')
						.where(eq('score', 3))
						.build()
						.toIntent(),
					orderBy: [{ field: 'score', direction: 'desc' }],
					limit: 1,
				},
			},
			operator: 'gt',
			value: 67,
		} as WhereIntent);
		expect(result.sql).toBe(
			sql(
				'(SELECT posts.score FROM posts WHERE posts."deletedAt" IS NULL AND posts.score = $1 ORDER BY posts.score DESC LIMIT 1) > $2',
				true,
				true,
			),
		);
		expect(result.parameters).toEqual([3, 67]);
	});
	for (const [label, db] of [
		['plain', plain],
		['filtered', filtered],
	] as const) {
		const filter = label === 'filtered';
		it(`AC2 dotted ${label}: a dotted relation path compiles to EXISTS`, () => {
			const result = run(db, eq('posts.title', 'x'));
			expect(result.sql).toBe(sql(rel(filter), true, filter));
			expect(result.parameters).toEqual(['x']);
		});
		it(`AC2 selfdot ${label}: a self-relation path compiles to EXISTS`, () => {
			const result = run(db, eq('parent.name', 'x'));
			expect(result.sql).toBe(
				sql(
					`EXISTS (SELECT 1 FROM categories AS categories_exists_0 WHERE __n."parentId" = categories_exists_0.id${filter ? ' AND categories_exists_0."deletedAt" IS NULL' : ''} AND categories_exists_0.name = $1)`,
					true,
					filter,
				),
			);
			expect(result.parameters).toEqual(['x']);
		});
		it(`AC4 recursive-message ${label}`, () => {
			expect(() =>
				run(
					db,
					exists('children', {
						recursive: { direction: 'down', through: 'children' },
					}),
				),
			).toThrow(
				new Error(
					"start.where exists('children'): recursive relation predicates are not supported inside start.where.",
				),
			);
		});
		it(`R1 undeclared-relation ${label}: planRecursive alone refuses`, () => {
			expect(() => plan(db, exists('nope'))).toThrow(
				new Error(
					"exists('nope'): no relation 'nope' is declared on table 'categories'. Use rawExists(subquery(...)) for an EXISTS over an undeclared or uncorrelated subquery.",
				),
			);
		});
	}
	const pathBody =
		'SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0."categoryId" AND EXISTS (SELECT 1 FROM categories AS categories_exists_1 WHERE posts_exists_0."categoryId" = categories_exists_1.id AND categories_exists_1.id = $1)';
	it('AC2 exists-path: a relation path given to exists() compiles to nested EXISTS', () => {
		const result = run(plain, exists('posts.category', { where: eq('id', 1) }));
		expect(result.sql).toBe(sql(`EXISTS (${pathBody})`));
		expect(result.parameters).toEqual([1]);
	});
	it('AC2 notexists-path: a relation path given to notExists() compiles under NOT', () => {
		const result = run(
			plain,
			notExists('posts.category', { where: eq('id', 1) }),
		);
		expect(result.sql).toBe(sql(`NOT (EXISTS (${pathBody}))`));
		expect(result.parameters).toEqual([1]);
	});
	it('AC4 outer-invisible: an invisible outerRef qualifier gets the resolver message', () => {
		expect(() =>
			run(
				plain,
				rawExists(
					subquery('posts')
						.select('id')
						.where(eq('categoryId', outerRef('invisible.id'))),
				),
			),
		).toThrow(
			new Error(
				"outerRef qualifier 'invisible' is not visible in an enclosing query.",
			),
		);
	});
	it('AC4 unknown-kind: an unknown kind gets the shared message', () => {
		expect(() =>
			plan(plain, JSON.parse('{"kind":"bogusKind"}') as WhereIntent),
		).toThrow(new Error("Unsupported predicate kind 'bogusKind'"));
	});
	it('AC4 many-to-many: a many-to-many exists carries the start.where label', () => {
		expect(() => plan(tagged, exists('tags'))).toThrow(
			new NotYetSupportedError(
				"many-to-many traversal exists('tags')",
				'start.where condition',
				787,
			),
		);
	});
	it('AC6 legacy-report: a report without recursiveFilters.start keeps the direct compile', () => {
		const report = plan(plain, neq('score', 1));
		const { start, ...rest } = report.recursiveFilters ?? {};
		expect(start).toBeDefined();
		const result = local.compileRecursive(
			{ ...report, recursiveFilters: rest },
			plain.model,
		);
		expect(result.sql).toBe(sql('__n.score != $1'));
		expect(result.parameters).toEqual([1]);
	});
	const correlated = (column: string) =>
		rawExists(
			subquery('posts')
				.select('id')
				.where(eq('categoryId', outerRef(column))),
		);
	for (const column of ['id', 'categories.id']) {
		for (const [label, db] of [
			['plain', plain],
			['filtered', filtered],
		] as const) {
			const filter = label === 'filtered';
			const body = `SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq."categoryId" = __n.id${filter ? ' AND posts_sq."deletedAt" IS NULL' : ''}`;
			it(`AC9 correlated-rawexists outerRef('${column}') ${label}`, () => {
				const result = run(db, correlated(column));
				expect(result.sql).toBe(sql(`EXISTS (${body})`, true, filter));
				expect(result.parameters).toEqual([]);
			});
			it(`AC9 correlated-rawnotexists outerRef('${column}') ${label}`, () => {
				const result = run(db, {
					...correlated(column),
					kind: 'rawNotExists',
				} as WhereIntent);
				expect(result.sql).toBe(sql(`NOT (EXISTS (${body}))`, true, filter));
				expect(result.parameters).toEqual([]);
			});
		}
	}
	for (const [column, target] of [
		['id', 'posts_exists_0.id'],
		['posts.id', 'posts_exists_0.id'],
		['categories.id', '__n.id'],
	] as const) {
		it(`AC9 correlated-nested outerRef('${column}') binds ${target}`, () => {
			const result = run(
				plain,
				exists('posts', {
					where: rawExists(
						subquery('categories')
							.select('id')
							.where(eq('id', outerRef(column))),
					),
				}),
			);
			expect(result.sql).toBe(
				sql(
					`EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0."categoryId" AND EXISTS (SELECT categories_sq.id FROM categories AS categories_sq WHERE categories_sq.id = ${target}))`,
				),
			);
			expect(result.parameters).toEqual([]);
		});
	}
	it('AC10 issued-policy-filtered: a filtered issuer keeps its filter under an unfiltered plan', () => {
		const result = run(
			plain,
			rawExists(
				issuedBody(
					filteredOrm.select('posts').columns(['id']).where(eq('title', 'x')),
				),
			),
		);
		expect(result.sql).toBe(sql(raw(true)));
		expect(result.parameters).toEqual(['x']);
	});
	it('AC10 issued-policy-optout: an opted-out issuer adds no filter under a filtered plan', () => {
		const result = run(
			filtered,
			rawExists(
				issuedBody(
					filteredOrm
						.select('posts')
						.withoutDefaultFilters()
						.columns(['id'])
						.where(eq('title', 'x')),
				),
			),
		);
		expect(result.sql).toBe(sql(raw(false), true, true));
		expect(result.parameters).toEqual(['x']);
	});
	for (const [name, where, anchor, params] of [
		['eq', eq('id', 1), '__n.id = CAST($1 AS int4)', [1]],
		[
			'in',
			inArray('id', [1, 2]),
			'__n.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		],
		[
			'ParamIntent',
			eq('id', { kind: 'param', value: 3 }),
			'__n.id = CAST($1 AS int4)',
			[3],
		],
		['param() wrapper', eq('id', param(3)), '__n.id = $1', [3]],
		[
			'any param() elements',
			any('id', [param(1), param(2)]),
			'__n.id = ANY (CAST($1 AS int4[]))',
			[[1, 2]],
		],
	] as const) {
		const key =
			name === 'eq' || name === 'in' ? 'typed-cast' : 'typed-param-forms';
		it(`AC11 ${key} ${name}`, () => {
			const result = run(typed, where);
			expect(result.sql).toBe(sql(anchor));
			expect(result.parameters).toEqual(params);
		});
	}
	const pr = { paramIndex: 7, value: 'payload' };
	for (const [key, name, where, anchor, params] of [
		[
			'paramref-anchor',
			'eq',
			eq('data', pr),
			'__n.data = CAST($1 AS jsonb)',
			[pr],
		],
		[
			'paramintent-nested',
			'eq',
			eq('data', { kind: 'param', value: { kind: 'param', value: 'payload' } }),
			'__n.data = CAST($1 AS jsonb)',
			[{ kind: 'param', value: 'payload' }],
		],
		[
			'param-wrapper',
			'jsonContains',
			{
				kind: 'jsonContains',
				field: 'data',
				value: param({ active: true }),
				reversed: false,
			},
			'__n.data @> $1',
			[{ active: true }],
		],
		[
			'param-wrapper',
			'like',
			{ kind: 'like', field: 'name', pattern: param('x%') },
			'__n.name LIKE $1',
			['x%'],
		],
		[
			'param-wrapper',
			'jsonExists',
			{ kind: 'jsonExists', field: 'data', key: param('k') },
			'__n.data ? $1',
			['k'],
		],
		[
			'in-param-wrapper',
			'elements',
			inArray('id', [param(1), param(2)]),
			'__n.id = ANY ($1)',
			[[1, 2]],
		],
		[
			'in-param-wrapper',
			'single array',
			inArray('id', [param([1, 2])]),
			'__n.id = ANY ($1)',
			[[1, 2]],
		],
		[
			'in-param-wrapper',
			'whole list',
			{ kind: 'in', field: 'id', values: param([1, 2]) },
			'__n.id = ANY ($1)',
			[[1, 2]],
		],
	] as const) {
		it(`AC12 ${key} ${name}: the resolved value binds as data`, () => {
			const result = run(plain, where as WhereIntent);
			expect(result.sql).toBe(sql(anchor));
			expect(result.parameters).toEqual(params);
		});
	}
	const recursion = {
		kind: 'exists',
		relation: 'children',
		where: eq('score', 71),
		recursive: { direction: 'down', through: 'children', maxDepth: 3 },
	} as const;
	it('AC13 exists-projection-recursion: recursion in a dropped EXISTS projection compiles', () => {
		const result = run(
			plain,
			rawExists(
				issuedBody(
					plainOrm
						.select('categories')
						.columns([
							caseWhen(recursion, literal(1)).else(literal(0)).as('flag'),
						]),
				),
			),
		);
		expect(result.sql).toBe(
			sql('EXISTS (SELECT 1 FROM categories AS categories_sq)'),
		);
		expect(result.parameters).toEqual([]);
	});
	it('AC13 exists-aggregate-filter-recursion: the aggregate stays, its FILTER goes', () => {
		const result = run(plain, {
			kind: 'rawExists',
			subquery: {
				type: 'select',
				from: 'categories',
				where: or(),
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'count', field: '*', filter: recursion }],
				},
			},
		} as WhereIntent);
		expect(result.sql).toBe(
			sql(
				'EXISTS (SELECT count(*) FROM categories AS categories_sq WHERE false)',
			),
		);
		expect(result.parameters).toEqual([]);
	});
	it('AC14 expression-rhs-ref: a column reference on the right compiles to the column', () => {
		const result = run(plain, {
			...fn('abs', exprRef('score')).eq(5),
			value: ref('score'),
		} as WhereIntent);
		expect(result.sql).toBe(sql('abs(__n.score) = __n.score'));
		expect(result.parameters).toEqual([]);
	});
	it('AC14 jsonpath-rhs-ref: the JSON extraction is kept', () => {
		const result = run(plain, {
			kind: 'comparison',
			field: 'data',
			operator: 'eq',
			jsonPath: ['foo'],
			jsonMode: 'json',
			value: exprRef('data'),
		} as WhereIntent);
		expect(result.sql).toBe(sql('(__n.data -> $1) = __n.data'));
		expect(result.parameters).toEqual(['foo']);
	});
	const hops = (column: string) =>
		({
			kind: 'relationFilter',
			relation: ['posts', 'comments'],
			mode: 'some',
			where: eq('id', outerRef(column)),
		}) as WhereIntent;
	it('AC15 multi-hop-outer-unqualified: binds the anchor range', () => {
		const result = run(plain, hops('id'));
		expect(result.sql).toBe(
			sql(
				'EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0."categoryId" AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1."postId" AND comments_exists_1.id = __n.id))',
			),
		);
		expect(result.parameters).toEqual([]);
	});
	it('AC15 multi-hop-outer-intermediate: an intermediate hop qualifier is refused', () => {
		expect(() => plan(plain, hops('posts.id'))).toThrow(
			new Error(
				"outerRef qualifier 'posts' is not visible in an enclosing query.",
			),
		);
	});
	it('an unknown start table is reported before a start.where refusal', () => {
		const query = walk(exists('rel'));
		expect(() =>
			planRecursive(
				{
					...query,
					start: { ...query.start, from: 'nope' },
					traversal: { ...query.traversal, nodeTable: 'nope' },
				} as RecursiveIntent,
				plain.model,
			),
		).toThrow(new Error('Unknown table: nope'));
	});
	it('R2 scalar-aggregate-filter: planRecursive alone refuses', () => {
		expect(() =>
			plan(plain, {
				kind: 'subquery',
				field: 'score',
				operator: 'gt',
				subquery: {
					type: 'select',
					from: 'posts',
					select: {
						type: 'aggregate',
						aggregates: [
							{ function: 'count', field: '*', filter: eq('score', 1) },
						],
					},
				},
			} as WhereIntent),
		).toThrow(
			new Error(
				'scalar subquery with an aggregate FILTER is not supported — it would silently change which rows match; restructure the query or use a CTE.',
			),
		);
	});
});

describe('a relation-path ColumnRef in a recursive start.where (#991)', () => {
	const nodeDb = schema({
		nodes: {
			id: { type: 'integer', primaryKey: true },
			label: 'text',
			parent_id: ref('nodes', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const nodeOrm = createOrm({
		schema: nodeDb,
		adapter: createPgCompileOnlyAdapter({ model: nodeDb.model }),
		suppressDxWarnings: true,
	});
	const { nodes } = nodeOrm.tables;
	const walk = (where: WhereIntent): RecursiveIntent => ({
		type: 'recursive',
		cteName: 'tree',
		start: { from: 'nodes', nodeIdExpr: { kind: 'column', name: 'id' }, where },
		traversal: {
			kind: 'adjacency',
			nodeTable: 'nodes',
			nodeId: 'id',
			parentId: 'parent_id',
			direction: 'descendants',
		},
		maxDepth: 2,
	});
	const L = () => eq(nodes.parent.label, 'x');
	it('AC29 nested-positions-refused recursive start.where body', () => {
		expect(() =>
			planRecursive(walk(exists('parent', { where: L() })), nodeDb.model),
		).toThrow(
			new Error(
				"ColumnRef 'parent.label' follows a relation; inside a relation predicate, quantifier callback or subquery body its path would be read from that body's row (#1014).",
			),
		);
	});
	it('AC30 top-level-unchanged recursive start.where', () => {
		const result = createPgCompileOnlyAdapter().compileRecursive(
			planRecursive(walk(L()), nodeDb.model),
			nodeDb.model,
		);
		expect(result.sql).toBe(
			'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE __n.parent_id = nodes_exists_0.id AND nodes_exists_0.label = $1) UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN nodes AS __n ON __n.parent_id = tree.id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		);
		expect(result.parameters).toEqual(['x']);
	});
});

describe('hand-built recursive reports (#1027)', () => {
	const linked = schema(
		{
			users: {
				id: { type: 'integer', primaryKey: true },
				parentId: { type: 'integer', nullable: true },
			},
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('users', { as: 'author', inverse: 'authored' }),
				parentId: { type: 'integer', nullable: true },
			},
			tags: { id: { type: 'integer', primaryKey: true } },
			postTags: { postId: ref('posts'), tagId: ref('tags') },
		},
		undefined,
		{
			relations: {
				posts: {
					tags: manyToMany('tags', {
						through: 'postTags',
						inverse: 'posts',
						sourceForeignKey: ['postId'],
						targetForeignKey: ['tagId'],
					}),
				},
			},
		},
	);
	const local = createPgCompileOnlyAdapter({ model: linked.model });
	// A report issued by planRecursive resolves start.where in core; one without
	// recursiveFilters keeps the adapter's direct anchor compile.
	function handBuilt(table: 'users' | 'posts', where: WhereIntent) {
		const issued = planRecursive(
			{
				type: 'recursive',
				cteName: 'tree',
				start: {
					from: table,
					nodeIdExpr: { kind: 'column', name: 'id' },
					where: eq('id', 1),
				},
				traversal: {
					kind: 'adjacency',
					nodeTable: table,
					nodeId: 'id',
					parentId: 'parentId',
					direction: 'descendants',
				},
				maxDepth: 2,
			},
			linked.model,
		);
		const { recursiveFilters: _resolved, ...report } = issued;
		return {
			...report,
			intent: { ...report.intent, start: { ...report.intent.start, where } },
		} as typeof issued;
	}
	it("types the hand-built anchor's many-to-many refusal", () => {
		expect(() =>
			local.compileRecursive(handBuilt('posts', exists('tags')), linked.model),
		).toThrow(
			new NotYetSupportedError(
				"many-to-many traversal exists('tags')",
				'WHERE condition',
				787,
			),
		);
		expect(() =>
			local.compileRecursive(
				handBuilt(
					'users',
					exists('authored', { include: { tags: { join: 'inner' } } }),
				),
				linked.model,
			),
		).toThrow(
			new NotYetSupportedError(
				"many-to-many traversal include('tags')",
				'RECURSIVE-ANCHOR condition',
				787,
			),
		);
	});
});
