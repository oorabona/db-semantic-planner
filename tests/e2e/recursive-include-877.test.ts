import { readFile } from 'node:fs/promises';
import { createOrm, eq, isNull, ref, schema } from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import hierarchy from '../../examples/hierarchy.schema.js';
import {
	closeTestDb,
	createSchema,
	dropSchema,
	execInSchema,
	getTestAdapter,
} from './testkit/index.js';

const categories = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});
const repaired = schema({
	__n: {
		id: { type: 'integer', primaryKey: true },
		depth: 'integer',
		__depth: 'integer',
		__visited: 'string',
		parentId: ref('__n', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	big_nodes: {
		id: { type: 'bigint', js: 'bigint', primaryKey: true },
		amount: { type: 'bigint', js: 'bigint' },
		textAmount: { type: 'bigint', js: 'string' },
		numberAmount: { type: 'bigint', js: 'number' },
		parentId: ref('big_nodes', {
			js: 'bigint',
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	wide_nodes: {
		id: { type: 'integer', primaryKey: true },
		...Object.fromEntries(
			Array.from({ length: 49 }, (_, i) => [`field${i}`, 'integer' as const]),
		),
		parentId: ref('wide_nodes', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});
const namespace = 'recursive_include_877';
const nodes = [
	{ id: 1, name: 'A', parentId: null },
	{ id: 2, name: 'B', parentId: 1 },
	{ id: 3, name: 'C', parentId: 2 },
	{ id: 4, name: 'D', parentId: 3 },
	{ id: 10, name: 'Other', parentId: null },
	{ id: 11, name: 'Other child', parentId: 10 },
];
const tree = {
	...nodes[0],
	children: [
		{
			...nodes[1],
			children: [{ ...nodes[2], children: [{ ...nodes[3], children: [] }] }],
		},
	],
};
describe('#877 correlated recursive includes', () => {
	beforeAll(async () => {
		await createSchema(namespace);
		await execInSchema(
			namespace,
			`CREATE TABLE categories (id integer PRIMARY KEY, name text NOT NULL, parent_id integer REFERENCES categories(id)); INSERT INTO categories VALUES (1, 'A', NULL), (2, 'B', 1), (3, 'C', 2), (4, 'D', 3), (10, 'Other', NULL), (11, 'Other child', 10)`,
		);
		await execInSchema(
			namespace,
			"INSERT INTO categories VALUES (20, 'Cycle A', NULL), (21, 'Cycle B', 20), (30, 'Self cycle', NULL); UPDATE categories SET parent_id = 21 WHERE id = 20; UPDATE categories SET parent_id = 30 WHERE id = 30",
		);
		await execInSchema(
			namespace,
			await readFile(
				new URL('../../examples/hierarchy.ddl.sql', import.meta.url),
				'utf8',
			),
		);
		await execInSchema(
			namespace,
			await readFile(
				new URL('../../examples/hierarchy.seed.sql', import.meta.url),
				'utf8',
			),
		);
		await execInSchema(
			namespace,
			`CREATE TABLE __n (id integer PRIMARY KEY, depth integer NOT NULL, __depth integer NOT NULL, __visited text NOT NULL, parent_id integer REFERENCES __n(id)); INSERT INTO __n VALUES (1, 87, 91, 'root', NULL), (2, 88, 92, 'child', 1), (3, 89, 93, 'grandchild', 2)`,
		);
		await execInSchema(
			namespace,
			`CREATE TABLE big_nodes (id bigint PRIMARY KEY, amount bigint NOT NULL, text_amount bigint NOT NULL, number_amount bigint NOT NULL, parent_id bigint REFERENCES big_nodes(id)); INSERT INTO big_nodes VALUES (1, 1, 1, 1, NULL), (9007199254740993, 9007199254740995, 9007199254740997, 42, 1), (9007199254740994, 9007199254740996, 9007199254740998, 43, 9007199254740993)`,
		);
		const fields = Array.from(
			{ length: 49 },
			(_, i) => `field${i} integer NOT NULL`,
		).join(', ');
		const values = Array.from({ length: 49 }, (_, i) => i).join(', ');
		await execInSchema(
			namespace,
			`CREATE TABLE wide_nodes (id integer PRIMARY KEY, ${fields}, parent_id integer REFERENCES wide_nodes(id)); INSERT INTO wide_nodes VALUES (1, ${values}, NULL), (2, ${values}, 1)`,
		);
	});
	afterAll(async () => {
		await dropSchema(namespace);
		await closeTestDb();
	});
	it('hydrates default descendants, including self, without multiplying roots or leaking another tree', async () => {
		const orm = createOrm({
			schema: categories,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		const rows = await orm
			.select('categories')
			.where(isNull('parentId'))
			.orderBy('id')
			.include('children', { recursive: true, direction: 'descendants' })
			.all();
		expect(rows).toEqual([
			{ ...nodes[0], children: [tree] },
			{
				...nodes[4],
				children: [{ ...nodes[4], children: [{ ...nodes[5], children: [] }] }],
			},
		]);
	});
	it('hydrates default ancestors and an omitted-self flat chain of depth 3', async () => {
		const orm = createOrm({
			schema: categories,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		expect(
			await orm
				.select('categories')
				.where(eq('id', 4))
				.include('parent', { recursive: true, direction: 'ancestors' })
				.all(),
		).toEqual([
			{
				...nodes[3],
				parent: {
					...nodes[3],
					parent: {
						...nodes[2],
						parent: { ...nodes[1], parent: { ...nodes[0], parent: null } },
					},
				},
			},
		]);
		expect(
			await orm
				.select('categories')
				.where(eq('id', 4))
				.include('parent', {
					recursive: true,
					direction: 'ancestors',
					omitSelf: true,
					flat: true,
				})
				.all(),
		).toEqual([
			{
				...nodes[3],
				parent: [
					{ ...nodes[2], depth: 1 },
					{ ...nodes[1], depth: 2 },
					{ ...nodes[0], depth: 3 },
				],
			},
		]);
	});
	it('returns the hierarchy managementChain.* query as one ordered JSON array per employee', async () => {
		const orm = createOrm({
			schema: hierarchy,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		const employees = [
			{
				id: 1,
				name: 'Alice',
				email: 'alice@example.com',
				title: 'CEO',
				departmentId: 1,
				managerId: null,
				hireDate: '2020-01-15',
				salary: 250000,
			},
			{
				id: 2,
				name: 'Bob',
				email: 'bob@example.com',
				title: 'VP Engineering',
				departmentId: 1,
				managerId: 1,
				hireDate: '2020-03-01',
				salary: 200000,
			},
			{
				id: 3,
				name: 'Carol',
				email: 'carol@example.com',
				title: 'VP Product',
				departmentId: 2,
				managerId: 1,
				hireDate: '2020-06-15',
				salary: 190000,
			},
			{
				id: 4,
				name: 'Dave',
				email: 'dave@example.com',
				title: 'Engineering Director',
				departmentId: 1,
				managerId: 2,
				hireDate: '2021-01-10',
				salary: 170000,
			},
			{
				id: 5,
				name: 'Eve',
				email: 'eve@example.com',
				title: 'Product Director',
				departmentId: 2,
				managerId: 3,
				hireDate: '2021-04-20',
				salary: 160000,
			},
		];
		const ancestor = (index: number, depth: number) => ({
			...employees[index],
			depth,
		});
		const expected = [
			{ name: 'Alice', managementChain: [] },
			{ name: 'Bob', managementChain: [ancestor(0, 1)] },
			{ name: 'Carol', managementChain: [ancestor(0, 1)] },
			{ name: 'Dave', managementChain: [ancestor(1, 1), ancestor(0, 2)] },
			{ name: 'Eve', managementChain: [ancestor(2, 1), ancestor(0, 2)] },
			{
				name: 'Frank',
				managementChain: [ancestor(3, 1), ancestor(1, 2), ancestor(0, 3)],
			},
			{
				name: 'Grace',
				managementChain: [ancestor(3, 1), ancestor(1, 2), ancestor(0, 3)],
			},
			{
				name: 'Heidi',
				managementChain: [ancestor(4, 1), ancestor(2, 2), ancestor(0, 3)],
			},
		];
		const query = orm.nql`employees | select name, managementChain.* | order by id`;
		expect(query.dump().sql).toContain('AS "managementChain_json"');
		expect(await query.all()).toEqual(expected);
	});

	it('terminates cycles without returning the omitted source, including a direct self-loop', async () => {
		const orm = createOrm({
			schema: categories,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		for (const direction of ['ancestors', 'descendants'] as const) {
			const relation = direction === 'ancestors' ? 'parent' : 'children';
			expect(
				await orm
					.select('categories')
					.where(eq('id', 20))
					.include(relation, {
						recursive: true,
						direction,
						flat: true,
						omitSelf: true,
					})
					.all(),
			).toEqual([
				{
					id: 20,
					name: 'Cycle A',
					parentId: 21,
					[relation]: [{ id: 21, name: 'Cycle B', parentId: 20, depth: 1 }],
				},
			]);
			expect(
				await orm
					.select('categories')
					.where(eq('id', 30))
					.include(relation, {
						recursive: true,
						direction,
						flat: true,
						omitSelf: true,
					})
					.all(),
			).toEqual([{ id: 30, name: 'Self cycle', parentId: 30, [relation]: [] }]);
		}
	});
	it('returns children under a root named __n and preserves stored depth columns', async () => {
		const orm = createOrm({
			schema: repaired,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		expect(
			await orm
				.select('__n')
				.where(eq('id', 1))
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
				})
				.all(),
		).toEqual([
			{
				id: 1,
				depth: 87,
				__depth: 91,
				__visited: 'root',
				parentId: null,
				children: [
					{
						id: 2,
						depth: 88,
						__depth: 92,
						__visited: 'child',
						parentId: 1,
						children: [
							{
								id: 3,
								depth: 89,
								__depth: 93,
								__visited: 'grandchild',
								parentId: 2,
								children: [],
							},
						],
					},
				],
			},
		]);
		for (const options of [{ flat: true }, { includeDepth: true }])
			expect(() =>
				orm
					.select('__n')
					.include('children', {
						recursive: true,
						direction: 'descendants',
						...options,
					})
					.dump(),
			).toThrow(
				"Recursive include 'children' cannot expose traversal depth: projected column 'depth' already exists",
			);
	});
	it('returns every stored value from a 51-column recursive payload', async () => {
		const orm = createOrm({
			schema: repaired,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		const fields = Object.fromEntries(
			Array.from({ length: 49 }, (_, i) => [`field${i}`, i]),
		);
		expect(
			await orm
				.select('wide_nodes')
				.where(eq('id', 1))
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
					flat: true,
				})
				.all(),
		).toEqual([
			{
				id: 1,
				...fields,
				parentId: null,
				children: [{ id: 2, ...fields, parentId: 1, depth: 1 }],
			},
		]);
	});
	it('hydrates exact bigint ids and fields before assembling the identity map', async () => {
		const orm = createOrm({
			schema: repaired,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		const child = {
			id: 9007199254740993n,
			amount: 9007199254740995n,
			textAmount: '9007199254740997',
			numberAmount: 42,
			parentId: 1n,
		};
		const grandchild = {
			id: 9007199254740994n,
			amount: 9007199254740996n,
			textAmount: '9007199254740998',
			numberAmount: 43,
			parentId: 9007199254740993n,
		};
		const root = {
			id: 1n,
			amount: 1n,
			textAmount: '1',
			numberAmount: 1,
			parentId: null,
		};
		expect(
			await orm
				.select('big_nodes')
				.where(eq('id', 1n))
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
				})
				.all(),
		).toEqual([
			{
				...root,
				children: [{ ...child, children: [{ ...grandchild, children: [] }] }],
			},
		]);
		expect(
			await orm
				.select('big_nodes')
				.where(eq('id', 1n))
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
					flat: true,
				})
				.all(),
		).toEqual([
			{
				...root,
				children: [
					{ ...child, depth: 1 },
					{ ...grandchild, depth: 2 },
				],
			},
		]);
	});
	it('preserves distinct requested names for two recursive relations', async () => {
		const labels = schema({
			labels: {
				id: { type: 'integer', primaryKey: true },
				fooId: ref('labels', {
					nullable: true,
					as: 'fooParent',
					inverse: 'fooBar',
					roles: {
						parent: 'fooParent',
						children: 'fooBar',
						ancestors: 'fooAncestors',
						descendants: 'fooDescendants',
					},
				}),
				barId: ref('labels', {
					nullable: true,
					as: 'barParent',
					inverse: 'foo_bar',
					roles: {
						parent: 'barParent',
						children: 'foo_bar',
						ancestors: 'barAncestors',
						descendants: 'barDescendants',
					},
				}),
			},
		});
		const orm = createOrm({
			schema: labels,
			adapter: await getTestAdapter(),
		}).withSchema(namespace);
		const query = orm
			.select('labels')
			.include('fooBar', { recursive: true, direction: 'descendants' })
			.include('foo_bar', { recursive: true, direction: 'descendants' })
			.dump();
		expect(query.sql).toContain('AS "fooBar_json"');
		expect(query.sql).toContain('AS foo_bar_json');
	});
});
