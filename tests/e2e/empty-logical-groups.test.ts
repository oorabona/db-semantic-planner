import { and, createOrm, eq, not, or, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const SCHEMA = 'empty_logical_groups_e2e';
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		tenantId: { type: 'integer' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
} as const);
beforeAll(async () => {
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await execInSchema(
		SCHEMA,
		'CREATE TABLE users (id integer PRIMARY KEY, tenant_id integer NOT NULL); INSERT INTO users VALUES (1, 1), (2, 1), (3, 2); CREATE TABLE posts (id integer PRIMARY KEY, published boolean NOT NULL, author_id integer REFERENCES users(id)); INSERT INTO posts VALUES (11, true, 1), (12, false, 1), (21, false, 2), (22, true, 2);',
	);
});
afterAll(async () => {
	await dropSchema(SCHEMA);
	await closeTestDb();
});
describe('#888 empty logical groups with rows', () => {
	it('returns no rows for false conjunctions and preserves the tenant disjunction', async () => {
		const orm = createOrm({
			schema: testSchema,
			adapter: await getTestAdapter(),
		}).withSchema(SCHEMA);
		expect(
			await orm
				.select('users')
				.where(and(eq('tenantId', 1), or()))
				.execute(),
		).toEqual([]);
		expect(await orm.select('users').where(not(and())).execute()).toEqual([]);
		const rows = await orm
			.select('users')
			.where(or(eq('tenantId', 1), or()))
			.columns(['id'])
			.orderBy('id')
			.execute();
		expect(rows.map((row) => row.id)).toEqual([1, 2]);
	});
	it('join include where keeps roots with published posts and empty OR removes roots', async () => {
		const orm = createOrm({
			schema: testSchema,
			adapter: await getTestAdapter(),
		}).withSchema(SCHEMA);
		const published = (await orm
			.select('users')
			.include('posts', { join: 'inner', where: eq('published', true) })
			.orderBy('id')
			.execute()) as unknown as Array<{
			id: number;
			posts: Array<{ id: number }>;
		}>;
		expect(
			published.map((user) => ({
				id: user.id,
				posts: user.posts.map((post) => post.id),
			})),
		).toEqual([
			{ id: 1, posts: [11] },
			{ id: 2, posts: [22] },
		]);
		const empty = (await orm
			.select('users')
			.include('posts', { join: 'inner', where: or() })
			.orderBy('id')
			.execute()) as unknown as Array<{
			id: number;
			posts: Array<{ id: number }>;
		}>;
		expect(empty).toEqual([]);
		await expect(
			orm.select('users').include('posts', { where: or() }).all(),
		).rejects.toThrow(/strategy json_agg.*include\[0\]\(posts\).*#892/);
	});
});
