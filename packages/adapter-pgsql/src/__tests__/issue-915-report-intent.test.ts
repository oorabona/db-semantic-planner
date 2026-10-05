import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { IncludeIntent, PlanReport } from '@dbsp/types';
import { describe, expect, it, vi } from 'vitest';
import * as compiler from '../compiler.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { asLegacyReport } from './legacy-include-report.js';

const model = schema({
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
		editorId: ref('users', { as: 'editor' }),
		tenantId: 'integer',
	},
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		tenantId: 'integer',
	},
}).model;
const adapter = createPgCompileOnlyAdapter({ model });
function report(
	include: IncludeIntent,
	from = 'posts',
	defaultIncludeStrategy: 'json_agg' | 'lateral' = 'json_agg',
) {
	return asLegacyReport(
		plan({ type: 'select', from, include: [include] }, model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
			defaultIncludeStrategy,
		}),
	);
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

describe('#915 declared keys and path coverage', () => {
	it('synthesizes the uncovered root when only same.same is covered', () => {
		const repeated = schema({
			a: {
				id: { type: 'integer', primaryKey: true },
				sameId: ref('b', { as: 'same' }),
			},
			b: {
				id: { type: 'integer', primaryKey: true },
				sameId: ref('c', { as: 'same' }),
			},
			c: { id: { type: 'integer', primaryKey: true } },
		}).model;
		const original = asLegacyReport(
			plan(
				{
					type: 'select',
					from: 'a',
					include: [
						{
							relation: 'same',
							join: 'left',
							include: [{ relation: 'same', join: 'left' }],
						},
					],
				},
				repeated,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		);
		const partial = {
			...original,
			decisions: original.decisions.filter(
				(d) => d.context.intentPath !== 'include[0]',
			),
		};
		const local = createPgCompileOnlyAdapter({ model: repeated });
		expect(local.compile(partial).sql).toBe(local.compile(original).sql);
		expect(local.compile(partial).sql).toBe(
			'SELECT a.*, same.id AS "same.id", same."sameId" AS "same.sameId", same.id AS __dbsp_presence_same, same_1.id AS "same.same.id", same_1.id AS "__dbsp_presence_same.same" FROM a LEFT JOIN b AS same ON a."sameId" = same.id LEFT JOIN c AS same_1 ON same."sameId" = same_1.id',
		);
		const ambiguous = {
			...partial,
			decisions: partial.decisions.map((d) => {
				if (d.type !== 'include-strategy') return d;
				const context = { ...d.context };
				delete context.intentPath;
				return { ...d, context };
			}),
		};
		expect(() => local.compile(ambiguous)).toThrowError(
			new Error(
				"Ambiguous include relation 'same': context.intentPath is required for unique strategy assignment (#894).",
			),
		);
	});
	it('refuses foreignKey and parentKey overrides and fills omitted keys', () => {
		const original = report({ relation: 'author', join: 'left' });
		for (const field of ['foreignKey', 'parentKey'] as const) {
			const external = {
				...original,
				decisions: original.decisions.map((d) =>
					d.type === 'include-strategy'
						? { ...d, context: { ...d.context, [field]: 'tenantId' } }
						: d,
				),
			};
			expect(() => adapter.compile(external)).toThrowError(
				new Error(
					'Include include[0](author) decision does not match its intent',
				),
			);
		}
		const omitted = {
			...original,
			decisions: original.decisions.map((d) => {
				if (d.type !== 'include-strategy') return d;
				const context = { ...d.context };
				delete context.foreignKey;
				delete context.parentKey;
				return { ...d, context };
			}),
		};
		expect(adapter.compile(omitted).sql).toBe(adapter.compile(original).sql);
		expect(adapter.compile(omitted).sql).toBe(
			'SELECT posts.*, author.id AS "author.id", author.name AS "author.name", author."tenantId" AS "author.tenantId", author.id AS __dbsp_presence_author FROM posts LEFT JOIN users AS author ON posts."authorId" = author.id',
		);
	});
	it('refuses ordering before compiler dispatch for json_agg and lateral', () => {
		const spy = vi.spyOn(compiler, 'compilePlan');
		try {
			for (const strategy of ['json_agg', 'lateral'] as const) {
				const original = report(
					{ relation: 'author', limit: 1 },
					'posts',
					strategy,
				);
				for (const [orderBy, message] of [
					[
						[{ field: 'name', direction: 'wrong' }],
						'Include author orderBy requires fields, asc/desc direction and first/last nulls',
					],
					[
						[{ field: 'missing', direction: 'asc' }],
						'Include author orderBy field "missing" is not a column of target table "users"',
					],
				] as const) {
					const external = edited(original, [
						{
							relation: 'author',
							limit: 1,
							orderBy,
						} as unknown as IncludeIntent,
					]);
					expect(() => adapter.compile(external)).toThrowError(
						new Error(message),
					);
				}
			}
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
