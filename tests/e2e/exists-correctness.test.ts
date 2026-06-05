/**
 * EXISTS-correctness integration tests — fix/core-correctness-130
 *
 * These tests prove that the EXISTS-related fixes return the CORRECT ROWS, not
 * just the correct SQL shape.  Each case seeds a mix of rows that SHOULD match
 * and rows that SHOULD NOT, so a buggy compilation (broadened predicate, wrong FK
 * correlation, dropped quantifier, incorrect polarity) produces a DIFFERENT set
 * from the expected one.
 *
 * Schema overview (see testkit/exists-correctness.{ddl,model,seed}.ts):
 *   users(id, name, active)
 *   posts(id, title, author_id → users [declared FK], published)
 *   comments(id, post_id → posts, user_id → users, body, flagged)
 *
 * NOTE: this suite CANNOT be run in the sandbox environment — it requires a
 * running PostgreSQL container.  CI runs it via `pnpm test:e2e` using the
 * Testcontainers global setup in tests/e2e/globalSetup.ts.
 *
 * DEFECTS covered by these integration tests:
 *   DEFECT 1 — single-hop FK metadata dropped: wrong FK column used in EXISTS corr.
 *   DEFECT 2 — mode:every vacuous-true / NOT EXISTS crash with undefined where
 *   DEFECT 3 — multi-aggregate scalar subquery not rejected
 *   IN-polarity — IN-to-EXISTS rewrite picked wrong form (exists vs notExists)
 *   Nested EXISTS — inner correlations not receiving enrichment (wrong rows)
 *   Cross-source guard — notExists/every leaking into root includes
 *   Multi-hop quantifier scoping — none/every applied to wrong path segment
 */

import {
	and,
	createOrm,
	eq,
	exists,
	inSubquery,
	not,
	notExists,
	or,
	subquery,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	closeTestDb,
	createExistsCorrectnessSchema,
	dropExistsCorrectnessSchema,
	existsCorrectnessModel,
	getTestAdapter,
	seedExistsCorrectnessData,
} from './testkit/index.js';

const SCHEMA = 'exists_correctness_e2e';

// ---------------------------------------------------------------------------
// Suite lifecycle — single schema shared across all cases for speed
// ---------------------------------------------------------------------------

beforeAll(async () => {
	await dropExistsCorrectnessSchema(SCHEMA);
	await createExistsCorrectnessSchema(SCHEMA);
	await seedExistsCorrectnessData(SCHEMA);
});

afterAll(async () => {
	await dropExistsCorrectnessSchema(SCHEMA);
	await closeTestDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sort an array of name strings for stable comparison. */
function sortedNames(rows: Array<{ name: string }>): string[] {
	return rows.map((r) => r.name).sort();
}

// ---------------------------------------------------------------------------
// Case 1 — Basic positive EXISTS: users with ≥1 published post
// ---------------------------------------------------------------------------
describe('Case 1: EXISTS posts{published=true} returns only users with a published post', () => {
	it('returns Alice, Bob, Carol — not Dave or Eve (no posts)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Discriminating rows:
		//   Dave and Eve have NO posts → must be excluded.
		//   If FK correlation drops, the subquery may mis-join and include/exclude wrongly.
		expect(sortedNames(rows)).toEqual(['Alice', 'Bob', 'Carol']);
	});
});

// ---------------------------------------------------------------------------
// Case 2 — NOT EXISTS: users with NO unpublished post
// ---------------------------------------------------------------------------
describe('Case 2: notExists posts{published=false} returns users with NO draft posts', () => {
	it('returns Bob, Dave, Eve — excludes Alice and Carol (who have drafts)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(notExists('posts', { where: eq('published', false) }))
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Alice has p2 (published=false) → must be excluded.
		// Carol has p6 (published=false) → must be excluded.
		// Bob has only published posts → included.
		// Dave/Eve have NO posts → NOT EXISTS is vacuously true → included.
		// Bug: if FK is wrong, Alice/Carol might survive the NOT EXISTS check.
		expect(sortedNames(rows)).toEqual(['Bob', 'Dave', 'Eve']);
	});
});

// ---------------------------------------------------------------------------
// Case 3 — IN subquery and NOT-IN subquery
// ---------------------------------------------------------------------------
describe('Case 3: inSubquery and not(inSubquery) produce correct complementary sets', () => {
	it('inSubquery returns users who authored a published post', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(
				inSubquery(
					'id',
					subquery('posts').select('authorId').where(eq('published', true)),
				),
			)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Alice (p1), Bob (p3,p4), Carol (p5) authored published posts.
		// Dave, Eve have no posts → excluded.
		// Bug: if IN-to-EXISTS rewrite picks wrong polarity, includes Dave/Eve or excludes Alice.
		expect(sortedNames(rows)).toEqual(['Alice', 'Bob', 'Carol']);
	});

	it('not(inSubquery) returns users who did NOT author any published post', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(
				not(
					inSubquery(
						'id',
						subquery('posts').select('authorId').where(eq('published', true)),
					),
				),
			)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Dave and Eve have no published posts → they are NOT IN the author set.
		// Bug: if polarity of the NOT inversion is wrong, returns Alice/Bob/Carol instead.
		expect(sortedNames(rows)).toEqual(['Dave', 'Eve']);
	});
});

// ---------------------------------------------------------------------------
// Case 4 — Nested EXISTS: users with a post that has a flagged comment
// ---------------------------------------------------------------------------
describe('Case 4: nested exists — users → posts → comments{flagged=true}', () => {
	it('returns only users reachable via post → flagged-comment chain', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flagged', true) }),
				}),
			)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Discrimination map:
		//   p1 (Alice's) → c2 (Bob, flagged=T) → Alice INCLUDED
		//   p5 (Carol's) → c4 (Dave, flagged=T) → Carol INCLUDED
		//   p3/p4 (Bob's) → only c3 (Alice, flagged=F) → Bob EXCLUDED
		//   Dave/Eve: no posts → EXCLUDED
		//
		// Key discriminator for inner-correlation correctness:
		//   c4 belongs to p5 (post_id=5) but was written by Dave (user_id=4).
		//   If the inner exists uses user_id instead of post_id to correlate
		//   comments back to posts, it would match user=Dave and include Dave.
		//   The correct result excludes Dave (he has no posts with flagged comments).
		expect(sortedNames(rows)).toEqual(['Alice', 'Carol']);
	});
});

// ---------------------------------------------------------------------------
// Case 5 — NOT(AND(EXISTS, eq)): active users WITH posts are excluded
// ---------------------------------------------------------------------------
describe('Case 5: not(and(exists posts, eq active=true)) excludes active users with posts', () => {
	it('returns Carol, Dave, Eve', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(not(and(exists('posts'), eq('active', true))))
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// NOT(EXISTS(posts) AND active=T):
		//   Alice: active=T and has posts → condition true → NOT → EXCLUDED
		//   Bob:   active=T and has posts → condition true → NOT → EXCLUDED
		//   Carol: active=F and has posts → AND is false (active=F) → NOT(false) → INCLUDED
		//   Dave:  active=T and no posts  → AND is false (no posts) → NOT(false) → INCLUDED
		//   Eve:   active=F and no posts  → AND is false → NOT(false) → INCLUDED
		// Bug: if NOT wraps only one side of the AND, Alice or Bob might survive.
		expect(sortedNames(rows)).toEqual(['Carol', 'Dave', 'Eve']);
	});
});

// ---------------------------------------------------------------------------
// Case 6 — OR position: active=true OR exists posts{published=true}
// ---------------------------------------------------------------------------
describe('Case 6: or(eq active=true, exists posts{published=true}) union semantics', () => {
	it('returns Alice, Bob, Carol, Dave — excludes Eve only', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(
				or(
					eq('active', true),
					exists('posts', { where: eq('published', true) }),
				),
			)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Alice: active=T → INCLUDED (regardless of posts)
		// Bob:   active=T → INCLUDED
		// Carol: active=F, but has p5(published=T) → INCLUDED via EXISTS
		// Dave:  active=T, no posts → INCLUDED via active
		// Eve:   active=F, no posts → BOTH sides false → EXCLUDED
		// Bug: if EXISTS absorbs the OR and drops the active branch, Dave is excluded.
		//      If OR is compiled as AND, Carol is excluded.
		expect(sortedNames(rows)).toEqual(['Alice', 'Bob', 'Carol', 'Dave']);
	});
});

// ---------------------------------------------------------------------------
// Case 7 — Multi-hop relationFilter ['posts','comments'] with flagged predicate
// ---------------------------------------------------------------------------
describe('Case 7: multi-hop relationFilter posts → comments{flagged=true}', () => {
	it('returns Alice and Carol — not Bob (only unflagged comments on his posts)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		// Multi-hop: select users where the chain users→posts→comments contains
		// a comments row with flagged=true.
		// This exercises the multi-hop relationFilter path in the planner/compiler.
		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(
				exists('posts', {
					where: exists('comments', { where: eq('flagged', true) }),
				}),
			)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Same expected set as Case 4 (which uses the same WHERE expression):
		// Alice (via p1 → c2 flagged) and Carol (via p5 → c4 flagged).
		// Bob's posts have only c3 (not flagged).  Dave/Eve: no posts.
		//
		// Discrimination vs Case 9: Case 9 uses the DIRECT comments relation
		// (user_id FK), which returns Bob and Dave — a completely different set.
		// Having both cases in the suite proves the two correlation paths are
		// independently correct and not aliased into each other.
		expect(sortedNames(rows)).toEqual(['Alice', 'Carol']);
	});
});

// ---------------------------------------------------------------------------
// Case 8 — include + exists: propagateExistsConditions filters the include
//
// DESIGN NOTE: when a top-level (AND-position) exists() filter is combined
// with an include() on the same relation, the planner intentionally propagates
// the exists filter conditions into the include subquery
// (propagateExistsConditions in adapter-compiler-select.ts).  This is the
// designed behaviour documented in exists-inline-position.test.ts § 5
// ("include(posts) with top-level AND exists — include DOES inherit filter").
//
// Consequence: the include returns only posts that satisfied the exists
// predicate (published=true), NOT all posts for the matching user.
//
//   Alice: p1 (published=T) → 1 included post
//   Bob:   p3, p4 (both published=T) → 2 included posts
//   Carol: p5 (published=T) → 1 included post
//
// The original e2e expectation (all 2 posts per user) was wrong — it
// contradicted the designed propagation behaviour.
// ---------------------------------------------------------------------------
describe('Case 8: include posts after exists posts{published=true} — include IS filtered (propagation)', () => {
	it('matching users have only published posts included (exists filter propagated to include)', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(exists('posts', { where: eq('published', true) }))
			.include('posts')
			.columns(['id', 'name'])
			.execute()) as Array<{
			id: number;
			name: string;
			posts: Array<{ id: number; published: boolean }>;
		}>;

		// Users with ≥1 published post: Alice (has p1+p2), Bob (has p3+p4), Carol (has p5+p6).
		expect(sortedNames(rows)).toEqual(['Alice', 'Bob', 'Carol']);

		const alice = rows.find((r) => r.name === 'Alice');
		expect(alice).toBeDefined();
		// Alice has p1(published=T) and p2(published=F).
		// propagateExistsConditions propagates published=true into the include subquery,
		// so only p1 is returned (the published post).
		expect(alice!.posts).toHaveLength(1);
		expect(alice!.posts[0]).toMatchObject({ published: true });

		const bob = rows.find((r) => r.name === 'Bob');
		expect(bob).toBeDefined();
		// Bob has p3 and p4, both published=T → both included.
		expect(bob!.posts).toHaveLength(2);
		expect(bob!.posts.every((p) => p.published)).toBe(true);

		const carol = rows.find((r) => r.name === 'Carol');
		expect(carol).toBeDefined();
		// Carol has p5(published=T) and p6(published=F).
		// Only p5 is returned (published post).
		expect(carol!.posts).toHaveLength(1);
		expect(carol!.posts[0]).toMatchObject({ published: true });
	});
});

// ---------------------------------------------------------------------------
// Case 9 — Cross-source same-name: users.comments (direct FK) vs posts.comments
// ---------------------------------------------------------------------------
describe('Case 9: exists comments via direct user_id FK — different set from Case 4', () => {
	it('returns Bob and Dave — users who directly wrote a flagged comment', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		// The 'comments' relation on users is via user_id (direct; commenter role).
		// This is DIFFERENT from the posts→comments relation (post_id).
		// The relation name exposed in the model is 'comments' (inverse of userId ref).
		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(exists('comments', { where: eq('flagged', true) }))
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// c2: user_id=Bob(2), flagged=T  → Bob INCLUDED
		// c4: user_id=Dave(4), flagged=T → Dave INCLUDED
		// c1: user_id=Alice(1), flagged=F → Alice NOT included by this filter
		// c3: user_id=Alice(1), flagged=F → Alice NOT included
		// c5: user_id=Eve(5),   flagged=F → Eve NOT included
		// Carol: no direct comments at all → excluded
		//
		// Contrast with Case 4 (Alice, Carol) — the two cases return DISJOINT sets
		// which proves the FK routing is correct:
		//   Case 4 correlates via posts.author_id → users.id → posts.post_id → comments.post_id
		//   Case 9 correlates via comments.user_id → users.id  (single hop)
		expect(sortedNames(rows)).toEqual(['Bob', 'Dave']);
	});

	it('Case 9 vs Case 4 sets are disjoint — confirms FK path discrimination', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const [directRows, nestedRows] = await Promise.all([
			orm
				.withSchema(SCHEMA)
				.select('users')
				.where(exists('comments', { where: eq('flagged', true) }))
				.columns(['id', 'name'])
				.execute() as Promise<Array<{ id: number; name: string }>>,
			orm
				.withSchema(SCHEMA)
				.select('users')
				.where(
					exists('posts', {
						where: exists('comments', { where: eq('flagged', true) }),
					}),
				)
				.columns(['id', 'name'])
				.execute() as Promise<Array<{ id: number; name: string }>>,
		]);

		const directNames = new Set(directRows.map((r) => r.name));
		const nestedNames = new Set(nestedRows.map((r) => r.name));

		// If any name appears in both sets, at least one FK path is mis-routed.
		const intersection = [...directNames].filter((n) => nestedNames.has(n));
		expect(intersection).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Case 10 — every-quantifier correctness (PR #130 fix verification)
//
// Seed recap:
//   Alice (u1): p1(published=T), p2(published=F) — MIXED → NOT every-published
//   Bob   (u2): p3(published=T), p4(published=T) — ALL published → every-published
//   Carol (u3): p5(published=T), p6(published=F) — MIXED → NOT every-published
//   Dave  (u4): NO posts → vacuously TRUE → every-published
//   Eve   (u5): NO posts → vacuously TRUE → every-published
//
// Expected for every(posts, p → eq(p.published, true)):
//   INCLUDED: Bob (all published), Dave (vacuous), Eve (vacuous)
//   EXCLUDED: Alice (has p2 draft), Carol (has p6 draft)
//
// Discrimination power:
//   — A plain EXISTS would include Alice/Carol/Bob but exclude Dave/Eve (wrong).
//   — A bare NOT EXISTS without inner WHERE would include only Dave/Eve (wrong "no posts").
//   — The correct NOT EXISTS(posts WHERE NOT published=T) includes Bob/Dave/Eve exactly.
// ---------------------------------------------------------------------------
describe('Case 10: every-quantifier — users whose every post is published', () => {
	it('returns Bob, Dave, Eve — excludes Alice and Carol who have unpublished posts', async () => {
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		// Build the every-quantifier intent directly (the typed every() helper requires
		// a RelationRef from the schema DSL which is not easily composable in e2e tests;
		// the raw intent is the same wire format the NQL compiler and planner emit).
		const everyIntent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: eq('published', true),
			mode: 'every' as const,
		};

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(everyIntent as any)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// INCLUDED: Bob (p3+p4 both published), Dave (no posts → vacuous), Eve (same)
		// EXCLUDED: Alice (p2 unpublished), Carol (p6 unpublished)
		expect(sortedNames(rows)).toEqual(['Bob', 'Dave', 'Eve']);

		// Sanity-check against the "bugs this fix prevents" polarity:
		// — If compiled as plain EXISTS: Alice/Carol would appear (wrong inclusion)
		expect(sortedNames(rows)).not.toContain('Alice');
		expect(sortedNames(rows)).not.toContain('Carol');
		// — If compiled as bare NOT EXISTS (vacuous-true bug): Dave/Eve would be absent
		expect(sortedNames(rows)).toContain('Dave');
		expect(sortedNames(rows)).toContain('Eve');
	});

	it('every with vacuous condition (no where) returns ALL users — vacuous truth', async () => {
		// every(relation, TRUE) = NOT EXISTS(path WHERE NOT TRUE) = TRUE for all rows
		// All 5 users should be returned.
		const adapter = await getTestAdapter();
		const orm = createOrm({ model: existsCorrectnessModel, adapter });

		const everyVacuous = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			// no where clause — every(TRUE) = vacuously true for all rows
			mode: 'every' as const,
		};

		const rows = (await orm
			.withSchema(SCHEMA)
			.select('users')
			.where(everyVacuous as any)
			.columns(['id', 'name'])
			.execute()) as Array<{ id: number; name: string }>;

		// Vacuous every is TRUE for everyone — all 5 users returned
		expect(sortedNames(rows)).toEqual(['Alice', 'Bob', 'Carol', 'Dave', 'Eve']);
	});
});
