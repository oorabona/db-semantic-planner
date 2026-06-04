/**
 * Tests that EXISTS / NOT EXISTS compile at their exact position in the boolean tree.
 *
 * Prior behavior stripped all exists stubs and re-appended them as top-level AND
 * predicates, causing "x=1 OR exists('rel')" to emit "x=1 AND EXISTS(...)".
 * The inline enrichment path keeps them where they were placed.
 */

import {
	and,
	createOrm,
	eq,
	exists,
	not,
	notExists,
	or,
	ref,
	schema,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema
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
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
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
// 1. exists() nested under OR
// ---------------------------------------------------------------------------

describe('1. exists nested under OR', () => {
	it('or(eq, exists) → SQL uses OR, not AND', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(eq('name', 'Alice'), exists('posts')))
			.dump();
		// EXISTS must sit INSIDE the OR branch, not hoisted to top-level AND
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE users.name = $1 OR EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id)',
		);
		expect(params).toEqual(['Alice']);
	});

	it('or(exists, eq) → SQL uses OR, not AND', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(exists('posts'), eq('active', true)))
			.dump();
		const normalized = ws(sql);
		expect(normalized).toContain('OR');
		expect(normalized).toContain('EXISTS');
		// Must NOT emit "AND EXISTS" (the old hoisted-to-top-level-AND behavior)
		expect(normalized).not.toMatch(/AND EXISTS/i);
		expect(params).toEqual([true]);
	});
});

// ---------------------------------------------------------------------------
// 2. notExists() nested under OR
// ---------------------------------------------------------------------------

describe('2. notExists nested under OR', () => {
	it('or(eq, notExists) → SQL uses OR NOT EXISTS', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(eq('name', 'Bob'), notExists('posts')))
			.dump();
		expect(ws(sql)).toContain('OR');
		expect(ws(sql)).toContain('NOT (EXISTS');
		expect(params).toEqual(['Bob']);
	});
});

// ---------------------------------------------------------------------------
// 3. exists() nested inside NOT + AND
// ---------------------------------------------------------------------------

describe('3. exists nested inside NOT(AND(...))', () => {
	it('not(and(exists, eq)) → NOT (EXISTS(...) AND col = $1)', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(not(and(exists('posts'), eq('name', 'W'))))
			.dump();
		// EXISTS must be INSIDE the NOT, not hoisted outside
		const normalized = ws(sql);
		expect(normalized).toContain('NOT');
		expect(normalized).toContain('EXISTS');
		// The NOT must enclose the EXISTS — check EXISTS appears after NOT
		const notIdx = normalized.indexOf('NOT');
		const existsIdx = normalized.indexOf('EXISTS');
		expect(existsIdx).toBeGreaterThan(notIdx);
		expect(params).toEqual(['W']);
	});
});

// ---------------------------------------------------------------------------
// 4. Top-level exists still works (AND semantics unchanged)
// ---------------------------------------------------------------------------

describe('4. top-level exists (AND semantics unchanged)', () => {
	it('where(exists) at top level → WHERE EXISTS(...)', () => {
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
		);
	});

	it('where(and(eq, exists)) at top level → WHERE col = $1 AND EXISTS(...)', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(and(eq('active', true), exists('posts')))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE users.active = $1 AND EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id)',
		);
		expect(params).toEqual([true]);
	});
});

// ---------------------------------------------------------------------------
// 5. Relation that is both EXISTS-filtered (nested) and included
//    Item A fix: OR-branch exists must NOT propagate conditions to include.
// ---------------------------------------------------------------------------

describe('5. include + nested exists (propagateExistsConditions AND-only propagation)', () => {
	it('include(posts) with exists(posts,{where}) nested in OR — include does NOT inherit filter (Item A fix)', () => {
		// Before Item A fix, collectEnrichedExistsDecisions descended into whereOr,
		// so `exists('posts', { where: eq('published', true) })` under OR would
		// propagate `published = true` into the include subquery.  That was wrong:
		// a row selected by `active = true` would have ALL its posts included, not
		// only published ones.
		const orm = buildOrm();
		const dump = (orm as any)
			.select('users')
			.where(
				or(
					eq('active', true),
					exists('posts', { where: eq('published', true) }),
				),
			)
			.include('posts')
			.dump();
		const normalized = ws(dump.sql);
		// OR must appear (exists stays inline)
		expect(normalized).toContain('OR');
		// Include subquery must appear
		expect(normalized).toMatch(/json_agg|lateral|posts/i);
		// `published` must appear EXACTLY ONCE in the full SQL:
		// - once inside the EXISTS subquery in the WHERE clause
		// - NOT a second time inside the include (json_agg) subquery
		// If it appears twice, the include erroneously inherited the OR-branch filter.
		const publishedCount = (normalized.match(/published/gi) ?? []).length;
		expect(publishedCount).toBe(1);
	});

	it('include(posts) with top-level AND exists(posts,{where}) — include DOES inherit filter (AND-required)', () => {
		// Top-level exists in AND position: the condition IS AND-required for every
		// selected row, so the include should inherit the filter.
		const orm = buildOrm();
		const dump = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.dump();
		const normalized = ws(dump.sql);
		// Include must appear
		expect(normalized).toMatch(/json_agg|lateral|posts/i);
		// published condition must appear (propagated to include)
		expect(normalized).toContain('published');
	});
});

// ---------------------------------------------------------------------------
// 6. Custom-FK exists nested under OR
// ---------------------------------------------------------------------------

describe('6. custom-FK exists nested under OR', () => {
	it('or(eq, exists(comments)) — FK resolution still works inline', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('posts')
			.where(
				or(
					eq('published', true),
					exists('comments', { where: eq('body', 'hi') }),
				),
			)
			.dump();
		const normalized = ws(sql);
		// OR must appear (not hoisted to AND)
		expect(normalized).toContain('OR');
		// EXISTS must be present
		expect(normalized).toContain('EXISTS');
		// comments FK: post_id
		expect(normalized).toContain('post_id');
		expect(params).toContain(true);
		expect(params).toContain('hi');
	});
});

// ---------------------------------------------------------------------------
// 7. FK correlation direction: belongsTo vs hasMany (must not be reversed)
//
// buildExistsSubquery reads decision.sourceColumn / decision.targetColumn.
// mapToHandlerDecision → deriveFkColumns derives them from relationType + foreignKey.
// Without relationType the deriveFkColumns fallback assumes hasMany, reversing
// the correlation for belongsTo relations (posts.id = users_alias.author_id instead
// of the correct posts.author_id = users_alias.id).
// ---------------------------------------------------------------------------

describe('7. FK correlation direction: belongsTo vs hasMany', () => {
	it('belongsTo exists inline: FK is on outer table (posts.author_id = users_alias.id)', () => {
		// posts.author is a belongsTo: FK author_id lives on posts, PK id on users.
		// Correct:   posts_alias.author_id = users_exists_0.id
		// Wrong:     posts_alias.id        = users_exists_0.author_id  (hasMany default)
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('posts')
			.where(or(eq('title', 'hello'), exists('author')))
			.dump();
		const normalized = ws(sql);
		// author_id must appear on the outer (posts) side of the correlation
		expect(normalized).toContain('author_id');
		// The reversed direction must NOT appear: posts_alias.id = ...exists_N.author_id
		expect(normalized).not.toMatch(
			/posts\b.*\.id\s*=\s*\w+_exists_\d+\.author_id/i,
		);
		// Inline OR position preserved
		expect(normalized).toContain('OR');
		expect(params).toEqual(['hello']);
	});

	it('hasMany exists inline: FK is on inner table (users.id = posts_alias.author_id)', () => {
		// users.posts is a hasMany: FK author_id lives on posts, PK id on users.
		// Correct:   users_alias.id        = posts_exists_0.author_id
		// Wrong:     users_alias.author_id = posts_exists_0.id  (belongsTo default)
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(eq('name', 'Alice'), exists('posts')))
			.dump();
		const normalized = ws(sql);
		// author_id must appear on the inner (posts) alias side
		expect(normalized).toContain('author_id');
		// The reversed direction must NOT appear: users_alias.author_id = ...
		expect(normalized).not.toMatch(/users\b.*\.author_id\s*=/i);
		// Inline OR position preserved
		expect(normalized).toContain('OR');
		expect(params).toEqual(['Alice']);
	});

	it('belongsTo notExists at top level: correct FK direction', () => {
		// top-level notExists('author') on posts — same FK direction as the nested case
		const orm = buildOrm();
		const { sql } = (orm as any)
			.select('posts')
			.where(notExists('author'))
			.dump();
		const normalized = ws(sql);
		// author_id on the outer posts side
		expect(normalized).toContain('author_id');
		// Wrong direction absent
		expect(normalized).not.toMatch(
			/posts\b.*\.id\s*=\s*\w+_exists_\d+\.author_id/i,
		);
		expect(normalized).toContain('NOT');
	});

	it('top-level hasMany exists: SQL identical to pre-refactor baseline', () => {
		// Regression lock: top-level hasMany exists must produce the exact same SQL.
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id AND posts_exists_0.published = $1)',
		);
		expect(params).toEqual([true]);
	});

	it('hasMany exists inline (comments): FK on inner table (posts.id = comments_alias.post_id)', () => {
		// posts.comments is hasMany: FK post_id lives on comments, PK id on posts.
		// Correct:   posts_alias.id      = comments_exists_0.post_id
		// Wrong:     posts_alias.post_id = comments_exists_0.id
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('posts')
			.where(or(eq('published', false), exists('comments')))
			.dump();
		const normalized = ws(sql);
		// post_id must appear on the inner (comments) alias side
		expect(normalized).toContain('post_id');
		// The reversed direction must NOT appear: posts_alias.post_id = ...
		expect(normalized).not.toMatch(/posts\b.*\.post_id\s*=/i);
		expect(normalized).toContain('OR');
		expect(params).toEqual([false]);
	});
});
