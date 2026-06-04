/**
 * Regression tests: IN→EXISTS optimization must produce consistent plan/SQL output.
 *
 * Before issue #130 item 1 was fixed, the planner optimized WHERE IN (subquery) to EXISTS
 * in plan.decisions but left plan.intent.where as the original 'in' kind. The adapter's
 * extractExistsDecisions searched plan.intent.where for 'exists' intents, found 'in'
 * instead, and the match failed. The result was that the adapter emitted both
 * IN (SELECT ...) and EXISTS (SELECT ...) in SQL while plan.decisions claimed only EXISTS.
 *
 * This file pins the corrected behavior: for any query where the planner emits an
 * EXISTS filter-strategy decision, the compiled SQL must use EXISTS, not IN.
 */

import {
	inSubquery,
	not,
	POSTGRESQL_CAPABILITIES,
	plan,
	type QueryIntent,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: products --(hasMany productImages via productId FK)
// ---------------------------------------------------------------------------
const testSchema = schema({
	products: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	productImages: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products', {
			as: 'product',
			inverse: 'images',
		}),
		approved: 'boolean',
	},
});

// Schema for NOT IN tests (nullable vs non-nullable FK)
const schemaWithNullableFK = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', {
			as: 'author',
			inverse: 'posts',
			nullable: true,
		}),
		title: 'string',
	},
});

const schemaWithNonNullableFK = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
	posts_nn: {
		id: { type: 'integer', primaryKey: true },
		authorId: ref('users', {
			as: 'author',
			inverse: 'posts_nn',
			// nullable omitted → defaults to false (NOT NULL)
		}),
		title: 'string',
	},
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function compileIntent(
	intent: QueryIntent,
	model: ReturnType<typeof schema>['model'],
): { sql: string; params: readonly unknown[] } {
	const planReport = plan(intent, model, {
		dialectCapabilities: POSTGRESQL_CAPABILITIES,
	});
	const adapter = createPgsqlCompileOnlyAdapter();
	const result = adapter.compile(planReport, { model });
	return { sql: normalizeSQL(result.sql), params: result.parameters };
}

// ---------------------------------------------------------------------------
// Suite: positive IN → EXISTS (plan/SQL agreement)
// ---------------------------------------------------------------------------
describe('IN→EXISTS: plan and SQL both use EXISTS for optimizable IN subquery', () => {
	it('compiled SQL uses EXISTS, not IN, for hasMany IN-subquery', () => {
		// Regression gate (issue #130 item 1): before the fix, SQL contained
		// IN (SELECT ...) even though plan.decisions claimed EXISTS.
		const intent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'in',
				field: 'id',
				values: [],
				subquery: {
					type: 'select',
					from: 'productImages',
					select: { type: 'fields', fields: ['productId'] },
					where: {
						kind: 'comparison',
						field: 'approved',
						operator: 'eq',
						value: true,
					},
				},
			},
		};

		const planReport = plan(intent, testSchema.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan.decisions must claim EXISTS
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision?.choice).toBe('exists');

		// plan.intent.where must be exists (so adapter can match correctly)
		expect(planReport.intent.where?.kind).toBe('exists');

		// SQL must use EXISTS, not IN (...) — normalizeSQL lowercases, so match lowercase
		const { sql } = compileIntent(intent, testSchema.model);
		expect(sql).toContain('exists');
		expect(sql).not.toContain('in (select');
		// SQL must contain exactly one EXISTS clause (no duplication)
		const existsCount = (sql.match(/\bexists\b/g) ?? []).length;
		expect(existsCount).toBe(1);
	});

	it('SQL parameter is the approved=true value, not a duplicate', () => {
		// Regression gate: before the fix, the adapter emitted both IN and EXISTS
		// WHERE clauses, which would double-bind parameters. After the fix, only
		// the EXISTS path is compiled → one param binding for approved=true.
		const intent = inSubquery(
			'id',
			subquery('productImages').select('productId').where({
				kind: 'comparison',
				field: 'approved',
				operator: 'eq',
				value: true,
			}),
		);

		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: intent,
		};

		const { params } = compileIntent(queryIntent, testSchema.model);
		// Only one parameter for the approved=true condition
		expect(params).toHaveLength(1);
		expect(params[0]).toBe(true);
	});

	it('IN within AND conditions: SQL uses EXISTS for the IN branch', () => {
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'products',
			where: {
				kind: 'and',
				conditions: [
					{
						kind: 'comparison',
						field: 'name',
						operator: 'eq',
						value: 'Widget',
					},
					{
						kind: 'in',
						field: 'id',
						values: [],
						subquery: {
							type: 'select',
							from: 'productImages',
							select: { type: 'fields', fields: ['productId'] },
							where: {
								kind: 'comparison',
								field: 'approved',
								operator: 'eq',
								value: true,
							},
						},
					},
				],
			},
		};

		const { sql } = compileIntent(queryIntent, testSchema.model);
		// normalizeSQL lowercases output
		expect(sql).toContain('exists');
		expect(sql).not.toContain('in (select');
	});
});

// ---------------------------------------------------------------------------
// Suite: NOT IN → NOT EXISTS (non-nullable FK only)
// ---------------------------------------------------------------------------
describe('NOT IN→NOT EXISTS: SQL uses NOT EXISTS for non-nullable FK', () => {
	it('compiled SQL uses NOT EXISTS for NOT IN on non-nullable FK', () => {
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts_nn').select('authorId'))),
		};

		const planReport = plan(queryIntent, schemaWithNonNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan must claim a filter-strategy (notExists rewrite applied)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeDefined();

		// plan.intent.where must be notExists
		expect(planReport.intent.where?.kind).toBe('notExists');

		const { sql } = compileIntent(queryIntent, schemaWithNonNullableFK.model);
		// normalizeSQL lowercases output; PostgreSQL emits NOT EXISTS or NOT (EXISTS ...)
		expect(sql).toContain('exists');
		expect(sql).not.toContain('not in (select');
	});
});

// ---------------------------------------------------------------------------
// Suite: NOT IN preserved on nullable FK (three-valued-logic guard)
// ---------------------------------------------------------------------------
describe('NOT IN preserved: SQL keeps NOT IN when FK is nullable', () => {
	it('compiled SQL keeps NOT IN when nullable FK blocks NOT EXISTS rewrite', () => {
		// The nullable FK guard in optimizeInToExists must prevent rewriting
		// NOT IN → NOT EXISTS to avoid SQL three-valued-logic differences.
		const queryIntent: QueryIntent = {
			type: 'select',
			from: 'users',
			where: not(inSubquery('id', subquery('posts').select('authorId'))),
		};

		const planReport = plan(queryIntent, schemaWithNullableFK.model, {
			dialectCapabilities: POSTGRESQL_CAPABILITIES,
		});

		// plan must NOT have a filter-strategy (NOT IN preserved, not rewritten)
		const filterDecision = planReport.decisions.find(
			(d) => d.type === 'filter-strategy',
		);
		expect(filterDecision).toBeUndefined();

		// plan.intent must be unchanged (same object as input intent)
		expect(planReport.intent).toBe(queryIntent);

		// normalizeSQL lowercases output; optimization was blocked → no EXISTS in SQL
		const { sql } = compileIntent(queryIntent, schemaWithNullableFK.model);
		expect(sql).not.toContain('exists');
	});
});
