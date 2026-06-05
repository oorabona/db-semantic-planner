/**
 * Decoupled include: exists() filter never propagates into a sibling include subquery.
 *
 * Tests verify:
 *   1. Cross-source: nested posts.comments EXISTS does NOT propagate to
 *      users.comments include — the include correlates on user_id only.
 *   2. Top-level users.comments EXISTS + include(comments) — include is also
 *      NOT filtered (decoupled: exists only picks root rows; include returns all).
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

describe('decoupled include: exists filter never propagates regardless of source table', () => {
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

	it('top-level users.comments exists does NOT propagate to users.comments include (decoupled)', () => {
		// After decoupling, include is never filtered by a sibling exists — even when
		// the exists and include target the same relation on the same source table.
		const orm = buildOrm();
		const dump = orm
			.select('users')
			.where(exists('comments', { where: eq('flag', true) }))
			.include('comments')
			.dump();
		const sql = ws(dump.sql);

		// flag=true must appear exactly ONCE — only in the WHERE EXISTS, NOT in the include.
		const trueCount = (dump.params as unknown[]).filter(
			(p) => p === true,
		).length;
		expect(
			trueCount,
			`flag=true must appear exactly once (only in the WHERE EXISTS). Got ${trueCount}. SQL: ${sql}`,
		).toBe(1);

		// The include subquery must NOT contain the flag predicate.
		expect(
			sql,
			`Include subquery must NOT carry flag predicate after decoupling. SQL: ${sql}`,
		).not.toContain('__t__.flag');
	});

	it('cross-source: exists(posts,{where:exists(comments,flag)}) + include(comments) — flag NOT in include', () => {
		// Both users.comments (top-level include) and posts.comments (nested exists)
		// share the 'comments' relation name.  After decoupling, neither propagates
		// into the include subquery.
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

		// The include subquery must not carry the flag predicate.
		expect(
			sql,
			`Include subquery must not contain __t__.flag. SQL: ${sql}`,
		).not.toContain('__t__.flag');

		// The value false must appear exactly once (in the nested EXISTS only).
		const falseCount = (dump.params as unknown[]).filter(
			(p) => p === false,
		).length;
		expect(
			falseCount,
			`flag=false must appear exactly once. params: ${JSON.stringify(dump.params)}`,
		).toBe(1);
	});
});
