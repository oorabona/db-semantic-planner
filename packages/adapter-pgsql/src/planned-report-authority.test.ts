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
import { describe, expect, it } from 'vitest';
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
	it('freezes issued execution without freezing caller intent', () => {
		const report = planned();

		expect(() => {
			Object.assign(report.execution!.includes[0]!, { limit: 99 });
		}).toThrow(TypeError);
		expect(Object.isFrozen(report.intent.include![0])).toBe(false);
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
});

const refusal =
	'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation';
describe('external include reports lose registry authority', () => {
	it.each([
		'serialized',
		'spread',
		'hand-built',
		'legacy',
		'execution-only',
		'decision-only',
	] as const)('refuses %s reports by name', (kind) => {
		const issued = planned();
		const report = { ...(kind === 'spread' ? issued : external()) };
		if (kind === 'legacy' || kind === 'hand-built') delete report.execution;
		if (kind === 'hand-built') Object.assign(report, { decisions: [] });
		if (kind === 'execution-only' || kind === 'decision-only')
			Object.assign(report, { intent: { type: 'select', from: 'posts' } });
		if (kind === 'decision-only') delete report.execution;
		expect(isPlannedReport(report)).toBe(false);
		expect(() => adapter.compile(report)).toThrow(new Error(refusal));
		expect(() => createPgCompileOnlyAdapter().compile(report)).toThrow(
			new Error(refusal),
		);
	});
	it('refuses report-shaped input carrying an NQL query field before lowering', () => {
		const report = { ...external(), query: { type: 'select', from: 'posts' } };
		Reflect.deleteProperty(report, 'intent');
		expect(() => adapter.compile(report)).toThrow(refusal);
	});
	it('compiles the issued report and refuses a forged symbol', () => {
		expect(adapter.compile(planned()).sql).toContain('posts');
		const report = external();
		Object.defineProperty(report, Symbol.for('@dbsp/types/plannedReport'), {
			value: true,
		});
		expect(() => adapter.compile(report)).toThrow(new Error(refusal));
	});
	it('refuses external reports without includes', () => {
		const report = plan({ type: 'select', from: 'posts' }, model);
		expect(() => adapter.compile({ ...report })).toThrow(refusal);
		const legacy = { ...report };
		delete legacy.execution;
		expect(() => adapter.compile(legacy)).toThrow(refusal);
	});
});
