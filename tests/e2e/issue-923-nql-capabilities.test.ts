import { createPgAdapter } from '@dbsp/adapter-pgsql';
import { createOrm, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
} from './testkit/index.js';

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

const namespace = 'issue_923_nql';
beforeAll(async () => {
	await dropSchema(namespace);
	await createSchema(namespace);
	const pool = await getTestPool();
	await pool.query(`CREATE TABLE ${namespace}.users (id integer PRIMARY KEY, name text, "fileId" integer);
 CREATE TABLE ${namespace}.posts (id integer PRIMARY KEY, "authorId" integer REFERENCES ${namespace}.users(id), title text);
 INSERT INTO ${namespace}.users VALUES (1, 'Ada', NULL), (2, 'Grace', NULL);
 INSERT INTO ${namespace}.posts VALUES (10, 1, 'First'), (11, 1, 'Second');`);
});
afterAll(async () => {
	await dropSchema(namespace);
	await closeTestDb();
});
it('returns one row per user with nested post title objects through the tag', async () => {
	const orm = createOrm({
		model: db.model,
		adapter: createPgAdapter(await getTestPool(), { model: db.model }),
	});
	const rows = await orm.withSchema(namespace).nql<{
		id: number;
		name: string;
		fileId: number | null;
		posts: { title: string }[];
	}>`users | select *, posts.title`.all();
	expect(rows.sort((a, b) => Number(a.id) - Number(b.id))).toEqual([
		{
			id: 1,
			name: 'Ada',
			fileId: null,
			posts: [{ title: 'First' }, { title: 'Second' }],
		},
		{ id: 2, name: 'Grace', fileId: null, posts: [] },
	]);
});

it('hydrates program-final and CTE reads through all() and first()', async () => {
	const orm = createOrm({
		model: db.model,
		adapter: createPgAdapter(await getTestPool(), { model: db.model }),
	}).withSchema(namespace);
	const expected = { id: 1, posts: [{ title: 'First' }, { title: 'Second' }] };
	const program =
		() => orm.nql`insert into users set id = 3, name = 'New' | select id | bind created
users | where id = 1 | select id, posts.title`;
	expect(await program().all()).toEqual([expected]);
	await (await getTestPool()).query(
		`DELETE FROM ${namespace}.users WHERE id = 3`,
	);
	expect(await program().first()).toEqual(expected);
	const cte =
		() => orm.nql`with enriched as (users | where id = 1 | select id, posts.title)
enriched | select *`;
	expect(await cte().all()).toEqual([expected]);
	expect(await cte().first()).toEqual(expected);
});
