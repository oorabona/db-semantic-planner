/**
 * @fileoverview Tests for .exists() and .existsDump() on QueryBuilder (DX-CATA-1 Block 1).
 * Acceptance criteria A1-A9.
 */

import { createPgsqlCompileOnlyAdapter } from '@dbsp/adapter-pgsql';
import { describe, expect, it, vi } from 'vitest';
import type { Adapter, Dump } from '../adapter.js';
import { eq } from './filters.js';
import { createHookManager } from './hooks.js';
import { createOrm } from './orm.js';
import { ref, schema } from './schema.js';
import { createMockAdapter } from './test-utils.js';

// ============================================================================
// Test Setup
// ============================================================================

const testSchema = schema({
	users: {
		id: 'uuid',
		name: 'string',
		email: 'string',
		active: 'boolean',
		role: 'string',
	},
	posts: {
		id: 'uuid',
		title: 'string',
		author: ref('users'),
	},
});

/**
 * Create a mock adapter that records compile calls and returns controllable execute results.
 */
function createSpyAdapter(executeResult: unknown[] = []) {
	const base = createMockAdapter();
	const compileSpy = vi.fn((_plan: unknown, _opts?: unknown) => ({
		sql: 'SELECT 1',
		parameters: [] as readonly unknown[],
	}));
	const executeSpy = vi.fn(() => Promise.resolve(executeResult));
	const createDumpSpy = vi.fn(
		(
			_plan: unknown,
			compiled: { sql: string; parameters: readonly unknown[] },
		) =>
			({
				sql: compiled.sql,
				params: compiled.parameters,
				plan: {},
			}) as unknown as Dump,
	);

	// Create a self-referential adapter so withSchema returns the same spy
	const adapter = {
		...base,
		compile: compileSpy,
		execute: executeSpy,
		createDump: createDumpSpy,
		withSchema: (_schemaName: string) => adapter, // Return self to preserve spies
		_spies: {
			compile: compileSpy,
			execute: executeSpy,
			createDump: createDumpSpy,
		},
	} as unknown as Adapter & {
		_spies: {
			compile: typeof compileSpy;
			execute: typeof executeSpy;
			createDump: typeof createDumpSpy;
		};
	};
	return adapter;
}

/**
 * Create an adapter that compiles REAL SQL (via the pgsql compile-only
 * adapter) while stubbing `execute()` — lets the hook-aware `.exists()` path
 * run to completion (it awaits `adapter.execute()`) while still exposing the
 * genuine compiled SQL text through the `compile` spy's recorded return
 * value, so the hook path can be asserted at the same SQL-equals rigor as
 * the non-hook path (#230 finding: the hook path had its own copy of the
 * stripping logic and must be proven fixed independently).
 */
function createHookProbeAdapter(executeResult: unknown[] = []) {
	const real = createPgsqlCompileOnlyAdapter();
	// Capture the genuine compile BEFORE shadowing it, so the spy delegates to
	// the real compiler (real SQL) without recursing into itself.
	const realCompile = real.compile.bind(real);
	const compileSpy = vi.fn(
		(
			plan: Parameters<Adapter['compile']>[0],
			opts?: Parameters<Adapter['compile']>[1],
		) => realCompile(plan, opts as never),
	);
	const executeSpy = vi.fn(() => Promise.resolve(executeResult));
	// Shadow compile/execute as OWN properties on the real instance rather than
	// spreading it: a spread drops prototype getters/methods (dialectCapabilities,
	// createDump, dbCasing, …), leaving a non-faithful mock. Mutating keeps every
	// other member resolving through the real prototype with real private state.
	Object.assign(real as object, {
		compile: compileSpy,
		execute: executeSpy,
		_spies: { compile: compileSpy, execute: executeSpy },
	});
	Object.defineProperty(real, 'connectionAvailability', {
		value: { status: 'available' },
		configurable: true,
	});
	return real as unknown as Adapter & {
		_spies: {
			compile: typeof compileSpy;
			execute: typeof executeSpy;
		};
	};
}

/**
 * A real pgsql compile-only adapter with `dialectCapabilities` monkey-patched
 * to declare `supportsRecursiveCTE: false` — used to prove the planner's
 * #230 recursive-include skip fires BEFORE the `supportsRecursiveCTE`
 * capability throw (planner.ts), through the FULL public `.exists()` /
 * `.existsDump()` entry point rather than a hand-built PlanReport that
 * bypasses the planner entirely (the gap a compiler-only test cannot close).
 *
 * The real pgsql adapter's `dialectCapabilities` is a class getter (always
 * `supportsRecursiveCTE: true` — PostgreSQL natively supports `WITH
 * RECURSIVE`), so `Object.defineProperty` shadows it with an own property on
 * the SAME instance — every other adapter method (compile, createDump, …)
 * stays the real implementation; only capability negotiation is overridden.
 */
function createRecursiveCapabilityGuardAdapter() {
	const adapter = createPgsqlCompileOnlyAdapter();
	const original = adapter.dialectCapabilities;
	Object.defineProperty(adapter, 'dialectCapabilities', {
		get: () => ({ ...original, supportsRecursiveCTE: false }),
		configurable: true,
	});
	return adapter;
}

// ============================================================================
// Tests
// ============================================================================

describe('DX-CATA-1: .exists() and .existsDump()', () => {
	describe('A1: exists() returns true on non-empty result', () => {
		it('returns true when rows exist', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').exists();
			expect(result).toBe(true);
		});
	});

	describe('A2: exists() returns false when no match', () => {
		it('returns false when no rows match', async () => {
			const adapter = createSpyAdapter([{ exists: false }]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').where(eq('id', '999')).exists();
			expect(result).toBe(false);
		});
	});

	describe('A3: exists() returns false on empty table', () => {
		it('returns false when execute returns empty array', async () => {
			const adapter = createSpyAdapter([]);
			const orm = createOrm({ adapter, schema: testSchema });

			const result = await orm.select('users').exists();
			expect(result).toBe(false);
		});
	});

	describe('A5: existsDump() returns Dump', () => {
		it('returns a Dump object', () => {
			const adapter = createSpyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm.select('users').where(eq('active', true)).existsDump();
			expect(dump).toBeDefined();
			expect(dump.sql).toBeDefined();
			expect(dump.params).toBeDefined();
		});
	});

	describe('A6: a pure-hydration include has no effect on exists() (kept in the intent, discarded by existsWrap)', () => {
		it('keeps include in the exists intent — existsWrap discards its hydration, not intent-level pruning', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').include('posts').exists();

			// Verify compile was called and inspect the plan's intent
			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			expect(compileCalls.length).toBe(1);
			const firstCall = compileCalls[0];
			expect(firstCall).toBeDefined();
			const planArg = firstCall![0] as {
				intent?: { include?: unknown; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			// Correct-by-construction design (#230): buildExistsIntent does NOT
			// prune includes — nothing does. The include stays in `intent.include`
			// (this assertion); it compiles normally, and existsWrap's `SELECT 1`
			// discards the target-list hydration (default json_agg) for free (see
			// the "#230: exists() keeps every include" describe block below for the
			// SQL-level proof).
			expect(planArg.intent?.include).toBeDefined();
		});
	});

	describe('A7: groupBy and having are preserved in exists()', () => {
		it('preserves groupBy in the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm
				.select('users')
				.groupBy(['role'])
				.having(eq('role', 'admin'))
				.exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { groupBy?: string[]; having?: unknown };
			};
			expect(planArg.intent?.groupBy).toEqual(['role']);
			expect(planArg.intent?.having).toBeDefined();
		});
	});

	describe('A8: orderBy is stripped in exists()', () => {
		it('removes orderBy from the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').orderBy('name').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { orderBy?: unknown; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			expect(planArg.intent?.orderBy).toBeUndefined();
		});
	});

	describe('A9: offset is preserved in exists()', () => {
		it('preserves offset in the exists intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').offset(5).exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as { intent?: { offset?: number } };
			expect(planArg.intent?.offset).toBe(5);
		});
	});

	describe('exists sets limit to 1 and existsWrap to true', () => {
		it('sets limit=1 and existsWrap=true in the intent', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.select('users').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const planArg = compileCalls[0]![0] as {
				intent?: { limit?: number; existsWrap?: boolean };
			};
			expect(planArg.intent?.existsWrap).toBe(true);
			expect(planArg.intent?.limit).toBe(1);
		});
	});

	describe('#230: exists() keeps every include (correct-by-construction) — existsWrap swaps the target list for `1`, so target-list hydration (json_agg) vanishes for free while FROM joins (inner/left/lateral/cte) ride along and filter/multiply exactly like the full query', () => {
		const nestedSchema = schema({
			users: {
				id: 'uuid',
				name: 'string',
				email: 'string',
				active: 'boolean',
				role: 'string',
			},
			posts: {
				id: 'uuid',
				title: 'string',
				author: ref('users'),
			},
			comments: {
				id: 'uuid',
				body: 'string',
				post: ref('posts'),
			},
		});

		const categorySchema = schema({
			categories: {
				id: { type: 'integer', primaryKey: true },
				name: 'string',
				parentId: ref('categories', {
					nullable: true,
					as: 'parent',
					inverse: 'children',
					roles: { parent: 'parent', children: 'children' },
				}),
			},
		} as never);

		it('keeps the JOIN + its where for an inner-join include (full SQL, the #230 repro)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('posts')
				.include('author', { join: 'inner', where: eq('id', 999999) })
				.where(eq('title', 'x'))
				.existsDump();

			// sql.equals: full SQL comparison — an inner-join include must NOT be
			// silently dropped from an EXISTS subquery: existsWrap only replaces
			// the target list with `1`, the JOIN + WHERE survive untouched.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM posts JOIN users AS author ON posts.author = author.id WHERE posts.title = $1 AND author.id = $2 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual(['x', 999999]);
		});

		it('keeps the LEFT JOIN + its where for a left-join include (also filters — was wrongly dropped by the inner-only design)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('posts')
				.include('author', { join: 'left', where: eq('id', 999999) })
				.where(eq('title', 'x'))
				.existsDump();

			// A LEFT JOIN with a where on the joined table's column is a real
			// filter too (rows where the join didn't match have that column
			// NULL, which fails the where) — a prior "inner-only" classification
			// design wrongly dropped this. existsWrap keeps the LEFT JOIN and
			// folds the where into the root WHERE exactly like the non-exists path.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM posts LEFT JOIN users AS author ON posts.author = author.id WHERE posts.title = $1 AND author.id = $2 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual(['x', 999999]);
		});

		it('keeps a to-many LEFT JOIN under offset() so row multiplicity stays correct', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('users')
				.include('posts', { join: 'left' })
				.offset(1)
				.existsDump();

			// A to-many LEFT JOIN duplicates the root row per matching child —
			// that row multiplication is what `offset` counts against. Pruning
			// this include (as a prior design did) would silently change which
			// "row" offset(1) skips. existsWrap must keep the JOIN.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users LEFT JOIN posts AS author_posts ON users.id = author_posts.author LIMIT 1 OFFSET 1) AS "exists"',
			);
			expect(dump.params).toEqual([]);
		});

		it('preserves an explicit .limit(0) — an empty result set makes .exists() false, never a spurious true (any positive limit is capped to 1)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			// .limit(0) means "no rows": EXISTS must be over an empty set, so the
			// wrapped query keeps LIMIT 0 → `SELECT EXISTS (SELECT 1 ... LIMIT 0)`
			// is false, not a spurious true from a forced LIMIT 1.
			const zero = orm.select('users').limit(0).existsDump();
			expect(zero.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users LIMIT 0) AS "exists"',
			);

			// Any positive user limit is capped to 1 — EXISTS only needs to know
			// one row survives.
			const five = orm.select('users').limit(5).existsDump();
			expect(five.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users LIMIT 1) AS "exists"',
			);
		});

		it('keeps an inner-join CHAIN: both JOINs appear for a 2-hop inner-join include', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: nestedSchema });

			// Dot-notation propagates join:'inner' to every intermediate hop
			// (core/src/dx/intent-builder.ts: parseDotNotationInclude).
			const dump = orm
				.select('users')
				.include('posts.comments', {
					join: 'inner',
					where: eq('body', 'flagged'),
				})
				.where(eq('active', true))
				.existsDump();

			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users JOIN posts AS author_posts ON users.id = author_posts.author JOIN comments AS post_comments ON author_posts.id = post_comments.post WHERE users.active = $1 AND post_comments.body = $2 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([true, 'flagged']);
		});

		it('keeps a recursive-flagged self-referential include under exists — its CTE + LEFT JOIN survive existsWrap (a to-many join multiplies root rows, so pruning it would change offset/groupBy/having results)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: categorySchema });

			// existsWrap only swaps the target list for `1`; the WITH cte + LEFT
			// JOIN survive untouched — the exists FROM clause is identical to the
			// non-exists query's. Pruning it (as three prior designs attempted)
			// would drop a FROM join that multiplies root rows, silently changing
			// what offset/groupBy/having observe.
			const dump = orm
				.select('categories')
				.include('children', { recursive: true, direction: 'descendants' })
				.existsDump();

			expect(dump.sql).toBe(
				'SELECT EXISTS (WITH children_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT 1 FROM categories LEFT JOIN children_cte AS children_ref_0 ON categories.id = children_ref_0."parentId" LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([]);
		});

		it('a recursive self-referential include under exists throws on a dialect without recursive-CTE support — identical to the non-exists path (existsWrap keeps the include, it never special-cases recursion)', () => {
			const adapter = createRecursiveCapabilityGuardAdapter();
			const orm = createOrm({ adapter, schema: categorySchema });

			// Non-exists throws (the capability override is live)...
			expect(() =>
				orm
					.select('categories')
					.include('children', { recursive: true, direction: 'descendants' })
					.dump(),
			).toThrow(/supportsRecursiveCTE/);

			// ...and exists throws identically. Because D keeps the include, the
			// planner resolves it to the recursive-CTE strategy and hits the same
			// supportsRecursiveCTE capability guard — exists no longer suppresses
			// a query that the full SELECT would reject. Consistent behavior beats
			// exists silently succeeding where the real query fails.
			expect(() =>
				orm
					.select('categories')
					.include('children', { recursive: true, direction: 'descendants' })
					.existsDump(),
			).toThrow(/supportsRecursiveCTE/);
		});

		it('keeps a relation-level recursive include (ancestors / descendants) under exists — its CTE + LEFT JOIN survive even with no `recursive` flag on the entry', () => {
			// schema()'s self-referential FK sugar generates 'ancestors' and
			// 'descendants' RELATIONS with recursive metadata (schema.ts), so
			// `.include('ancestors')` resolves to a CTE strategy even though the
			// include entry has no `recursive` field. Its `WITH ... LEFT JOIN`
			// is a FROM join that rides along under existsWrap.
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: categorySchema });

			const ancestorsDump = orm
				.select('categories')
				.include('ancestors')
				.existsDump();
			expect(ancestorsDump.sql).toBe(
				'SELECT EXISTS (WITH ancestors_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT 1 FROM categories LEFT JOIN ancestors_cte AS ancestors_ref_0 ON categories.id = ancestors_ref_0."parentId" LIMIT 1) AS "exists"',
			);

			const descendantsDump = orm
				.select('categories')
				.include('descendants')
				.existsDump();
			expect(descendantsDump.sql).toBe(
				'SELECT EXISTS (WITH descendants_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT 1 FROM categories LEFT JOIN descendants_cte AS descendants_ref_0 ON categories.id = descendants_ref_0."parentId" LIMIT 1) AS "exists"',
			);
		});

		it('keeps an include whose `recursive` flag the planner ignores (non-self relation) — its JOIN + where still filter', () => {
			// `include.recursive` only matters when the referenced relation is
			// self-referential; otherwise the planner warns and falls through to
			// the normal strategy. Dot-notation is the reachable path here: the DX
			// `.include()` eagerly THROWS for a plain non-self relation name with
			// `recursive: true` (validateRecursiveInclude), but that validation
			// only checks the exact qualified relation name and silently no-ops
			// for a dotted path — so the `recursive` flag still reaches the
			// (non-self) leaf relation's intent, and its explicit join:'inner' +
			// where is a real FROM filter that rides along under existsWrap.
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: nestedSchema });

			const dump = orm
				.select('users')
				.include('posts.comments', {
					recursive: true,
					direction: 'descendants',
					join: 'inner',
					where: eq('body', 'flagged'),
				} as never)
				.where(eq('active', true))
				.existsDump();

			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users JOIN posts AS author_posts ON users.id = author_posts.author JOIN comments AS post_comments ON author_posts.id = post_comments.post WHERE users.active = $1 AND post_comments.body = $2 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([true, 'flagged']);
		});

		it('keeps a recursive self-referential include that ALSO carries an explicit join — recursion wins the strategy (CTE), and existsWrap keeps that CTE + LEFT JOIN', () => {
			// A recursive self-referential relation resolves to the CTE strategy
			// regardless of an explicit `join` option (recursion takes priority in
			// processInclude), so the include compiles to `WITH ... LEFT JOIN cte`
			// — a FROM join that survives existsWrap. Cover BOTH the include-level
			// `recursive` flag AND a relation that is recursive on its own.
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: categorySchema });

			// (a) include-level `recursive` flag + explicit join on the same entry
			const flagged = orm
				.select('categories')
				.include('children', {
					recursive: true,
					direction: 'descendants',
					join: 'inner',
				} as never)
				.existsDump();
			expect(flagged.sql).toBe(
				'SELECT EXISTS (WITH children_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT 1 FROM categories LEFT JOIN children_cte AS children_ref_0 ON categories.id = children_ref_0."parentId" LIMIT 1) AS "exists"',
			);
			expect(flagged.params).toEqual([]);

			// (b) relation-level recursive (`descendants` carries recursive
			// metadata; the entry has no `recursive` flag) + explicit join
			const relational = orm
				.select('categories')
				.include('descendants', { join: 'inner' } as never)
				.existsDump();
			expect(relational.sql).toBe(
				'SELECT EXISTS (WITH descendants_cte AS (SELECT categories_inner_0.* FROM categories AS categories_inner_0) SELECT 1 FROM categories LEFT JOIN descendants_cte AS descendants_ref_0 ON categories.id = descendants_ref_0."parentId" LIMIT 1) AS "exists"',
			);
		});

		it('filters via the hook-aware exists() path too — a no-op hook must not bypass the fix', async () => {
			// #230 finding: existsWithHooks() -> buildExistsIntentFromIntent() was
			// a THIRD, separately-stripping copy — any configured hook (even a
			// no-op) sent .exists() down the buggy path. Prove the hook path now
			// shares the same fixed construction as the non-hook path.
			const adapter = createHookProbeAdapter([{ exists: true }]);
			const hooks = createHookManager().beforeQuery((ctx) => ctx);
			const orm = createOrm({ adapter, schema: testSchema, hooks });

			const result = await orm
				.select('posts')
				.include('author', { join: 'inner', where: eq('id', 999999) })
				.where(eq('title', 'x'))
				.exists();

			expect(result).toBe(true);

			expect(adapter._spies.compile.mock.calls.length).toBe(1);
			const compiled = adapter._spies.compile.mock.results[0]!.value as {
				sql: string;
				parameters: readonly unknown[];
			};
			expect(compiled.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM posts JOIN users AS author ON posts.author = author.id WHERE posts.title = $1 AND author.id = $2 LIMIT 1) AS "exists"',
			);
			expect(compiled.parameters).toEqual(['x', 999999]);
		});

		it('a where-only include (no explicit join) resolves to the default json_agg strategy — a target-list scalar subquery that existsWrap discards, so no effect on the wrapped SQL', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('posts')
				.include('author', { where: eq('id', 999999) })
				.where(eq('title', 'x'))
				.existsDump();

			// buildExistsIntent keeps the include; with no explicit `join` it
			// resolves to the default json_agg strategy — a scalar subquery in the
			// TARGET LIST (not a FROM join). existsWrap replaces the whole target
			// list with `1`, so that hydration (and its inner where) vanishes for
			// free: the SQL equals the no-include baseline, and the include's where
			// never filtered root rows to begin with.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM posts WHERE posts.title = $1 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual(['x']);
		});

		it('a nested inner-join include under a default (json_agg) parent lives inside the parent hydration subquery — discarded by existsWrap, so no effect on the wrapped SQL', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: nestedSchema });

			const dump = orm
				.select('users')
				.include('posts', {
					include: [
						{
							relation: 'comments',
							join: 'inner',
							where: eq('body', 'flagged'),
						},
					],
				})
				.where(eq('active', true))
				.existsDump();

			// The outer 'posts' include has no explicit `join` → default json_agg,
			// a target-list scalar subquery. Its nested 'comments' inner-join is
			// hydrated INSIDE that subquery (a correlated nested aggregate), not as
			// a root FROM join — it filters comments within a post's hydration, not
			// which users exist. existsWrap replaces the whole target list with
			// `1`, discarding the entire nested hydration: the SQL equals the
			// no-include baseline, correctly, since nothing here filtered roots.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users WHERE users.active = $1 LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([true]);
		});

		it('a to-many pure-hydration include (default json_agg) has no effect on the wrapped SQL — its target-list scalar subquery is discarded by existsWrap (A6)', () => {
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			// Default 'posts' include (no explicit `join`) → json_agg, a
			// target-list scalar subquery that existsWrap's `SELECT 1` discards.
			const dump = orm.select('users').include('posts').existsDump();

			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([]);
		});

		it("finding 1 repro: defaultIncludeStrategy:'join' resolves a no-{join} include to a real JOIN — its filter + row multiplicity must survive existsWrap", () => {
			// The disproven assumption this whole spec round exists to fix: "an
			// include root-filters under .exists() iff it has an explicit
			// {join} option". FALSE — a query-level defaultIncludeStrategy:'join'
			// override resolves a plain `.include('posts', {...})` (no
			// `include.join` at all) to the SAME 'join' strategy as an explicit
			// `join: 'inner'`, and that JOIN + its WHERE filter root rows exactly
			// like the explicit-join case. Pruning on `include.join === undefined`
			// (the pre-fix classification) would silently drop this filter and
			// the OFFSET multiplicity under `.exists()`.
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: 'join' })
				.include('posts', { where: eq('title', 'x') })
				.offset(1)
				.existsDump();

			// sql.equals: full SQL comparison — resolved-strategy 'join' must be
			// kept and compiled identically to an explicit join:'inner' include.
			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users JOIN posts AS author_posts ON users.id = author_posts.author WHERE author_posts.title = $1 LIMIT 1 OFFSET 1) AS "exists"',
			);
			expect(dump.params).toEqual(['x']);
		});

		it("keeps a defaultIncludeStrategy:'lateral' include under exists — a LEFT JOIN LATERAL is a FROM join that multiplies root rows, so it must survive existsWrap", () => {
			// `defaultIncludeStrategy` (via `.withPlanOptions()`) forces
			// `determineIncludeStrategy` to a resolved 'lateral' strategy instead
			// of the json_agg default. Unlike json_agg (a target-list scalar
			// subquery that existsWrap's `SELECT 1` discards), a LATERAL is a FROM
			// join whose per-parent rows multiply the root — pruning it would
			// change what offset/groupBy/having count. existsWrap keeps it.
			const adapter = createPgsqlCompileOnlyAdapter();
			const orm = createOrm({ adapter, schema: testSchema });

			const dump = orm
				.select('users')
				.withPlanOptions({ defaultIncludeStrategy: 'lateral' })
				.include('posts')
				.existsDump();

			expect(dump.sql).toBe(
				'SELECT EXISTS (SELECT 1 FROM users LEFT JOIN LATERAL (SELECT posts_inner_0.* FROM posts AS posts_inner_0 WHERE posts_inner_0.author = users.id) AS posts_lat_0 ON true LIMIT 1) AS "exists"',
			);
			expect(dump.params).toEqual([]);
		});
	});

	describe('A4: withSchema().exists() passes schemaName', () => {
		it('passes schemaName to adapter.compile', async () => {
			const adapter = createSpyAdapter([{ exists: true }]);
			const orm = createOrm({ adapter, schema: testSchema });

			await orm.withSchema('tenant_123').select('users').exists();

			const compileCalls = (
				adapter as unknown as {
					_spies: { compile: { mock: { calls: unknown[][] } } };
				}
			)._spies.compile.mock.calls;
			const options = compileCalls[0]![1] as { schemaName?: string };
			expect(options.schemaName).toBe('tenant_123');
		});
	});
});
