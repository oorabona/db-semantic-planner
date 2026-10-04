import { createPgCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { createOrm, nqlRaw, ref, schema } from '@dbsp/core';
import { expect, it } from 'vitest';
import { compileNqlToSql } from './nql-executor.js';

const db = schema({
	files: { id: { type: 'integer', primaryKey: true }, path: 'string' },
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		fileId: ref('files', { as: 'file' }),
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		title: 'string',
	},
});
const cases = [
	[
		'users | select *, posts.title',
		"SELECT users.*, COALESCE((SELECT json_agg(jsonb_build_object('title', __t__.title) ORDER BY __t__.id ASC NULLS LAST) FROM posts AS __t__ WHERE __t__.\"authorId\" = users.id), '[]'::json) AS posts_json FROM users",
	],
	[
		'users | select *, posts.title | flat',
		'SELECT users.*, posts.title AS "posts.title" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"',
	],
	[
		'posts | select *, author.name',
		"SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('name', __t__.name) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
	],
	[
		'posts | select *, author.name | flat',
		'SELECT posts.*, author.name AS "author.name" FROM posts JOIN users AS author ON posts."authorId" = author.id',
	],
	[
		'posts | select *, author.file.path as fp',
		"SELECT posts.*, COALESCE((SELECT json_agg(jsonb_build_object('id', __t__.id, 'name', __t__.name, 'fileId', __t__.\"fileId\") || jsonb_build_object('file', COALESCE((SELECT json_agg(jsonb_build_object('fp', __t1__.path) ORDER BY __t1__.id ASC NULLS LAST) FROM files AS __t1__ WHERE __t1__.id = __t__.\"fileId\"), '[]'::json)) ORDER BY __t__.id ASC NULLS LAST) FROM users AS __t__ WHERE __t__.id = posts.\"authorId\"), '[]'::json) AS author_json FROM posts",
	],
	[
		'posts | select *, author.file.path as fp | flat',
		'SELECT posts.*, file.path AS fp FROM posts JOIN users AS author ON posts."authorId" = author.id JOIN files AS file ON author."fileId" = file.id',
	],
] as const;
it.each(cases)('CLI and tag agree for %s', async (text, sql) => {
	const cli = await compileNqlToSql(text, db.model);
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	const tag = orm.nql`${nqlRaw(text)}`.dump();
	expect(cli.sql).toBe(sql);
	expect(cli.params).toEqual([]);
	expect(tag.sql).toBe(cli.sql);
	expect('params' in tag && tag.params).toEqual(cli.params);
});

const refusal =
	"Set operations with nested relation output are not supported; use | flat in every branch. A relation with includeStrategy hint 'json_agg' or 'cte' cannot be flattened; change that hint or select from the joined table.";
const nested = 'users | select id, posts.title';
const flat = 'users | select id, posts.title | flat';
const setCases = [
	...[
		'union',
		'union all',
		'intersect',
		'intersect all',
		'except',
		'except all',
	].map((op) => `${nested} | ${op} (${nested})`),
	`${nested} | union (users | select id, name)`,
	`users | select id, name | union (${nested})`,
	`${nested} | union (posts | select id, author.name)`,
	`users | select id, name | union (${nested} | except (${nested}))`,
];
it.each(setCases)('CLI and tag refuse nested set output: %s', async (text) => {
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	await expect(compileNqlToSql(text, db.model)).rejects.toThrow(refusal);
	expect(() => orm.nql`${nqlRaw(text)}`.dump()).toThrow(refusal);
});
it.each([
	'union',
	'union all',
	'intersect',
	'intersect all',
	'except',
	'except all',
])('CLI and tag compile flat %s', async (op) => {
	const text = `${flat} | ${op} (${flat})`;
	const cli = await compileNqlToSql(text, db.model);
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(orm.nql`${nqlRaw(text)}`.dump().sql).toBe(cli.sql);
	const branch =
		'SELECT users.id, posts.title AS "posts.title" FROM users LEFT JOIN posts AS posts ON users.id = posts."authorId"';
	expect(cli.sql).toBe(`(${branch}) ${op.toUpperCase()} (${branch})`);
	expect(cli.params).toEqual([]);
});

it.each([
	'with enriched as (posts | select id, author.name)\nenriched | select *',
	'posts | select id, author.name | bind enriched\nenriched | select *',
])('CLI and tag refuse relational body: %s', async (text) => {
	const message = refusal.replace('Set operations', 'Relational bodies');
	await expect(compileNqlToSql(text, db.model)).rejects.toThrow(
		new Error(message),
	);
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	expect(() => orm.nql`${nqlRaw(text)}`.dump()).toThrow(new Error(message));
});

it.each([
	[
		'with enriched as (posts | select id, author.name | flat)\nenriched | select *',
		'AS',
	],
	[
		'posts | select id, author.name | flat | bind enriched\nenriched | select *',
		'as',
	],
])('CLI and tag preserve flat body SQL: %s', async (text, keyword) => {
	const cli = await compileNqlToSql(text!, db.model);
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	const expected = `WITH "enriched" ${keyword} (SELECT posts.id, author.name AS "author.name" FROM posts JOIN users AS author ON posts."authorId" = author.id) SELECT enriched.* FROM enriched`;
	expect(cli.sql).toBe(expected);
	expect(orm.nql`${nqlRaw(text!)}`.dump().sql).toBe(expected);
	expect(cli.params).toEqual([]);
});

it('binding read exposes the same plan as the tag', async () => {
	const text = 'users | select id | bind u\nu | select *';
	const cli = await compileNqlToSql(text, db.model);
	const orm = createOrm({
		model: db.model,
		adapter: createPgCompileOnlyAdapter({ model: db.model }),
	});
	const dump = orm.nql`${nqlRaw(text)}`.dump();
	expect(cli.planReport).toMatchObject({
		rootTable: 'u',
		decisions: [],
		ctes: [],
	});
	expect(cli.planReport).toEqual('plan' in dump && dump.plan);
	expect(cli.sql).toBe(dump.sql);
});
