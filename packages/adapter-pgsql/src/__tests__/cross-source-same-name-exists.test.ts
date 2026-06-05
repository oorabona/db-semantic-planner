/**
 * Regression tests for exists stub identity collision when two relations share the
 * same name/target table but originate from DIFFERENT source tables.
 *
 * Schema: users → posts (hasMany, posts.author_id)
 *         users → comments (hasMany, comments.user_id)
 *         posts → comments (hasMany, comments.post_id)
 *
 * Both users.comments and posts.comments resolve to target table 'comments'.
 * Before the fix, matching stubs only on target name caused cross-wiring:
 * the nested posts.comments filter-strategy could consume the top-level
 * users.comments stub, producing wrong FK correlations.
 */

import { and, createOrm, eq, exists, or, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: three tables, two distinct 'comments' relations from different sources
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
		active: { type: 'boolean' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		published: { type: 'boolean' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		// Two FKs on comments: one to users, one to posts.
		// This gives both users and posts a 'comments' relation with different FKs.
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
// Core cross-wire test: nested posts.comments + top-level users.comments
// ---------------------------------------------------------------------------

describe('cross-source same-target collision: users.comments vs posts.comments', () => {
	it('and(exists(posts,{where:exists(comments,filterA)}), exists(comments,filterB)) — correct FK correlations, no cross-wiring', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					// Outer exists: users → posts (posts.author_id)
					// Inner nested: posts → comments (comments.post_id), filter A = body='nested'
					exists('posts', {
						where: exists('comments', { where: eq('body', 'nested') }),
					}),
					// Top-level: users → comments (comments.user_id), filter B = body='toplevel'
					exists('comments', { where: eq('body', 'toplevel') }),
				),
			)
			.dump();
		const normalized = ws(sql);

		// Exactly 3 EXISTS: outer posts, nested posts.comments, top-level users.comments.
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 3 EXISTS, got: ${normalized}`,
		).toBe(3);

		// Top-level users.comments: must correlate via user_id (users.id = comments.user_id).
		// The alias for the top-level comments stub is different from the nested one.
		expect(
			normalized,
			`Top-level users→comments must use user_id correlation. SQL: ${normalized}`,
		).toMatch(/users\.id\s*=\s*\w+_exists_\d+\.user_id/);

		// Nested posts.comments: must correlate via post_id (posts_exists_N.id = comments.post_id).
		expect(
			normalized,
			`Nested posts→comments must use post_id correlation. SQL: ${normalized}`,
		).toMatch(/posts_exists_\d+\.id\s*=\s*\w+_exists_\d+\.post_id/);

		// Filter A ('nested') must appear inside the nested posts.comments EXISTS.
		// Filter B ('toplevel') must appear inside the top-level users.comments EXISTS.
		// Both params must be present.
		expect(params).toContain('nested');
		expect(params).toContain('toplevel');
	});

	it('ordering variant: and(exists(comments,filterB), exists(posts,{where:exists(comments,filterA)})) — same correct FKs', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					// Top-level first this time
					exists('comments', { where: eq('body', 'toplevel') }),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'nested') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 3 EXISTS, got: ${normalized}`,
		).toBe(3);

		// Same FK requirements regardless of order.
		expect(normalized).toMatch(/users\.id\s*=\s*\w+_exists_\d+\.user_id/);
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*\w+_exists_\d+\.post_id/,
		);
		expect(params).toContain('nested');
		expect(params).toContain('toplevel');
	});

	it('or(exists(comments,filterB), exists(posts,{where:exists(comments,filterA)})) — correct FKs under OR', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				or(
					exists('comments', { where: eq('body', 'toplevel') }),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'nested') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 3 EXISTS, got: ${normalized}`,
		).toBe(3);

		// Top-level is inside OR — user_id correlation must still be present.
		expect(normalized).toMatch(/users\.id\s*=\s*\w+_exists_\d+\.user_id/);
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*\w+_exists_\d+\.post_id/,
		);
		expect(params).toContain('nested');
		expect(params).toContain('toplevel');
	});

	it('top-level exists(comments) alone — uses user_id FK (regression: no cross-wiring without nesting)', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(exists('comments', { where: eq('body', 'x') }))
			.dump();
		const normalized = ws(sql);
		// Must correlate to users.id = comments.user_id, not post_id.
		expect(normalized).toMatch(/users\.id\s*=\s*\w+_exists_\d+\.user_id/);
		expect(normalized).not.toMatch(/post_id/);
	});

	it('exists(posts, {where: exists(comments)}) alone — posts.comments uses post_id FK (regression)', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(exists('posts', { where: exists('comments') }))
			.dump();
		const normalized = ws(sql);
		// Outer: users.id = posts.author_id
		expect(normalized).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		// Inner: posts_exists.id = comments.post_id
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*\w+_exists_\d+\.post_id/,
		);
		expect(normalized).not.toMatch(/user_id/);
	});
});
