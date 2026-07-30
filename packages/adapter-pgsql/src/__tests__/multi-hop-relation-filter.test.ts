/**
 * Regression tests for multi-hop relationFilter(['hop1', 'hop2'], { where }) compilation.
 *
 * A multi-hop relation path like ['posts', 'comments'] from users means:
 *   users → posts (via posts.authorId) → comments (via comments.postId)
 *
 * The planner produces ONE filter-strategy decision for the LAST hop (comments),
 * with context.sourceTable = 'posts' and context.target = 'comments'.
 * The adapter must match the stub (targetTable = ['posts','comments']) to this
 * decision and compile a valid EXISTS — no malformed SQL, no thrown error.
 *
 * BASELINE from main (old top-level extraction path):
 * The old code produced:
 *   EXISTS (SELECT 1 FROM comments WHERE users.id = comments."postId")
 * Correlation used the ROOT table (users), NOT the intermediate posts table.
 * The nested `where` filter was LOST because the intent match failed
 * (i.relation[0]='posts' ≠ context.relation='comments').
 *
 * The new code must produce the same or better SQL with NO malformed table name,
 * no thrown error for a declared-relation multi-hop path.
 */

import { and, POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import type { WhereIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts (via posts.authorId) → comments (via comments.postId)
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
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

function compileMultiHop(
	relation: string[],
	body?: string,
): { sql: string; parameters: readonly unknown[] } {
	const whereCondition: WhereIntent = body
		? {
				kind: 'like',
				field: 'body',
				pattern: `%${body}%`,
			}
		: { kind: 'null', field: 'id', operator: 'isNotNull' };

	const planReport = plan(
		{
			type: 'select',
			from: 'users',
			where: {
				kind: 'relationFilter',
				relation,
				where: whereCondition,
				mode: 'some',
			},
		},
		testSchema.model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	return adapter.compile(planReport, { model: testSchema.model });
}

// ---------------------------------------------------------------------------
// 1. Baseline regression — multi-hop compiles without error
// ---------------------------------------------------------------------------

describe('1. multi-hop relationFilter — no malformed SQL, no error', () => {
	it('relationFilter(["posts","comments"]) does NOT throw', () => {
		expect(() => compileMultiHop(['posts', 'comments'], 'hello')).not.toThrow();
	});

	it('relationFilter(["posts","comments"]) produces WHERE EXISTS', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toContain('SELECT users.* FROM users');
	});

	it('relationFilter(["posts","comments"]) targets the last-hop table (comments)', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// EXISTS subquery must target comments, not posts or a malformed name
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Must NOT contain malformed table names
		expect(normalized).not.toMatch(/posts,comments/i);
		expect(normalized).not.toMatch(/\[object/i);
		expect(normalized).not.toMatch(/undefined/i);
	});

	it('relationFilter(["posts","comments"]) uses the correct FK column (postId)', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// FK from posts → comments is postId
		expect(normalized).toContain('postId');
	});

	it('SQL uses nested EXISTS chain (updated: old single-EXISTS assertion locked the pre-existing bug)', () => {
		// The old assertion was: WHERE EXISTS count === 1 (single flat EXISTS on
		// last hop only, wrong correlation against users.id instead of posts_alias.id).
		// That locked a known bug — the nested-chain fix (Item B) changes the output
		// to a proper 2-level nested EXISTS.  This test is updated to assert the
		// new correct behavior.
		const { sql } = compileMultiHop(['posts', 'comments']);
		const normalized = ws(sql);
		// Nested chain: >= 2 EXISTS subqueries
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
		// Targets both intermediate (posts) and last (comments) tables
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Uses the FK columns for each hop
		expect(normalized).toContain('authorId');
		expect(normalized).toContain('postId');
	});
});

// ---------------------------------------------------------------------------
// 2. Fail-closed guard does NOT fire for a fully-declared multi-hop path
// ---------------------------------------------------------------------------

describe('2. fail-closed guard — declared multi-hop path does not throw', () => {
	it('["posts","comments"] — all hops declared — no error', () => {
		expect(() => compileMultiHop(['posts', 'comments'])).not.toThrow();
	});

	it('["posts"] single-element array — no regression from last-element fix', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
	});

	it('undeclared single-hop still throws (fail-closed unchanged for single-hop)', () => {
		// auditLog is in the schema but has no FK relation to users
		const schemaWithAuditLog = schema({
			users: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			auditLog: {
				id: { type: 'integer', primaryKey: true },
				entityType: 'text',
			},
		} as const);
		const adapterLocal = createPgsqlCompileOnlyAdapter({
			model: schemaWithAuditLog.model,
		});
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'auditLog',
					where: {
						kind: 'comparison',
						field: 'entityType',
						operator: 'eq',
						value: 'login',
					},
				} as any,
			},
			schemaWithAuditLog.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapterLocal.compile(planReport, { model: schemaWithAuditLog.model }),
		).toThrow(/exists\('auditLog'\).*no relation 'auditLog'.*declared/i);
	});
});

// ---------------------------------------------------------------------------
// 3. Multi-hop nested under OR — inline position preserved
// ---------------------------------------------------------------------------

describe('3. multi-hop relationFilter nested under OR', () => {
	it('or(eq, multi-hop-relationFilter) — compiles with EXISTS, no malformed SQL', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{
							kind: 'relationFilter',
							relation: ['posts', 'comments'],
							where: {
								kind: 'like',
								field: 'body',
								pattern: '%hi%',
							},
							mode: 'some',
						},
					],
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// EXISTS must appear
		expect(normalized).toContain('EXISTS');
		// No malformed SQL
		expect(normalized).not.toMatch(/posts,comments/i);
		expect(normalized).not.toMatch(/\[object/i);
		// Targets comments
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
	});
});

// ---------------------------------------------------------------------------
// 4. Single-hop exists — no regression from multi-hop normalizeStubRelation fix
// ---------------------------------------------------------------------------

describe('4. single-hop exists — no regression', () => {
	it('plain string relation still works (not an array path)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: 'posts',
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
	});

	it('exists("comments") from posts — single hop, correct FK (postId)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'posts',
				where: {
					kind: 'exists',
					relation: 'comments',
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'like',
						value: '%hi%',
					},
				} as any,
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('EXISTS');
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		expect(normalized).toContain('postId');
		expect(parameters).toContain('%hi%');
	});
});

// ---------------------------------------------------------------------------
// 5. Nested-EXISTS chain: the correct target SQL (Item B fix)
//
// Prior to this fix (old single-EXISTS path), the adapter produced:
//   EXISTS (SELECT 1 FROM "comments" WHERE users.id = comments."postId")
// — wrong correlation (users.id instead of posts_alias.id) and dropped inner
// where filter (because intent matching used i.relation[0]='posts' against
// context.relation='comments' → no match → conditions undefined).
//
// The fix builds a nested EXISTS chain:
//   EXISTS (SELECT 1 FROM "posts" AS posts_exists_0
//           WHERE <users.id = posts_exists_0.authorId>
//             AND EXISTS (SELECT 1 FROM "comments" AS comments_exists_1
//                         WHERE <posts_exists_0.id = comments_exists_1.postId>
//                           AND comments_exists_1.body = $1))
//
// The old test in describe('1') that asserted "single WHERE EXISTS"
// (existsCount === 1) is updated here because it locked the pre-existing
// bug (single flat EXISTS on last hop only, wrong correlation).
// ---------------------------------------------------------------------------

describe('5. nested-EXISTS chain — correct correlations and inner where (Item B fix)', () => {
	it('produces TWO nested EXISTS subqueries (not one flat EXISTS)', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// Count EXISTS( occurrences: should be >= 2 (outer + inner)
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
	});

	it('outer EXISTS targets posts', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
	});

	it('inner EXISTS targets comments', () => {
		const { sql } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
	});

	it('inner where filter (body condition) is NOT dropped', () => {
		// compileMultiHop with a body string uses operator 'like', producing body LIKE $1.
		// The assertion checks that body appears in the innermost subquery and the
		// parameter is bound — verifying the user's where clause is NOT silently dropped.
		const { sql, parameters } = compileMultiHop(['posts', 'comments'], 'hello');
		const normalized = ws(sql);
		// body must appear in the inner subquery (comments level)
		expect(normalized).toMatch(/body\s+(=|LIKE|ILIKE)\s+\$\d/i);
		expect(parameters).toContain('%hello%');
	});

	it('outer correlation uses authorId (users hasMany posts, FK on posts side)', () => {
		// users → posts: hasMany, FK=authorId on posts side
		// Outer correlation: <sourceAlias>.id = <postsAlias>.authorId
		const { sql } = compileMultiHop(['posts', 'comments']);
		const normalized = ws(sql);
		expect(normalized).toContain('authorId');
	});

	it('inner correlation uses postId (posts hasMany comments, FK on comments side)', () => {
		// posts → comments: hasMany, FK=postId on comments side
		// Inner correlation: <postsAlias>.id = <commentsAlias>.postId
		const { sql } = compileMultiHop(['posts', 'comments']);
		const normalized = ws(sql);
		expect(normalized).toContain('postId');
	});

	it('single-hop still produces ONE EXISTS (zero regression)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'some',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		// Single-hop: exactly 1 EXISTS
		expect(existsCount).toBe(1);
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
	});
});

// ---------------------------------------------------------------------------
// 6. Multi-hop under OR — nested chain preserved, inline position preserved
// ---------------------------------------------------------------------------

describe('6. multi-hop nested under OR — nested chain + inline position (Item B fix)', () => {
	it('or(eq, relationFilter([posts,comments])) — produces nested EXISTS + OR', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{
							kind: 'relationFilter',
							relation: ['posts', 'comments'],
							where: {
								kind: 'like',
								field: 'body',
								pattern: '%hi%',
							},
							mode: 'some',
						},
					],
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// OR must appear (inline position preserved)
		expect(normalized).toContain('OR');
		// Nested EXISTS chain: >= 2 EXISTS
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
		// Both hops present
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Inner filter preserved
		expect(parameters).toContain('%hi%');
	});
});

// ---------------------------------------------------------------------------
// 7. notExists / every mode on multi-hop — quantifier at OUTERMOST hop
//
// Correctness fix: the quantifier must scope the FULL path, so NOT EXISTS must
// wrap the outermost hop (posts), not the innermost (comments).
//
// OLD (buggy): NOT EXISTS(users WHERE EXISTS(posts WHERE NOT EXISTS(comments ...)))
//   — a user with one clean post and one spammed post wrongly matched mode:none
//   because "some posts have no spam comment" is true even when spam exists elsewhere.
//
// CORRECT:
//   none  → NOT EXISTS(posts WHERE corr AND EXISTS(comments WHERE corr AND body=))
//   every → NOT EXISTS(posts WHERE corr AND EXISTS(comments WHERE corr AND NOT(body=)))
// ---------------------------------------------------------------------------

describe('7. mode notExists/every on multi-hop — quantifier at OUTERMOST hop (defect fix)', () => {
	it('mode:none — NOT EXISTS wraps outermost (posts) hop', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts', 'comments'],
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'eq',
						value: 'spam',
					},
					mode: 'none',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);

		// The deparser emits NOT (EXISTS (...)) for the notExists operator.
		// Correct structure: NOT (EXISTS (SELECT 1 FROM posts ... AND EXISTS (SELECT 1 FROM comments ...)))
		expect(normalized).toContain('NOT');
		expect(normalized).toContain('EXISTS');
		// Both hops present
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Inner filter preserved
		expect(parameters).toContain('spam');

		// Key structural assertion: the NOT must wrap the OUTERMOST (posts) hop.
		// NOT(EXISTS(posts ...)) pattern — NOT appears BEFORE FROM posts
		const notIdx = normalized.indexOf('NOT');
		const postsFromIdx = normalized.search(/FROM\s+"?posts"?/i);
		const commentsFromIdx = normalized.search(/FROM\s+"?comments"?/i);
		// NOT appears before FROM posts (wraps posts — outermost)
		expect(notIdx).toBeLessThan(postsFromIdx);
		// FROM posts appears before FROM comments (correct nesting)
		expect(postsFromIdx).toBeLessThan(commentsFromIdx);
		// Inner subquery (comments) uses positive EXISTS: no NOT between posts FROM and comments FROM
		const betweenHops = normalized.slice(postsFromIdx, commentsFromIdx);
		expect(betweenHops).not.toMatch(/NOT/i);
	});

	it('mode:every — NOT EXISTS at outermost, NOT wraps innermost condition', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts', 'comments'],
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'eq',
						value: 'approved',
					},
					mode: 'every',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);

		// The deparser emits NOT (EXISTS (...)) for notExists operator — outermost
		expect(normalized).toContain('NOT');
		// Both hops present
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Condition parameter preserved
		expect(parameters).toContain('approved');
		// NOT must appear AT LEAST TWICE: once for outer NOT(EXISTS), once for NOT(cond)
		const notCount = (normalized.match(/NOT/gi) ?? []).length;
		expect(notCount).toBeGreaterThanOrEqual(2);

		// Structural: the first NOT wraps the OUTERMOST (posts) hop
		const notIdx = normalized.indexOf('NOT');
		const postsFromIdx = normalized.search(/FROM\s+"?posts"?/i);
		const commentsFromIdx = normalized.search(/FROM\s+"?comments"?/i);
		expect(notIdx).toBeLessThan(postsFromIdx);
		expect(postsFromIdx).toBeLessThan(commentsFromIdx);
		// Inner EXISTS (posts hop's conditions) is positive — no NOT EXISTS between posts and comments
		const betweenHops = normalized.slice(postsFromIdx, commentsFromIdx);
		expect(betweenHops).not.toMatch(/NOT\s+EXISTS/i);
		// NOT(condition) appears after comments FROM
		const afterComments = normalized.slice(commentsFromIdx);
		expect(afterComments).toContain('NOT');
	});

	it('mode:some on multi-hop is UNCHANGED — positive EXISTS at outermost', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts', 'comments'],
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'eq',
						value: 'hello',
					},
					mode: 'some',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// Positive EXISTS — no NOT
		expect(normalized).not.toContain('NOT EXISTS');
		// Both hops present
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		expect(parameters).toContain('hello');
	});

	it('single-hop mode:none is UNCHANGED — NOT EXISTS wraps single hop (regression lock)', () => {
		// Single-hop: outermost === innermost, so outerOperator on i=0 is identical
		// to the old innerOperator on the single isInnermost hop.
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: false,
					},
					mode: 'none',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('NOT');
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(false);
		// No comments table
		expect(normalized).not.toMatch(/FROM\s+"?comments"?/i);
	});

	it('single-hop mode:every is UNCHANGED (regression lock)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
					mode: 'every',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// NOT (EXISTS (...)) + NOT condition
		expect(normalized).toContain('NOT');
		const notCount = (normalized.match(/NOT/gi) ?? []).length;
		expect(notCount).toBeGreaterThanOrEqual(2);
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(parameters).toContain(true);
		expect(normalized).not.toMatch(/FROM\s+"?comments"?/i);
	});
});

// ---------------------------------------------------------------------------
// 8. Nested exists-in-where: exists("posts", { where: exists("comments", ...) })
//
// Structurally different from multi-hop relationFilter(["posts","comments"]):
// the user writes explicit nested exists() calls inside the outer where.
//   Correct SQL:
//     EXISTS(SELECT 1 FROM posts WHERE users.id=posts.authorId
//              AND EXISTS(SELECT 1 FROM comments WHERE posts_alias.id=comments.postId
//                           AND comments.body=$1))
//
// Root cause (fixed):
//   1. convertWhereToDecisions had no handler for exists/notExists kinds
//      -> fell through to default:[] -> inner exists silently dropped entirely.
//   2. enrichExistsStubsInConditions now resolves the inner stub using the OUTER
//      targetTable (posts) as sourceTable - NOT the root table (users) - so
//      model.getRelation(posts.comments) is used for the inner FK, not
//      model.getRelation(users.comments).
// ---------------------------------------------------------------------------

describe('8. nested exists-in-where — correct inner FK correlation (nested-exists fix)', () => {
	it('exists(posts,{where:exists(comments,{where:eq(body,x)})}) produces two nested EXISTS', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'exists',
						relation: 'comments',
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: 'x',
						},
					},
				},
			} as any,
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// Two nested EXISTS
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
		// Both tables present
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);
		expect(normalized).toMatch(/FROM\s+"?comments"?/i);
		// Outer FK (users->posts hasMany, FK=authorId on posts)
		expect(normalized).toContain('authorId');
		// Inner FK (posts->comments hasMany, FK=postId on comments)
		expect(normalized).toContain('postId');
		// Inner filter NOT dropped
		expect(normalized).toMatch(/body\s*=\s*\$1/i);
		expect(parameters).toContain('x');
	});

	it('inner correlation is posts->comments NOT users->comments (key correctness check)', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'exists',
						relation: 'comments',
					},
				} as any,
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// authorId (outer posts correlation) before postId (inner comments correlation)
		const authorIdPos = normalized.indexOf('authorId');
		const postIdPos = normalized.indexOf('postId');
		expect(authorIdPos).toBeGreaterThan(-1);
		expect(postIdPos).toBeGreaterThan(-1);
		expect(authorIdPos).toBeLessThan(postIdPos);
	});

	it('exists-in-where under OR — inline position preserved, both FKs correct', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'or',
					conditions: [
						{
							kind: 'comparison',
							field: 'active',
							operator: 'eq',
							value: true,
						},
						{
							kind: 'exists',
							relation: 'posts',
							where: {
								kind: 'exists',
								relation: 'comments',
								where: {
									kind: 'comparison',
									field: 'body',
									operator: 'eq',
									value: 'y',
								},
							},
						},
					],
				} as any,
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		expect(normalized).toContain('OR');
		expect(normalized).toContain('authorId');
		expect(normalized).toContain('postId');
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
		expect(parameters).toContain('y');
	});

	it('single-level exists (no nesting) is UNCHANGED — zero regression', () => {
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'exists',
					relation: 'posts',
					where: {
						kind: 'comparison',
						field: 'published',
						operator: 'eq',
						value: true,
					},
				} as any,
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// Single EXISTS only
		const existsCount = (normalized.match(/EXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBe(1);
		// Correct outer FK
		expect(normalized).toContain('authorId');
		// Filter present
		expect(parameters).toContain(true);
		// No comments table leaked in
		expect(normalized).not.toMatch(/FROM\s+"?comments"?/i);
	});
});

// ---------------------------------------------------------------------------
// 9. DEFECT-2 — multi-hop mode:every with EMPTY predicate is vacuously true
//
// `every(TRUE)` = ∀ row . TRUE = TRUE.  Semantically this holds even for
// users who have no posts or comments: "every post of mine has every comment
// that satisfies TRUE" is trivially satisfied.
//
// Before the fix, an empty predicate (e.g. and() with no conditions) caused
// `rawInnerConditions = undefined`, so the multi-hop branch called
// `buildMultiHopExistsChain` with operator='notExists' and no inner
// conditions, producing: NOT EXISTS(posts WHERE correlation).
// That is "user has NO posts at all" — the opposite of vacuous truth.
//
// Fix: when isEvery && !rawInnerConditions, fall through to
// buildEnrichedExistsDecision (single-hop path, operator:'every'), which
// routes to everyHandler that returns TRUE literal when conditions is empty.
// ---------------------------------------------------------------------------

describe('9. DEFECT-2 — multi-hop mode:every with empty predicate is vacuously true', () => {
	it('mode:every with empty and() predicate does NOT produce "no posts" SQL', () => {
		// The bug: empty predicate → NOT EXISTS(posts ...) → "user has no posts"
		// The fix: empty predicate → vacuously TRUE (not NOT EXISTS)
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts', 'comments'],
					// and() with zero conditions = logically TRUE
					where: and(),
					mode: 'every',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql } = adapter.compile(planReport, { model: testSchema.model });
		const normalized = ws(sql);
		// Must NOT produce a NOT EXISTS that filters rows based on the path.
		// The everyHandler short-circuits to a bare TRUE constant when conditions
		// is empty — no subquery at all.
		expect(normalized).not.toMatch(/NOT\s+EXISTS/i);
		// The users query itself should still compile (no error, valid SQL)
		expect(normalized).toMatch(/FROM\s+"?users"?/i);
	});

	it('mode:every with empty and() predicate compiles without throwing', () => {
		expect(() =>
			plan(
				{
					type: 'select',
					from: 'users',
					where: {
						kind: 'relationFilter',
						relation: ['posts', 'comments'],
						where: and(),
						mode: 'every',
					},
				},
				testSchema.model,
				{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
			),
		).not.toThrow();
	});

	it('mode:every with a REAL predicate still uses NOT EXISTS (regression lock)', () => {
		// Verify the non-vacuous path is unchanged after the fix.
		const planReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts', 'comments'],
					where: {
						kind: 'comparison',
						field: 'body',
						operator: 'eq',
						value: 'approved',
					},
					mode: 'every',
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const { sql, parameters } = adapter.compile(planReport, {
			model: testSchema.model,
		});
		const normalized = ws(sql);
		// Non-vacuous every: still produces NOT ... EXISTS (the deparser may emit
		// NOT (EXISTS ...) or NOT EXISTS — both are acceptable).
		expect(normalized).toMatch(/NOT\s*\(?.*EXISTS/i);
		expect(parameters).toContain('approved');
	});
});
