import {
	createOrm,
	eq,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import type { PlanReport, QueryIntent } from '@dbsp/types';
import { isPlannedReport } from '@dbsp/types/internal';
import { describe, expect, it, vi } from 'vitest';
import { createPgCompileOnlyAdapter } from './pgsql-adapter.js';

const model = schema({
	authors: { id: { type: 'integer', primaryKey: true }, title: 'text' },
	outsiders: { id: { type: 'integer', primaryKey: true }, title: 'text' },
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
	it('uses re-planned intent rather than external executable intent', () => {
		const report = external();
		Object.assign(report, {
			executableIntent: { type: 'select', from: 'authors' },
		});
		expect(adapter.compile(report).sql).toBe(adapter.compile(planned()).sql);
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
	it('freezes issued execution without freezing caller intent', () => {
		const report = planned();

		expect(() => {
			Object.assign(report.execution!.includes[0]!, { limit: 99 });
		}).toThrow(TypeError);
		expect(Object.isFrozen(report.intent.include![0])).toBe(false);
		expect(Object.isFrozen(report.planningInputs)).toBe(true);
	});
	it.each([
		Buffer.from([1, 2]),
		new Uint8Array([1, 2]),
		new (class Parameter {
			data = [1, 2];
		})(),
	])('plans and compiles opaque caller parameter %s', (value) => {
		const db = schema({
			rows: { id: { type: 'integer', primaryKey: true }, data: 'jsonb' },
		});
		const pg = createPgCompileOnlyAdapter({ model: db.model });
		const orm = createOrm({ schema: db, adapter: pg });
		const report = orm.select('rows').where(eq('data', value)).plan();
		expect(pg.compile(report).parameters).toEqual([value]);
		expect(Object.isFrozen(value)).toBe(false);
	});
	it('refuses forged property authority escaping the relation graph', () => {
		const report = external();
		Object.defineProperty(report, Symbol.for('@dbsp/types/plannedReport'), {
			value: true,
		});
		Object.assign(report.execution!.includes[0]!.targetRange, {
			table: 'outsiders',
		});
		expect(() => adapter.compile(report)).toThrow(
			/External report execution differs/,
		);
		expect(isPlannedReport(report)).toBe(false);
	});
	it('re-plans reports issued by a second package instance', async () => {
		vi.resetModules();
		const { markPlannedReport: markForeignReport } = await import(
			'@dbsp/types/internal'
		);
		const report = external();
		Object.assign(report.execution!.includes[0]!.targetRange, {
			table: 'outsiders',
		});
		const foreign = markForeignReport(report);
		expect(isPlannedReport(foreign)).toBe(false);
		expect(() => adapter.compile(foreign)).toThrow(
			/External report execution differs/,
		);
	});
	it('copies include structures without traversing or freezing caller parameter graphs', () => {
		let reads = 0;
		const value = {
			get opaque() {
				reads++;
				return 'opaque';
			},
			bytes: Buffer.from([1, 2]),
		};
		const input: QueryIntent = {
			type: 'select',
			from: 'posts',
			include: [
				{
					relation: 'author',
					strategy: 'flat',
					join: 'left',
					where: { kind: 'comparison', field: 'title', operator: 'eq', value },
				},
			],
		};
		const report = plan(input, model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});
		expect(reads).toBe(0);
		expect(adapter.compile(report).parameters).toContain(value);
		expect(Object.isFrozen(input.include![0])).toBe(false);
		expect(Object.isFrozen(input.include![0]!.where)).toBe(false);
		expect(Object.isFrozen(value)).toBe(false);
		expect(Object.isFrozen(value.bytes)).toBe(false);
		expect(
			Object.isFrozen(report.execution!.includes[0]!.predicate!.condition),
		).toBe(true);
	});
	it('refuses JSON and spread binding-final reports, including without execution', () => {
		const db = schema({ rows: { id: { type: 'integer', primaryKey: true } } });
		const pg = createPgCompileOnlyAdapter({ model: db.model });
		const { nql } = createOrm({ schema: db, adapter: pg });
		const report = nql`rows | select id | bind selected_rows
selected_rows | select id`.plan();
		const unmarked = { ...report };
		delete unmarked.bindingFinal;
		expect(createPgCompileOnlyAdapter().compile(report).sql).toContain(
			'selected_rows',
		);
		expect(() =>
			createPgCompileOnlyAdapter().compile(JSON.parse(JSON.stringify(report))),
		).toThrow(
			'Binding-final reports compile only in the process that planned them',
		);
		for (const external of [
			JSON.parse(JSON.stringify(report)),
			{ ...report },
			{ ...unmarked, execution: undefined },
			{ ...unmarked, intent: { type: 'select', from: 'rows' } },
		]) {
			expect(() => pg.compile(external)).toThrow(
				'Binding-final reports compile only in the process that planned them',
			);
		}
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
