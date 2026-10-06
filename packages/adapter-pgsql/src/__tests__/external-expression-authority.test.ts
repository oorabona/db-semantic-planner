import { exists, plan, ref, schema } from '@dbsp/core';
import type { ExpressionIntent, PlanReport } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const model = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
const refusal =
	'Adapter compilation requires a report planned by this loaded copy of dbsp (plan(), the ORM or NQL); plan the query with this loaded copy, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation';
function external(): { -readonly [K in keyof PlanReport]: PlanReport[K] } {
	return JSON.parse(
		JSON.stringify(plan({ type: 'select', from: 'users' }, model)),
	);
}

describe('external expression authority', () => {
	for (const slot of ['intent', 'executableIntent'] as const) {
		it.each<ExpressionIntent>([
			{
				kind: 'case',
				when: [
					{ condition: exists('posts'), result: { kind: 'literal', value: 1 } },
				],
				else: { kind: 'literal', value: 0 },
			},
			{
				kind: 'customFn',
				name: 'count',
				args: [{ kind: 'ref', column: 'id' }],
				filter: exists('posts'),
			},
			{
				kind: 'subquery',
				query: {
					type: 'select',
					from: 'posts',
					select: { type: 'fields', fields: ['id'] },
				},
			},
		])(`refuses ${slot} ORDER BY $kind after JSON round trip`, (expression) => {
			const report = external();
			report[slot] = {
				...report.intent!,
				orderBy: [{ expression, direction: 'asc' }],
			};
			expect(() => adapter.compile(JSON.parse(JSON.stringify(report)))).toThrow(
				refusal,
			);
		});
		it(`plans plain ${slot} ORDER BY`, () => {
			const report = external();
			report[slot] = {
				...report.intent!,
				orderBy: [{ field: 'id', direction: 'asc' }],
			};
			expect(adapter.compile(plan(report[slot]!, model)).sql).toBe(
				'SELECT users.* FROM users ORDER BY users.id ASC',
			);
		});
	}
	it.each(['object', 'cyclic'] as const)(
		'binds an opaque %s LAG default',
		(shape) => {
			const payload: {
				field: string;
				self?: unknown;
				toPostgres?: () => string;
			} = { field: 'a.b' };
			if (shape === 'cyclic') {
				payload.self = payload;
				payload.toPostgres = () => 'fallback';
			}
			const report = external();
			report.intent = {
				...report.intent!,
				select: {
					type: 'expressions',
					columns: [
						{
							kind: 'window',
							function: 'lag',
							field: 'id',
							alias: 'previous',
							offset: 1,
							defaultValue: payload,
							over: { orderBy: [{ field: 'id', direction: 'asc' }] },
						},
					],
				},
			};
			const issued = plan(report.intent!, model);
			if (shape === 'cyclic') {
				expect(() => adapter.compile(issued)).toThrow(
					'stableJson cannot serialize cyclic structures',
				);
				return;
			}
			const compiled = adapter.compile(issued);
			expect(compiled.sql).toBe(
				'SELECT lag(users.id, $1, $2) OVER (ORDER BY users.id ASC) AS previous FROM users',
			);
			expect(compiled.parameters).toEqual([1, payload]);
			expect(compiled.parameters[1]).toBe(payload);
		},
	);
	it('preserves main refusal of cyclic non-payload projection metadata', () => {
		const expression = {
			kind: 'ref' as const,
			column: 'id',
			self: {} as unknown,
		};
		expression.self = expression;
		const report = external();
		report.intent = {
			...report.intent!,
			select: { type: 'expressions', columns: [expression] },
		};
		expect(() => adapter.compile(plan(report.intent!, model))).toThrow(
			'stableJson cannot serialize cyclic structures',
		);
	});
});

describe('loaded-copy report authority', () => {
	it('compiles its own issued reports and refuses reports from another module instance', async () => {
		const firstCore = await import('@dbsp/core');
		const firstTypes = await import('@dbsp/types/internal');
		const firstAdapter = await import('../pgsql-adapter.js');
		const firstModel = firstCore.schema({
			rows: { id: { type: 'integer', primaryKey: true } },
		}).model;
		const firstReport = firstCore.plan(
			{ type: 'select', from: 'rows' },
			firstModel,
		);
		const first = firstAdapter.createPgCompileOnlyAdapter({
			model: firstModel,
		});
		vi.resetModules();
		const secondCore = await import('@dbsp/core');
		const secondTypes = await import('@dbsp/types/internal');
		const secondAdapter = await import('../pgsql-adapter.js');
		const secondModel = secondCore.schema({
			rows: { id: { type: 'integer', primaryKey: true } },
		}).model;
		const secondReport = secondCore.plan(
			{ type: 'select', from: 'rows' },
			secondModel,
		);
		const second = secondAdapter.createPgCompileOnlyAdapter({
			model: secondModel,
		});
		expect(firstTypes.isPlannedReport(firstReport)).toBe(true);
		expect(secondTypes.isPlannedReport(secondReport)).toBe(true);
		expect(firstTypes.isPlannedReport(secondReport)).toBe(false);
		expect(secondTypes.isPlannedReport(firstReport)).toBe(false);
		expect(first.compile(firstReport).sql).toBe('SELECT rows.* FROM rows');
		expect(second.compile(secondReport).sql).toBe('SELECT rows.* FROM rows');
		expect(() => second.compile(firstReport)).toThrow(refusal);
		expect(() => first.compile(secondReport)).toThrow(refusal);
	});
});
