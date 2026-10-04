import {
	createPgAdapter,
	createPgCompileOnlyAdapter,
} from '@dbsp/adapter-pgsql';
import { createOrm, nqlRaw, ref, schema } from '@dbsp/core';
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
 CREATE TABLE ${namespace}.roots (id integer PRIMARY KEY);
 CREATE TABLE ${namespace}.children (id integer PRIMARY KEY, "rootId" integer);
 CREATE TABLE ${namespace}.siblings (id integer PRIMARY KEY, "rootId" integer);
 INSERT INTO ${namespace}.roots VALUES (1);
 INSERT INTO ${namespace}.children VALUES (2, 1);
 INSERT INTO ${namespace}.siblings VALUES (2, 1);
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

it('hydrates program-final reads through all() and first()', async () => {
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
});

it('hydrates a join-hinted author through tag all() and preserves flat labels', async () => {
	const hints = {
		getRelation: (name: string) => {
			const relation = db.model.getRelation(name);
			return relation
				? { ...relation, includeStrategy: 'join' as const }
				: relation;
		},
		getRelationsFrom: (name: string) =>
			db.model
				.getRelationsFrom(name)
				.map((relation) => ({ ...relation, includeStrategy: 'join' as const })),
	};
	const model = new Proxy(db.model, {
		get(target, property) {
			if (property === 'getRelation') return hints.getRelation;
			if (property === 'getRelationsFrom') return hints.getRelationsFrom;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	const orm = createOrm({
		model,
		adapter: createPgAdapter(await getTestPool(), { model }),
	}).withSchema(namespace);
	expect(
		await orm.nql`posts | where id = 10 | select id, author.name`.all(),
	).toEqual([{ id: 10, author: { name: 'Ada' } }]);
	expect(
		await orm.nql`posts | where id = 10 | select id, author.name | flat`.all(),
	).toEqual([{ id: 10, 'author.name': 'Ada' }]);
});

for (const relations of [
	['r'.repeat(62)],
	[`${'r'.repeat(63)}a`, `${'r'.repeat(63)}b`],
]) {
	const [first, second] = relations;
	const model = schema({
		roots: { id: { type: 'integer', primaryKey: true } },
		children: {
			id: { type: 'integer', primaryKey: true },
			rootId: ref('roots', { inverse: first! }),
		},
		...(second
			? {
					siblings: {
						id: { type: 'integer', primaryKey: true },
						rootId: ref('roots', { inverse: second }),
					},
				}
			: {}),
	}).model;
	const read = `roots | where id = 1 | select id, ${relations.map((r) => `${r}.id`).join(', ')}`;
	const expected = {
		id: 1,
		...Object.fromEntries(relations.map((r) => [r, [{ id: 2 }]])),
	};
	for (const program of [false, true]) {
		const text = `${program ? 'insert into roots set id = 3 | select id | bind created\n' : ''}${read}`;
		it(`terminal label all/first program=${program} relations=${relations.length}`, async () => {
			const orm = createOrm({
				model,
				adapter: createPgAdapter(await getTestPool(), { model }),
			}).withSchema(namespace);
			expect(await orm.nql`${nqlRaw(text)}`.all()).toEqual([expected]);
			if (program)
				await (await getTestPool()).query(
					`DELETE FROM ${namespace}.roots WHERE id = 3`,
				);
			expect(await orm.nql`${nqlRaw(text)}`.first()).toEqual(expected);
			if (program)
				await (await getTestPool()).query(
					`DELETE FROM ${namespace}.roots WHERE id = 3`,
				);
		});
	}
}

it.each(['json_agg', 'cte'] as const)(
	'terminal flat refuses %s hint',
	(strategy) => {
		const model = new Proxy(db.model, {
			get(target, property) {
				if (property === 'getRelation')
					return (name: string) => {
						const r = target.getRelation(name);
						return r ? { ...r, includeStrategy: strategy } : r;
					};
				if (property === 'getRelationsFrom')
					return (name: string) =>
						target
							.getRelationsFrom(name)
							.map((r) => ({ ...r, includeStrategy: strategy }));
				const value = Reflect.get(target, property, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const orm = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		});
		const message = `Flat output for relation 'author' cannot use relation includeStrategy hint '${strategy}'. Use 'auto', 'join', or 'lateral'.`;
		for (const prefix of [
			'',
			"insert into users set id = 3, name = 'New' | select id | bind created\n",
		]) {
			expect(() =>
				orm.nql`${nqlRaw(`${prefix}posts | select id, author.name | flat`)}`.dump(),
			).toThrow(message);
		}
	},
);
