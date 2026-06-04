/**
 * DEFECT 2: propagateExistsConditions cross-wires relations that target the same table.
 *
 * When two relations (e.g. 'authoredPosts' and 'reviewedPosts') both target the same
 * table ('posts'), the old fallback `ed.targetTable === jd.targetTable` caused
 * `exists('authoredPosts', { where: A })` to propagate condition A into the
 * `include('reviewedPosts')` subquery — filtering the wrong relation.
 *
 * Fix: match ONLY by relationName when both decisions have one. Fall back to
 * targetTable only when neither has a relationName.
 */

import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// Schema with two FK relations from users → posts (different relation names, same target table)
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		authorId: ref('users', { as: 'authoredPosts', inverse: 'authoredPosts' }),
		reviewerId: ref('users', { as: 'reviewedPosts', inverse: 'reviewedPosts' }),
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter: adapter as any });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

describe('propagateExistsConditions: relation-identity match prevents cross-wiring', () => {
	it('exists(authoredPosts, where=published:true) does NOT contaminate include(reviewedPosts)', () => {
		const orm = buildOrm() as any;
		const dump = orm
			.select('users')
			.where(exists('authoredPosts', { where: eq('published', true) }))
			.include('reviewedPosts')
			.dump();
		const sql = ws(dump.sql);

		// The filter on authored posts must be in the top-level WHERE (EXISTS subquery)
		// but must NOT appear inside the reviewed-posts include subquery.
		expect(sql).toContain('EXISTS');

		// The filter (published=true) must appear exactly once — only in the EXISTS subquery,
		// NOT propagated into the reviewedPosts include subquery (cross-wire prevented).
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(trueCount).toBe(1);
	});

	it('exists(authoredPosts, where=published:true) + include(authoredPosts) DOES propagate correctly', () => {
		// The matching-relation case: same relation in both exists and include.
		// The filter condition SHOULD be propagated into the include subquery.
		const orm = buildOrm() as any;
		const dump = orm
			.select('users')
			.where(exists('authoredPosts', { where: eq('published', true) }))
			.include('authoredPosts')
			.dump();
		const sql = ws(dump.sql);

		// Both the EXISTS subquery and the include subquery should be filtered.
		// params must contain true at least twice: once for EXISTS, once for include.
		expect(sql).toContain('EXISTS');
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(trueCount).toBeGreaterThanOrEqual(2);
	});

	it('exists(reviewedPosts, where=published:false) does NOT contaminate include(authoredPosts)', () => {
		const orm = buildOrm() as any;
		const dump = orm
			.select('users')
			.where(exists('reviewedPosts', { where: eq('published', false) }))
			.include('authoredPosts')
			.dump();
		const sql = ws(dump.sql);

		expect(sql).toContain('EXISTS');

		// The published=false filter on reviewedPosts must NOT propagate to include(authoredPosts).
		const falseCount = (dump.params as unknown[]).filter(
			(p) => p === false,
		).length;
		expect(falseCount).toBe(1);
	});
});
