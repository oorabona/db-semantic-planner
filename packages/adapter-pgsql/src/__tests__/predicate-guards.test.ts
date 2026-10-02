import {
	and,
	createOrm,
	eq,
	exists,
	inSubquery,
	like,
	not,
	notExists,
	or,
	planRecursive,
	ref,
	schema,
	some,
	subquery,
} from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { compilePlan } from '../compiler.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	users: { id: { type: 'integer', primaryKey: true }, name: { type: 'text' } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	edges: {
		id: { type: 'integer', primaryKey: true },
		from_id: { type: 'integer' },
		to_id: { type: 'integer' },
	},
} as const);
const model = testSchema.model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ schema: testSchema, adapter });
const refusal =
	/Relation predicates inside an include where are not supported yet.*include\[0\]\(posts\).*#892/;

describe('#888 include preflight', () => {
	for (const join of [undefined, 'inner', 'left'] as const) {
		for (const [name, where] of [
			['exists', exists('comments')],
			['notExists', notExists('comments')],
			[
				'relationFilter',
				some(orm.tables.posts.comments, () => eq('published', true)),
			],
			['nested boolean', and(eq('id', 1), not(or(exists('comments'))))],
		] as const) {
			it(`refuses ${name} with ${join ?? 'default'} strategy`, () => {
				expect(() =>
					orm
						.select('users')
						.include('posts', { ...(join && { join }), where })
						.dump(),
				).toThrow(refusal);
			});
		}
	}
	for (const strategy of ['lateral', 'cte', 'subquery', 'json_agg'] as const) {
		it(`refuses forced ${strategy} include`, () => {
			expect(() =>
				orm
					.select('users')
					.withPlanOptions({ defaultIncludeStrategy: strategy })
					.include('posts', { where: exists('comments') })
					.dump(),
			).toThrow(refusal);
		});
	}
	it('refuses nested include relation filters with their path', () => {
		expect(() =>
			orm
				.select('users')
				.include('posts', {
					include: [
						{
							relation: 'comments',
							where: some(orm.tables.comments.post, () => eq('id', 1)),
						},
					],
				})
				.dump(),
		).toThrow(/include\[0\]\(posts\).*include\[0\]\(comments\).*#892/);
	});
});
function recursive(where: WhereIntent) {
	return adapter.compileRecursive(
		planRecursive(
			{
				type: 'recursive',
				cteName: 'tree',
				start: {
					from: 'users',
					nodeIdExpr: { kind: 'column', name: 'id' },
					where,
				},
				traversal: {
					kind: 'edge-table',
					nodeTable: 'users',
					nodeId: 'id',
					edgeTable: 'edges',
					edgeFrom: 'from_id',
					edgeTo: 'to_id',
					direction: 'out',
				},
				maxDepth: 2,
			},
			model,
		),
		model,
	);
}
describe('#888 recursive anchor', () => {
	for (const where of [like('name', 'A%'), not(like('name', 'A%'))]) {
		it(`refuses ${where.kind} with unsupported like leaf`, () => {
			expect(() => recursive(where)).toThrow(/recursive start\.where.*like/);
		});
	}
	it('negates a supported comparison and binds its value', () => {
		const result = recursive(not(eq('name', 'x')));
		expect(result.sql).toBe(
			'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE NOT (__n.name = $1) UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN edges AS __e ON __e.from_id = tree.id JOIN users AS __n ON __n.id = __e.to_id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
		);
		expect(result.parameters).toEqual(['x']);
	});
});

it('everyHandler negates both conditions and binds both parameters', () => {
	const result = compilePlan({
		rootTable: 'users',
		decisions: [
			{ type: 'select', column: '*' },
			{
				type: 'where',
				operator: 'every',
				relation: 'posts',
				targetTable: 'posts',
				sourceColumn: 'id',
				targetColumn: 'authorId',
				conditions: [
					{ type: 'where', operator: '=', column: 'id', value: 1 },
					{ type: 'where', operator: '=', column: 'authorId', value: 2 },
				],
			},
		],
	});
	expect(result.sql).toBe(
		'SELECT * FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND NOT (posts_exists_0.id = $1 AND posts_exists_0."authorId" = $2)))',
	);
	expect(result.parameters).toEqual([1, 2]);
});

for (const kind of [
	'in',
	'any',
	'null',
	'range',
	'exists',
	'notExists',
	'rawExists',
	'rawNotExists',
	'relationFilter',
	'subquery',
	'jsonContains',
	'jsonExists',
	'expression',
	'unknown_kind',
]) {
	it(`refuses recursive anchor ${kind}`, () => {
		expect(() => recursive({ kind } as WhereIntent)).toThrow(
			new RegExp(`recursive start\\.where.*${kind}`),
		);
	});
}

for (const join of ['inner', 'left'] as const) {
	it(`keeps ordinary ${join} include conditions in root WHERE`, () => {
		const result = orm
			.select('users')
			.include('posts', { join, where: eq('id', 7) })
			.dump();
		expect(result.sql).toBe(
			join === 'inner'
				? 'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.id = $1'
				: 'SELECT users.*, posts.id AS "posts.id" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.id = $1',
		);
		expect(result.params).toEqual([7]);
	});
}

for (const predicate of [
	exists('post'),
	notExists('post'),
	some(orm.tables.comments.post, () => eq('id', 1)),
]) {
	const body = {
		type: 'select',
		from: 'comments',
		select: { type: 'fields', fields: ['id'] },
		where: and(eq('id', 7), not(or(predicate))),
	} as const;
	for (const [name, where] of [
		[
			'scalar',
			{ kind: 'subquery', field: 'id', operator: 'eq', subquery: body },
		],
		['IN', { kind: 'in', field: 'id', subquery: body }],
		['rawExists', { kind: 'rawExists', subquery: body }],
		['rawNotExists', { kind: 'rawNotExists', subquery: body }],
		[
			'expression',
			{
				kind: 'expression',
				expr: { kind: 'subquery', query: body },
				operator: 'eq',
				value: 1,
			},
		],
		[
			'named argument expression',
			{
				kind: 'expression',
				expr: {
					kind: 'function',
					name: 'custom',
					args: [
						{
							kind: 'namedArg',
							name: 'input',
							value: { kind: 'subquery', query: body },
						},
					],
				},
				operator: 'eq',
				value: 1,
			},
		],
		[
			'deep query',
			{
				kind: 'rawExists',
				subquery: { ...body, where: { kind: 'rawNotExists', subquery: body } },
			},
		],
	] as const) {
		it(`refuses ${predicate.kind} inside join include ${name} query body`, () => {
			expect(() =>
				orm
					.select('users')
					.include('posts', { join: 'inner', where: where as WhereIntent })
					.dump(),
			).toThrow(refusal);
		});
	}
}

it('treats parameter payloads as opaque in join include where', () => {
	const value = { kind: 'exists', relation: 'comments' };
	const result = orm
		.select('users')
		.include('posts', { join: 'inner', where: eq('id', value) })
		.dump();
	expect(result.sql).toBe(
		'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.id = $1',
	);
	expect(result.params).toEqual([value]);
});

it('keeps a join include IN query body without relation predicates', () => {
	const result = orm
		.select('users')
		.include('posts', {
			join: 'inner',
			where: inSubquery(
				'id',
				subquery('comments').select('postId').where(eq('published', true)),
			),
		})
		.dump();
	expect(result.sql).toBe(
		'SELECT users.*, posts.id AS "posts.id" FROM users JOIN posts AS posts ON users.id = posts."authorId" WHERE posts.id = ANY (SELECT comments_subq_1."postId" FROM comments AS comments_subq_1 WHERE comments_subq_1.published = $1)',
	);
	expect(result.params).toEqual([true]);
});
