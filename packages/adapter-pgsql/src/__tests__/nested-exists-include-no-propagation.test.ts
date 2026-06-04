/**
 * Regression tests for cross-source include-filter propagation with nested exists.
 *
 * Bug: collectEnrichedExistsDecisions + propagateExistsConditions matched exists
 * decisions to include decisions by relationName alone.  When a nested exists
 * `exists('posts', { where: exists('comments', { where: eq('flag', true) }) })`
 * is combined with `.include('comments')`, the inner posts→comments exists shares
 * the relation name 'comments' with the root users→comments include.  Descending
 * into the outer exists's own conditions (or failing the source guard) could
 * propagate the `flag = true` filter into the root users.comments include,
 * producing wrongly-filtered include results.
 *
 * Fix:
 *   1. collectEnrichedExistsDecisions stops at exists boundaries — it never
 *      descends into an exists's own conditions (those belong to a nested subquery
 *      on a different source table).
 *   2. propagateExistsConditions adds a sourceTable guard: when both the exists
 *      decision and the include decision carry sourceTable, they must match.
 *      A posts→comments exists (sourceTable='posts') must not match a
 *      users.comments include (sourceTable='users').
 *
 * Schema: users → posts (FK author_id)
 *         users → comments (FK user_id, relation 'comments')
 *         posts → comments (FK post_id, relation 'comments')
 */

import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: three tables with two independent 'comments' relations
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
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		flag: { type: 'boolean' },
		// Two FKs: comments.user_id → users (gives users a 'comments' relation)
		//          comments.post_id → posts (gives posts a 'comments' relation)
		user_id: ref('users', { as: 'authorComment', inverse: 'comments' }),
		post_id: ref('posts', { as: 'postComment', inverse: 'comments' }),
	},
} as const);

function buildOrm() {
	const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });
	return createOrm({ model: testSchema.model, adapter });
}

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Primary defect: nested posts.comments must NOT pollute users.comments include
// ---------------------------------------------------------------------------

describe('nested exists cross-source: inner posts.comments filter must NOT propagate to users.comments include', () => {
	it('exists(posts,{where:exists(comments,{where:eq(flag,true)})}) + include(comments) — flag NOT in include subquery', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flag', true) }),
				}),
			)
			.include('comments')
			.dump();

		const sql = ws(dump.sql);

		// The root users.comments include subquery correlates via user_id.
		// It must NOT carry the flag predicate — that belongs to posts.comments.
		expect(
			sql,
			`Root users→comments include must correlate via user_id. SQL: ${sql}`,
		).toMatch(/__t__\.user_id\s*=\s*users\.id/);

		// The outer WHERE contains the nested EXISTS chain with flag=true.
		expect(sql, `WHERE must contain nested EXISTS. SQL: ${sql}`).toMatch(
			/WHERE\s+EXISTS/i,
		);
		expect(
			params_include_flag_twice(dump.params),
			`flag=true must appear exactly once (only in the EXISTS, NOT propagated into the include). params: ${JSON.stringify(dump.params)}`,
		).toBe(false);

		// params must contain true exactly once — in the nested EXISTS, NOT in the include.
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(
			trueCount,
			`flag=true must appear exactly once (in the EXISTS only). Got ${trueCount} in params: ${JSON.stringify(dump.params)}`,
		).toBe(1);
	});

	it('include subquery for users.comments has NO flag condition (SQL-level assertion)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flag', true) }),
				}),
			)
			.include('comments')
			.dump();

		const sql = ws(dump.sql);

		// The json_agg / correlated subquery for users.comments must not contain
		// a flag predicate.  Its WHERE should only carry the FK correlation.
		// Pattern: the include subquery is "SELECT json_agg(...) FROM comments AS __t__
		//   WHERE __t__.user_id = users.id" — no extra AND __t__.flag = $N.
		//
		// The flag predicate is inside the outer WHERE … EXISTS (… AND EXISTS (…
		//   AND comments_exists_N.flag = $1)).
		// A simple way to verify: the string "__t__.flag" must NOT appear.
		expect(
			sql,
			`Include subquery must not reference __t__.flag. SQL: ${sql}`,
		).not.toContain('__t__.flag');
	});
});

// ---------------------------------------------------------------------------
// Regression: top-level same-relation exists STILL propagates (must not break)
// ---------------------------------------------------------------------------

describe('same-relation top-level exists + include — propagation is preserved', () => {
	it('exists(comments,{where:eq(flag,true)}) + include(comments) — flag IS in include subquery (same source)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(exists('comments', { where: eq('flag', true) }))
			.include('comments')
			.dump();

		const sql = ws(dump.sql);

		// Both the EXISTS subquery and the include subquery are users→comments.
		// The flag predicate must appear twice: once in the WHERE EXISTS clause,
		// and once in the include subquery (propagated by propagateExistsConditions).
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(
			trueCount,
			`flag=true must appear at least twice when propagated into include. Got ${trueCount}. SQL: ${sql}`,
		).toBeGreaterThanOrEqual(2);

		// The include subquery must reference flag — confirming propagation occurred.
		expect(
			sql,
			`Include subquery must carry flag predicate when same-source exists propagates. SQL: ${sql}`,
		).toContain('__t__.flag');
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the flag value (true) appears MORE than once in params,
 * which would indicate propagation into the include.  Used as a guard in the
 * primary defect test to give a clear failure message.
 */
function params_include_flag_twice(params: readonly unknown[]): boolean {
	return (params as unknown[]).filter((p) => p === true).length > 1;
}
