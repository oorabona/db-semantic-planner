import {
	and,
	createOrm,
	eq,
	exists,
	fn,
	outerRef,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { resolveSelectWhere } from '@dbsp/core/internal';
import { type PlanReport, RangeAllocator, type WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createCompilerState } from '../handlers/types.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { compileResolvedCondition } from '../resolved-condition-compiler.js';

const db = schema({
	users: { id: { type: 'integer', primaryKey: true } },
	category: { id: { type: 'integer', primaryKey: true } },
	posts: {
		id: { type: 'integer', primaryKey: true },
		userId: ref('users', { inverse: 'posts' }),
		categoryId: ref('category', { as: 'category' }),
	},
});
const adapter = createPgCompileOnlyAdapter({ model: db.model });
const orm = createOrm({ schema: db, adapter });
const hostile = ') = $1 OR true --';

describe('resolved WHERE alias reservation and operator guards', () => {
	it('reserves relation includes before resolving a correlated scalar body', () => {
		const result = orm
			.select('users')
			.where(
				exists('posts', {
					include: { category: { join: 'inner' } },
					where: fn(
						'abs',
						subquery('category')
							.select('id')
							.where(eq('id', outerRef('category.id')))
							.asExpr('x'),
					).gt(0),
				}),
			)
			.dump();
		expect(result.sql).toBe(
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 JOIN category AS category ON posts_exists_0."categoryId" = category.id WHERE users.id = posts_exists_0."userId" AND abs((SELECT category_sq.id FROM category AS category_sq WHERE category_sq.id = category.id)) > $1)',
		);
		expect(result.params).toEqual([0]);
	});

	it.each(['arithmetic', 'comparison', 'range'] as const)(
		'refuses hostile %s operators from a deserialized plain-column report',
		(family) => {
			const where = (family === 'range'
				? { kind: 'range', field: 'id', operator: hostile, value: 1 }
				: family === 'comparison'
					? { kind: 'comparison', field: 'id', operator: hostile, value: 1 }
					: {
							kind: 'expression',
							expr: {
								kind: 'arithmetic',
								operator: hostile,
								left: { kind: 'column', column: 'id' },
								right: { kind: 'literal', value: 1 },
							},
							operator: 'gt',
							value: 0,
						}) as unknown as WhereIntent;
			const report = JSON.parse(
				JSON.stringify({
					rootTable: 'users',
					decisions: [],
					warnings: [],
					ctes: [],
					intent: { type: 'select', from: 'users', where },
					metadata: {
						planningTimeMs: 0,
						relationsAnalyzed: 0,
						isAmbiguous: false,
					},
				}),
			) as PlanReport;
			const allocator = new RangeAllocator();
			const root = allocator.allocate('users', 'users');
			const resolved = resolveSelectWhere(
				and(eq('id', 7), where),
				root,
				[root],
				allocator,
				db.model,
			)!;
			const state = createCompilerState();
			expect(() =>
				compileResolvedCondition(
					resolved,
					{ rootTable: 'users', model: db.model, maxRecursiveDepth: 100 },
					state,
				),
			).toThrow(`Unsupported ${family} operator '${hostile}'`);
			expect(state.parameters).toEqual([]);
			expect(state.paramIndex).toBe(0);
			expect(() => adapter.compile(report)).toThrow(
				`Unsupported ${family} operator '${hostile}'`,
			);
		},
	);
});
