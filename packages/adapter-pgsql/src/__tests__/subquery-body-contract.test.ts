import {
	and,
	any,
	createOrm,
	eq,
	exists,
	fn,
	inSubquery,
	not,
	or,
	outerRef,
	rawExists,
	ref,
	schema,
	star,
	subquery,
} from '@dbsp/core';
import type { ModelIR, WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileCondition,
} from '../condition-compiler.js';
import { createCompilerState } from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true }, score: 'integer' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		score: 'integer',
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		score: 'integer',
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
const dump = (body: WhereIntent) =>
	orm
		.select('users')
		.where(rawExists(subquery('posts').select('id').where(body)))
		.dump();

it('supplied callback sentinel retains its result and parameters', () => {
	const sentinel = { A_Const: { ival: { ival: 731 } } };
	const state = createCompilerState();
	let calls = 0;
	const result = compileCondition(
		rawExists(subquery('posts').select('id').where(eq('score', 5))),
		{
			logicalSourceTable: 'users',
			emittedAlias: 'users',
			visibleAliases: new Map(),
			position: 'where',
			paramState: state,
			compileSubquery: (_intent, offset, parent) => {
				calls++;
				expect(offset).toBe(0);
				expect(parent?.paramState).toBe(state);
				return { sql: sentinel, paramCount: 1, parameters: [91] };
			},
		},
	);
	expect(calls).toBe(1);
	expect(result).toMatchObject({ SubLink: { subselect: sentinel } });
	expect(state.parameters).toEqual([91]);
	expect(state.paramIndex).toBe(1);
});

it('supplied callback sentinel survives inside the direct builder', () => {
	const state = createCompilerState();
	const sentinel = { A_Const: { ival: { ival: 733 } } };
	let calls = 0;
	const result = buildSubqueryFromIntent(
		subquery('posts')
			.select('id')
			.where(rawExists(subquery('comments').select('id')))
			.build().intent,
		0,
		{
			rootTable: 'users',
			aliases: new Map(),
			paramState: state,
			compileSubquery: (_query, offset, child) => {
				calls++;
				expect(offset).toBe(0);
				expect(child?.rootTable).toBe('posts');
				expect(child?.currentAlias).toBe('posts_sq');
				expect(child?.paramState).toBe(state);
				state.parameters.push(93);
				state.paramIndex++;
				return { sql: sentinel, paramCount: 0, parameters: [] };
			},
		},
	);
	expect(calls).toBe(1);
	expect(result.sql).toMatchObject({
		SelectStmt: { whereClause: { SubLink: { subselect: sentinel } } },
	});
	expect(result.paramCount).toBe(0);
	expect(result.parameters).toEqual([]);
	expect(state.parameters).toEqual([93]);
	expect(state.paramIndex).toBe(1);
});

it('child alias exact SQL', () => {
	const result = dump(exists('comments', { where: eq('score', 7) }));
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts_sq.id = comments_exists_0."postId" AND comments_exists_0.score = $1))',
	);
	expect(result.params).toEqual([7]);
});

const shapes = [
	{
		name: 'leaf',
		wrap: (c: WhereIntent) => c,
		sql: 'posts_sq.score = (SELECT comments_subq_0.score FROM comments AS comments_subq_0 WHERE comments_subq_0."postId" = posts_sq.id AND comments_subq_0.score = $3)',
		params: [1, 2, 3, 4],
	},
	{
		name: 'and',
		wrap: (c: WhereIntent) => and(c, eq('score', 5)),
		sql: 'posts_sq.score = (SELECT comments_subq_0.score FROM comments AS comments_subq_0 WHERE comments_subq_0."postId" = posts_sq.id AND comments_subq_0.score = $3) AND posts_sq.score = $4',
		params: [1, 2, 3, 5, 4],
	},
	{
		name: 'or',
		wrap: (c: WhereIntent) => or(c, eq('score', 5)),
		sql: '(posts_sq.score = (SELECT comments_subq_0.score FROM comments AS comments_subq_0 WHERE comments_subq_0."postId" = posts_sq.id AND comments_subq_0.score = $3) OR posts_sq.score = $4)',
		params: [1, 2, 3, 5, 4],
	},
	{
		name: 'not',
		wrap: (c: WhereIntent) => not(c),
		sql: 'NOT (posts_sq.score = (SELECT comments_subq_0.score FROM comments AS comments_subq_0 WHERE comments_subq_0."postId" = posts_sq.id AND comments_subq_0.score = $3))',
		params: [1, 2, 3, 4],
	},
	{
		name: 'two-level',
		wrap: (c: WhereIntent) => or(not(c), eq('score', 5)),
		sql: '(NOT (posts_sq.score = (SELECT comments_subq_0.score FROM comments AS comments_subq_0 WHERE comments_subq_0."postId" = posts_sq.id AND comments_subq_0.score = $3)) OR posts_sq.score = $4)',
		params: [1, 2, 3, 5, 4],
	},
];
for (const shape of shapes)
	it(`nested scalar ${shape.name} distinct aliases numbering immediate outerRef`, () => {
		const scalar: WhereIntent = {
			kind: 'subquery',
			field: 'score',
			operator: 'eq',
			subquery: subquery('comments')
				.select('score')
				.where(and(eq('postId', outerRef('id')), eq('score', 3)))
				.build().intent,
		};
		const result = orm
			.select('users')
			.where(
				and(
					eq('score', 1),
					rawExists(
						subquery('posts')
							.select('id')
							.where(and(eq('score', 2), shape.wrap(scalar))),
					),
					eq('score', 4),
				),
			)
			.dump();
		expect(result.sql).toBe(
			`SELECT users.* FROM users WHERE users.score = $1 AND EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = $2 AND ${shape.sql}) AND users.score = $${shape.params.length}`,
		);
		expect(result.params).toEqual(shape.params);
	});

it('nested rawExists same table allocates a distinct alias', () => {
	const result = dump(
		rawExists(subquery('posts').select('id').where(eq('score', 3))),
	);
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT posts_sq_1.id FROM posts AS posts_sq_1 WHERE posts_sq_1.score = $1))',
	);
	expect(result.params).toEqual([3]);
});
it('nested rawExists distinct alias outcome', () => {
	const result = dump(
		rawExists(
			subquery('comments')
				.select('id')
				.where(and(eq('postId', outerRef('id')), eq('score', 3))),
		),
	);
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT comments_sq.id FROM comments AS comments_sq WHERE comments_sq."postId" = posts_sq.id AND comments_sq.score = $1))',
	);
	expect(result.params).toEqual([3]);
});

it('scalar and IN bodies keep outer qualifier and one numbering across two subqueries', () => {
	const scalar: WhereIntent = {
		kind: 'subquery',
		field: 'score',
		operator: 'eq',
		subquery: subquery('posts')
			.select('score')
			.where(and(eq('authorId', outerRef('id')), eq('score', 2)))
			.build().intent,
	};
	const result = orm
		.select('users')
		.where(
			and(
				eq('score', 1),
				scalar,
				inSubquery(
					'id',
					subquery('comments')
						.select('postId')
						.where(and(eq('postId', outerRef('id')), eq('score', 3))),
				),
			),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE users.score = $1 AND users.score = (SELECT posts_subq_0.score FROM posts AS posts_subq_0 WHERE posts_subq_0."authorId" = users.id AND posts_subq_0.score = $2) AND users.id = ANY (SELECT comments_subq_1."postId" FROM comments AS comments_subq_1 WHERE comments_subq_1."postId" = users.id AND comments_subq_1.score = $3)',
	);
	expect(result.params).toEqual([1, 2, 3]);
});

for (const position of ['raw', 'scalar', 'in'] as const) {
	const run = (condition: WhereIntent, model: ModelIR = db.model) => {
		const local = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		const q = subquery('posts').select('id').where(condition);
		const predicate: WhereIntent =
			position === 'raw'
				? rawExists(q)
				: position === 'in'
					? inSubquery('id', q)
					: {
							kind: 'subquery',
							field: 'id',
							operator: 'eq',
							subquery: q.build().intent,
						};
		return local.select('users').where(predicate).dump();
	};
	it(`${position} undeclared refusal`, () =>
		expect(() => run(exists('typo'))).toThrow(
			"no relation 'typo' is declared on table 'posts'",
		));
	it(`${position} recursive refusal`, () =>
		expect(() =>
			run({
				kind: 'exists',
				relation: 'comments',
				recursive: { direction: 'down', through: 'parentId' },
			} as WhereIntent),
		).toThrow('recursive relation predicates are not supported inside WHERE'));
	it(`${position} many-to-many refusal`, () => {
		const relations = new Map(db.model.relations);
		const prior = db.model
			.getRelationsFrom('posts')
			.find((r) => r.name === 'comments')!;
		relations.set('posts.comments', { ...prior, type: 'belongsToMany' });
		const model: ModelIR = {
			...db.model,
			getTable: (name) => db.model.getTable(name),
			isAmbiguous: (source, target) => db.model.isAmbiguous(source, target),
			getRelationsTo: (target) =>
				[...relations.values()].filter((r) => r.target === target),
			relations,
			getRelation: (name) => relations.get(name),
			getRelationsFrom: (source) =>
				[...relations.values()].filter((r) => r.source === source),
		};
		expect(() => run(exists('comments'), model)).toThrow(
			'many-to-many traversal is not supported yet (#787)',
		);
	});
}

for (const kind of ['rawExists', 'rawNotExists'] as const) {
	const predicate = (body: ReturnType<typeof subquery>) => ({
		...rawExists(body),
		kind,
	});
	it(`FILTER ${kind} body uses model array type`, () => {
		const result = orm
			.select('users')
			.columns([
				fn('count', star())
					.filter(
						predicate(subquery('posts').select('id').where(any('score', []))),
					)
					.as('n'),
			])
			.dump();
		expect(result.sql).toBe(
			`SELECT count(*) FILTER (WHERE ${kind === 'rawNotExists' ? 'NOT (' : ''}EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = ANY (CAST($1 AS int4[])))${kind === 'rawNotExists' ? ')' : ''}) AS n FROM users`,
		);
		expect(result.params).toEqual([[]]);
	});
}
for (const sibling of [false, true]) {
	it(`three nested same-table aliases with sibling ${sibling}`, () => {
		const deepest = subquery('posts')
			.select('id')
			.where(and(eq('score', 3), eq('id', outerRef('id'))));
		const middle = subquery('posts')
			.select('id')
			.where(
				and(
					eq('score', 2),
					eq('id', outerRef('id')),
					inSubquery('id', deepest),
				),
			);
		const nested = inSubquery(
			'id',
			subquery('posts')
				.select('id')
				.where(
					and(
						eq('score', 1),
						eq('id', outerRef('id')),
						inSubquery('id', middle),
					),
				),
		);
		const result = orm
			.select('users')
			.where(
				sibling
					? and(
							inSubquery(
								'id',
								subquery('posts').select('id').where(eq('score', 0)),
							),
							nested,
						)
					: nested,
			)
			.dump();
		const n = sibling ? 1 : 0;
		const offset = sibling ? 1 : 0;
		const a = `posts_subq_${n}`,
			b = `posts_subq_${n + 1}`,
			c = `posts_subq_${n + 2}`;
		expect(result.sql).toBe(
			`SELECT users.* FROM users WHERE ${sibling ? 'users.id = ANY (SELECT posts_subq_0.id FROM posts AS posts_subq_0 WHERE posts_subq_0.score = $1) AND ' : ''}users.id = ANY (SELECT ${a}.id FROM posts AS ${a} WHERE ${a}.score = $${offset + 1} AND ${a}.id = users.id AND ${a}.id = ANY (SELECT ${b}.id FROM posts AS ${b} WHERE ${b}.score = $${offset + 2} AND ${b}.id = ${a}.id AND ${b}.id = ANY (SELECT ${c}.id FROM posts AS ${c} WHERE ${c}.score = $${offset + 3} AND ${c}.id = ${b}.id)))`,
		);
		expect(result.sql).toContain(`posts_subq_${n}.id = users.id`);
		expect(result.sql).toContain(`posts_subq_${n + 1}.id = posts_subq_${n}.id`);
		expect(result.sql).toContain(
			`posts_subq_${n + 2}.id = posts_subq_${n + 1}.id`,
		);
		expect(result.sql.match(/FROM posts AS posts_subq_\d+/g)).toEqual(
			Array.from(
				{ length: sibling ? 4 : 3 },
				(_, i) => `FROM posts AS posts_subq_${i}`,
			),
		);
		expect(result.params).toEqual(sibling ? [0, 1, 2, 3] : [1, 2, 3]);
		expect(result.sql.match(/\$\d+/g)).toEqual(
			result.params.map((_, i) => `$${i + 1}`),
		);
	});
}

it('rawExists sibling then nested same table has unique aliases and immediate outerRef', () => {
	const result = orm
		.select('users')
		.where(
			and(
				rawExists(subquery('posts').select('id').where(eq('score', 0))),
				rawExists(
					subquery('posts')
						.select('id')
						.where(
							and(
								eq('score', 1),
								eq('id', outerRef('id')),
								rawExists(
									subquery('posts')
										.select('id')
										.where(and(eq('score', 2), eq('id', outerRef('id')))),
								),
							),
						),
				),
			),
		)
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE posts_sq.score = $1) AND EXISTS (SELECT posts_sq_1.id FROM posts AS posts_sq_1 WHERE posts_sq_1.score = $2 AND posts_sq_1.id = users.id AND EXISTS (SELECT posts_sq_2.id FROM posts AS posts_sq_2 WHERE posts_sq_2.score = $3 AND posts_sq_2.id = posts_sq_1.id))',
	);
	expect(result.params).toEqual([0, 1, 2]);
});

it('canonical subquery body avoids repeated recursive validation', () => {
	let reads = 0;
	const body = exists('comments');
	Object.defineProperty(body, 'recursive', {
		enumerable: true,
		get: () => {
			reads++;
			return undefined;
		},
	});
	const result = orm
		.select('users')
		.where(inSubquery('id', subquery('posts').select('id').where(body)))
		.dump();
	expect(result.params).toEqual([]);
	// One validation read plus the retained lowering/handler reads.
	expect(reads).toBe(3);
});

it('qualified outerRef binds nearest enclosing same-table query at depth three', () => {
	const result = dump(
		rawExists(
			subquery('posts')
				.select('id')
				.where(
					rawExists(
						subquery('posts')
							.select('id')
							.where(eq('id', outerRef('posts.id'))),
					),
				),
		),
	);
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT posts_sq.id FROM posts AS posts_sq WHERE EXISTS (SELECT posts_sq_1.id FROM posts AS posts_sq_1 WHERE EXISTS (SELECT posts_sq_2.id FROM posts AS posts_sq_2 WHERE posts_sq_2.id = posts_sq_1.id)))',
	);
	expect(result.params).toEqual([]);
});

for (const table of ['t'.repeat(63)]) {
	it(`generated aliases fit 63 bytes and preserve self correlation: ${table}`, () => {
		const model = schema({
			[table]: { id: { type: 'integer', primaryKey: true } },
		});
		const longOrm = createOrm({
			schema: model,
			adapter: createPgCompileOnlyAdapter({ model: model.model }),
		});
		const prefix = 't'.repeat(60);
		const alias = `${prefix}_sq`;
		const result = longOrm
			.select(table)
			.where(
				rawExists(
					subquery(table)
						.select('id')
						.where(eq('id', outerRef('id'))),
				),
			)
			.dump();
		expect(new TextEncoder().encode(alias).length).toBe(63);
		expect(result.sql).toBe(
			`SELECT ${table}.* FROM ${table} WHERE EXISTS (SELECT ${alias}.id FROM ${table} AS ${alias} WHERE ${alias}.id = ${table}.id)`,
		);
		expect(result.params).toEqual([]);
	});
}

it('handler subquery aliases fit 63 bytes across siblings', () => {
	const table = 't'.repeat(63);
	const model = schema({
		[table]: { id: { type: 'integer', primaryKey: true } },
	});
	const longOrm = createOrm({
		schema: model,
		adapter: createPgCompileOnlyAdapter({ model: model.model }),
	});
	const body = subquery(table)
		.select('id')
		.where(eq('id', outerRef('id')));
	const first = `${'t'.repeat(56)}_subq_0`;
	const second = `${'t'.repeat(56)}_subq_1`;
	const result = longOrm
		.select(table)
		.where(and(inSubquery('id', body), inSubquery('id', body)))
		.dump();
	expect(result.sql).toBe(
		`SELECT ${table}.* FROM ${table} WHERE ${table}.id = ANY (SELECT ${first}.id FROM ${table} AS ${first} WHERE ${first}.id = ${table}.id) AND ${table}.id = ANY (SELECT ${second}.id FROM ${table} AS ${second} WHERE ${second}.id = ${table}.id)`,
	);
	expect(result.params).toEqual([]);
});
