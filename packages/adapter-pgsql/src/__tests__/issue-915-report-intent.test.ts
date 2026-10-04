import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { IncludeIntent, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
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
function report(
	include: IncludeIntent,
	from = 'posts',
	defaultIncludeStrategy: 'json_agg' | 'lateral' = 'json_agg',
) {
	return plan({ type: 'select', from, include: [include] }, model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
		defaultIncludeStrategy,
	});
}
function edited(
	original: PlanReport,
	include: readonly IncludeIntent[],
): PlanReport {
	return { ...original, intent: { ...original.intent!, include } };
}

describe('#915 external include decisions match intent', () => {
	for (const [name, include] of [
		['relation', { relation: 'editor', join: 'left' }],
		['join type', { relation: 'author', join: 'inner' }],
	] as const) {
		it(`refuses stale ${name} by include path`, () => {
			expect(() =>
				adapter.compile(
					edited(report({ relation: 'author', join: 'left' }), [include]),
				),
			).toThrowError(
				new Error(
					`Include include[0](${include.relation}) decision does not match its intent`,
				),
			);
		});
	}
	it('refuses stale nested output for flat intent', () => {
		expect(() =>
			adapter.compile(
				edited(report({ relation: 'author' }), [
					{ relation: 'author', strategy: 'flat' },
				]),
			),
		).toThrowError(
			new Error(
				'Include include[0](author) decision does not match its intent',
			),
		);
	});
	it('refuses a removed include decision', () => {
		expect(() =>
			adapter.compile(edited(report({ relation: 'author', join: 'left' }), [])),
		).toThrowError(
			new Error('Include include[0] has no matching intent include'),
		);
	});
	it('refuses duplicate decision paths', () => {
		const original = report({ relation: 'author', join: 'left' });
		const decision = original.decisions.find(
			(d) => d.type === 'include-strategy',
		)!;
		expect(() =>
			adapter.compile({
				...original,
				decisions: [...original.decisions, decision],
			}),
		).toThrowError(
			new Error('Include include[0] has duplicate include-strategy decisions'),
		);
	});
	it('refuses mismatched source, target, and relation type', () => {
		for (const field of ['sourceTable', 'target', 'relationType'] as const) {
			const original = report({ relation: 'author', join: 'left' });
			const external = {
				...original,
				decisions: original.decisions.map((d) =>
					d.type === 'include-strategy'
						? { ...d, context: { ...d.context, [field]: 'wrong' } }
						: d,
				),
			} as PlanReport;
			expect(() => adapter.compile(external)).toThrowError(
				new Error(
					'Include include[0](author) decision does not match its intent',
				),
			);
		}
	});
	it('removed orderBy stays absent for json_agg and lateral', () => {
		for (const strategy of ['json_agg', 'lateral'] as const) {
			const include: IncludeIntent = {
				relation: 'author',
				limit: 2,
				orderBy: [{ field: 'name', direction: 'desc' }],
			};
			const original = report(include, 'posts', strategy);
			const withoutOrder = { ...include };
			delete withoutOrder.orderBy;
			const sql = adapter.compile(edited(original, [withoutOrder])).sql;
			expect(sql).toBe(
				adapter.compile(report(withoutOrder, 'posts', strategy)).sql,
			);
			expect(sql).not.toContain('name DESC');
			expect(sql).toContain('id ASC');
		}
	});
	it('removed nested orderBy stays absent', () => {
		const child: IncludeIntent = {
			relation: 'author',
			orderBy: [{ field: 'name', direction: 'desc' }],
		};
		const include: IncludeIntent = {
			relation: 'posts',
			include: [child],
		};
		const original = report(include, 'users');
		const withoutOrder: IncludeIntent = {
			...include,
			include: [{ relation: 'author' }],
		};
		expect(adapter.compile(edited(original, [withoutOrder])).sql).toBe(
			adapter.compile(report(withoutOrder, 'users')).sql,
		);
	});
});
