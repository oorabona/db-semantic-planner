import {
	and,
	createOrm,
	eq,
	every,
	exists,
	fn,
	none,
	notExists,
	planRecursive,
	ref,
	schema,
	some,
	star,
} from '@dbsp/core';
import type { RecursiveIntent, WhereIntent } from '@dbsp/types';
import { expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		parentId: { type: 'integer' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users'),
		published: { type: 'boolean' },
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		postId: ref('posts'),
		authorName: { type: 'text' },
	},
} as const);
const adapter = createPgCompileOnlyAdapter({
	model: db.model,
	dbCasing: 'snake_case',
});
const orm = createOrm({ schema: db, adapter });
const rawPosts: WhereIntent = {
	kind: 'relationFilter',
	relation: 'posts',
	mode: 'some',
	where: eq('published', true),
};
const correlation = 'users.id = posts_exists_0.user_id';

it('compiles the README some(users.posts) example with declared inverse keys', () => {
	expect(db.tables.users.posts).toBeDefined();
	// Use the existing broad predicate type; schema callback typing is outside this fix.
	const result = orm
		.select('users')
		.where(
			some(db.tables.users.posts as typeof orm.tables.users.posts, (p) =>
				eq(p.published!, true),
			),
		)
		.dump();
	expect(result.sql).toBe(
		`SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE ${correlation} AND posts_exists_0.published = $1)`,
	);
	expect(result.params).toEqual([true]);
});

for (const [name, predicate] of [
	['some', rawPosts],
	['every', every(orm.tables.users.posts, () => eq('published', true))],
	['none', none(orm.tables.users.posts, () => eq('published', true))],
	['exists', exists('posts', { where: eq('published', true) })],
	['notExists', notExists('posts', { where: eq('published', true) })],
] as const) {
	it(`${name} resolves the inverse in root WHERE and FILTER`, () => {
		const root = orm.select('users').where(predicate).dump();
		const filtered = orm
			.select('users')
			.columns([fn('count', star()).filter(predicate).as('n')])
			.dump();
		const inner = `${correlation} AND ${name === 'every' ? 'NOT (posts_exists_0.published = $1)' : 'posts_exists_0.published = $1'}`;
		const positive = `EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE ${inner})`;
		const condition =
			name === 'every' || name === 'none' || name === 'notExists'
				? `NOT (${positive})`
				: positive;
		expect(root.sql).toBe(`SELECT users.* FROM users WHERE ${condition}`);
		expect(root.sql).toContain(correlation);
		expect(filtered.sql).toBe(
			`SELECT count(*) FILTER (WHERE ${condition}) AS n FROM users`,
		);
		expect(root.params).toEqual([true]);
		expect(filtered.params).toEqual([true]);
	});
}

it('compiles the second raw-intent shape: posts filtered by comments.author_name', () => {
	const result = orm
		.select('posts')
		.where({
			kind: 'relationFilter',
			relation: 'comments',
			mode: 'some',
			where: eq('author_name', 'Charlie'),
		})
		.dump();
	expect(result.sql).toBe(
		'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM comments AS comments_exists_0 WHERE posts.id = comments_exists_0.post_id AND comments_exists_0.author_name = $1)',
	);
	expect(result.params).toEqual(['Charlie']);
});

it('validates default inverse paths for vacuous every and multiple hops', () => {
	expect(
		orm
			.select('users')
			.where({
				kind: 'relationFilter',
				relation: 'posts',
				mode: 'every',
				where: and(),
			})
			.dump().sql,
	).toBe('SELECT users.* FROM users WHERE true');
	const result = orm
		.select('users')
		.where({
			kind: 'relationFilter',
			relation: ['posts', 'comments'],
			mode: 'some',
			where: eq('author_name', 'Charlie'),
		})
		.dump();
	expect(result.sql).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.user_id AND EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.author_name = $1))',
	);
	expect(result.params).toEqual(['Charlie']);
	expect(
		orm
			.select('users')
			.where({
				kind: 'relationFilter',
				relation: ['posts', 'comments'],
				mode: 'every',
				where: and(),
			})
			.dump().sql,
	).toBe('SELECT users.* FROM users WHERE true');
});

it('recursive start.where resolves the same inverse without changing anchor aliases', () => {
	const intent: RecursiveIntent = {
		type: 'recursive',
		cteName: 'tree',
		start: {
			from: 'users',
			nodeIdExpr: { kind: 'column', name: 'id' },
			where: rawPosts,
		},
		traversal: {
			kind: 'adjacency',
			nodeTable: 'users',
			nodeId: 'id',
			parentId: 'parentId',
			direction: 'descendants',
		},
		maxDepth: 2,
	};
	const result = adapter.compileRecursive(
		planRecursive(intent, db.model),
		db.model,
	);
	expect(result.sql).toBe(
		'WITH RECURSIVE tree AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM users AS __n WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE __n.id = posts_exists_0.user_id AND posts_exists_0.published = $1) UNION ALL SELECT __n.id AS id, tree.__depth + 1 AS __depth, tree.__visited || __n.id AS __visited FROM tree JOIN users AS __n ON __n.parent_id = tree.id WHERE tree.__depth < 2 AND __n.id <> ALL (tree.__visited)) SELECT tree.id AS id FROM tree',
	);
	expect(result.parameters).toEqual([true]);
});

it('retains the exact refusal for a truly undeclared relation', () => {
	expect(() =>
		orm
			.select('users')
			.where({ ...rawPosts, relation: 'missing' })
			.dump(),
	).toThrow(
		new Error(
			"relationFilter('missing'): no relation 'missing' declared on table 'users'. Use rawExists(subquery(...)) for an uncorrelated or undeclared subquery.",
		),
	);
});

// Quantifiers traverse the RelationRef's relation path and give their callback
// refs relative to the related table (#991).
const namedDb = schema({
	users: { id: { type: 'integer', primaryKey: true }, email: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		published: 'boolean',
		author_id: ref('users', { as: 'author', inverse: 'writings' }),
		editor_id: ref('users', { as: 'editor', inverse: 'edits' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: 'text',
		post_id: ref('posts', { as: 'post', inverse: 'replies' }),
	},
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
const namedOrm = createOrm({
	schema: namedDb,
	adapter: createPgCompileOnlyAdapter({ model: namedDb.model }),
	suppressDxWarnings: true,
});
const named = namedOrm.tables;
const writingsExists = (where: string) =>
	`SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND ${where})`;
const repliesWhere =
	'EXISTS (SELECT 1 FROM comments AS comments_exists_1 WHERE posts_exists_0.id = comments_exists_1.post_id AND comments_exists_1.body = $1)';

it('some() over a relation named unlike its table binds callback columns to the relation range', () => {
	expect(
		namedOrm
			.select('users')
			.where(some(named.users.writings, (p) => eq(p.published!, true)))
			.dump().sql,
	).toBe(writingsExists('posts_exists_0.published = $1'));
});

it('some() over a two-hop relation path traverses both hops', () => {
	expect(
		namedOrm
			.select('users')
			.where(some(named.users.writings.replies, (c) => eq(c.body!, 'x')))
			.dump().sql,
	).toBe(writingsExists(repliesWhere));
});

it('a nested quantifier starts its relation path at the related table', () => {
	expect(
		namedOrm
			.select('users')
			.where(
				some(named.users.writings, (p) =>
					// The callback types `p.replies` as a column (existing typing gap).
					some(p.replies as never, (c) => eq(c.body!, 'x')),
				),
			)
			.dump().sql,
	).toBe(writingsExists(repliesWhere));
});

it('every/some/none pick the relation, not the target table, with two relations to one table', () => {
	expect(
		namedOrm
			.select('users')
			.where(some(named.users.edits, (p) => eq(p.published!, true)))
			.dump().sql,
	).toBe(
		'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.editor_id AND posts_exists_0.published = $1)',
	);
	expect(
		namedOrm
			.select('users')
			.where(every(named.users.writings, (p) => eq(p.published!, true)))
			.dump().sql,
	).toBe(
		'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND NOT (posts_exists_0.published = $1)))',
	);
	expect(
		namedOrm
			.select('users')
			.where(none(named.users.edits, (p) => eq(p.published!, true)))
			.dump().sql,
	).toBe(
		'SELECT users.* FROM users WHERE NOT (EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.editor_id AND posts_exists_0.published = $1))',
	);
});

it('some() over a self-relation binds the callback column to the inner range', () => {
	expect(
		namedOrm
			.select('nodes')
			.where(some(named.nodes.children, (c) => eq(c.label!, 'x')))
			.dump().sql,
	).toBe(
		'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes.id = nodes_exists_0.parent_id AND nodes_exists_0.label = $1)',
	);
});
