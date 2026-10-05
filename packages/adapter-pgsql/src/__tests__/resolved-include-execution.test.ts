import { createOrm, ref, schema } from '@dbsp/core';
import { RangeAllocator } from '@dbsp/types';
import { resolveDeclaredRelationPath } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	nodes: {
		id: { type: 'integer', primaryKey: true },
		parentId: ref('nodes', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const orm = createOrm({ model, adapter });
describe('resolved recursive include edges (#891)', () => {
	for (const direction of ['ancestors', 'descendants'] as const)
		it(`pins the seed and next ${direction} edges`, () => {
			const report = orm
				.select('nodes')
				.include(direction, { recursive: true, direction, omitSelf: true })
				.plan();
			const node = report.execution!.includes[0]!;
			const expected =
				direction === 'ancestors'
					? { fromColumn: 'parentId', toColumn: 'id' }
					: { fromColumn: 'id', toColumn: 'parentId' };
			const path = resolveDeclaredRelationPath(model, 'nodes', [direction]);
			expect(path.ok && path.hops[0]?.pairs).toEqual([expected]);
			expect(node.path.hops[0]?.pairs).toEqual([expected]);
			const sql = adapter.compile(report).sql;
			if (direction === 'ancestors') {
				expect(sql).toContain('__n.id = nodes."parentId"');
				expect(sql).toContain('ON __n.id = ancestors_walk."parentId"');
			} else {
				expect(sql).toContain('__n."parentId" = nodes.id');
				expect(sql).toContain('ON __n."parentId" = descendants_walk.id');
			}
		});
	it('indexes compiled payload authority by nodeId and hydrates without decisions', () => {
		const report = orm.select('nodes').include('parent').plan();
		const compiled = adapter.compile({ ...report, decisions: [] });
		expect(
			compiled.hydrationPlan?.includePayloadsByNodeId?.['include[0]'],
		).toEqual(compiled.hydrationPlan?.includePayloads?.[0]);
	});
});

// External execution must match re-planning; branded reports keep their authority.
describe('resolved include boundary authority', () => {
	it('refuses an external report-carried range alias', () => {
		const report = orm.select('nodes').include('parent').plan();
		const node = report.execution!.includes[0]!;
		const targetRange = { ...node.targetRange, alias: 'pinned_parent' };
		const execution = {
			...report.execution!,
			includes: [
				{
					...node,
					targetRange,
					outputRange: targetRange,
					hopRanges: [{ from: node.sourceRange, to: targetRange }],
				},
			],
		};
		expect(() =>
			adapter.compile({ ...report, execution, decisions: [] }),
		).toThrow(
			'External report execution differs at execution.includes[0].hopRanges[0].to.alias',
		);
	});
	it('keeps every include observation free of execution keys', () => {
		const report = orm
			.select('nodes')
			.include('parent', { join: 'left' })
			.plan();
		const observations = report.decisions.filter((decision) =>
			decision.context.intentPath?.startsWith('include['),
		);
		expect(
			observations.map((decision) => Object.keys(decision.context).sort()),
		).toEqual([
			['intentPath', 'nodeId'],
			['intentPath', 'nodeId'],
		]);
	});
	it('refuses a malformed external physical correlation', () => {
		const report = orm.select('nodes').include('parent').plan();
		const node = report.execution!.includes[0]!;
		expect(() =>
			adapter.compile({
				...report,
				execution: {
					...report.execution!,
					includes: [
						{
							...node,
							path: {
								...node.path,
								hops: [{ ...node.path.hops[0]!, pairs: [] }],
							},
						},
					],
				},
			}),
		).toThrow(
			'External report execution differs at execution.includes[0].path.hops[0].pairs[0]',
		);
	});
	it('reserves explicit names and assigns distinct identities across scopes', () => {
		const ranges = new RangeAllocator(['parent']);
		const root = ranges.allocate('nodes', 'nodes');
		ranges.reserve(root.alias);
		expect(ranges.allocate('nodes', 'parent').alias).toBe('parent_1');
		const left = ranges.allocate('nodes', '__t__', 'left');
		const right = ranges.allocate('nodes', '__t__', 'right');
		expect(left.alias).toBe(right.alias);
		expect(left.id).not.toBe(right.id);
	});
});
