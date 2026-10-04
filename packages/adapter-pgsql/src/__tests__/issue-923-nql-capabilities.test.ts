import { createOrm, nqlRaw, ref, schema } from '@dbsp/core';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import {
	createPgAdapter,
	createPgCompileOnlyAdapter,
} from '../pgsql-adapter.js';

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
const orm = createOrm({
	model: db.model,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});
it.each(cases)('tag plans %s with adapter capabilities', (text, sql) => {
	const query = orm.nql`${nqlRaw(text)}`;
	expect(query.dump().sql).toBe(sql);
	const dump = query.dump();
	expect('params' in dump && dump.params).toEqual([]);
	expect(query.plan().decisions).toEqual(
		'plan' in dump && dump.plan?.decisions,
	);
});

it('hydrates JSON strings from non-binding all()', async () => {
	const pool = {
		query: vi.fn().mockResolvedValue({
			rows: [
				{
					id: 1,
					name: 'Ada',
					fileId: null,
					posts_json: '[{"title":"First"},{"title":"Second"}]',
				},
				{ id: 2, name: 'Grace', fileId: null, posts_json: '[]' },
			],
		}),
	} as unknown as Pool;
	const executingOrm = createOrm({
		model: db.model,
		adapter: createPgAdapter(pool, { model: db.model }),
	});
	expect(await executingOrm.nql`users | select *, posts.title`.all()).toEqual([
		{
			id: 1,
			name: 'Ada',
			fileId: null,
			posts: [{ title: 'First' }, { title: 'Second' }],
		},
		{ id: 2, name: 'Grace', fileId: null, posts: [] },
	]);
});

it.each(cases)(
	'program-sequence dump plans %s with adapter capabilities',
	(text, sql) => {
		const query = orm.nql`insert into users set id = 3, name = 'New' | select id | bind created
${nqlRaw(text)}`;
		const dump = query.dump();
		expect('sequence' in dump && dump.sequence?.at(-1)?.sql).toBe(sql);
		expect('sequence' in dump && dump.sequence?.at(-1)?.params).toEqual([]);
		expect('plan' in dump && dump.plan?.decisions).toEqual(
			query.plan().decisions,
		);
	},
);

const nestedRead = 'users | select id, posts.title';
const programRead =
	"insert into users set id = 3, name = 'New' | select id | bind created\nusers | select id, posts.title";
const cteRead =
	'with enriched as (users | select id, posts.title)\nenriched | select *';

it.each([programRead, cteRead])(
	'hydrates final read all() and first(): %s',
	async (text) => {
		const query = vi.fn(async (sql: string) => ({
			rows:
				sql.startsWith('SELECT') || sql.startsWith('WITH')
					? [{ id: 1, posts_json: '[{"title":"First"}]' }]
					: [{ id: 3 }],
		}));
		const client = { query, release: vi.fn() };
		const pool = {
			query,
			connect: vi.fn(async () => client),
		} as unknown as Pool;
		const executingOrm = createOrm({
			model: db.model,
			adapter: createPgAdapter(pool, { model: db.model }),
		});
		expect(await executingOrm.nql`${nqlRaw(text)}`.all()).toEqual([
			{ id: 1, posts: [{ title: 'First' }] },
		]);
		expect(await executingOrm.nql`${nqlRaw(text)}`.first()).toEqual({
			id: 1,
			posts: [{ title: 'First' }],
		});
	},
);

it('run discards program read rows without parsing JSON', async () => {
	const query = vi.fn(async (sql: string) => ({
		rows: sql.startsWith('SELECT')
			? [{ id: 1, posts_json: 'invalid JSON' }]
			: [{ id: 3 }],
	}));
	const client = { query, release: vi.fn() };
	const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
	const executingOrm = createOrm({
		model: db.model,
		adapter: createPgAdapter(pool, { model: db.model }),
	});
	await expect(
		executingOrm.nql`${nqlRaw(programRead)}`.run(),
	).resolves.toBeUndefined();
});

it.each(['*', 'id, posts_json', 'id'])(
	'CTE projection resolves payload visibility: %s',
	async (projection) => {
		const query = vi.fn().mockResolvedValue({
			rows: [
				projection === 'id'
					? { id: 1 }
					: { id: 1, posts_json: '[{"title":"First"}]' },
			],
		});
		const executingOrm = createOrm({
			model: db.model,
			adapter: createPgAdapter({ query } as unknown as Pool, {
				model: db.model,
			}),
		});
		const text = `with enriched as (${nestedRead})\nenriched | select ${projection}`;
		expect(await executingOrm.nql`${nqlRaw(text)}`.all()).toEqual([
			projection === 'id' ? { id: 1 } : { id: 1, posts: [{ title: 'First' }] },
		]);
	},
);
