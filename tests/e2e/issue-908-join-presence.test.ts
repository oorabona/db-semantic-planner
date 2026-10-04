import { createOrm, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	getTestPool,
} from './testkit/index.js';

const schemaName = 'issue_908';
const model = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text', nullable: true },
		email: { type: 'text', nullable: true },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		author_id: ref('users', { as: 'author', nullable: true }),
	},
}).model;
// The E2E global setup supplies PostgreSQL through testcontainers.
beforeAll(async () => {
	const pool = await getTestPool();
	await pool.query(
		`CREATE SCHEMA ${schemaName}; CREATE TABLE ${schemaName}.users (id integer PRIMARY KEY, name text, email text); CREATE TABLE ${schemaName}.posts (id integer PRIMARY KEY, author_id integer REFERENCES ${schemaName}.users); INSERT INTO ${schemaName}.users VALUES (7, NULL, NULL); INSERT INTO ${schemaName}.posts VALUES (1, 7), (2, NULL);`,
	);
});
afterAll(async () => {
	const pool = await getTestPool();
	await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
	await closeTestDb();
});
it('an all-null selected object exists; an unmatched left join returns null and no marker', async () => {
	const adapter = await createPgsqlAdapterForSchema(schemaName);
	const orm = createOrm({ model, adapter });
	const rows = await orm
		.select('posts')
		.include('author', {
			join: 'left',
			select: { type: 'fields', fields: ['name', 'email'] },
		})
		.orderBy('id')
		.execute();
	expect(rows).toEqual([
		{ id: 1, author_id: 7, author: { name: null, email: null } },
		{ id: 2, author_id: null, author: null },
	]);
});
