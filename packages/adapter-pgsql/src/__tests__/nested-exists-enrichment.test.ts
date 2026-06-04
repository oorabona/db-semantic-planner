/**
 * Tests for nested exists enrichment — exists() whose where clause itself contains
 * another exists().  Three defects addressed:
 *
 * (1) Nested exists emitted twice: the filter-strategy loop appended an extra
 *     top-level AND EXISTS for the inner relation because no matching stub was found
 *     in the top-level stubs array.  Fixed by skipping append when the target is
 *     a known nested-exists relation.
 *
 * (2) Fail-closed for undeclared nested relations: enrichExistsStubsInConditions
 *     previously convention-compiled an undeclared inner relation; now throws.
 *
 * (3) outerRef rejection on the direct compile-where path (compileWhereIntent /
 *     handleRawExistsIntent).  The decisions path already rejected this; the direct
 *     path now matches.
 */

import {
	and,
	createOrm,
	eq,
	exists,
	or,
	outerRef,
	rawExists,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (hasMany via posts.author_id)
//                posts → comments (hasMany via comments.post_id)
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
// Defect 1 — nested exists emitted exactly once (not twice)
// ---------------------------------------------------------------------------

describe('nested exists — correct EXISTS count and structure', () => {
	it('exists(posts, { where: exists(comments, { where: eq(body,x) }) }) → exactly 2 EXISTS, correct correlations', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('body', 'x') }),
				}),
			)
			.dump();
		const normalized = ws(sql);

		// Count the number of EXISTS occurrences — must be exactly 2.
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// Outer correlation: users.id = posts_exists_N.author_id
		expect(normalized).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);

		// Inner correlation: posts_exists_N.id = comments_exists_M.post_id
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*comments_exists_\d+\.post_id/,
		);

		// Inner filter: comments alias has body = $1
		expect(normalized).toMatch(/comments_exists_\d+\.body\s*=\s*\$1/);

		// Must NOT have a third AND EXISTS at the root — that would be the double-emit.
		// The SQL structure is: WHERE EXISTS (posts ... AND EXISTS (comments ...))
		// with exactly one top-level WHERE clause, no extra root-level AND EXISTS.
		// Use the FIRST WHERE occurrence to check the root predicate starts with EXISTS.
		const firstWhereMatch = normalized.match(/WHERE\s+(EXISTS\b)/i);
		expect(
			firstWhereMatch,
			`Expected outermost WHERE to start with EXISTS, got: ${normalized}`,
		).not.toBeNull();

		expect(params).toEqual(['x']);
	});

	it('nested exists under OR — no extra top-level AND EXISTS', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				or(
					eq('active', true),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'hello') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		// Exactly 2 EXISTS in the output.
		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// The top-level boolean operator is OR, not AND.
		expect(normalized).toMatch(/WHERE.*active.*OR.*EXISTS/i);

		// Must NOT have a third bare AND EXISTS appended at root level.
		// Pattern: "... OR EXISTS (...) AND EXISTS (...)" would indicate double-emit.
		expect(normalized).not.toMatch(
			/OR\s+EXISTS\s*\(.*\)\s+AND\s+EXISTS\s*\(/is,
		);

		expect(params).toEqual([true, 'hello']);
	});

	it('nested exists under AND — both filters present, no duplication', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(
				and(
					eq('active', true),
					exists('posts', {
						where: exists('comments', { where: eq('body', 'hi') }),
					}),
				),
			)
			.dump();
		const normalized = ws(sql);

		const existsMatches = normalized.match(/\bEXISTS\b/g);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got: ${normalized}`,
		).toBe(2);

		// The outer exists is AND-ed with the active filter (either order is fine).
		expect(normalized).toMatch(/active/i);
		expect(normalized).toMatch(/EXISTS/i);
		expect(params).toEqual([true, 'hi']);
	});
});

// ---------------------------------------------------------------------------
// Defect 2 — fail-closed: undeclared inner relation must throw
// ---------------------------------------------------------------------------

describe('nested exists — fail-closed for undeclared inner relation', () => {
	it('exists(posts, { where: exists(undeclaredRelation) }) → throws clear error', () => {
		const orm = buildOrm();
		expect(() => {
			(orm as any)
				.select('users')
				.where(
					exists('posts', {
						where: (exists as any)('unknownRelation', {}),
					}),
				)
				.dump();
		}).toThrow(/no relation 'unknownRelation' is declared on table 'posts'/i);
	});

	it('top-level exists with undeclared relation still throws (regression guard)', () => {
		const orm = buildOrm();
		expect(() => {
			(orm as any)
				.select('users')
				.where((exists as any)('noSuchTable', {}))
				.dump();
		}).toThrow(/no relation 'noSuchTable'.*declared/i);
	});
});

// ---------------------------------------------------------------------------
// Defect 3 — rawExists + outerRef on the direct compileWhereIntent path
// ---------------------------------------------------------------------------

describe('rawExists + outerRef on direct compileWhereIntent path', () => {
	function makeRealCtx(): WhereCompilerCtx {
		const paramState = createCompilerState();
		return {
			rootTable: 'users',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent, paramOffset) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
	}

	it('rawExists(subquery with outerRef) on direct path → throws', () => {
		const intent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'author_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/correlated subqueries.*not yet supported/i,
		);
	});

	it('rawNotExists(subquery with outerRef) on direct path → throws', () => {
		const intent = {
			kind: 'rawNotExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'author_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		const ctx = makeRealCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/correlated subqueries.*not yet supported/i,
		);
	});

	it('rawExists without outerRef on direct path → does NOT throw', () => {
		const ctx = makeRealCtx();
		const safeIntent = {
			kind: 'rawExists' as const,
			subquery: {
				type: 'select' as const,
				from: 'posts',
				select: { type: 'fields' as const, fields: ['id'] as const },
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
			},
		};
		expect(() => compileWhereIntent(safeIntent as any, ctx)).not.toThrow();
	});

	it('rawExists + outerRef on ORM path (decisions path) → still throws', () => {
		const orm = buildOrm();
		const correlated = rawExists(
			subquery('posts')
				.select('id')
				.where(eq('author_id', outerRef('id') as any)),
		);
		expect(() => {
			(orm as any).select('users').where(correlated).dump();
		}).toThrow(/correlated subqueries.*not yet supported/i);
	});
});

// ---------------------------------------------------------------------------
// Regression guard — single-level exists must compile unchanged
// ---------------------------------------------------------------------------

describe('regression: single-level exists unchanged', () => {
	it('exists(posts) at top level — correct SQL (regression lock)', () => {
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

	it('or(eq, exists(posts)) — exists stays in OR branch', () => {
		const orm = buildOrm();
		const { sql, params } = (orm as any)
			.select('users')
			.where(or(eq('name', 'Alice'), exists('posts')))
			.dump();
		expect(ws(sql)).toEqual(
			'SELECT users.* FROM users WHERE users.name = $1 OR EXISTS (SELECT 1 FROM posts AS posts_exists_0 WHERE users.id = posts_exists_0.author_id)',
		);
		expect(params).toEqual(['Alice']);
	});
});
