import {
	and,
	createOrm,
	eq,
	exists,
	inSubquery,
	not,
	or,
	outerRef,
	rawExists,
	ref,
	schema,
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

it('nested rawExists same alias refusal', () => {
	expect(() => dump(rawExists(subquery('posts').select('id')))).toThrow(
		"Query scope already binds qualifier 'posts_sq'.",
	);
	expect(() =>
		dump(rawExists(subquery('posts').select('id').where(eq('score', 3)))),
	).toThrow("Query scope already binds qualifier 'posts_sq'.");
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
			'many-to-many relation predicates need the junction declaration (#787)',
		);
	});
}
