import { createOrm, ref, schema } from '@dbsp/core';
import type { IncludeStrategy, PlanReport } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

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
const error =
	"Strategy 'subquery' is not supported by postgresql. Supported strategies: 'join', 'json_agg', 'lateral', 'cte'.";

describe('#894 removed include strategy refusal', () => {
	it('refuses defaultIncludeStrategy at the public boundary', () => {
		expect(() =>
			orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: removed })
				.include('posts')
				.dump(),
		).toThrow(error);
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
		const p = orm.select('users').include('posts').plan();
		const stale = {
			...p,
			decisions: p.decisions.map((d) =>
				d.type === 'include-strategy' ? { ...d, choice: removed } : d,
			),
		} as PlanReport;
		expect(() => adapter.compile(stale)).toThrow(error);
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
