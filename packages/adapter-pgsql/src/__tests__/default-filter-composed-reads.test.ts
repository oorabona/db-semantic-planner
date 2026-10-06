import { createOrm, eq, isNull, planRecursive, ref, schema } from '@dbsp/core';
import type { RecursiveIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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
		edges: {
			id: { type: 'integer', primaryKey: true },
			fromId: 'integer',
			toId: 'integer',
			hidden: { type: 'timestamp', nullable: true },
		},
	},
	undefined,
	{ defaultFilters: { nodes: isNull('hidden') } },
);
const adapter = createPgCompileOnlyAdapter();
const orm = createOrm({ schema: db, adapter });
const standalone: RecursiveIntent = {
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
function compile(intent: RecursiveIntent, filters: typeof db.defaultFilters) {
	const result = adapter.compileRecursive(
		planRecursive(intent, db.model, {
			...(filters && { defaultFilters: filters }),
		}),
		db.model,
	);
	return { sql: result.sql, params: result.parameters };
}
function dumped(query: {
	dump(): { sql: string; params: readonly unknown[] };
}) {
	const { sql, params } = query.dump();
	return { sql, params };
}

describe('default filters in composed reads', () => {
	it('filters recursive include anchor and step with a complete builder opt-out', () => {
		const build = (o: typeof orm) =>
			o.select('nodes').include('children', {
				recursive: true,
				direction: 'descendants',
				flat: true,
			});
		expect(dumped(build(orm))).toEqual({
			sql: 'SELECT nodes.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", __n.hidden AS hidden, 1 AS __depth, array_remove(ARRAY[nodes.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentId" = nodes.id AND __n.id IS DISTINCT FROM nodes.id AND __n.id IS NOT NULL AND __n.hidden IS NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", __n.hidden AS hidden, children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited) AND __n.hidden IS NULL), children_output AS (SELECT children_walk.id, children_walk."parentId", children_walk.hidden, children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT nodes.id AS id, nodes."parentId" AS "parentId", nodes.hidden AS hidden, 0 AS __depth, array_remove(ARRAY[nodes.id], NULL) AS __visited, CAST(nodes.id AS text) AS __node_text, CAST(nodes."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'parentId\', children_walk."parentId", \'hidden\', children_walk.hidden, \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS children_json FROM nodes WHERE nodes.hidden IS NULL',
			params: [],
		});
		expect(dumped(build(orm.withoutDefaultFilters()))).toEqual({
			sql: 'SELECT nodes.*, COALESCE((WITH RECURSIVE children_walk AS (SELECT __n.id AS id, __n."parentId" AS "parentId", __n.hidden AS hidden, 1 AS __depth, array_remove(ARRAY[nodes.id, __n.id], NULL) AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM nodes AS __n WHERE __n."parentId" = nodes.id AND __n.id IS DISTINCT FROM nodes.id AND __n.id IS NOT NULL UNION ALL SELECT __n.id AS id, __n."parentId" AS "parentId", __n.hidden AS hidden, children_walk.__depth + 1 AS __depth, children_walk.__visited || __n.id AS __visited, CAST(__n.id AS text) AS __node_text, CAST(__n."parentId" AS text) AS __parent_text FROM children_walk JOIN nodes AS __n ON __n."parentId" = children_walk.id WHERE children_walk.__depth < 100 AND __n.id <> ALL (children_walk.__visited)), children_output AS (SELECT children_walk.id, children_walk."parentId", children_walk.hidden, children_walk.__depth, children_walk.__visited, children_walk.__node_text, children_walk.__parent_text FROM children_walk UNION ALL SELECT nodes.id AS id, nodes."parentId" AS "parentId", nodes.hidden AS hidden, 0 AS __depth, array_remove(ARRAY[nodes.id], NULL) AS __visited, CAST(nodes.id AS text) AS __node_text, CAST(nodes."parentId" AS text) AS __parent_text) SELECT json_agg(json_build_object(\'id\', children_walk.id, \'parentId\', children_walk."parentId", \'hidden\', children_walk.hidden, \'__dbsp_node\', children_walk.__node_text, \'__dbsp_parent\', children_walk.__parent_text, \'__dbsp_depth\', children_walk.__depth) ORDER BY children_walk.__depth, children_walk.id) FROM children_output AS children_walk), \'[]\'::json) AS children_json FROM nodes',
			params: [],
		});
	});
	it('preserves the policy of every leaf in a mixed union', () => {
		const build = (o: typeof orm) =>
			o
				.select('nodes')
				.join('parent')
				.unionAll(o.select('nodes').withoutDefaultFilters());
		expect(dumped(build(orm))).toEqual({
			sql: '(SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id AND parent.hidden IS NULL WHERE nodes.hidden IS NULL) UNION ALL (SELECT nodes.* FROM nodes)',
			params: [],
		});
		expect(dumped(build(orm.withoutDefaultFilters()))).toEqual({
			sql: '(SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id) UNION ALL (SELECT nodes.* FROM nodes)',
			params: [],
		});
	});
	it('filters the fluent CTE outer body and allows its opt-out', () => {
		const build = (o: typeof orm) =>
			o
				.withCte('lookups')
				.fromUnnest({ id: [1] })
				.query(o.select('nodes').join('parent'));
		expect(dumped(build(orm))).toEqual({
			sql: 'WITH lookups AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id AND parent.hidden IS NULL WHERE nodes.hidden IS NULL',
			params: [[1]],
		});
		expect(dumped(build(orm.withoutDefaultFilters()))).toEqual({
			sql: 'WITH lookups AS (SELECT t.id AS id FROM unnest(CAST($1 AS int4[])) AS t(id)) SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id',
			params: [[1]],
		});
	});
	it('preserves independent policies for recursive CTE anchor and step bodies', () => {
		const build = (o: typeof orm) =>
			o.recursive('walk', {
				base: o.select('nodes').join('parent'),
				step: o.select('nodes').join('parent').withoutDefaultFilters(),
			});
		expect(dumped(build(orm))).toEqual({
			sql: 'WITH RECURSIVE "walk" AS (SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id AND parent.hidden IS NULL WHERE nodes.hidden IS NULL UNION ALL SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id) SELECT walk.* FROM walk',
			params: [],
		});
		expect(dumped(build(orm.withoutDefaultFilters()))).toEqual({
			sql: 'WITH RECURSIVE "walk" AS (SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id UNION ALL SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id) SELECT walk.* FROM walk',
			params: [],
		});
	});
	it('filters standalone recursive anchor and step scans', () => {
		expect(compile(standalone, db.defaultFilters)).toEqual({
			sql: 'WITH RECURSIVE walk AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = $1 AND __n.hidden IS NULL UNION ALL SELECT __n.id AS id, walk.__depth + 1 AS __depth, walk.__visited || __n.id AS __visited FROM walk JOIN nodes AS __n ON __n."parentId" = walk.id WHERE walk.__depth < 3 AND __n.id <> ALL (walk.__visited) AND __n.hidden IS NULL) SELECT walk.id AS id FROM walk',
			params: [1],
		});
		expect(compile(standalone, undefined)).toEqual({
			sql: 'WITH RECURSIVE walk AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = $1 UNION ALL SELECT __n.id AS id, walk.__depth + 1 AS __depth, walk.__visited || __n.id AS __visited FROM walk JOIN nodes AS __n ON __n."parentId" = walk.id WHERE walk.__depth < 3 AND __n.id <> ALL (walk.__visited)) SELECT walk.id AS id FROM walk',
			params: [1],
		});
	});
	it('refuses a filtered junction by name while filtering edge traversal nodes', () => {
		const edge: RecursiveIntent = {
			...standalone,
			traversal: {
				kind: 'edge-table',
				nodeTable: 'nodes',
				nodeId: 'id',
				edgeTable: 'edges',
				edgeFrom: 'fromId',
				edgeTo: 'toId',
				direction: 'out',
			},
		};
		expect(() => compile(edge, { edges: isNull('hidden') })).toThrowError(
			new Error(
				"Default filter for table 'edges' is not supported at recursive.traversal.edgeTable.",
			),
		);
		expect(compile(edge, db.defaultFilters)).toEqual({
			sql: 'WITH RECURSIVE walk AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = $1 AND __n.hidden IS NULL UNION ALL SELECT __n.id AS id, walk.__depth + 1 AS __depth, walk.__visited || __n.id AS __visited FROM walk JOIN edges AS __e ON __e."fromId" = walk.id JOIN nodes AS __n ON __n.id = __e."toId" WHERE walk.__depth < 3 AND __n.id <> ALL (walk.__visited) AND __n.hidden IS NULL) SELECT walk.id AS id FROM walk',
			params: [1],
		});
		expect(compile(edge, undefined)).toEqual({
			sql: 'WITH RECURSIVE walk AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = $1 UNION ALL SELECT __n.id AS id, walk.__depth + 1 AS __depth, walk.__visited || __n.id AS __visited FROM walk JOIN edges AS __e ON __e."fromId" = walk.id JOIN nodes AS __n ON __n.id = __e."toId" WHERE walk.__depth < 3 AND __n.id <> ALL (walk.__visited)) SELECT walk.id AS id FROM walk',
			params: [1],
		});
	});
	it('resolves recursive predicates with only the current node scan visible', () => {
		expect(() =>
			compile(standalone, { nodes: eq('parent.hidden', null) }),
		).toThrow(
			/Default filter for table 'nodes' must reference only its own scan/,
		);
		expect(compile(standalone, undefined)).toEqual({
			sql: 'WITH RECURSIVE walk AS (SELECT __n.id AS id, 1 AS __depth, ARRAY[__n.id] AS __visited FROM nodes AS __n WHERE __n.id = $1 UNION ALL SELECT __n.id AS id, walk.__depth + 1 AS __depth, walk.__visited || __n.id AS __visited FROM walk JOIN nodes AS __n ON __n."parentId" = walk.id WHERE walk.__depth < 3 AND __n.id <> ALL (walk.__visited)) SELECT walk.id AS id FROM walk',
			params: [1],
		});
		const includes = orm
			.select('nodes')
			.include('children', { recursive: true, direction: 'descendants' })
			.plan().execution?.includes;
		const scans = includes?.[0]?.recursiveRanges;
		expect(scans?.anchorDefaultFilter).toBeDefined();
		expect(scans?.stepDefaultFilter).toBeDefined();
		expect(scans?.next.id).not.toBe(includes?.[0]?.targetRange.id);
	});
	it('keeps appended set leaves filtered after a mixed union', () => {
		const query = orm
			.select('nodes')
			.unionAll(orm.select('nodes').withoutDefaultFilters())
			.except(orm.select('nodes').join('parent'));
		expect(dumped(query)).toEqual({
			sql: '((SELECT nodes.* FROM nodes WHERE nodes.hidden IS NULL) UNION ALL (SELECT nodes.* FROM nodes)) EXCEPT (SELECT nodes.* FROM nodes JOIN nodes AS parent ON nodes."parentId" = parent.id AND parent.hidden IS NULL WHERE nodes.hidden IS NULL)',
			params: [],
		});
	});
	it('refuses a filtered CTE binding shadowing a table and allows a complete opt-out', () => {
		const build = (o: typeof orm) =>
			o.recursive('nodes', {
				base: o.select('nodes').withoutDefaultFilters(),
				step: o.select('nodes'),
			});
		expect(() => build(orm).dump()).toThrowError(
			new Error(
				"Default filter for table 'nodes' is not supported at CTE binding.from.",
			),
		);
		expect(dumped(build(orm.withoutDefaultFilters()))).toEqual({
			sql: 'WITH RECURSIVE "nodes" AS (SELECT nodes.* FROM nodes UNION ALL SELECT nodes.* FROM nodes) SELECT nodes.* FROM nodes',
			params: [],
		});
	});
});
