import {
	type Adapter,
	type CompiledQuery,
	createOrm,
	isNull,
	manyToMany,
	nqlRaw,
	ref,
	type SchemaDefinition,
	schema,
	type WhereIntent,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const tables: SchemaDefinition = {
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		deletedAt: { type: 'timestamp', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: 'text',
		deletedAt: { type: 'timestamp', nullable: true },
		authorId: ref('users', { as: 'author', inverse: 'authored' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		deletedAt: { type: 'timestamp', nullable: true },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
	nodes: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		deletedAt: { type: 'timestamp', nullable: true },
		parentId: ref('nodes', {
			nullable: true,
			roles: { parent: 'parent', children: 'children' },
		}),
	},
};
tables.tags = {
	id: { type: 'integer', primaryKey: true },
	name: 'text',
	deletedAt: { type: 'timestamp', nullable: true },
};
tables.postTags = {
	deletedAt: { type: 'timestamp', nullable: true },
	postId: ref('posts', { inverse: 'tagLinks' }),
	tagId: ref('tags', { inverse: 'postLinks' }),
};

const allFilters = Object.fromEntries(
	Object.keys(tables).map((table) => [table, isNull('deletedAt')]),
);
function make(
	filters: Record<string, WhereIntent> = allFilters,
	adapter = createPgCompileOnlyAdapter() as unknown as Adapter,
) {
	return createOrm({
		schema: schema(tables, undefined, {
			relations: {
				posts: {
					tags: manyToMany('tags', {
						through: 'postTags',
						sourceForeignKey: ['postId'],
						targetForeignKey: ['tagId'],
						inverse: 'posts',
					}),
				},
			},
			defaultFilters: filters,
		}),
		adapter,
	});
}
const cases = [
	{
		behavior: 'filters the root table',
		query: 'posts',
		filtered: {
			sql: 'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: 'SELECT posts.* FROM posts',
			params: [],
		},
	},
	{
		behavior: 'filters wildcard relation includes',
		query: 'posts | select *, author.*',
		filtered: {
			sql: 'SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object(\'id\', __t__.id, \'name\', __t__.name, \'deletedAt\', __t__."deletedAt") ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts."authorId" AND __t__."deletedAt" IS NULL), \'[]\'::json) AS author_json FROM posts WHERE posts."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: "SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'deletedAt', __t__.\"deletedAt\") ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
			params: [],
		},
	},
	{
		behavior: 'filters relation predicate scans',
		query: "posts | where some(author).name = 'x'",
		filtered: {
			sql: 'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0."deletedAt" IS NULL AND users_exists_0.name = $1)',
			params: ['x'],
		},
		unfiltered: {
			sql: 'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.name = $1)',
			params: ['x'],
		},
	},
	{
		behavior: 'filters dotted predicate scans',
		query: "posts | where author.name = 'x'",
		filtered: {
			sql: 'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0."deletedAt" IS NULL AND users_exists_0.name = $1)',
			params: ['x'],
		},
		unfiltered: {
			sql: 'SELECT posts.* FROM posts WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE posts."authorId" = users_exists_0.id AND users_exists_0.name = $1)',
			params: ['x'],
		},
	},
	{
		behavior: 'filters to-one relation projections',
		query: 'posts | select id, author.name',
		filtered: {
			sql: 'SELECT posts.id, COALESCE((SELECT json_agg(jsonb_build_object(\'name\', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts."authorId" AND __t__."deletedAt" IS NULL), \'[]\'::json) AS author_json FROM posts WHERE posts."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: "SELECT posts.id, COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
			params: [],
		},
	},
	{
		behavior: 'filters to-many relation projections',
		query: 'users | select id, authored.title',
		filtered: {
			sql: 'SELECT users.id, COALESCE((SELECT json_agg(jsonb_build_object(\'title\', __t__.title) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__."authorId" = users.id AND __t__."deletedAt" IS NULL), \'[]\'::json) AS authored_json FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: "SELECT users.id, COALESCE((SELECT json_agg(jsonb_build_object('title', __t__.title) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS authored_json FROM users",
			params: [],
		},
	},
	{
		behavior: 'filters each dotted projection hop',
		query: 'comments | select id, post.author.name',
		filtered: {
			sql: "SELECT comments.id, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") || jsonb_build_object('author', COALESCE((SELECT json_agg(jsonb_build_object('name', __t1__.name) ORDER BY __t1__.id ASC NULLS LAST) FROM users AS __t1__ WHERE __t1__.id = __t__.\"authorId\" AND __t1__.\"deletedAt\" IS NULL), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.id = comments.\"postId\" AND __t__.\"deletedAt\" IS NULL), '[]'::json) AS post_json FROM comments WHERE comments.\"deletedAt\" IS NULL",
			params: [],
		},
		unfiltered: {
			sql: "SELECT comments.id, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'title', __t__.title, 'deletedAt', __t__.\"deletedAt\", 'authorId', __t__.\"authorId\") || jsonb_build_object('author', COALESCE((SELECT json_agg(jsonb_build_object('name', __t1__.name) ORDER BY __t1__.id ASC NULLS LAST) FROM users AS __t1__ WHERE __t1__.id = __t__.\"authorId\"), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.id = comments.\"postId\"), '[]'::json) AS post_json FROM comments",
			params: [],
		},
	},
	{
		behavior: 'filters binding bodies and leaves the synthetic root unfiltered',
		query: 'posts | select id, authorId | bind p\np | select id',
		filtered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts WHERE posts."deletedAt" IS NULL) SELECT p.id FROM p',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts) SELECT p.id FROM p',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered scalar binding projection scans',
		query: 'posts | select id, authorId | bind p\np | select id, author.name',
		filtered: {
			error:
				"Default filter for table 'users' is not supported at NQL.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts) SELECT p.id, (SELECT rc_0.name FROM users AS rc_0 WHERE rc_0.id = p."authorId") AS "author.name" FROM p',
			params: [],
		},
	},
	{
		behavior: 'filters binding-final includes and their tails',
		query:
			'posts | select id, authorId | bind p\np | select *, author.authored.*',
		filtered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts WHERE posts."deletedAt" IS NULL) SELECT p.*, COALESCE((SELECT json_agg(jsonb_build_object(\'id\', __t__.id, \'name\', __t__.name, \'deletedAt\', __t__."deletedAt") || jsonb_build_object(\'authored\', COALESCE((SELECT json_agg(jsonb_build_object(\'id\', __t1__.id, \'title\', __t1__.title, \'deletedAt\', __t1__."deletedAt", \'authorId\', __t1__."authorId") ORDER BY __t1__.id ASC NULLS LAST) FROM posts AS __t1__ WHERE __t1__."authorId" = __t__.id AND __t1__."deletedAt" IS NULL), \'[]\'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = p."authorId" AND __t__."deletedAt" IS NULL), \'[]\'::json) AS author_json FROM p',
			params: [],
		},
		unfiltered: {
			sql: "WITH \"p\" as (SELECT posts.id, posts.\"authorId\" FROM posts) SELECT p.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'deletedAt', __t__.\"deletedAt\") || jsonb_build_object('authored', COALESCE((SELECT json_agg(jsonb_build_object('id', __t1__.id, 'title', __t1__.title, 'deletedAt', __t1__.\"deletedAt\", 'authorId', __t1__.\"authorId\") ORDER BY __t1__.id ASC NULLS LAST) FROM posts AS __t1__ WHERE __t1__.\"authorId\" = __t__.id), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = p.\"authorId\"), '[]'::json) AS author_json FROM p",
			params: [],
		},
	},
	{
		behavior: 'filters every read binding and the final statement',
		query: 'posts | select id | bind p\nusers | select id | bind u\ncomments',
		filtered: {
			sql: 'WITH "p" as (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL), "u" as (SELECT users.id FROM users WHERE users."deletedAt" IS NULL) SELECT comments.* FROM comments WHERE comments."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id FROM posts), "u" as (SELECT users.id FROM users) SELECT comments.* FROM comments',
			params: [],
		},
	},
	{
		behavior: 'filters CTE bodies and leaves the CTE root unfiltered',
		query: 'with p as (posts | select id) p | select id',
		filtered: {
			sql: 'WITH "p" AS (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) SELECT p.id FROM p',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "p" AS (SELECT posts.id FROM posts) SELECT p.id FROM p',
			params: [],
		},
	},
	{
		behavior: 'filters both CTE bodies and physical final reads',
		query: 'with p as (posts | select id) users',
		filtered: {
			sql: 'WITH "p" AS (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) SELECT users.* FROM users WHERE users."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "p" AS (SELECT posts.id FROM posts) SELECT users.* FROM users',
			params: [],
		},
	},
	{
		behavior: 'filters both set-operation leaves',
		query: 'posts | select id | union (users | select id)',
		filtered: {
			sql: '(SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) UNION (SELECT users.id FROM users WHERE users."deletedAt" IS NULL)',
			params: [],
		},
		unfiltered: {
			sql: '(SELECT posts.id FROM posts) UNION (SELECT users.id FROM users)',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered parent pseudo-column projections',
		query: 'nodes | select id, parent.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].pseudoColumn.",
		},
		unfiltered: {
			sql: 'SELECT nodes.id FROM nodes',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered children pseudo-column projections',
		query: 'nodes | select id, children.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].pseudoColumn.",
		},
		unfiltered: {
			sql: 'SELECT nodes.id FROM nodes',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered ancestor pseudo-column projections',
		query: 'nodes | select id, ascendant.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].pseudoColumn.",
		},
		unfiltered: {
			sql: 'SELECT nodes.id FROM nodes',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered descendant pseudo-column projections',
		query: 'nodes | select id, descendant.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].pseudoColumn.",
		},
		unfiltered: {
			sql: 'SELECT nodes.id FROM nodes',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered aggregate binding projection scans',
		query: 'users | select id | bind u\nu | select id, authored.title',
		filtered: {
			error:
				"Default filter for table 'posts' is not supported at NQL.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "u" as (SELECT users.id FROM users) SELECT u.id, (SELECT COALESCE(json_agg(rc_0.title ORDER BY CAST(rc_0.title AS text) NULLS LAST), \'[]\'::json) FROM posts AS rc_0 WHERE rc_0."authorId" = u.id) AS "authored.title" FROM u',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered dotted binding projection scans',
		query:
			'comments | select id, postId | bind c\nc | select id, post.author.name',
		filtered: {
			error:
				"Default filter for table 'posts' is not supported at NQL.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "c" as (SELECT comments.id, comments."postId" FROM comments) SELECT c.id, (SELECT rc_0_h1.name FROM posts AS rc_0 JOIN users AS rc_0_h1 ON rc_0_h1.id = rc_0."authorId" WHERE rc_0.id = c."postId") AS "post.author.name" FROM c',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered recursive ancestor binding projections',
		query:
			'nodes | select id, parentId | bind n\nn | select id, ascendant.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "n" as (SELECT nodes.id, nodes."parentId" FROM nodes) SELECT n.id, (WITH RECURSIVE __rc_0 AS (SELECT __n.*, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = n."parentId" UNION ALL SELECT __n.*, __rc_0.__depth + 1 AS __depth, __rc_0.__visited || __n.id AS __visited FROM __rc_0 JOIN nodes AS __n ON __n.id = __rc_0."parentId" WHERE __rc_0.__depth < 10 AND __n.id <> ALL (__rc_0.__visited)) SELECT COALESCE(json_agg(__rc_0.name ORDER BY __rc_0.__depth), \'[]\'::json) FROM __rc_0) AS "ascendant.name" FROM n',
			params: [],
		},
	},
	{
		behavior: 'refuses filtered recursive descendant binding projections',
		query:
			'nodes | select id, parentId | bind n\nn | select id, descendant.name',
		filtered: {
			error:
				"Default filter for table 'nodes' is not supported at NQL.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "n" as (SELECT nodes.id, nodes."parentId" FROM nodes) SELECT n.id, (WITH RECURSIVE __rc_0 AS (SELECT __n.*, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n."parentId" = n.id UNION ALL SELECT __n.*, __rc_0.__depth + 1 AS __depth, __rc_0.__visited || __n.id AS __visited FROM __rc_0 JOIN nodes AS __n ON __n."parentId" = __rc_0.id WHERE __rc_0.__depth < 10 AND __n.id <> ALL (__rc_0.__visited)) SELECT COALESCE(json_agg(__rc_0.name ORDER BY __rc_0.__depth), \'[]\'::json) FROM __rc_0) AS "descendant.name" FROM n',
			params: [],
		},
	},
	{
		behavior: 'filters direct parent predicate scans',
		query: "nodes | where parent.name = 'x'",
		filtered: {
			sql: 'SELECT nodes.* FROM nodes WHERE nodes."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes."parentId" = nodes_exists_0.id AND nodes_exists_0."deletedAt" IS NULL AND nodes_exists_0.name = $1)',
			params: ['x'],
		},
		unfiltered: {
			sql: 'SELECT nodes.* FROM nodes WHERE EXISTS (SELECT 1 FROM nodes AS nodes_exists_0 WHERE nodes."parentId" = nodes_exists_0.id AND nodes_exists_0.name = $1)',
			params: ['x'],
		},
	},
	{
		behavior: 'filters NQL subqueries',
		query: 'users | where id in (posts | select authorId)',
		filtered: {
			sql: 'SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId" AND posts_exists_0."deletedAt" IS NULL)',
			params: [],
		},
		unfiltered: {
			sql: 'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0."authorId")',
			params: [],
		},
	},
	{
		behavior: 'filters relation joins in ON and the root in WHERE',
		query: 'posts | select *, author.* | flat',
		filtered: {
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt" FROM posts JOIN users AS author ON posts."authorId" = author.id AND author."deletedAt" IS NULL WHERE posts."deletedAt" IS NULL',
			params: [],
		},
		unfiltered: {
			sql: 'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."deletedAt" AS "author.deletedAt" FROM posts JOIN users AS author ON posts."authorId" = author.id',
			params: [],
		},
	},
	{
		behavior: 'filters relation predicates on a synthetic binding root',
		query:
			"posts | select id, authorId | bind p\np | where some(author).name = 'x'",
		filtered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts WHERE posts."deletedAt" IS NULL) SELECT p.* FROM p WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE p."authorId" = users_exists_0.id AND users_exists_0."deletedAt" IS NULL AND users_exists_0.name = $1)',
			params: ['x'],
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts) SELECT p.* FROM p WHERE EXISTS (SELECT 1 FROM users AS users_exists_0 WHERE p."authorId" = users_exists_0.id AND users_exists_0.name = $1)',
			params: ['x'],
		},
	},
	{
		behavior: 'filters snapshot reads and final reads across a mutation',
		query:
			"posts | select id | bind p\nupdate posts set title = 'x' where id = 1 | select id | bind changed\nusers | where id in (p)",
		filtered: {
			sql: 'SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL;\nUPDATE posts SET title = $1 WHERE posts.id = $2 RETURNING posts.id AS id;\nWITH "p" ("id") as (SELECT CAST(NULL AS integer) AS "id" WHERE false) SELECT users.* FROM users WHERE users."deletedAt" IS NULL AND users.id = ANY (SELECT p_subq_0.id FROM p AS p_subq_0)',
			params: ['x', 1],
		},
		unfiltered: {
			sql: 'SELECT posts.id FROM posts;\nUPDATE posts SET title = $1 WHERE posts.id = $2 RETURNING posts.id AS id;\nWITH "p" ("id") as (SELECT CAST(NULL AS integer) AS "id" WHERE false) SELECT users.* FROM users WHERE users.id = ANY (SELECT p_subq_0.id FROM p AS p_subq_0)',
			params: ['x', 1],
		},
	},
	{
		behavior: 'refuses filtered junction includes',
		query: 'posts | select id, tags.name',
		filtered: {
			error:
				"Default filter for table 'postTags' is not supported at NQL.query.select.columns[1].junction.",
		},
		unfiltered: {
			error:
				"Invalid include: Relation 'posts.tags': many-to-many traversal is not supported yet (#787).",
		},
	},
	{
		behavior: 'refuses filtered junction binding projections',
		query: 'posts | select id | bind p\np | select id, tags.name',
		filtered: {
			error:
				"Default filter for table 'postTags' is not supported at NQL.query.select.columns[1].junction.",
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id FROM posts) SELECT p.id, (SELECT COALESCE(json_agg(rc_0.name ORDER BY CAST(rc_0.name AS text) NULLS LAST), \'[]\'::json) FROM tags AS rc_0 JOIN "postTags" AS rc_1 ON rc_0.id = rc_1."tagId" WHERE rc_1."postId" = p.id) AS "tags.name" FROM p',
			params: [],
		},
	},
	{
		behavior: 'filters the physical body when a CTE shadows its source name',
		query: 'with posts as (posts | select id) posts | select id',
		filtered: {
			sql: 'WITH "posts" AS (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) SELECT posts.id FROM posts',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "posts" AS (SELECT posts.id FROM posts) SELECT posts.id FROM posts',
			params: [],
		},
	},
	{
		behavior:
			'filters the physical body when a binding shadows its source name',
		query: 'posts | select id | bind posts\nposts | select id',
		filtered: {
			sql: 'WITH "posts" as (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) SELECT posts.id FROM posts',
			params: [],
		},
		unfiltered: {
			sql: 'WITH "posts" as (SELECT posts.id FROM posts) SELECT posts.id FROM posts',
			params: [],
		},
	},
	{
		behavior: 'refuses filters on relation reads from a projected CTE',
		query:
			'with users as (users | select id, name) posts | select id, author.name',
		filtered: {
			error:
				"Default filter for table 'users' is not supported at NQL.cteQuery.query.select.columns[1].relation.",
		},
		unfiltered: {
			sql: 'WITH "users" AS (SELECT users.id, users.name FROM users) SELECT posts.id, COALESCE((SELECT json_agg(jsonb_build_object(\'name\', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts."authorId"), \'[]\'::json) AS author_json FROM posts',
			params: [],
		},
	},
	{
		behavior: 'filters read bindings used by an unfiltered mutation',
		query:
			"posts | select id | bind p\nupdate posts set title = 'x' where id in (p)",
		filtered: {
			sql: 'WITH "p" as (SELECT posts.id FROM posts WHERE posts."deletedAt" IS NULL) UPDATE posts SET title = $1 WHERE posts.id = ANY (SELECT p_subq_0.id FROM p AS p_subq_0)',
			params: ['x'],
		},
		unfiltered: {
			sql: 'WITH "p" as (SELECT posts.id FROM posts) UPDATE posts SET title = $1 WHERE posts.id = ANY (SELECT p_subq_0.id FROM p AS p_subq_0)',
			params: ['x'],
		},
	},
];
describe('default filters on NQL read scans', () => {
	for (const entry of cases) {
		it(entry.behavior, () => {
			const orm = make();
			for (const [view, expected] of [
				[orm, entry.filtered],
				[orm.withoutDefaultFilters(), entry.unfiltered],
			] as const) {
				const query = view.nql`${nqlRaw(entry.query)}`;
				if ('error' in expected) {
					let message: string | undefined;
					try {
						query.dump();
					} catch (error) {
						expect(error).toBeInstanceOf(Error);
						message = (error as Error).message;
					}
					expect(message).toBe(expected.error);
				} else {
					const dump = query.dump();
					expect({
						sql: dump.sql,
						params: 'params' in dump ? dump.params : dump.parameters,
					}).toEqual(expected);
				}
			}
		});
	}
	it('keeps source filters while allowing unfiltered binding relation targets', () => {
		const orm = make({ posts: isNull('deletedAt') });
		const dump = orm.nql`posts | select id, authorId | bind p
p | select id, author.name`.dump();
		expect(dump.sql).toBe(
			'WITH "p" as (SELECT posts.id, posts."authorId" FROM posts WHERE posts."deletedAt" IS NULL) SELECT p.id, (SELECT rc_0.name FROM users AS rc_0 WHERE rc_0.id = p."authorId") AS "author.name" FROM p',
		);
	});
	it('carries the read policy through execution and planning', async () => {
		const executed: CompiledQuery[] = [];
		const adapter = createPgCompileOnlyAdapter() as unknown as Adapter;
		Object.defineProperty(adapter, 'connectionAvailability', {
			value: { status: 'available' },
		});
		adapter.execute = async <T>(query: CompiledQuery<T>): Promise<T[]> => {
			executed.push(query);
			return [];
		};
		const orm = make(allFilters, adapter);
		const query = orm.nql`posts`;
		expect(query.plan().execution?.where?.kind).toBe('null');
		await query.all();
		await orm.withoutDefaultFilters().nql`posts`.all();
		expect(
			executed.map((query) => ({ sql: query.sql, params: query.parameters })),
		).toEqual([
			{
				sql: 'SELECT posts.* FROM posts WHERE posts."deletedAt" IS NULL',
				params: [],
			},
			{ sql: 'SELECT posts.* FROM posts', params: [] },
		]);
	});
	it('carries filters through execution of binding roots and include tails', async () => {
		const executed: CompiledQuery[] = [];
		const adapter = createPgCompileOnlyAdapter() as unknown as Adapter;
		Object.defineProperty(adapter, 'connectionAvailability', {
			value: { status: 'available' },
		});
		adapter.execute = async <T>(query: CompiledQuery<T>): Promise<T[]> => {
			executed.push(query);
			return [];
		};
		const orm = make(allFilters, adapter);
		const selected = cases.filter((entry) =>
			[
				'filters binding bodies and leaves the synthetic root unfiltered',
				'filters binding-final includes and their tails',
				'filters every read binding and the final statement',
			].includes(entry.behavior),
		);
		for (const entry of selected) {
			await orm.nql`${nqlRaw(entry.query)}`.all();
			await orm.withoutDefaultFilters().nql`${nqlRaw(entry.query)}`.all();
		}
		expect(
			executed.map((query) => ({ sql: query.sql, params: query.parameters })),
		).toEqual(selected.flatMap((entry) => [entry.filtered, entry.unfiltered]));
	});
	it('refuses a filtered later hop of a binding projection', () => {
		const orm = make({ users: isNull('deletedAt') });
		expect(() =>
			orm.nql`comments | select id, postId | bind c
c | select id, post.author.name`.dump(),
		).toThrowError(
			new Error(
				"Default filter for table 'users' is not supported at NQL.query.select.columns[1].relation.",
			),
		);
		expect(
			orm.withoutDefaultFilters().nql`comments | select id, postId | bind c
c | select id, post.author.name`.dump().sql,
		).toBe(
			'WITH "c" as (SELECT comments.id, comments."postId" FROM comments) SELECT c.id, (SELECT rc_0_h1.name FROM posts AS rc_0 JOIN users AS rc_0_h1 ON rc_0_h1.id = rc_0."authorId" WHERE rc_0.id = c."postId") AS "post.author.name" FROM c',
		);
	});
});
