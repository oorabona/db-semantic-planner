import { createOrm, ref, schema } from '@dbsp/core';
import type { IncludeStrategy, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { asExternalReport } from './external-include-report.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	categories: {
		id: { type: 'integer', primaryKey: true },
		parentId: ref('categories', {
			roles: { parent: 'parent', children: 'children' },
		}),
	},
} as const);
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
// Stale values cross the runtime API boundary despite the removed type member.
const removed = 'subquery' as unknown as IncludeStrategy;
const resolvedError =
	"Strategy 'subquery' is not supported by postgresql. Supported strategies: 'join', 'json_agg', 'lateral', 'cte'.";

const error = resolvedError.replace("'cte'.", "'cte', 'auto'.");

describe('#894 removed include strategy refusal', () => {
	it('refuses defaultIncludeStrategy at the public boundary', () => {
		expect(() =>
			orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: removed })
				.include('posts')
				.dump(),
		).toThrow(
			"Unknown strategy 'subquery'. Valid strategies: 'join', 'json_agg', 'lateral', 'cte', 'auto'.",
		);
	});
	it('refuses per-include strategy at the public boundary', () => {
		const options = { strategy: removed } as unknown as Parameters<
			ReturnType<typeof orm.select<'users'>>['include']
		>[1];
		expect(() => orm.select('users').include('posts', options).dump()).toThrow(
			error,
		);
	});
	it('refuses an adapter include-strategy decision before SQL lowering', () => {
		const p = asExternalReport(orm.select('users').include('posts').plan());
		const stale = {
			...p,
			decisions: p.decisions.map((d) =>
				d.type === 'include-strategy' ? { ...d, choice: removed } : d,
			),
		} as PlanReport;
		expect(() => adapter.compile(stale)).toThrow(
			new Error(
				'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
	for (const missing of [false, true]) {
		it(`refuses recursive include with ${missing ? 'no capabilities' : 'no recursive CTE support'}`, () => {
			const localAdapter = Object.create(adapter);
			Object.defineProperty(localAdapter, 'dialectCapabilities', {
				value: missing
					? undefined
					: {
							...adapter.dialectCapabilities,
							name: 'NoRecursive',
							supportsRecursiveCTE: false,
						},
			});
			const localOrm = createOrm({ schema: db, adapter: localAdapter });
			expect(() =>
				localOrm
					.select('categories')
					.include('children', { recursive: true, direction: 'descendants' })
					.dump(),
			).toThrow(
				`Recursive include at include[0](children) requires a dialect with supportsRecursiveCTE; current dialect (${missing ? 'no capabilities' : 'NoRecursive'}) does not support it.`,
			);
		});
	}
});

describe('#900 recursive strategy contract', () => {
	it('ignores the non-recursive default for recursion and lists no alternatives', () => {
		const dump = orm
			.select('categories')
			.withPlanOptions({ defaultIncludeStrategy: 'join' })
			.include('children', { recursive: true, direction: 'descendants' })
			.dump();
		const decision = dump.plan?.decisions.find(
			(d) => d.type === 'include-strategy',
		);
		expect(decision?.choice).toBe('cte');
		expect(decision?.alternatives).toEqual([]);
	});
	for (const hint of ['join', 'json_agg', 'lateral'] as const) {
		it(`refuses recursive relation hint ${hint}`, () => {
			const model: typeof db.model = Object.assign(
				Object.create(Object.getPrototypeOf(db.model)),
				{
					...db.model,
					relations: new Map(
						[...db.model.relations].map(([key, r]) => [
							key,
							r.name === 'children' ? { ...r, includeStrategy: hint } : r,
						]),
					),
				},
			);
			const localAdapter = createPgCompileOnlyAdapter({ model });
			const localOrm = createOrm({
				schema: { ...db, model },
				adapter: localAdapter,
			});
			expect(() =>
				localOrm
					.select('categories')
					.include('children', { recursive: true, direction: 'descendants' })
					.dump(),
			).toThrow(
				`Recursive include at include[0](children) requires strategy 'cte', but relation 'children' declares includeStrategy '${hint}'. Use 'auto' or 'cte'.`,
			);
		});
	}
	it('accepts auto as a planner input', () => {
		expect(
			orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: 'auto' })
				.include('posts')
				.dump()
				.plan?.decisions.find((d) => d.type === 'include-strategy')?.choice,
		).toBe('json_agg');
	});
	it('refuses auto as an adapter decision and lists only resolved strategies', () => {
		const p = asExternalReport(
			orm.select('users').include('posts').dump().plan!,
		);
		const unresolved = {
			...p,
			decisions: p.decisions.map((d) =>
				d.type === 'include-strategy' ? { ...d, choice: 'auto' } : d,
			),
		} as PlanReport;
		expect(() => adapter.compile(unresolved)).toThrow(
			new Error(
				'Adapter compilation requires a report planned in this process; plan the query in this process, or use compilePlan from @dbsp/adapter-pgsql/internal for decision-level compilation',
			),
		);
	});
});
