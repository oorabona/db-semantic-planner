import {
	createOrm,
	eq,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	nodes: {
		id: { type: 'bigint', js: 'string', primaryKey: true },
		parentId: ref('nodes', {
			js: 'bigint',
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
	others: {
		id: { type: 'integer', primaryKey: true },
		nodeId: ref('nodes', { as: 'node', inverse: 'others' }),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const options = { dialectCapabilities: POSTGRESQL_CAPABILITIES };

describe('#877 recursive include boundaries', () => {
	it('casts both identity keys in the walk independently of public policies', () => {
		const { sql } = orm
			.select('nodes')
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
			})
			.dump();
		expect(sql).toBe(
			'SELECT nodes.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[nodes.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentId" = nodes.id AND __n.id IS DISTINCT FROM nodes.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', CAST(children_walk.id AS text), \'parentId\', CAST(children_walk."parentId" AS text), \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM nodes',
		);
	});
	it('hydrates mixed public bigint policies using canonical identity text', async () => {
		const fake = Object.create(adapter) as typeof adapter;
		Object.defineProperty(fake, 'connectionAvailability', {
			value: { status: 'available' },
		});
		Object.defineProperty(fake, 'execute', {
			value: async () => [
				{
					id: '1',
					children_json: [
						{
							id: '2',
							parentId: '1',
							__dbsp_node: '2',
							__dbsp_parent: '1',
							__dbsp_depth: 1,
						},
						{
							id: '3',
							parentId: '2',
							__dbsp_node: '3',
							__dbsp_parent: '2',
							__dbsp_depth: 2,
						},
					],
				},
			],
		});
		expect(
			await createOrm({ schema: db, adapter: fake })
				.select('nodes')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
				})
				.all(),
		).toEqual([
			{
				id: '1',
				children: [
					{
						id: '2',
						parentId: 1n,
						children: [{ id: '3', parentId: 2n, children: [] }],
					},
				],
			},
		]);
	});
	it('refuses different traversals sharing one public key', () => {
		expect(() =>
			orm
				.select('nodes')
				.include('tree', {
					via: 'parent',
					recursive: true,
					direction: 'ancestors',
				})
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
				})
				.dump(),
		).toThrow(
			"Include payload '$' has conflicting public key 'tree' (recursive traversals).",
		);
		expect(() =>
			orm
				.select('nodes')
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
					maxDepth: 2,
				})
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
					maxDepth: 3,
				})
				.dump(),
		).toThrow(
			"Include payload '$' has conflicting public key 'tree' (recursive traversals).",
		);
		expect(() =>
			orm
				.select('nodes')
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
				})
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
				})
				.dump(),
		).not.toThrow();
	});
	it('plans a schema constructor default filter without inherited values', () => {
		const db = schema(
			{ constructor: { id: { type: 'integer', primaryKey: true } } },
			undefined,
			{ defaultFilters: { constructor: eq('id', 1) } },
		);
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const orm = createOrm({
			schema: db,
			adapter,
		});
		expect(orm.select('constructor').plan().intent.where).toEqual(eq('id', 1));
		expect(orm.select('constructor').dump().sql).toBe(
			'SELECT constructor.* FROM constructor WHERE constructor.id = $1',
		);
	});
	it('copies schema default-filter sources before lookup', async () => {
		const filters = { nodes: eq('id', 7) };
		const db = schema(
			{
				constructor: { id: { type: 'integer', primaryKey: true } },
				nodes: { id: { type: 'integer', primaryKey: true } },
			},
			undefined,
			{ defaultFilters: filters },
		);
		expect(Object.getPrototypeOf(db.defaultFilters)).toBe(null);
		expect(db.defaultFilters).not.toBe(filters);
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const fake = Object.create(adapter) as typeof adapter;
		Object.defineProperty(fake, 'connectionAvailability', {
			value: { status: 'available' },
		});
		Object.defineProperty(fake, 'execute', { value: async () => [{ id: 1 }] });
		const orm = createOrm({
			schema: db,
			adapter: fake,
		});
		expect(await orm.select('constructor').all()).toEqual([{ id: 1 }]);
		expect(
			createOrm({ schema: db, adapter }).select('constructor').plan().intent
				.where,
		).toBeUndefined();
	});
	it('refuses maxDepth beyond PostgreSQL integer range at planning', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'nodes',
					include: [
						{
							relation: 'children',
							recursive: { direction: 'descendants', maxDepth: 2147483648 },
						},
					],
				},
				db.model,
				options,
			),
		).toThrow(
			'Recursive include option maxDepth must be a positive integer at most 2147483647',
		);
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'nodes',
					include: [
						{ relation: 'children', recursive: { maxDepth: 2147483647 } },
					],
				},
				db.model,
				options,
			),
		).not.toThrow();
	});
	it('refuses empty recursive field selection at planning', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'nodes',
					include: [
						{
							relation: 'children',
							recursive: { direction: 'descendants' },
							select: { type: 'fields', fields: [] },
						},
					],
				},
				db.model,
				options,
			),
		).toThrow('Recursive include option select requires at least one field');
	});
	it('refuses contradictory direction and non-self-reference at planning', () => {
		for (const [relation, direction] of [
			['parent', 'descendants'],
			['children', 'ancestors'],
		] as const)
			expect(() =>
				plan(
					{
						type: 'select',
						from: 'nodes',
						include: [{ relation, recursive: { direction } }],
					},
					db.model,
					options,
				),
			).toThrow(
				direction === 'descendants'
					? "Option direction 'descendants' conflicts with recursive relation 'parent' (ancestors). Direction 'descendants' requires a to-many relation. Relation 'parent' has type 'belongsTo'."
					: "Option direction 'ancestors' conflicts with recursive relation 'children' (descendants). Direction 'ancestors' requires a to-one relation. Relation 'children' has type 'hasMany'.",
			);
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'others',
					include: [
						{ relation: 'node', recursive: { direction: 'ancestors' } },
					],
				},
				db.model,
				options,
			),
		).toThrow(
			"Recursive include requires a self-referential relation. Relation 'node' connects 'others' to 'nodes', but both must be the same table for recursive traversal.",
		);
	});
	it('uses recursive metadata and DX delegates to the shared validator', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'nodes',
					include: [
						{ relation: 'ancestors', recursive: { direction: 'descendants' } },
					],
				},
				db.model,
				options,
			),
		).toThrow(
			"Option direction 'descendants' conflicts with recursive relation 'ancestors' (ancestors). Direction 'descendants' requires a to-many relation. Relation 'ancestors' has type 'hasMany'.",
		);
		expect(() =>
			orm
				.select('nodes')
				.include('parent', { recursive: true, direction: 'descendants' }),
		).toThrow(
			"Invalid recursive include: Option direction 'descendants' conflicts with recursive relation 'parent' (ancestors). Direction 'descendants' requires a to-many relation. Relation 'parent' has type 'belongsTo'.",
		);
	});
	it('canonical recursive options default to nested self without depth', () => {
		const report = plan(
			{
				type: 'select',
				from: 'nodes',
				include: [
					{ relation: 'children', recursive: { direction: 'descendants' } },
				],
			},
			db.model,
			options,
		);
		expect(
			report.decisions.find((d) => d.context.recursiveInclude)?.context
				.recursiveInclude,
		).toEqual({
			direction: 'descendants',
			maxDepth: 100,
			flat: false,
			omitSelf: false,
			track: { depth: false },
		});
		expect(adapter.compile(report).sql).toContain('children_output AS');
	});
	it('NQL hierarchy pseudo-columns explicitly request flat output without self', () => {
		const intent = orm.nql`nodes | select ancestors.*`.plan().intent;
		expect(intent.include?.[0]?.recursive).toEqual({
			direction: 'ancestors',
			flat: true,
			omitSelf: true,
			track: { depth: true },
		});
	});
	it('keeps unselected bigint primary-key ordering out of payload', () => {
		const db = schema({
			nodes: {
				pk: { type: 'bigint', js: 'number', primaryKey: true },
				id: { type: 'string', unique: true },
				parentId: ref('nodes', {
					column: 'id',
					nullable: true,
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const sql = createOrm({ schema: db, adapter })
			.select('nodes')
			.columns(['id'])
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				select: { type: 'fields', fields: ['id'] },
			})
			.dump().sql;
		expect(sql).toBe(
			'SELECT nodes.id, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", __n.pk AS pk, 1 AS __depth, array_remove(ARRAY[nodes.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentId" = nodes.id AND __n.id IS DISTINCT FROM nodes.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", __n.pk AS pk, children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id, children_walk.pk) FROM children_walk), \'[]\'::json) AS children_json FROM nodes',
		);
	});
	it('hydrates without decoding an unselected unsafe bigint order key', async () => {
		const db = schema({
			nodes: {
				pk: { type: 'bigint', js: 'number', primaryKey: true },
				id: { type: 'string', unique: true },
				parentId: ref('nodes', {
					column: 'id',
					nullable: true,
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const adapter = createPgCompileOnlyAdapter({ model: db.model });
		const fake = Object.create(adapter) as typeof adapter;
		Object.defineProperty(fake, 'connectionAvailability', {
			value: { status: 'available' },
		});
		Object.defineProperty(fake, 'execute', {
			value: async (query: { sql: string }) => [
				{
					id: 'root',
					children_json: [
						{
							id: 'child',
							__dbsp_node: 'child',
							__dbsp_parent: 'root',
							__dbsp_depth: 1,
							...(query.sql.includes('__dbsp_order')
								? { __dbsp_order: '9007199254740993' }
								: {}),
						},
					],
				},
			],
		});
		expect(
			await createOrm({ schema: db, adapter: fake })
				.select('nodes')
				.columns(['id'])
				.include('children', {
					recursive: true,
					direction: 'descendants',
					omitSelf: true,
					select: { type: 'fields', fields: ['id'] },
				})
				.all(),
		).toEqual([{ id: 'root', children: [{ id: 'child', children: [] }] }]);
	});
});
