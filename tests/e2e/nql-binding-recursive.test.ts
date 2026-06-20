import { createOrm } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	categoriesModel,
	closeTestDb,
	createCategoriesSchema,
	dropCategoriesSchema,
	getTestAdapter,
	seedCategoriesData,
} from './testkit/index.js';

describe('NQL binding recursive relation columns E2E', () => {
	const SCHEMA = 'nql_binding_recursive_e2e';

	beforeAll(async () => {
		await dropCategoriesSchema(SCHEMA);
		await createCategoriesSchema(SCHEMA);
		await seedCategoriesData(SCHEMA);
	});

	afterAll(async () => {
		await dropCategoriesSchema(SCHEMA);
		await closeTestDb();
	});

	it('executes ascendant and descendant scalar columns from a binding', async () => {
		const recursiveRelations = categoriesModel
			.getRelationsFrom('categories')
			.filter((relation) => relation.recursive !== undefined)
			.map((relation) => ({
				name: relation.name,
				direction: relation.recursive?.direction,
			}));
		expect(recursiveRelations).toEqual(
			expect.arrayContaining([
				{ name: 'ascendant', direction: 'up' },
				{ name: 'descendant', direction: 'down' },
			]),
		);

		const adapter = await getTestAdapter();
		const orm = createOrm({ model: categoriesModel, adapter }).withSchema(
			SCHEMA,
		);

		const leafAncestors = orm.nql<{
			id: number;
			ancestorNames: string[];
		}>`categories
			| where id = ${4}
			| select id, parentId
			| bind c
c
			| select id, ascendant.name as ancestorNames`;
		const rootDescendants = orm.nql<{
			id: number;
			descendantNames: string[];
		}>`categories
			| where id = ${1}
			| select id, parentId
			| bind c
c
			| select id, descendant.name as descendantNames`;

		const leafDump = leafAncestors.dump();
		const rootDump = rootDescendants.dump();
		const leafRows = await leafAncestors.all();
		const rootRows = await rootDescendants.all();

		expect(leafDump.sql).toMatch(/WITH RECURSIVE __rc_\d+ AS/i);
		expect(rootDump.sql).toMatch(/WITH RECURSIVE __rc_\d+ AS/i);
		expect(leafDump.sql).toMatch(
			/json_agg\(__rc_\d+\.name ORDER BY __rc_\d+\.__depth\)/i,
		);
		expect(rootDump.sql).toMatch(
			/json_agg\(__rc_\d+\.name ORDER BY __rc_\d+\.__depth\)/i,
		);

		expect(leafRows).toEqual([
			{ id: 4, ancestorNames: ['Laptops', 'Hardware', 'Root'] },
		]);
		expect(rootRows).toEqual([
			{ id: 1, descendantNames: ['Hardware', 'Laptops', 'Ultrabooks'] },
		]);
	});

	it('terminates recursive binding columns on cyclic adjacency data', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: categoriesModel, adapter }).withSchema(
			SCHEMA,
		);

		const rows = await orm.nql<{
			id: number;
			descendantNames: string[];
		}>`categories
			| where id = ${10}
			| select id, parentId
			| bind c
c
			| select id, descendant.name as descendantNames`.all();

		expect(rows).toEqual([
			{ id: 10, descendantNames: ['Cycle B', 'Cycle C', 'Cycle A'] },
		]);
		expect(new Set(rows[0]?.descendantNames).size).toBe(
			rows[0]?.descendantNames.length,
		);
	});
});
