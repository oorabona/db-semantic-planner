/**
 * Regression tests for sourceTable on enriched exists decisions and the
 * propagateExistsConditions sourceTable guard.
 *
 * Before the fix, buildEnrichedExistsDecision did not set sourceTable on the
 * returned decision, making the sourceTable guard in propagateExistsConditions
 * a no-op (both sides would be undefined, skipping the guard entirely).
 * The cross-source protection came solely from collectEnrichedExistsDecisions
 * not descending into nested exists conditions.
 *
 * Fix: buildEnrichedExistsDecision now sets sourceTable = sourceTableForRelation
 * (plan.rootTable for top-level filter-strategy decisions).  This makes the
 * (sourceTable, relationName) guard in propagateExistsConditions meaningful.
 *
 * Tests verify:
 *   1. Cross-source: nested posts.comments EXISTS does NOT propagate to
 *      users.comments include (now guarded by BOTH don't-descend AND sourceTable).
 *   2. Same-source: top-level users.comments EXISTS DOES propagate to
 *      users.comments include (sourceTable matches → propagation fires correctly).
 *
 * Schema: users → posts (FK author_id)
 *         users → comments (FK user_id, relation 'comments')
 *         posts → comments (FK post_id, relation 'comments')
 */

import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		flag: { type: 'boolean' },
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
// Cross-source: nested posts.comments must NOT propagate to users.comments include
// ---------------------------------------------------------------------------

describe('sourceTable guard on propagateExistsConditions', () => {
	it('nested posts.comments exists does NOT propagate to users.comments include', () => {
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

		// flag=true must appear exactly once (in the nested EXISTS WHERE, NOT in include).
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(
			trueCount,
			`flag=true must appear exactly once (only in the WHERE EXISTS, not in the include). params: ${JSON.stringify(dump.params)}`,
		).toBe(1);

		// The include subquery must NOT carry the flag predicate.
		expect(
			sql,
			`Include subquery must not reference __t__.flag. SQL: ${sql}`,
		).not.toContain('__t__.flag');
	});

	it('top-level users.comments exists DOES propagate to users.comments include (sourceTable matches)', () => {
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(exists('comments', { where: eq('flag', true) }))
			.include('comments')
			.dump();
		const sql = ws(dump.sql);

		// flag=true must appear at least twice: once in the WHERE EXISTS and once
		// propagated into the include subquery.
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(
			trueCount,
			`flag=true must appear at least twice when propagated into the include. Got ${trueCount}. SQL: ${sql}`,
		).toBeGreaterThanOrEqual(2);

		// The include subquery must contain the flag predicate.
		expect(
			sql,
			`Include subquery must carry flag predicate when same-source exists propagates. SQL: ${sql}`,
		).toContain('__t__.flag');
	});

	it('cross-source: and(exists(posts, nested-comments), exists(comments,flag)) + include(comments) — only root exists propagates', () => {
		// Both users.comments (top-level) and posts.comments (nested) share the
		// 'comments' relation name.  Only users.comments must propagate.
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flag', false) }),
				}),
			)
			.include('comments')
			.dump();
		const sql = ws(dump.sql);

		// The nested EXISTS has flag=false; it must NOT appear in the include.
		// The include has no top-level users.comments exists here, so flag should
		// not appear in the include subquery at all.
		expect(
			sql,
			`Include subquery must not contain __t__.flag (no top-level users.comments exists to propagate). SQL: ${sql}`,
		).not.toContain('__t__.flag');

		// The value false must appear exactly once (in the nested EXISTS).
		const falseCount = (dump.params as unknown[]).filter(
			(p) => p === false,
		).length;
		expect(
			falseCount,
			`flag=false must appear exactly once. params: ${JSON.stringify(dump.params)}`,
		).toBe(1);
	});
});
