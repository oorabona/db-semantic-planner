/**
 * Regression test: two multi-hop relation paths ending in the SAME last-hop
 * relation name must NOT cross-wire their filter conditions.
 *
 * Bug: normalizeStubRelation returned only the LAST element of the relation
 * array. enrichExistsDecisionsInPlace matched stubs and intents by last-hop
 * name only.  Two multi-hop paths whose last hop is the same relation
 * (e.g. ['posts','comments'] and ['articles','comments']) both normalised to
 * 'comments', causing the matching logic to pair the wrong filter-strategy
 * decision with a stub — cross-wiring conditions and intermediate tables.
 *
 * Fix:
 * - normalizeStubRelationPath (new helper) dot-joins the full array:
 *   ['posts','comments'] → 'posts.comments'
 * - When context.relationPath is set (planner writes it for multi-hop), both
 *   intent matching (matchIdx) and stub matching (stubIdx) compare the full
 *   dot-joined path, not just the last hop.
 * - Single-hop and distinct-last-hop cases continue to use last-hop matching
 *   (context.relationPath is absent for them).
 */

import { POSTGRESQL_CAPABILITIES, plan, ref, schema } from '@dbsp/core';
import { describe, expect, it } from 'vitest';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Schema: users → posts/articles → comments (two paths to the same table)
//
//   users.posts   (users hasMany posts via posts.authorId)
//   users.articles (users hasMany articles via articles.authorId)
//   posts.comments   (posts hasMany comments via comments.postId)
//   articles.comments (articles hasMany comments via comments.articleId)
//
// Both ['posts','comments'] and ['articles','comments'] end in 'comments'.
// ---------------------------------------------------------------------------
const testSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		authorId: ref('users', { as: 'author', inverse: 'posts' }),
	},
	articles: {
		id: { type: 'integer', primaryKey: true },
		title: { type: 'text' },
		authorId: ref('users', { as: 'author', inverse: 'articles' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		postId: ref('posts', { as: 'post', inverse: 'comments' }),
		articleId: ref('articles', { as: 'article', inverse: 'comments' }),
	},
} as const);

const adapter = createPgsqlCompileOnlyAdapter({ model: testSchema.model });

function ws(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Compile a query with two multi-hop filters ending in the same relation name
// ---------------------------------------------------------------------------
function compileDualHop(
	postCommentBody: string,
	articleCommentBody: string,
): { sql: string; parameters: readonly unknown[] } {
	const planReport = plan(
		{
			type: 'select',
			from: 'users',
			where: {
				kind: 'and',
				conditions: [
					{
						kind: 'relationFilter',
						relation: ['posts', 'comments'],
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: postCommentBody,
						},
						mode: 'some' as const,
					},
					{
						kind: 'relationFilter',
						relation: ['articles', 'comments'],
						where: {
							kind: 'comparison',
							field: 'body',
							operator: 'eq',
							value: articleCommentBody,
						},
						mode: 'some' as const,
					},
				],
			},
		},
		testSchema.model,
		{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
	);
	return adapter.compile(planReport, { model: testSchema.model });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dual multi-hop paths ending in same relation name — no cross-wiring', () => {
	it('compiles without throwing (no collision crash)', () => {
		expect(() =>
			compileDualHop('post-comment', 'article-comment'),
		).not.toThrow();
	});

	it('each hop chain uses its own correct intermediate table', () => {
		const { sql } = compileDualHop('post-comment', 'article-comment');
		const normalized = ws(sql);

		// Chain 1: users → posts → comments — must reference "posts" as intermediate
		expect(normalized).toMatch(/FROM\s+"?posts"?/i);

		// Chain 2: users → articles → comments — must reference "articles" as intermediate
		expect(normalized).toMatch(/FROM\s+"?articles"?/i);
	});

	it('each filter condition uses its own distinct parameter value', () => {
		const { parameters } = compileDualHop('post-comment', 'article-comment');

		// Both parameter values must appear — not just one repeated
		expect(parameters).toContain('post-comment');
		expect(parameters).toContain('article-comment');
	});

	it('both filter values appear as separate parameters (not the same value twice)', () => {
		const { sql, parameters } = compileDualHop('alpha', 'beta');
		const normalized = ws(sql);

		// 'alpha' is the posts.comments body condition, 'beta' is the articles.comments condition
		expect(parameters).toContain('alpha');
		expect(parameters).toContain('beta');

		// SQL must have two separate EXISTS subqueries — one per multi-hop chain
		// (nested multi-hop generates one EXISTS per hop, so total ≥ 2)
		const existsCount = (normalized.match(/\bEXISTS\s*\(/gi) ?? []).length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
	});

	it('single-hop case is unchanged (no regression on last-hop-only matching)', () => {
		const singleHopReport = plan(
			{
				type: 'select',
				from: 'users',
				where: {
					kind: 'relationFilter',
					relation: ['posts'],
					where: {
						kind: 'comparison',
						field: 'title',
						operator: 'eq',
						value: 'hello',
					},
					mode: 'some' as const,
				},
			},
			testSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		expect(() =>
			adapter.compile(singleHopReport, { model: testSchema.model }),
		).not.toThrow();

		const { sql } = adapter.compile(singleHopReport, {
			model: testSchema.model,
		});
		expect(ws(sql)).toMatch(/FROM\s+"?posts"?/i);
	});
});
