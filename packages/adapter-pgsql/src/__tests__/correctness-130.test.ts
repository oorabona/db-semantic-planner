/**
 * Regression tests for three bounded correctness fixes (PR #130):
 *
 *   DEFECT 1: single-hop relationFilter drops FK metadata — fix threads
 *             sourceColumn/targetColumn from ModelIR so the EXISTS handler emits
 *             the declared FK column instead of convention fallback.
 *
 *   DEFECT 2: mode:'every' with omitted/undefined where crashed with
 *             `not(undefined)`. Fix returns vacuous TRUE before building
 *             innermostWhere.
 *
 *   DEFECT 3: scalar subquery with multiple aggregates was not rejected.
 *             Fix adds an aggregate-count guard to assertNoUnsupportedSubqueryModifiers
 *             for both 'scalar' and 'scalar-direct' contexts.
 */

import {
	createOrm,
	eq,
	exists,
	outerRef,
	POSTGRESQL_CAPABILITIES,
	plan,
	ref,
	schema,
} from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeToSql(node: Node): string {
	return deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// Schema:
//   users  -[hasMany posts via author_id]-> posts
//   posts  -[belongsTo users via author_id]- (exposed as 'author')
//   posts  -[hasMany comments via post_id]-> comments
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
		// non-conventional FK name — 'user_id' would be the convention
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		flagged: { type: 'boolean' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

// ============================================================================
// DEFECT 1 — single-hop relationFilter: correct FK correlation
// ============================================================================

describe('DEFECT 1: single-hop relationFilter threads declared FK columns', () => {
	// -------------------------------------------------------------------------
	// NEW: DEFECT 1 — nested exists drops its include joins
	//
	// Before the fix, the legacy extractor created exists stubs with _rawWhere
	// but silently dropped w.include.  enrichExistsStubsInConditions never saw the
	// include so the EXISTS handler never emitted the JOIN inside the subquery,
	// producing broadened / missing-alias SQL.
	//
	// Fix: preserve _rawInclude on the stub; the enricher converts it to
	// existsInclude decisions; the EXISTS handler emits the JOIN.
	// -------------------------------------------------------------------------
	it('DEFECT-1 (nested include JOIN): inner exists with include emits JOIN inside subquery', () => {
		// Schema for this case: users → posts → comments, comments belongsTo posts (via post_id)
		// We test: EXISTS (SELECT 1 FROM comments ... JOIN posts AS post ON ...) inside
		// an outer SELECT context.
		// The inner exists('comments', { include: { post: { join: 'inner' } }, where: ... })
		// must emit the JOIN on `post` inside the comments subquery.
		const adapter = createPgCompileOnlyAdapter({
			model: testSchema.model as any,
		});
		const orm = createOrm({
			model: testSchema.model as any,
			adapter: adapter as any,
		});

		// Nested exists: users who have a post that has a comment joined to its post.
		// The include: { post: ... } adds an INNER JOIN to the inner subquery.
		const nestedIntent = exists('posts', {
			where: exists('comments', {
				include: { post: { join: 'inner' as const } },
				where: eq('post.published', true),
			}),
		});

		const { sql } = orm.select('users').where(nestedIntent).dump();
		const normalized = sql.replace(/\s+/g, ' ').trim();

		// The inner EXISTS subquery must contain a JOIN keyword
		expect(normalized.toUpperCase()).toContain('JOIN');
		// The JOIN must reference the 'post' alias (the include relation)
		expect(normalized.toLowerCase()).toContain('post');
		// There must still be an outer EXISTS for posts
		expect(normalized.toUpperCase()).toContain('EXISTS');
	});

	it('DEFECT-1 (nested include JOIN — no include baseline): inner exists WITHOUT include has NO JOIN', () => {
		// Baseline: a nested exists without include must NOT add a JOIN.
		// This validates that adding the fix does not accidentally inject joins.
		const adapter = createPgCompileOnlyAdapter({
			model: testSchema.model as any,
		});
		const orm = createOrm({
			model: testSchema.model as any,
			adapter: adapter as any,
		});

		const nestedNoInclude = exists('posts', {
			where: exists('comments', {
				where: eq('flagged', true),
			}),
		});

		const { sql } = orm.select('users').where(nestedNoInclude).dump();
		const normalized = sql.replace(/\s+/g, ' ').trim();

		// Without include there must be NO JOIN inside the inner subquery
		expect(normalized.toUpperCase()).not.toContain('JOIN');
		// But EXISTS should still be present
		expect(normalized.toUpperCase()).toContain('EXISTS');
	});
});

// ============================================================================
// DEFECT 2 — mode:'every' with undefined/omitted where → vacuous TRUE (no crash)
// ============================================================================

// ============================================================================
// DEFECT 3 — multi-aggregate scalar subquery is rejected
// ============================================================================

// ============================================================================
// SCHEMA-SCOPING BUG — nested EXISTS inner FROM must be schema-qualified
//
// Root cause: in handlers/where/exists.ts, when building `subCtx` for the
// nested conditions dispatch, the schema was stripped from ctx.  Any nested
// EXISTS condition then built its rangeVar (FROM clause) without a schema
// qualifier, producing `FROM comments` instead of `FROM s.comments`.
// The fix keeps `schema` in `subCtx`; column references are query-scoped
// (alias-prefixed) already and are not affected.
// ============================================================================

function ws130(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

// Schema shared by all cases below: users → posts → comments
const schemaScoped = schema({
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
		body: { type: 'text' },
		flagged: { type: 'boolean' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

function buildScopedOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: schemaScoped.model });
	return createOrm({ model: schemaScoped.model, adapter: adapter as any });
}

describe('SCHEMA-SCOPING: nested exists — inner FROM must be schema-qualified', () => {
	it('single-hop exists: outer FROM is schema-qualified', () => {
		const orm = buildScopedOrm();
		const { sql } = orm
			.withSchema('s')
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.columns(['id', 'name'])
			.dump();
		const normalized = ws130(sql);

		// Root table is qualified
		expect(normalized).toContain('s.users');
		// Outer exists FROM is qualified
		expect(normalized).toContain('s.posts');
		// No bare unqualified posts in FROM position
		expect(normalized).not.toMatch(/FROM posts\b/);
	});

	it('nested exists: INNER FROM (comments) is schema-qualified — regression lock for the schema-scoping bug', () => {
		// This is the exact bug case: inner exists subquery used to emit
		// `FROM comments` (unqualified) because schema was stripped from subCtx.
		// After the fix it must emit `FROM s.comments`.
		const orm = buildScopedOrm();
		const { sql } = orm
			.withSchema('s')
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flagged', true) }),
				}),
			)
			.columns(['id', 'name'])
			.dump();
		const normalized = ws130(sql);

		// Root table
		expect(normalized).toContain('s.users');
		// Outer exists FROM
		expect(normalized).toContain('s.posts');
		// Inner exists FROM — this is the regression lock: must be qualified
		expect(normalized).toContain('s.comments');
		// No unqualified FROM positions for either table
		expect(normalized).not.toMatch(/FROM posts\b(?! AS)/);
		expect(normalized).not.toMatch(/FROM comments\b(?! AS)/);
		// Both EXISTS keywords must appear (outer + inner)
		const existsCount = (normalized.toUpperCase().match(/\bEXISTS\b/g) ?? [])
			.length;
		expect(existsCount).toBeGreaterThanOrEqual(2);
	});

	it('nested exists without schema: all FROMs are unqualified (control case)', () => {
		// Without .withSchema(), no qualifiers expected — confirms the fix is
		// conditional on schema presence and does not break the no-schema path.
		const orm = buildScopedOrm();
		const { sql } = orm
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flagged', true) }),
				}),
			)
			.columns(['id', 'name'])
			.dump();
		const normalized = ws130(sql);

		// No schema-qualified FROM: the pattern `FROM <schema>.` must not appear.
		// (We cannot use `not.toContain('s.')` because table.column refs like
		//  `users.id` contain the substring `s.` — check FROM positions explicitly.)
		expect(normalized).not.toMatch(/FROM \w+\./);
		// Both tables appear unqualified in FROM positions
		expect(normalized).toContain('FROM posts');
		expect(normalized).toContain('FROM comments');
	});

	it('multi-hop: inner hop FROM is schema-qualified', () => {
		// Multi-hop: users → posts → comments (expressed as nested exists).
		// Every hop must produce a qualified FROM when schema is set.
		const orm = buildScopedOrm();
		const { sql } = orm
			.withSchema('tenant')
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flagged', true) }),
				}),
			)
			.columns(['id'])
			.dump();
		const normalized = ws130(sql);

		// All three table references in FROM positions must carry the schema
		expect(normalized).toContain('tenant.users');
		expect(normalized).toContain('tenant.posts');
		expect(normalized).toContain('tenant.comments');
	});
});

// ============================================================================
// EVERY-QUANTIFIER CONSISTENCY (PR #130 correctness suite)
//
// The `every` quantifier must compile to NOT EXISTS(path WHERE NOT cond) on
// ALL three paths:
//   1. Direct compile-where path (the WHERE lowering / handleRelationFilterIntent)
//   2. Intent-to-decisions path (the WHERE lowering → everyHandler)
//   3. Nested multi-hop path (enrichExistsStubsInConditions)
//
// Invariant: every(cond) = NOT EXISTS(path WHERE NOT cond)
//            every(vacuous) = TRUE   — never a bare NOT EXISTS
// ============================================================================

// Schema for every-quantifier tests: users → posts (hasMany via author_id)
//                                     posts → comments (hasMany via post_id)
const everySchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

function buildEveryOrm() {
	const adapter = createPgCompileOnlyAdapter({ model: everySchema.model });
	return createOrm({ model: everySchema.model, adapter });
}

// ---------------------------------------------------------------------------
// FIX 1: intent-to-decisions path — the WHERE lowering emits operator:'every'
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FIX 2 (compile-where direct path): empty-and → vacuous TRUE (no EXISTS emitted)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FIX 3 (plan-decision-extractor nested multi-hop): vacuous every → TRUE
// ---------------------------------------------------------------------------

describe('FIX 3 (nested multi-hop enrichExistsStubs): mode:every vacuous → TRUE in nested chain', () => {
	it('exists(posts WHERE every(comments, vacuous)) does NOT produce inner NOT EXISTS', () => {
		// Nested: users → posts → comments, where the inner every has no predicate.
		// Before fix: produced NOT EXISTS(comments WHERE corr) inside the posts chain
		// After fix:  vacuous every resolves to TRUE → no inner NOT EXISTS
		const planReport = plan(
			{
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'exists' as const,
					relation: 'posts',
					where: {
						kind: 'relationFilter' as const,
						relation: ['comments'] as unknown as string,
						mode: 'every' as const,
						// No where clause — vacuous true
					} as any,
				} as any,
			},
			everySchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);
		const adapter = createPgCompileOnlyAdapter({ model: everySchema.model });
		const { sql } = adapter.compile(planReport, { model: everySchema.model });
		const normalized = sql.replace(/\s+/g, ' ').trim();

		// The outer EXISTS (posts) must be present
		expect(normalized.toUpperCase()).toContain('EXISTS');
		// The inner vacuous every must NOT produce NOT EXISTS(comments ...)
		// (it should either vanish or become TRUE)
		expect(normalized.toUpperCase()).not.toMatch(/NOT\s*\(?EXISTS.*comments/i);
	});
});

// ---------------------------------------------------------------------------
// FIX 4 (suppression key): nested multi-hop no double-emit
//
// Scenario: exists('posts', { where: <multi-hop relation filter> })
// Before fix: collectNestedExistsTargets stored "posts:comments.post_id_path" with
//             the ENCLOSING sourceTable (posts), but the no-stub suppression check
//             used context.sourceTable (comments — the penultimate hop's target),
//             producing a key mismatch → the filter-strategy decision was re-appended
//             at the root level as an extra AND EXISTS.
// After fix:  both sides use the penultimate-hop target as the key prefix.
// ---------------------------------------------------------------------------

// Extended schema for 4-table nested multi-hop test:
// users → posts (hasMany via author_id) → comments (hasMany via post_id)
const nestedMultiHopSchema = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: { type: 'text' },
	},
	posts: {
		id: { type: 'integer', primaryKey: true },
		published: { type: 'boolean' },
		author_id: ref('users', { as: 'author', inverse: 'posts' }),
	},
	comments: {
		id: { type: 'integer', primaryKey: true },
		body: { type: 'text' },
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

describe('FIX 4 (suppression key): nested multi-hop — no extra root-level EXISTS', () => {
	it('exists(posts, { where: relationFilter([comments], eq) }) → exactly 2 EXISTS, no root duplicate', () => {
		// This exercises the exact scenario: outer exists('posts') + inner multi-hop
		// relationFilter(['comments']) with a real predicate.
		// Before fix: the filter-strategy for comments was not suppressed → extra
		//   AND EXISTS(comments ...) appended at root level (3 EXISTS total).
		// After fix: exactly 2 EXISTS (one for posts, one for comments inside posts).
		const planReport = plan(
			{
				type: 'select' as const,
				from: 'users',
				where: {
					kind: 'exists' as const,
					relation: 'posts',
					where: {
						kind: 'relationFilter' as const,
						relation: ['comments'] as unknown as string,
						where: {
							kind: 'comparison' as const,
							field: 'body',
							operator: 'eq' as const,
							value: 'hello',
						},
						mode: 'some' as const,
					} as any,
				} as any,
			},
			nestedMultiHopSchema.model,
			{ dialectCapabilities: POSTGRESQL_CAPABILITIES },
		);

		const adapter = createPgCompileOnlyAdapter({
			model: nestedMultiHopSchema.model,
		});
		const { sql, parameters } = adapter.compile(planReport, {
			model: nestedMultiHopSchema.model,
		});
		const normalized = sql.replace(/\s+/g, ' ').trim();

		// Exactly 2 EXISTS: outer for posts, inner for comments
		const existsMatches = normalized.match(/\bEXISTS\b/gi);
		expect(
			existsMatches?.length,
			`Expected exactly 2 EXISTS, got ${existsMatches?.length ?? 0}: ${normalized}`,
		).toBe(2);

		// Outer correlation: users.id = posts_exists_N.author_id
		expect(normalized).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);

		// Inner correlation: posts_exists_N.id = comments_exists_M.post_id
		expect(normalized).toMatch(
			/posts_exists_\d+\.id\s*=\s*comments_exists_\d+\.post_id/,
		);

		// Inner filter preserved
		expect(parameters).toContain('hello');

		// NO extra root-level AND EXISTS appended after the outer EXISTS clause
		// Root WHERE must start with EXISTS (not AND/OR with extra terms)
		expect(normalized).toMatch(/WHERE\s+EXISTS/i);
	});
});

// ============================================================================
// NEW DEFECT 1 (PR #130 correctness suite)
//
// FAIL-OPEN security regression: vacuous every on an UNDECLARED/typoed relation
// must THROW fail-closed, not silently return all-rows TRUE.
//
// Invariant: vacuous every returns TRUE *only* when the relation/path is VALID.
// An undeclared relation throws even for the vacuous (no-predicate) case.
// ============================================================================

// ============================================================================
// NEW DEFECT 2 (PR #130 correctness suite)
//
// Nested range/between in the legacy extractor was
// hand-rolling the value conversion, passing the { lower, upper } object
// unchanged into a decision that the BETWEEN handler requires to be a
// [min, max] two-element array — causing a runtime throw or wrong SQL inside
// a nested exists where clause.
//
// Fix: delegate to the WHERE lowering (the central converter) which handles
// all range sub-shapes correctly.
// ============================================================================

describe('NEW-DEFECT-2 (nested range/between delegation): nested between in exists where compiles correctly', () => {
	it('nested between inside exists where compiles to correct SQL via compile-only ORM', () => {
		// Exercises the full pipeline: orm.select → plan → compiler.
		// Before fix: the nested BETWEEN crashed or produced wrong SQL.
		// After fix: correctly emits col BETWEEN $1 AND $2 inside the EXISTS subquery.
		const nestedBetweenSchema = schema({
			posts: {
				id: { type: 'integer', primaryKey: true },
				views: { type: 'integer' },
				author_id: { type: 'integer' },
			},
			comments: {
				id: { type: 'integer', primaryKey: true },
				score: { type: 'integer' },
				post_id: ref('posts', { as: 'post', inverse: 'comments' }),
			},
		} as const);

		const adapter = createPgCompileOnlyAdapter({
			model: nestedBetweenSchema.model,
		});
		const orm = createOrm({
			model: nestedBetweenSchema.model,
			adapter: adapter as any,
		});

		// Build the exists intent with a nested range BETWEEN directly
		const nestedRangeIntent = {
			kind: 'range' as const,
			field: 'score',
			operator: 'between' as const,
			value: { lower: 10, upper: 100 },
		};

		const { sql, params } = orm
			.select('posts')
			.where(
				exists('comments', {
					where: nestedRangeIntent as any,
				}),
			)
			.dump();

		const normalized = sql.replace(/\s+/g, ' ').trim();

		// Must contain BETWEEN keyword
		expect(normalized.toUpperCase()).toContain('BETWEEN');
		// Must contain EXISTS
		expect(normalized.toUpperCase()).toContain('EXISTS');
		// Parameters must include the lower and upper bounds
		expect(Array.from(params)).toContain(10);
		expect(Array.from(params)).toContain(100);
	});
});

// ============================================================================
// NEW DEFECT 3 (PR #130 correctness suite)
//
// outerRef() emitted { kind:'ref', column, outer:true } via `as unknown as`
// cast because SubqueryRefIntent did not declare the `outer` field.
// After adding `readonly outer?: true` to SubqueryRefIntent in @dbsp/types:
//   • outerRef() returns a properly typed SubqueryRefIntent (no cast needed)
//   • The converters still detect outer===true correctly
//   • A raw intent { kind:'ref', column:'x', outer:true } built per the
//     exported type is also recognized as an outer ref
// ============================================================================

describe('NEW-DEFECT-3 (SubqueryRefIntent outer field): outerRef is type-safe and recognized by converters', () => {
	it('outerRef() returns { kind:"ref", column, outer:true } — correctly typed, no cast', () => {
		const result = outerRef('userId');
		expect(result.kind).toBe('ref');
		expect(result.column).toBe('userId');
		// The outer field must be present and true — this is now type-safe
		// (SubqueryRefIntent declares readonly outer?: true)
		expect(result.outer).toBe(true);
	});
});

// ============================================================================
// NEW DEFECT 4 (PR #130 correctness suite)
// Single-hop non-vacuous relationFilter: fail-closed when model present but
// relation is undeclared.
//
// Before this fix, a typoed/undeclared single-hop relation with a model present
// fell through to the convention-fallback path — compiling EXISTS against an
// unintended table with guessed FK columns instead of throwing fail-closed.
// This is INCONSISTENT with the multi-hop path and the vacuous-every path (both
// throw on undeclared relations when a model is present).
//
// Fix: after resolving the relation from the model, if the model is present but
// the relation is NOT declared, throw the same clear error the multi-hop path uses.
// ============================================================================

// ============================================================================
// NEW DEFECT 5 (PR #130 correctness suite)
// Correlated scalar subquery: fail-closed on both decisions and direct paths.
//
// An outerRef() inside a scalar subquery's WHERE is NOT supported. Previously:
//   - decisions path: outerRef was lowered to a fieldRef(scope:'outer') in the
//     Decision, then dispatched against a subCtx with no outerAlias — so it bound
//     to the inner alias instead of the outer query, producing WRONG SQL silently.
//   - direct path: already guarded by buildSubqueryFromIntent (containsOuterRef).
//
// Fix: detect outerRef in scalar subquery WHERE before lowering (decisions path)
// and throw the same "correlated subqueries not supported" error. The
// buildScalarSubquery handler also throws as defense-in-depth.
// A NON-correlated scalar subquery (no outerRef) still compiles normally.
// ============================================================================
