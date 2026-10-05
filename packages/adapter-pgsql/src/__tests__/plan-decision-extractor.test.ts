/** Include extraction was removed; execution node behavior is pinned end to end in include-matrix.test.ts. */

import { createOrm, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { lowerResolvedIncludes } from '../resolved-include-decisions.js';

describe('resolved include lowering', () => {
	it('reads execution without decision context or raw includes', () => {
		const model = schema({
			roots: { id: { type: 'integer', primaryKey: true } },
			children: {
				id: { type: 'integer', primaryKey: true },
				rootId: ref('roots', { inverse: 'children' }),
			},
		}).model;
		const report = createOrm({
			model,
			adapter: createPgCompileOnlyAdapter({ model }),
		})
			.select('roots')
			.include('children')
			.plan();
		const decisions = lowerResolvedIncludes(report.execution!, 'id');
		expect(decisions[0]?.sourceColumn).toEqual(['id']);
		expect(decisions[0]?.targetColumn).toEqual(['rootId']);
		expect(
			report.decisions.find((d) => d.type === 'include-strategy')?.context,
		).toEqual({ intentPath: 'include[0]', nodeId: 'include[0]' });
	});
});
