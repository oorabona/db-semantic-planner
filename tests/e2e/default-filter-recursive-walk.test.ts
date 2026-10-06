import { createOrm, eq, isNull, planRecursive, ref, schema } from '@dbsp/core';
import type { RecursiveIntent } from '@dbsp/types';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const SCHEMA = 'default_filter_recursive_walk_e2e';
const db = schema(
	{
		nodes: {
			id: { type: 'integer', primaryKey: true },
			parentId: ref('nodes', {
				nullable: true,
				roles: { parent: 'parent', children: 'children' },
			}),
			hidden: { type: 'timestamp', nullable: true },
		},
	},
	undefined,
	{ defaultFilters: { nodes: isNull('hidden') } },
);
beforeAll(async () => {
	await dropSchema(SCHEMA);
	await createSchema(SCHEMA);
	await execInSchema(
		SCHEMA,
		`CREATE TABLE nodes (id integer PRIMARY KEY, "parentId" integer REFERENCES nodes(id), hidden timestamp);
 INSERT INTO nodes VALUES (1,NULL,NULL),(2,1,'2026-01-01'),(3,2,NULL);`,
	);
});
afterAll(async () => {
	await dropSchema(SCHEMA);
	await closeTestDb();
});
it('excludes a filtered node and its visible descendants from a recursive chain', async () => {
	const adapter = await getTestAdapter();
	const orm = createOrm({
		schema: db,
		adapter,
	}).withSchema(SCHEMA);
	const read = (o: typeof orm) =>
		o.select('nodes').where(eq('id', 1)).include('children', {
			recursive: true,
			direction: 'descendants',
			flat: true,
		});
	const filtered = await read(orm).all();
	expect(filtered).toEqual([
		expect.objectContaining({
			id: 1,
			children: [expect.objectContaining({ id: 1 })],
		}),
	]);
	const unfiltered = await read(orm.withoutDefaultFilters()).all();
	expect(unfiltered[0]?.children.map((node) => node.id)).toEqual([1, 2, 3]);
	const intent: RecursiveIntent = {
		type: 'recursive',
		cteName: 'walk',
		start: {
			from: 'nodes',
			nodeIdExpr: { kind: 'column', name: 'id' },
			where: eq('id', 1),
		},
		traversal: {
			kind: 'adjacency',
			nodeTable: 'nodes',
			nodeId: 'id',
			parentId: 'parentId',
			direction: 'descendants',
		},
		maxDepth: 3,
	};
	const filteredWalk = adapter.compileRecursive<{ id: number }>(
		planRecursive(intent, db.model, { defaultFilters: db.defaultFilters }),
		db.model,
		{ schemaName: SCHEMA },
	);
	expect(await adapter.execute(filteredWalk)).toEqual([{ id: 1 }]);
	const unfilteredWalk = adapter.compileRecursive<{ id: number }>(
		planRecursive(intent, db.model),
		db.model,
		{ schemaName: SCHEMA },
	);
	expect(
		(await adapter.execute(unfilteredWalk)).map((node) => node.id),
	).toEqual([1, 2, 3]);
});
