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
// ---------------------------------------------------------------------------

describe('5. include + nested exists (propagateExistsConditions tree walk)', () => {
	it('include(posts) with exists(posts, where) nested in OR — include inherits filter', () => {
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
		// OR must appear (exists is inline)
		expect(normalized).toContain('OR');
		// Include subquery must still appear
		expect(normalized).toMatch(/json_agg|lateral|posts/i);
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
