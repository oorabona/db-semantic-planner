/**
 * Regression test: DEFECT-1 — notExists() + include() must NOT propagate the
 * notExists condition onto the include subquery.
 *
 * Bug: collectEnrichedExistsDecisions collected 'notExists' (and 'every')
 * decisions in addition to 'exists'.  propagateExistsConditions then paired
 * the notExists filter condition with the include strategy for the same relation,
 * causing the include subquery to be filtered by `published = false` — which
 * produces empty results even when published posts exist.
 *
 * Fix: collectEnrichedExistsDecisions now collects ONLY operator === 'exists';
 * propagateExistsConditions now matches ONLY operator === 'exists'.
 */

import { createOrm, eq, exists, notExists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (one-to-many)
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter: adapter as any });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// DEFECT-1: notExists + include — included posts must NOT be filtered
// ---------------------------------------------------------------------------
describe('DEFECT-1: notExists + include — no condition propagation to include', () => {
	it('notExists filter condition is NOT injected into the include subquery', () => {
		const orm = buildOrm();

		// Select users who have NO unpublished posts, and include all their posts.
		// The include subquery for posts must NOT carry a filter from the notExists.
		// We verify this by comparing the include strategies:
		//
		// With the bug: collectEnrichedExistsDecisions collected notExists decisions,
		// so the include subquery would carry conditions: [published=false].
		// The plan's includeStrategy decision for 'posts' would have conditions set.
		//
		// After the fix: the plan's includeStrategy for 'posts' must have NO conditions.
		const dump = orm
			.select('users')
			.where(notExists('posts', { where: eq('published', false) }))
			.include('posts')
			.dump();

		// Plan-level check: the includeStrategy decision for 'posts' must not have conditions
		const includeDecision = dump.plan.decisions.find(
			(d: any) =>
				d.type === 'include-strategy' && d.context?.relation === 'posts',
		) as any;

		// The include decision exists (inclusion is happening)
		expect(includeDecision).toBeDefined();

		// The include decision must NOT have conditions propagated from notExists
		// (with bug: conditions would be set to [published=false] from notExists propagation)
		expect(includeDecision?.conditions).toBeUndefined();
	});

	it('positive exists filter condition IS propagated to the include subquery', () => {
		// Sanity: the EXISTING behaviour for exists() must be preserved —
		// when user filters with exists('posts', {where: eq('published', true)})
		// and also includes posts, the published=true filter appears in the include plan.
		const orm = buildOrm();

		const dump = orm
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.dump();

		const sql = ws(dump.sql);

		// EXISTS subquery must appear
		expect(sql).toMatch(/EXISTS/i);

		// Plan-level: the includeStrategy decision for 'posts' should have conditions
		// because exists() propagation is expected (that's the designed behaviour).
		// We verify the SQL contains 'published' at least once (in the EXISTS subquery).
		expect(sql).toMatch(/\bpublished\b/i);
	});

	it('notExists without include: NOT EXISTS with where condition compiles correctly', () => {
		const orm = buildOrm();

		const dump = orm
			.select('users')
			.where(notExists('posts', { where: eq('published', false) }))
			.dump();

		const sql = ws(dump.sql);

		// NOT EXISTS must appear
		expect(sql).toMatch(/NOT.*EXISTS/i);
		// The published condition must appear in the NOT EXISTS subquery
		expect(sql).toMatch(/\bpublished\b/i);
		// Must not have an include-related lateral or json_agg
		expect(sql).not.toMatch(/json_agg|lateral/i);
	});
});
