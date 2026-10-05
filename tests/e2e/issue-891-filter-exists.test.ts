import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	closeTestDb,
	createPgsqlAdapterForSchema,
	getTestPool,
} from './testkit/index.js';

const schemaName = 'issue_891';
const model = schema({
	roots: {
		id: { type: 'integer', primaryKey: true },
		targetId: ref('targets', { as: 'roots', nullable: true }),
	},
	targets: { id: { type: 'integer', primaryKey: true } },
}).model;
beforeAll(async () => {
	const pool = await getTestPool();
	await pool.query(
		`CREATE SCHEMA ${schemaName}; CREATE TABLE ${schemaName}.targets (id integer PRIMARY KEY); CREATE TABLE ${schemaName}.roots (id integer PRIMARY KEY, "targetId" integer REFERENCES ${schemaName}.targets); INSERT INTO ${schemaName}.targets VALUES (1), (2); INSERT INTO ${schemaName}.roots VALUES (10, 1), (20, 2), (30, NULL);`,
	);
});
afterAll(async () => {
	const pool = await getTestPool();
	await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
	await closeTestDb();
});
it('relation named like the root has unique ranges and returns correlated rows', async () => {
	const adapter = await createPgsqlAdapterForSchema(schemaName);
	const orm = createOrm({ model, adapter });
	const query = orm
		.select('roots')
		.where(exists('roots', { where: eq('id', 1) }));
	expect(query.dump().sql).toBe(
		'SELECT roots.* FROM issue_891.roots WHERE EXISTS (SELECT 1 FROM issue_891.targets AS targets_exists_0 WHERE roots."targetId" = targets_exists_0.id AND targets_exists_0.id = $1)',
	);
	expect(await query.execute()).toEqual([{ id: 10, targetId: 1 }]);
});
