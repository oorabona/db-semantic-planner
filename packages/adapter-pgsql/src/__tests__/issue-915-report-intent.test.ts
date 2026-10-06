import * as compiler from '@dbsp/adapter-pgsql/internal';
import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { PlanReport } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		editorId: ref('users', { as: 'editor' }),
	},
	users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const refusal = 'Includes compile only from a report planned in this process';
function issued() {
	return plan(
		{
			type: 'select',
			from: 'posts',
			include: [{ relation: 'author', join: 'left' }],
		},
		model,
	);
}

describe('#915 external include reports are refused before lowering', () => {
	it.each([
		'relation',
		'join type',
		'flat output',
		'removed include',
		'duplicate decision',
		'source',
		'target',
		'relation type',
		'foreign key',
		'parent key',
		'omitted keys',
		'pathless decision',
		'partial path coverage',
		'ordering',
	])('refuses an external report with changed %s', (change) => {
		const report = JSON.parse(JSON.stringify(issued())) as PlanReport;
		const include = report.intent.include![0]!;
		const decision = report.decisions.find(
			(d) => d.type === 'include-strategy',
		)!;
		if (change === 'relation') Object.assign(include, { relation: 'editor' });
		if (change === 'join type') Object.assign(include, { join: 'inner' });
		if (change === 'flat output') Object.assign(include, { strategy: 'flat' });
		if (change === 'removed include')
			Object.assign(report.intent, { include: [] });
		if (change === 'duplicate decision')
			Object.assign(report, { decisions: [...report.decisions, decision] });
		if (change === 'partial path coverage')
			Object.assign(report, { decisions: [] });
		const fields: Record<string, string> = {
			source: 'sourceTable',
			target: 'target',
			'relation type': 'relationType',
			'foreign key': 'foreignKey',
			'parent key': 'parentKey',
		};
		if (fields[change])
			Object.assign(decision.context, { [fields[change]!]: 'wrong' });
		if (change === 'omitted keys')
			Object.assign(decision.context, {
				foreignKey: undefined,
				parentKey: undefined,
			});
		if (change === 'pathless decision')
			Object.assign(decision.context, { intentPath: undefined });
		if (change === 'ordering')
			Object.assign(include, {
				orderBy: [{ field: 'missing', direction: 'wrong' }],
			});
		const spy = vi.spyOn(compiler, 'compilePlan');
		try {
			expect(() => adapter.compile(report)).toThrow(new Error(refusal));
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
for (const strategy of ['json_agg', 'lateral'] as const) {
	it(`plans removed ordering afresh for ${strategy}`, () => {
		const report = plan(
			{
				type: 'select',
				from: 'posts',
				include: [{ relation: 'author', limit: 2 }],
			},
			model,
			{
				defaultIncludeStrategy: strategy,
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			},
		);
		expect(adapter.compile(report).sql).toContain('id ASC');
		expect(adapter.compile(report).sql).not.toContain('name DESC');
	});
}
