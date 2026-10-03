import { createOrm, eq, inArray, planRecursive, ref, schema } from '@dbsp/core';
import type { RecursiveIntent } from '@dbsp/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgAdapter } from '../../packages/adapter-pgsql/src/pgsql-adapter.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	getTestPool,
	sql,
} from './testkit/index.js';

const SCHEMA = 'recursive_include_adjacency';
const db = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		parent_id: ref('categories', {
			roles: { parent: 'parent', children: 'children' },
			nullable: true,
		}),
	},
});

// Both the inserts and the expected results use this fixture, never query output.
const rootA = { id: 1, parent_id: null };
const rootB = { id: 2, parent_id: null };
const childA = { id: 3, parent_id: rootA.id };
const childB = { id: 4, parent_id: rootB.id };
const leafA = { id: 5, parent_id: childA.id };
const leafB = { id: 6, parent_id: childB.id };
const treeA = [rootA, childA, leafA];
const treeB = [rootB, childB, leafB];
const categories = [...treeA, ...treeB];

const traversalCases = [
	{
		name: 'descendants of the first root with eq',
		direction: 'descendants',
		where: eq('id', rootA.id),
		expected: treeA,
	},
	{
		name: 'descendants of the second root with eq',
		direction: 'descendants',
		where: eq('id', rootB.id),
		expected: treeB,
	},
	{
		name: 'descendants of both roots with inArray',
		direction: 'descendants',
		where: inArray('id', [rootA.id, rootB.id]),
		expected: categories,
	},
	{
		name: 'ancestors of the first leaf with eq',
		direction: 'ancestors',
		where: eq('id', leafA.id),
		expected: treeA,
	},
	{
		name: 'ancestors of the second leaf with eq',
		direction: 'ancestors',
		where: eq('id', leafB.id),
		expected: treeB,
	},
	{
		name: 'ancestors of both leaves with inArray',
		direction: 'ancestors',
		where: inArray('id', [leafA.id, leafB.id]),
		expected: categories,
	},
] as const;

describe('#891 adjacency recursion and public CTE includes', () => {
	beforeAll(async () => {
		await dropSchema(SCHEMA);
		await createSchema(SCHEMA);
		const pool = await getTestPool();
		await sql`CREATE TABLE ${sql.ref(SCHEMA)}.categories (
			id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES ${sql.ref(SCHEMA)}.categories(id)
		)`.execute(pool);
		for (const row of categories) {
			await sql`INSERT INTO ${sql.ref(SCHEMA)}.categories (id, parent_id)
				VALUES (${row.id}, ${row.parent_id})`.execute(pool);
		}
	});
	afterAll(async () => {
		await dropSchema(SCHEMA);
		await closeTestDb();
	});

	it.each(traversalCases)('executes $name', async (testCase) => {
		const pool = await getTestPool();
		const adapter = createPgAdapter(pool, { model: db.model });
		const intent: RecursiveIntent = {
			type: 'recursive',
			cteName: 'tree',
			start: {
				from: 'categories',
				nodeIdExpr: { kind: 'column', name: 'id' },
				select: ['parent_id'],
				where: testCase.where,
			},
			traversal: {
				kind: 'adjacency',
				nodeTable: 'categories',
				nodeId: 'id',
				parentId: 'parent_id',
				direction: testCase.direction,
			},
			maxDepth: 10,
		};
		const compiled = adapter.compileRecursive(
			planRecursive(intent, db.model),
			db.model,
			{ schemaName: SCHEMA },
		);
		const result = await pool.query<{ id: number; parent_id: number | null }>(
			compiled.sql,
			[...compiled.parameters],
		);
		expect(result.rows.sort((a, b) => a.id - b.id)).toEqual(
			[...testCase.expected].sort((a, b) => a.id - b.id),
		);
	});

	it('executes the public recursive children include through the main CTE statement', async () => {
		const adapter = createPgAdapter(await getTestPool(), { model: db.model });
		const orm = createOrm({ schema: db, adapter }).withSchema(SCHEMA);
		const query = orm
			.select('categories')
			.where(inArray('id', [rootA.id, rootB.id]))
			.orderBy('id')
			.include('children', { recursive: true, direction: 'descendants' });
		expect(
			query
				.plan()
				.decisions.filter((decision) => decision.type === 'include-strategy')
				.map((decision) => decision.choice),
		).toEqual(['cte']);

		// The current CTE handler joins immediate children without projecting child
		// columns. Public hydration therefore returns the root objects unchanged;
		// DX-017 does not populate the separate recursiveIncludes hydrator path.
		expect(await query.execute()).toEqual([rootA, rootB]);
	});
});
