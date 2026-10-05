import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { PlanReport, QueryIntent } from '@dbsp/types';
import { isPlannedReport } from '@dbsp/types/internal';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from './pgsql-adapter.js';

const model = schema({
	authors: { id: { type: 'integer', primaryKey: true }, title: 'text' },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('authors', { as: 'author', inverse: 'posts' }),
		editorId: ref('authors', { as: 'editor', inverse: 'edited' }),
	},
}).model;
const intent: QueryIntent = {
	type: 'select',
	from: 'posts',
	include: [
		{
			relation: 'author',
			strategy: 'auto',
			limit: 1,
			select: { type: 'fields', fields: ['title'] },
		},
		{ relation: 'editor', strategy: 'flat' },
	],
};
const adapter = createPgCompileOnlyAdapter({ model });
function planned() {
	return plan(structuredClone(intent), model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
}
function external() {
	return JSON.parse(JSON.stringify(planned())) as PlanReport;
}
describe('planned report compilation authority', () => {
	it('round-trips JSON and spread with identical SQL', () => {
		const report = planned();
		expect(isPlannedReport(report)).toBe(true);
		expect(isPlannedReport({ ...report })).toBe(false);
		const original = adapter.compile(report);
		expect(adapter.compile(JSON.parse(JSON.stringify(report))).sql).toBe(
			original.sql,
		);
		expect(adapter.compile({ ...report }).sql).toBe(original.sql);
	});
	it('retains planning options and re-plans recorded reports without execution', () => {
		const report = plan(
			{
				type: 'select',
				from: 'posts',
				include: [{ relation: 'author', strategy: 'flat' }],
			},
			model,
			{
				defaultIncludeStrategy: 'join',
				forceJoinType: 'inner',
				disambiguate: { 'posts.authors': 'author' },
				dialectCapabilities: POSTGRESQL_CAPABILITIES,
			},
		);
		expect(report.planningInputs).toMatchObject({
			defaultIncludeStrategy: 'join',
			forceJoinType: 'inner',
			enableCTEs: true,
			cteThreshold: 2,
			maxIncludeDepth: 5,
		});
		const wire = JSON.parse(JSON.stringify(report)) as PlanReport;
		expect(adapter.compile(wire).sql).toBe(adapter.compile(report).sql);
		const withoutExecution = { ...wire };
		delete withoutExecution.execution;
		expect(adapter.compile(withoutExecution).sql).toBe(
			adapter.compile(report).sql,
		);
	});
	it('freezes branded execution and intent deeply', () => {
		const report = planned();

		expect(() => {
			Object.assign(report.execution!.includes[0]!, { limit: 99 });
		}).toThrow(TypeError);
		expect(Object.isFrozen(report.intent.include![0])).toBe(true);
	});
	it('refuses execution options overriding intent', () => {
		const report = external();
		Object.assign(report.execution!.includes[0]!, {
			limit: 99,
			projection: undefined,
		});
		expect(() => adapter.compile(report)).toThrow(
			new Error(
				'External report execution differs at execution.includes[0].projection',
			),
		);
	});
	it('refuses two join ranges aliased author', () => {
		const report = JSON.parse(
			JSON.stringify(
				plan(
					{
						type: 'select',
						from: 'posts',
						include: [
							{ relation: 'author', strategy: 'flat' },
							{ relation: 'editor', strategy: 'flat' },
						],
					},
					model,
					{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
				),
			),
		) as PlanReport;
		expect(report.execution!.includes[0]!.targetRange.alias).toBe('author');
		Object.assign(report.execution!.includes[1]!.targetRange, {
			alias: 'author',
		});
		expect(() => adapter.compile(report)).toThrow(
			new Error(
				'External report execution differs at execution.includes[1].targetRange.alias',
			),
		);
	});
	it('refuses an extra include[99] node', () => {
		const report = external();
		(report.execution!.includes as unknown[]).push({
			...report.execution!.includes[0],
			nodeId: 'include[99]',
			intentPath: 'include[99]',
		});
		expect(() => adapter.compile(report)).toThrow(
			new Error('External report execution differs at execution.includes[2]'),
		);
	});
	it('refuses a sparse extra execution slot', () => {
		const report = external();
		(report.execution!.includes as unknown[]).length++;
		expect(() => adapter.compile(report)).toThrow(
			new Error(
				'External report execution differs at execution.includes.length',
			),
		);
	});
	it('refuses an external include report without a model', () => {
		expect(() => createPgCompileOnlyAdapter().compile(external())).toThrow(
			new Error('External report with includes requires a model'),
		);
	});
});
