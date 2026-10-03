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
