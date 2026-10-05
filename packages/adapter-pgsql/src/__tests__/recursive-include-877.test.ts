import { createOrm, eq, plan, ref, schema } from '@dbsp/core';
import type { ModelIR, QueryIntent } from '@dbsp/types';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	createPgAdapter,
	createPgCompileOnlyAdapter,
} from '../pgsql-adapter.js';
import { asLegacyReport } from './legacy-include-report.js';

const db = schema({
	categories: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		parentId: ref('categories', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: {
				parent: 'parent',
				children: 'children',
				ancestors: 'managementChain',
			},
		}),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
describe('#877 recursive includes', () => {
	it('hydrates compiled managementChain payloads through orm.nql', async () => {
		const pool = {
			query: vi.fn(async () => ({
				rows: [
					{ name: 'Alice', managementChain_json: [] },
					{
						name: 'Dave',
						managementChain_json: JSON.stringify([
							{
								id: 2,
								name: 'Bob',
								parentId: 1,
								__dbsp_node: '2',
								__dbsp_parent: '1',
								__dbsp_depth: 1,
							},
							{
								id: 1,
								name: 'Alice',
								parentId: null,
								__dbsp_node: '1',
								__dbsp_parent: null,
								__dbsp_depth: 2,
							},
						]),
					},
				],
			})),
		} as unknown as Pool;
		const fake = createPgAdapter(pool, { model: db.model });
		const executingOrm = createOrm({ schema: db, adapter: fake });
		const query = executingOrm.nql`categories | select name, managementChain.*`;
		const compiled = fake.compile(query.plan(), { model: db.model });
		expect(compiled.hydrationPlan?.includePayloads?.[0]?.strategy).toBe('cte');
		expect(await query.all()).toEqual([
			{ name: 'Alice', managementChain: [] },
			{
				name: 'Dave',
				managementChain: [
					{ id: 2, name: 'Bob', parentId: 1, depth: 1 },
					{ id: 1, name: 'Alice', parentId: null, depth: 2 },
				],
			},
		]);
	});
	it('ancestors maxDepth=undefined', () => {
		const query = orm
			.select('categories')
			.include('parent', {
				recursive: true,
				direction: 'ancestors',
				omitSelf: true,
				flat: true,
			})
			.dump();
		expect(query.sql).toBe(
			'SELECT categories.*, COALESCE((WITH RECURSIVE parent_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n.id = categories."parentId" AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", parent_walk.__depth + 1 AS __depth, parent_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM parent_walk JOIN categories AS __n ON __n.id = parent_walk."parentId" WHERE parent_walk.__depth < 100 AND __n.id <> ALL (parent_walk.__visited)) SELECT json_agg(json_build_object(\'id\', parent_walk.id, \'name\', parent_walk.name, \'parentId\', parent_walk."parentId", \'__dbsp_node\', parent_walk.__node_text, \'__dbsp_parent\', parent_walk.__parent_text, \'__dbsp_depth\', parent_walk.__depth) ORDER BY parent_walk.__depth, parent_walk.id) FROM parent_walk), \'[]\'::json) AS parent_json FROM categories',
		);
		expect('params' in query && query.params).toEqual([]);
	});
	it('ancestors maxDepth=3', () => {
		const query = orm
			.select('categories')
			.include('parent', {
				recursive: true,
				direction: 'ancestors',
				omitSelf: true,
				flat: true,
				maxDepth: 3,
			})
			.dump();
		expect(query.sql).toBe(
			'SELECT categories.*, COALESCE((WITH RECURSIVE parent_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n.id = categories."parentId" AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", parent_walk.__depth + 1 AS __depth, parent_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM parent_walk JOIN categories AS __n ON __n.id = parent_walk."parentId" WHERE parent_walk.__depth < 3 AND __n.id <> ALL (parent_walk.__visited)) SELECT json_agg(json_build_object(\'id\', parent_walk.id, \'name\', parent_walk.name, \'parentId\', parent_walk."parentId", \'__dbsp_node\', parent_walk.__node_text, \'__dbsp_parent\', parent_walk.__parent_text, \'__dbsp_depth\', parent_walk.__depth) ORDER BY parent_walk.__depth, parent_walk.id) FROM parent_walk), \'[]\'::json) AS parent_json FROM categories',
		);
		expect('params' in query && query.params).toEqual([]);
	});
	it('descendants maxDepth=undefined', () => {
		const query = orm
			.select('categories')
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				flat: true,
			})
			.dump();
		expect(query.sql).toBe(
			'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM categories',
		);
		expect('params' in query && query.params).toEqual([]);
	});
	it('descendants maxDepth=3', () => {
		const query = orm
			.select('categories')
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				flat: true,
				maxDepth: 3,
			})
			.dump();
		expect(query.sql).toBe(
			'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 3 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM categories',
		);
		expect('params' in query && query.params).toEqual([]);
	});
	it('exposes includeDepth under the public key without flat output', () => {
		const query = orm
			.select('categories')
			.include('children', {
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				includeDepth: true,
			})
			.dump();
		expect(query.sql).toBe(
			'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM categories',
		);
	});
	it('NQL managementChain projection', () => {
		const query = orm.nql`categories | select name, managementChain.*`.dump();
		expect(query.sql).toBe(
			'SELECT categories.name, COALESCE((WITH RECURSIVE "managementChain_walk" AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n.id = categories."parentId" AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", "managementChain_walk".__depth + 1 AS __depth, "managementChain_walk".__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM "managementChain_walk" JOIN categories AS __n ON __n.id = "managementChain_walk"."parentId" WHERE "managementChain_walk".__depth < 10 AND __n.id <> ALL ("managementChain_walk".__visited)) SELECT json_agg(json_build_object(\'id\', "managementChain_walk".id, \'name\', "managementChain_walk".name, \'parentId\', "managementChain_walk"."parentId", \'__dbsp_node\', "managementChain_walk".__node_text, \'__dbsp_parent\', "managementChain_walk".__parent_text, \'__dbsp_depth\', "managementChain_walk".__depth) ORDER BY "managementChain_walk".__depth, "managementChain_walk".id) FROM "managementChain_walk"), \'[]\'::json) AS "managementChain_json" FROM categories',
		);
		expect('params' in query && query.params).toEqual([]);
	});
});

describe('#877 recursive option refusals', () => {
	for (const [option, value] of [
		['foreignKey', 'parentId'],
		['track.path', true],
		['track.path', false],
		['track.depth.as', 'level'],
	] as const) {
		it(`refuses ${option}=${value}`, () => {
			const recursive =
				option === 'foreignKey'
					? { foreignKey: value as string }
					: option === 'track.path'
						? { track: { path: value as boolean } }
						: { track: { depth: { as: value as string } } };
			const plan = orm
				.select('categories')
				.include('children', { recursive: true, direction: 'descendants' })
				.plan();
			const intent = {
				...plan.intent!,
				include: [{ relation: 'children', recursive: { ...recursive } }],
			};
			const decisions = plan.decisions.map((d) =>
				d.type === 'include-strategy'
					? {
							...d,
							context: {
								...d.context,
								recursiveInclude: {
									...d.context.recursiveInclude!,
									...recursive,
								},
							},
						}
					: d,
			);
			expect(() => adapter.compile({ ...plan, intent, decisions })).toThrow(
				`Recursive include option ${option} is not supported`,
			);
		});
	}
	for (const maxDepth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
		it(`refuses maxDepth ${maxDepth}`, () => {
			expect(() =>
				orm
					.select('categories')
					.include('children', {
						recursive: true,
						direction: 'descendants',
						maxDepth,
					})
					.dump(),
			).toThrow(
				'Recursive include option maxDepth must be a positive integer at most 2147483647',
			);
		});
	it('refuses include', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					include: [{ relation: 'parent' }],
				})
				.dump(),
		).toThrow(/include/);
	});
	it('refuses select expressions', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					select: { type: 'expressions', columns: [] },
				})
				.dump(),
		).toThrow('Recursive include option select supports only fields or all');
	});
	it('refuses where', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					where: eq('id', 1),
				})
				.dump(),
		).toThrow(/where/);
	});
	it('refuses join', () => {
		expect(() =>
			orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					join: 'left',
				})
				.dump(),
		).toThrow(/join/);
	});
	for (const [option, value] of [
		['limit', 2],
		['orderBy', [{ field: 'name', direction: 'desc' }]],
	] as const)
		it(`refuses ${option}`, () => {
			const plan = orm
				.select('categories')
				.include('children', { recursive: true, direction: 'descendants' })
				.plan();
			const intent = {
				...plan.intent!,
				include: [{ ...plan.intent!.include![0]!, [option]: value }],
			};
			expect(() => adapter.compile({ ...plan, intent })).toThrow(
				`Recursive include option ${option} is not supported`,
			);
		});
});

describe('#877 shared plan/compile refusals', () => {
	const valid = () =>
		orm
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' })
			.plan();
	for (const [name, patch] of [
		['grouped or aggregated roots', { groupBy: ['id'] }],
		[
			'grouped or aggregated roots',
			{ select: { type: 'aggregate', aggregates: [{ function: 'count' }] } },
		],
		[
			'grouped or aggregated roots',
			{
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'function',
							name: 'abs',
							args: [{ kind: 'function', name: 'count', args: [] }],
						},
					],
				},
			},
		],
		['DISTINCT', { distinct: true }],
		['row locks', { lock: { strength: 'update', waitPolicy: 'block' } }],
	] as const)
		it(`refuses root ${JSON.stringify(patch)} in plan and compile`, () => {
			const report = asLegacyReport(valid());
			const intent = { ...report.intent!, ...patch };
			expect(() =>
				plan(intent as QueryIntent, db.model, {
					dialectCapabilities: adapter.dialectCapabilities,
				}),
			).toThrow(`Recursive include option ${name} is not supported`);
			expect(() =>
				adapter.compile({ ...report, intent: intent as QueryIntent }),
			).toThrow(`Recursive include option ${name} is not supported`);
		});
	for (const [name, patch] of [
		['where', { where: eq('id', 1) }],
		['limit', { limit: 2 }],
		['orderBy', { orderBy: [{ field: 'id', direction: 'asc' }] }],
		['include', { include: [{ relation: 'parent' }] }],
		[
			'select supports only fields or all',
			{ select: { type: 'expressions', columns: [] } },
		],
	] as const)
		it(`refuses include ${name} in plan and compile`, () => {
			const report = asLegacyReport(valid());
			const include = { ...report.intent!.include![0]!, ...patch };
			const intent = { ...report.intent!, include: [include] } as QueryIntent;
			expect(() =>
				plan(intent, db.model, {
					dialectCapabilities: adapter.dialectCapabilities,
				}),
			).toThrow(`Recursive include option ${name} is not supported`);
			expect(() => adapter.compile({ ...report, intent })).toThrow(
				`Recursive include option ${name} is not supported`,
			);
		});
	it('refuses a recursive include under an ordinary include', () => {
		const report = asLegacyReport(valid());
		const intent = {
			...report.intent!,
			include: [{ relation: 'parent', include: report.intent!.include }],
		} as QueryIntent;
		expect(() =>
			plan(intent, db.model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow(
			'Recursive include option include does not support nested recursive includes is not supported',
		);
		const outer = asLegacyReport(
			orm.select('categories').include('parent').plan(),
		);
		expect(() =>
			adapter.compile({
				...outer,
				intent,
				decisions: [
					...outer.decisions,
					...report.decisions.map((d) => ({
						...d,
						context: { ...d.context, intentPath: 'include[0].include[0]' },
					})),
				],
			}),
		).toThrow(
			'Recursive include option include does not support nested recursive includes is not supported',
		);
	});
	it('refuses applicable traversed-node default filters in plan and dump', () => {
		const filtered = schema(
			{
				categories: {
					id: { type: 'integer', primaryKey: true },
					parentId: ref('categories', {
						nullable: true,
						roles: { parent: 'parent', children: 'children' },
					}),
				},
			},
			undefined,
			{ defaultFilters: { categories: eq('id', 1) } },
		);
		const query = createOrm({
			schema: filtered,
			adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
		})
			.select('categories')
			.include('children', { recursive: true, direction: 'descendants' });
		expect(() => query.plan()).toThrow(
			'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
		);
		expect(() => query.dump()).toThrow(
			'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
		);
	});
	it('refuses set operations by name in NQL plan and adapter compile', () => {
		const query = orm.nql`categories | select managementChain.* | union (categories | select managementChain.*)`;
		expect(() => query.plan()).toThrow(
			'Recursive include option set operations is not supported',
		);
		expect(() => query.dump()).toThrow(
			'Recursive include option set operations is not supported',
		);
	});
	it('uses the declared non-id nullable referenced key and physical casing', () => {
		const keyed = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				nodeKey: { type: 'integer', nullable: true, unique: true },
				parentKey: ref('nodes', {
					references: ['nodeKey'],
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const result = createOrm({
			schema: keyed,
			adapter: createPgCompileOnlyAdapter({ model: keyed.model }),
		})
			.select('nodes')
			.include('tree', {
				via: 'children',
				recursive: true,
				direction: 'descendants',
				omitSelf: true,
				select: { type: 'fields', fields: ['id'] },
			})
			.dump();
		expect(result.sql).toBe(
			'SELECT nodes.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."nodeKey" AS "nodeKey", __n."parentKey" AS "parentKey", 1 AS __depth, array_remove(ARRAY[nodes."nodeKey", __n."nodeKey"], NULL) AS __visited, CAST(__n."nodeKey" AS text) AS __node_text, CAST(__n."parentKey" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentKey" = nodes."nodeKey" AND __n."nodeKey" IS DISTINCT FROM nodes."nodeKey" AND __n."nodeKey" IS NOT NULL UNION ALL SELECT __n.id AS id, __n."nodeKey" AS "nodeKey", __n."parentKey" AS "parentKey", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n."nodeKey" AS __visited, CAST(__n."nodeKey" AS text) AS __node_text, CAST(__n."parentKey" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentKey" = children_walk."nodeKey" WHERE children_walk.__depth < 100 AND __n."nodeKey" <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk."nodeKey", children_walk.id) FROM children_walk), \'[]\'::json) AS tree_json FROM nodes',
		);
		expect(result.sql).toContain('__n."parentKey" = nodes."nodeKey"');
		expect(result.sql).toContain('__n."nodeKey" IS NOT NULL');
	});
	it('refuses a missing referenced key instead of id fallback at both boundaries', () => {
		const relation = db.model.getRelation('categories.children')!;
		const model = {
			...db.model,
			getRelation: (name: string) =>
				name === 'categories.children'
					? { ...relation, sourceKey: undefined }
					: db.model.getRelation(name),
			getTable: db.model.getTable.bind(db.model),
			getRelationsFrom: db.model.getRelationsFrom.bind(db.model),
		} as ModelIR;
		const report = asLegacyReport(valid());
		expect(() =>
			plan(report.intent!, model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow('Recursive include requires a declared referenced key');
		expect(() => createPgCompileOnlyAdapter({ model }).compile(report)).toThrow(
			'Recursive include requires a declared referenced key',
		);
	});
	it('refuses composite self references at both boundaries', () => {
		const relation = db.model.getRelation('categories.children')!;
		const model = {
			...db.model,
			getRelation: (name: string) =>
				name === 'categories.children'
					? {
							...relation,
							sourceKey: ['id', 'name'],
							foreignKey: ['parentId', 'name'],
						}
					: db.model.getRelation(name),
			getTable: db.model.getTable.bind(db.model),
			getRelationsFrom: db.model.getRelationsFrom.bind(db.model),
		} as ModelIR;
		const report = asLegacyReport(valid());
		expect(() =>
			plan(report.intent!, model, {
				dialectCapabilities: adapter.dialectCapabilities,
			}),
		).toThrow('Recursive include requires a single parentKey and foreignKey');
		expect(() => createPgCompileOnlyAdapter({ model }).compile(report)).toThrow(
			'Recursive include requires a single parentKey and foreignKey',
		);
	});
	it('refuses stored requested keys at root and every node, and supports via', () => {
		const colliding = schema({
			nodes: {
				id: { type: 'integer', primaryKey: true },
				children: 'string',
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		});
		const query = createOrm({
			schema: colliding,
			adapter: createPgCompileOnlyAdapter({ model: colliding.model }),
		}).select('nodes');
		expect(() =>
			query
				.include('children', { recursive: true, direction: 'descendants' })
				.dump(),
		).toThrow("conflicting public key 'children'");
		expect(() =>
			query
				.columns(['id'])
				.include('children', { recursive: true, direction: 'descendants' })
				.dump(),
		).toThrow("conflicting public key 'children'");
		expect(
			query
				.include('tree', {
					via: 'children',
					recursive: true,
					direction: 'descendants',
				})
				.dump().sql,
		).toBe(
			'SELECT nodes.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.children AS children, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[nodes.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentId" = nodes.id AND __n.id IS DISTINCT FROM nodes.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.children AS children, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk.children, children_walk."parentId", children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT nodes.id AS id, nodes.children AS children, nodes."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[nodes.id], NULL) AS __visited, CAST(nodes.id AS text) AS __node_text, CAST(nodes."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'children\', children_walk.children, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS tree_json FROM nodes',
		);
	});
});

it('default nested ancestors includes a separate depth-zero self row and preserves root params', () => {
	const query = orm
		.select('categories')
		.where(eq('id', 4))
		.include('parent', { recursive: true, direction: 'ancestors' })
		.dump();
	expect(query.sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE parent_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n.id = categories."parentId" AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", parent_walk.__depth + 1 AS __depth, parent_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM parent_walk JOIN categories AS __n ON __n.id = parent_walk."parentId" WHERE parent_walk.__depth < 100 AND __n.id <> ALL (parent_walk.__visited)), parent_output AS (SELECT parent_walk.id, parent_walk.name, parent_walk."parentId", parent_walk.__depth, parent_walk.__visited, parent_walk.__node_text, parent_walk.__parent_text FROM parent_walk UNION ALL SELECT categories.id AS id, categories.name AS name, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', parent_walk.id, \'name\', parent_walk.name, \'parentId\', parent_walk."parentId", \'__dbsp_node\', parent_walk.__node_text, \'__dbsp_parent\', parent_walk.__parent_text, \'__dbsp_depth\', parent_walk.__depth) ORDER BY parent_walk.__depth, parent_walk.id) FROM parent_output AS parent_walk), \'[]\'::json) AS parent_json FROM categories WHERE categories.id = $1',
	);
	expect(query.params).toEqual([4]);
});

it('default nested descendants includes a separate depth-zero self row and preserves root params', () => {
	const query = orm
		.select('categories')
		.where(eq('id', 4))
		.include('children', { recursive: true, direction: 'descendants' })
		.dump();
	expect(query.sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk.name, children_walk."parentId", children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT categories.id AS id, categories.name AS name, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS children_json FROM categories WHERE categories.id = $1',
	);
	expect(query.params).toEqual([4]);
});

it('preserves the ordinary non-recursive CTE include SQL and params', () => {
	const query = orm
		.select('categories')
		.withPlanOptions({ defaultIncludeStrategy: 'cte' })
		.include('children')
		.dump();
	expect(query.sql).toBe(
		'WITH children_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT categories.* FROM categories LEFT JOIN children_cte AS children_ref_0 ON categories.id = children_ref_0."parentId"',
	);
	expect(query.params).toEqual([]);
});

const storedDepth = schema({
	depthNodes: {
		id: { type: 'integer', primaryKey: true },
		depth: 'integer',
		__depth: 'integer',
		__visited: 'string',
		parentId: ref('depthNodes', {
			nullable: true,
			as: 'parent',
			inverse: 'children',
			roles: { parent: 'parent', children: 'children' },
		}),
	},
});
it('refuses a projected public depth collision by relation and column', () => {
	for (const options of [{ flat: true }, { includeDepth: true }])
		expect(() =>
			createOrm({
				schema: storedDepth,
				adapter: createPgCompileOnlyAdapter({ model: storedDepth.model }),
			})
				.select('depthNodes')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					...options,
				})
				.dump(),
		).toThrow("conflicting public key 'depth'");
});

it('keeps stored depth and allocates internal columns around the complete model', () => {
	const query = createOrm({
		schema: storedDepth,
		adapter: createPgCompileOnlyAdapter({ model: storedDepth.model }),
	})
		.select('depthNodes')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
		})
		.dump();
	expect(query.sql).toBe(
		'SELECT "depthNodes".*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.depth AS depth, __n.__depth AS __depth, __n.__visited AS __visited, __n."parentId" AS "parentId", 1 AS __depth_1, array_remove(ARRAY["depthNodes".id, __n.id], NULL) AS __visited_1, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM "depthNodes" AS __n WHERE __n."parentId" = "depthNodes".id AND __n.id IS DISTINCT FROM "depthNodes".id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.depth AS depth, __n.__depth AS __depth, __n.__visited AS __visited, __n."parentId" AS "parentId", children_walk.__depth_1 + 1 AS __depth_1, children_walk.__visited_1 || __n.id AS __visited_1, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN "depthNodes" AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth_1 < 100 AND __n.id <> ALL (children_walk.__visited_1)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'depth\', children_walk.depth, \'__depth\', children_walk.__depth, \'__visited\', children_walk.__visited, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth_1) ORDER BY children_walk.__depth_1, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM "depthNodes"',
	);
	expect(query.params).toEqual([]);
});

it('allocates the inner alias when the root is __n', () => {
	const named = schema({
		__n: {
			id: { type: 'integer', primaryKey: true },
			name: 'string',
			parentId: ref('__n', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: named,
		adapter: createPgCompileOnlyAdapter({ model: named.model }),
	})
		.select('__n')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toBe(
		'SELECT __n.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n_1.id AS id, __n_1.name AS name, __n_1."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[__n.id, __n_1.id], NULL) AS __visited, CAST(__n_1.id AS text) AS __node_text, CAST(__n_1."parentId" AS text) AS __parent_text FROM __n AS __n_1 WHERE __n_1."parentId" = __n.id AND __n_1.id IS DISTINCT FROM __n.id AND __n_1.id IS NOT NULL UNION ALL SELECT __n_1.id AS id, __n_1.name AS name, __n_1."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n_1.id AS __visited, CAST(__n_1.id AS text) AS __node_text, CAST(__n_1."parentId" AS text) AS __parent_text FROM children_walk JOIN __n AS __n_1 ON __n_1."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n_1.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM __n',
	);
	expect(query.params).toEqual([]);
});

it('uses the json_agg read policy to cast handled bigint ids and payload fields exactly', () => {
	const big = schema({
		categories: {
			id: { type: 'bigint', js: 'bigint', primaryKey: true },
			name: { type: 'bigint', js: 'string' },
			parentId: ref('categories', {
				js: 'bigint',
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: big,
		adapter: createPgCompileOnlyAdapter({ model: big.model }),
	})
		.select('categories')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', CAST(children_walk.id AS text), \'name\', CAST(children_walk.name AS text), \'parentId\', CAST(children_walk."parentId" AS text), \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS children_json FROM categories',
	);
	expect(query.params).toEqual([]);
});

it('builds a 51-column payload in bounded chunks joined into one JSON object', () => {
	const fields = Object.fromEntries(
		Array.from({ length: 49 }, (_, i) => [`field${i}`, 'integer' as const]),
	);
	const wide = schema({
		wide: {
			id: { type: 'integer', primaryKey: true },
			...fields,
			parentId: ref('wide', {
				nullable: true,
				as: 'parent',
				inverse: 'children',
				roles: { parent: 'parent', children: 'children' },
			}),
		},
	});
	const query = createOrm({
		schema: wide,
		adapter: createPgCompileOnlyAdapter({ model: wide.model }),
	})
		.select('wide')
		.include('children', {
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		})
		.dump();
	expect(query.sql).toBe(
		"SELECT wide.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.field0 AS field0, __n.field1 AS field1, __n.field2 AS field2, __n.field3 AS field3, __n.field4 AS field4, __n.field5 AS field5, __n.field6 AS field6, __n.field7 AS field7, __n.field8 AS field8, __n.field9 AS field9, __n.field10 AS field10, __n.field11 AS field11, __n.field12 AS field12, __n.field13 AS field13, __n.field14 AS field14, __n.field15 AS field15, __n.field16 AS field16, __n.field17 AS field17, __n.field18 AS field18, __n.field19 AS field19, __n.field20 AS field20, __n.field21 AS field21, __n.field22 AS field22, __n.field23 AS field23, __n.field24 AS field24, __n.field25 AS field25, __n.field26 AS field26, __n.field27 AS field27, __n.field28 AS field28, __n.field29 AS field29, __n.field30 AS field30, __n.field31 AS field31, __n.field32 AS field32, __n.field33 AS field33, __n.field34 AS field34, __n.field35 AS field35, __n.field36 AS field36, __n.field37 AS field37, __n.field38 AS field38, __n.field39 AS field39, __n.field40 AS field40, __n.field41 AS field41, __n.field42 AS field42, __n.field43 AS field43, __n.field44 AS field44, __n.field45 AS field45, __n.field46 AS field46, __n.field47 AS field47, __n.field48 AS field48, __n.\"parentId\" AS \"parentId\", 1 AS __depth, array_remove(ARRAY[wide.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n.\"parentId\" AS text) AS __parent_text FROM wide AS __n WHERE __n.\"parentId\" = wide.id AND __n.id IS DISTINCT FROM wide.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.field0 AS field0, __n.field1 AS field1, __n.field2 AS field2, __n.field3 AS field3, __n.field4 AS field4, __n.field5 AS field5, __n.field6 AS field6, __n.field7 AS field7, __n.field8 AS field8, __n.field9 AS field9, __n.field10 AS field10, __n.field11 AS field11, __n.field12 AS field12, __n.field13 AS field13, __n.field14 AS field14, __n.field15 AS field15, __n.field16 AS field16, __n.field17 AS field17, __n.field18 AS field18, __n.field19 AS field19, __n.field20 AS field20, __n.field21 AS field21, __n.field22 AS field22, __n.field23 AS field23, __n.field24 AS field24, __n.field25 AS field25, __n.field26 AS field26, __n.field27 AS field27, __n.field28 AS field28, __n.field29 AS field29, __n.field30 AS field30, __n.field31 AS field31, __n.field32 AS field32, __n.field33 AS field33, __n.field34 AS field34, __n.field35 AS field35, __n.field36 AS field36, __n.field37 AS field37, __n.field38 AS field38, __n.field39 AS field39, __n.field40 AS field40, __n.field41 AS field41, __n.field42 AS field42, __n.field43 AS field43, __n.field44 AS field44, __n.field45 AS field45, __n.field46 AS field46, __n.field47 AS field47, __n.field48 AS field48, __n.\"parentId\" AS \"parentId\", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n.\"parentId\" AS text) AS __parent_text FROM children_walk JOIN wide AS __n ON __n.\"parentId\" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(CAST(CAST(json_build_object('id', children_walk.id, 'field0', children_walk.field0, 'field1', children_walk.field1, 'field2', children_walk.field2, 'field3', children_walk.field3, 'field4', children_walk.field4, 'field5', children_walk.field5, 'field6', children_walk.field6, 'field7', children_walk.field7, 'field8', children_walk.field8, 'field9', children_walk.field9, 'field10', children_walk.field10, 'field11', children_walk.field11, 'field12', children_walk.field12, 'field13', children_walk.field13, 'field14', children_walk.field14, 'field15', children_walk.field15, 'field16', children_walk.field16, 'field17', children_walk.field17, 'field18', children_walk.field18, 'field19', children_walk.field19, 'field20', children_walk.field20, 'field21', children_walk.field21, 'field22', children_walk.field22, 'field23', children_walk.field23, 'field24', children_walk.field24, 'field25', children_walk.field25, 'field26', children_walk.field26, 'field27', children_walk.field27, 'field28', children_walk.field28, 'field29', children_walk.field29, 'field30', children_walk.field30, 'field31', children_walk.field31, 'field32', children_walk.field32, 'field33', children_walk.field33, 'field34', children_walk.field34, 'field35', children_walk.field35, 'field36', children_walk.field36, 'field37', children_walk.field37, 'field38', children_walk.field38, 'field39', children_walk.field39, 'field40', children_walk.field40, 'field41', children_walk.field41, 'field42', children_walk.field42, 'field43', children_walk.field43, 'field44', children_walk.field44, 'field45', children_walk.field45, 'field46', children_walk.field46, 'field47', children_walk.field47, 'field48', children_walk.field48) AS jsonb) || CAST(json_build_object('parentId', children_walk.\"parentId\", '__dbsp_node', children_walk.__node_text, '__dbsp_parent', children_walk.__parent_text, '__dbsp_depth', children_walk.__depth) AS jsonb) AS json) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), '[]'::json) AS children_json FROM wide",
	);
	expect(query.params).toEqual([]);
});

it('refuses applicable default filters for NQL recursive pseudo-columns', () => {
	const filtered = schema(
		{
			nodes: {
				id: { type: 'integer', primaryKey: true },
				parentId: ref('nodes', {
					nullable: true,
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		},
		undefined,
		{ defaultFilters: { nodes: eq('id', 1) } },
	);
	const instance = createOrm({
		schema: filtered,
		adapter: createPgCompileOnlyAdapter({ model: filtered.model }),
	});
	expect(() => instance.nql`nodes | select ancestors.*`.plan()).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
	expect(() => instance.nql`nodes | select ancestors.*`.dump()).toThrow(
		'Recursive include with applicable defaultFilters on traversed nodes is not yet supported (#906).',
	);
});
it('uses shared shortening for long requested keys and collision-free transport labels', () => {
	const query = orm
		.select('categories')
		.include('é'.repeat(40), {
			via: 'children',
			recursive: true,
			direction: 'descendants',
		})
		.include('é'.repeat(39) + 'a', {
			via: 'parent',
			recursive: true,
			direction: 'ancestors',
		});
	const compiled = adapter.compile(query.plan());
	const shapes = compiled.hydrationPlan!.includePayloads!;
	expect(shapes.map((shape) => shape.publicKey)).toEqual([
		'é'.repeat(40),
		'é'.repeat(39) + 'a',
	]);
	expect(new Set(shapes.map((shape) => shape.outputLabel)).size).toBe(2);
	for (const shape of shapes)
		expect(Buffer.byteLength(shape.outputLabel)).toBeLessThanOrEqual(63);
	expect(compiled.sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk.name, children_walk."parentId", children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT categories.id AS id, categories.name AS name, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS "éééééééééééééééééééééééééééééé_3", COALESCE((WITH RECURSIVE parent_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n.id = categories."parentId" AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", parent_walk.__depth + 1 AS __depth, parent_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM parent_walk JOIN categories AS __n ON __n.id = parent_walk."parentId" WHERE parent_walk.__depth < 100 AND __n.id <> ALL (parent_walk.__visited)), parent_output AS (SELECT parent_walk.id, parent_walk.name, parent_walk."parentId", parent_walk.__depth, parent_walk.__visited, parent_walk.__node_text, parent_walk.__parent_text FROM parent_walk UNION ALL SELECT categories.id AS id, categories.name AS name, categories."parentId" AS "parentId", 0 AS __depth, array_remove(ARRAY[categories.id], NULL) AS __visited, CAST(categories.id AS text) AS __node_text, CAST(categories."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', parent_walk.id, \'name\', parent_walk.name, \'parentId\', parent_walk."parentId", \'__dbsp_node\', parent_walk.__node_text, \'__dbsp_parent\', parent_walk.__parent_text, \'__dbsp_depth\', parent_walk.__depth) ORDER BY parent_walk.__depth, parent_walk.id) FROM parent_output AS parent_walk), \'[]\'::json) AS "éééééééééééééééééééééééééééééé_7" FROM categories',
	);
});

it('preserves different recursive public payloads using via for the same relation', () => {
	const read = orm
		.select('categories')
		.include('tree', {
			via: 'children',
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
		})
		.include('list', {
			via: 'children',
			recursive: true,
			direction: 'descendants',
			omitSelf: true,
			flat: true,
		});
	const compiled = adapter.compile(read.plan());
	expect(
		compiled.hydrationPlan!.includePayloads!.map((shape) => [
			shape.publicKey,
			shape.recursive!.flat,
		]),
	).toEqual([
		['tree', false],
		['list', true],
	]);
	expect(compiled.sql).toBe(
		'SELECT categories.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS tree_json, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", 1 AS __depth, array_remove(ARRAY[categories.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM categories AS __n WHERE __n."parentId" = categories.id AND __n.id IS DISTINCT FROM categories.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n.name AS name, __n."parentId" AS "parentId", children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN categories AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'name\', children_walk.name, \'parentId\', children_walk."parentId", \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_walk), \'[]\'::json) AS list_json FROM categories',
	);
});
describe('#877 hierarchy shortcut execution', () => {
	for (const [parent, children] of [
		['parent', 'children'],
		['manager', 'reports'],
	] as const) {
		for (const direction of ['ancestors', 'descendants'] as const) {
			it(`reads the requested ${direction === 'ancestors' ? parent : children} key for ${direction}`, async () => {
				const db = schema({
					nodes: {
						id: { type: 'integer', primaryKey: true },
						parentId: ref('nodes', {
							nullable: true,
							as: parent,
							inverse: children,
							roles: { parent, children },
						}),
					},
				});
				const adapter = createPgCompileOnlyAdapter({ model: db.model });
				const fake = Object.create(adapter) as typeof adapter;
				const key = direction === 'ancestors' ? parent : children;
				Object.defineProperty(fake, 'connectionAvailability', {
					value: { status: 'available' },
				});
				Object.defineProperty(fake, 'execute', {
					value: async () => [
						{
							id: 1,
							[`${key}_json`]: [
								{
									id: 2,
									parentId: direction === 'ancestors' ? null : 1,
									__dbsp_node: '2',
									__dbsp_parent: direction === 'ancestors' ? null : '1',
									__dbsp_depth: 1,
								},
							],
						},
					],
				});
				const orm = createOrm({ schema: db, adapter: fake });
				const rows =
					direction === 'ancestors'
						? await orm.listAncestors('nodes', 1, { parentId: 'parentId' })
						: await orm.listDescendants('nodes', 1, { parentId: 'parentId' });
				expect(rows).toEqual([
					{ id: 2, parentId: direction === 'ancestors' ? null : 1, depth: 1 },
				]);
			});
		}
	}
});
