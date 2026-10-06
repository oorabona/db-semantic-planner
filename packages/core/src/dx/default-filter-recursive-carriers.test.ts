import type { RecursivePlanReport } from '@dbsp/types';
import { expect, it, vi } from 'vitest';
import { eq } from './filters.js';
import { createRecursiveBuilder } from './recursive-query-builder.js';
import { ResultHydrator } from './result-hydrator.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

const db = schema(
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
function capturingAdapter() {
	const reports: RecursivePlanReport[] = [];
	const adapter = createMockAdapter();
	adapter.compileRecursive = vi
		.fn()
		.mockImplementation((report: RecursivePlanReport) => {
			reports.push(report);
			return { sql: '', parameters: [] };
		});
	adapter.execute = vi.fn().mockResolvedValue([]);
	return { adapter, reports };
}
it('carries standalone builder node filters and removes them on opt-out', () => {
	const { adapter, reports } = capturingAdapter();
	const builder = createRecursiveBuilder(db.model, adapter, 'walk', undefined, {
		defaultFilters: db.defaultFilters,
	})
		.from('nodes')
		.nodeId('id')
		.traverseVia('nodes', { parentId: 'parentId' })
		.maxDepth(3);
	builder.dump();
	expect(reports[0]?.recursiveFilters?.anchor).toBeDefined();
	expect(reports[0]?.recursiveFilters?.step).toBeDefined();
	builder.withoutDefaultFilters().dump();
	expect(reports[1]?.recursiveFilters).toBeUndefined();
});
it('carries node filters through legacy recursive include hydration', async () => {
	const { adapter, reports } = capturingAdapter();
	const hydrator = new ResultHydrator(db.model, 'nodes', undefined, {
		defaultFilters: db.defaultFilters,
	});
	await hydrator.processRecursiveIncludes(
		[{ id: 1, parentId: null }],
		[
			{
				relation: 'children',
				options: { recursive: true, direction: 'descendants', flat: true },
			},
		],
		adapter,
	);
	expect(reports[0]?.recursiveFilters?.anchor).toBeDefined();
	expect(reports[0]?.recursiveFilters?.step).toBeDefined();
});
