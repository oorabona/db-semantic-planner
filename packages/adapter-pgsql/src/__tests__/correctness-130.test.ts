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
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { convertWhereCondition, isOuterRef } from '../intent-to-decisions.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';
import { convertWhereToDecisions } from '../plan-decision-extractor.js';

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
		post_id: ref('posts', { as: 'post', inverse: 'comments' }),
	},
} as const);

interface WhereCompilerCtxOverrides
	extends Omit<Partial<WhereCompilerCtx>, 'model'> {
	readonly withoutModel?: boolean;
}

function makeCtx(
	rootTable: string,
	overrides?: WhereCompilerCtxOverrides,
): WhereCompilerCtx {
	const paramState = createCompilerState();
	const { withoutModel = false, ...rest } = overrides ?? {};
	return {
		rootTable,
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		...(!withoutModel ? { model: testSchema.model as any } : {}),
		compileSubquery: (subIntent, paramOffset) =>
			buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		...rest,
	};
}

// ============================================================================
// DEFECT 1 — single-hop relationFilter: correct FK correlation
// ============================================================================

describe('DEFECT 1: single-hop relationFilter threads declared FK columns', () => {
	it('users → posts (hasMany, author_id): emits users.id = posts_exists_N.author_id, NOT posts.user_id', () => {
		// users hasMany posts via author_id (not the conventional user_id)
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		// Must use the declared FK 'author_id', NOT the convention 'user_id'
		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
		// Param still bound
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('users → posts mode:none (NOT EXISTS) uses declared FK', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: false,
			},
			mode: 'none' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
		expect(ctx.paramState.parameters).toContain(false);
	});

	it('users → posts mode:every uses declared FK (NOT EXISTS WHERE NOT cond)', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('posts → users (belongsTo, author_id): emits posts.author_id = users_exists_N.id', () => {
		// posts belongsTo users via author_id; FK is on the posts side
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'author',
			where: {
				kind: 'comparison' as const,
				field: 'active',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('posts');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		// belongsTo: FK on source side — posts.author_id = users_exists_N.id
		expect(sql).toMatch(/posts\.author_id\s*=\s*users_exists_\d+\.id/);
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('single-hop without model falls back to convention (no crash)', () => {
		// Without a model we cannot resolve FK — behavior unchanged (convention fallback)
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users', { withoutModel: true });
		// Must not throw — falls back to convention
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});

	it('single-element array relation treated as single-hop and uses declared FK', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts'] as unknown as string,
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
	});

	// -------------------------------------------------------------------------
	// NEW: DEFECT 1 — nested exists drops its include joins
	//
	// Before the fix, convertWhereToDecisions created exists stubs with _rawWhere
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
		const adapter = createPgsqlCompileOnlyAdapter({
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
		const adapter = createPgsqlCompileOnlyAdapter({
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

describe('DEFECT 2: mode:every with no where clause returns vacuous TRUE (valid SQL — not CAST(1 AS ))', () => {
	it('single-hop every with no where does not crash and returns TRUE literal SQL', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			// where is intentionally omitted (undefined at runtime)
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		let node: Node;
		expect(() => {
			node = compileWhereIntent(intent as any, ctx);
		}).not.toThrow();
		// vacuous-true: must produce a valid TRUE boolean literal, NOT an EXISTS subquery
		// and NOT the malformed CAST(1 AS ) that the previous mis-nested TypeCast emitted.
		// everyHandler uses { A_Const: { boolval: { boolval: true } } } — same shape here.
		const sql = nodeToSql(node!);
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		// Must NOT emit the malformed "CAST(1 AS )" — deparsed as "cast(1 as )" previously
		expect(sql.toLowerCase()).not.toMatch(/cast\s*\(\s*1\s+as\s*\)/);
		// Must contain a valid TRUE literal (PostgreSQL deparsed as "true")
		expect(sql.toLowerCase()).toContain('true');
		// Struct-level: A_Const boolval must be present on the returned node
		expect((node! as any).A_Const?.boolval?.boolval).toBe(true);
	});

	it('multi-hop every with no where does not crash and returns TRUE literal SQL', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		let node: Node;
		expect(() => {
			node = compileWhereIntent(intent as any, ctx);
		}).not.toThrow();
		const sql = nodeToSql(node!);
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		expect(sql.toLowerCase()).not.toMatch(/cast\s*\(\s*1\s+as\s*\)/);
		expect(sql.toLowerCase()).toContain('true');
		expect((node! as any).A_Const?.boolval?.boolval).toBe(true);
	});

	it('mode:every with a real where still compiles NOT EXISTS correctly', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		// mode:every = NOT (EXISTS(WHERE NOT cond)) — must include NOT and EXISTS and param.
		// The deparser renders NOT as "NOT (EXISTS (...))" not "NOT EXISTS".
		expect(sql.toUpperCase()).toContain('NOT');
		expect(sql.toUpperCase()).toContain('EXISTS');
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('mode:none with no where does NOT produce vacuous-true (it is NOT EXISTS)', () => {
		// mode:none is semantically "has no related rows" — no where is valid usage
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'none' as const,
		};
		const ctx = makeCtx('users');
		// Should not crash
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		// mode:none = NOT (EXISTS (...)) — must contain both NOT and EXISTS
		expect(sql.toUpperCase()).toContain('NOT');
		expect(sql.toUpperCase()).toContain('EXISTS');
	});

	it('decisions path: convertWhereCondition handles mode:every + where:undefined gracefully', () => {
		// The decisions path uses convertWhereCondition; it calls convertExistsLike
		// which already guards `cond.where` with a ternary — no crash expected.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'every' as const,
		};
		// convertWhereCondition should not throw — it converts to an exists decision
		expect(() => convertWhereCondition(intent as any, 'users')).not.toThrow();
	});

	it('DEFECT-3 FIX: vacuous every with no model throws (fail-closed, not fail-open)', () => {
		// Without a model, the adapter cannot validate the relation at all.
		// Returning vacuous TRUE here would match ALL rows regardless of whether
		// the relation exists — a silent security regression in mutation guards.
		// Fix: throw a clear error when model is absent on the vacuous every path.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users', { withoutModel: true });
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/every relation filter requires a model to validate the relation/,
		);
	});

	it('DEFECT-3 FIX: vacuous every with a valid model and declared relation returns TRUE (not throw)', () => {
		// Vacuous every on a KNOWN relation with a model is safe vacuous-truth.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users'); // has model with posts declared
		let node: Node;
		expect(() => {
			node = compileWhereIntent(intent as any, ctx);
		}).not.toThrow();
		expect((node! as any).A_Const?.boolval?.boolval).toBe(true);
	});

	it('DEFECT-3 FIX: vacuous every with a model on a typoed relation throws (invalid relation)', () => {
		// An undeclared/typoed relation with a model must throw — not return vacuous TRUE.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'nonexistent_table',
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users'); // model doesn't have 'nonexistent_table'
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'nonexistent_table' declared on table 'users'/,
		);
	});

	it('SEC-182: untrusted pre-resolved vacuous every validates relation instead of returning TRUE', () => {
		// Plain objects can carry targetTable/sourceColumn/targetColumn. That is not
		// proof that the relation exists or that the FK metadata came from the compiler.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'fabricatedAuthor',
			where: undefined as any,
			mode: 'every' as const,
			targetTable: 'users',
			sourceColumn: 'authorId',
			targetColumn: 'id',
		};
		const ctx = makeCtx('posts');

		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'fabricatedAuthor' declared on table 'posts'/,
		);
	});

	it('SEC-182: untrusted pre-resolved non-vacuous relationFilter fails loud instead of emitting forged EXISTS', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'fabricatedAuthor',
			where: {
				kind: 'comparison' as const,
				field: 'name',
				operator: 'eq',
				value: 'Mallory',
			},
			mode: 'some' as const,
			targetTable: 'users',
			sourceColumn: 'author_id',
			targetColumn: 'id',
		};
		const ctx = makeCtx('posts');

		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'fabricatedAuthor' declared on table 'posts'/,
		);
		expect(ctx.paramState.parameters).toEqual([]);
	});
});

// ============================================================================
// DEFECT 3 — multi-aggregate scalar subquery is rejected
// ============================================================================

describe('DEFECT 3: scalar subquery with multiple aggregates is rejected', () => {
	it('two-aggregate scalar subquery via decisions path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [
						{ function: 'avg' as const, field: 'price' },
						{ function: 'max' as const, field: 'price' },
					],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/scalar subquery with multi-aggregate projection.*is not supported/,
		);
	});

	it('two-aggregate scalar subquery via direct compile-where path throws', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [
						{ function: 'avg' as const, field: 'price' },
						{ function: 'max' as const, field: 'price' },
					],
				},
			},
		};
		const ctx = makeCtx('orders');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/scalar subquery.*multi-aggregate projection.*is not supported/,
		);
	});

	it('single-aggregate scalar subquery is still accepted', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg' as const, field: 'price' }],
				},
			},
		};
		// Single aggregate: must NOT throw on decisions path
		expect(() => convertWhereCondition(intent as any, 'orders')).not.toThrow();
	});

	it('single-aggregate scalar subquery on direct path does not throw', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg' as const, field: 'price' }],
				},
			},
		};
		const ctx = makeCtx('orders');
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});

	it('three-aggregate scalar subquery also rejected', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'eq' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [
						{ function: 'avg' as const, field: 'price' },
						{ function: 'min' as const, field: 'price' },
						{ function: 'max' as const, field: 'price' },
					],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/scalar subquery.*is not supported/,
		);
	});

	it('error message mentions restructuring guidance', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt' as const,
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [
						{ function: 'avg' as const, field: 'price' },
						{ function: 'max' as const, field: 'price' },
					],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).toThrow(
			/restructure the query or use a CTE/,
		);
	});
});

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
	const adapter = createPgsqlCompileOnlyAdapter({ model: schemaScoped.model });
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
//   1. Direct compile-where path (compileWhereIntent / handleRelationFilterIntent)
//   2. Intent-to-decisions path (convertWhereCondition → everyHandler)
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
	const adapter = createPgsqlCompileOnlyAdapter({ model: everySchema.model });
	return createOrm({ model: everySchema.model, adapter });
}

// ---------------------------------------------------------------------------
// FIX 1: intent-to-decisions path — convertWhereCondition emits operator:'every'
// ---------------------------------------------------------------------------

describe('FIX 1 (intent-to-decisions): mode:every emits operator:every NOT operator:exists', () => {
	it('convertWhereCondition with mode:every emits operator:"every", not "exists"', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq' as const,
				value: true,
			},
			mode: 'every' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision).not.toBeNull();
		// INVARIANT: must route to everyHandler, NOT existsHandler
		expect(decision?.operator).toBe('every');
		expect(decision?.operator).not.toBe('exists');
	});

	it('convertWhereCondition mode:every with no where emits operator:"every" with no conditions', () => {
		// Vacuous: everyHandler returns TRUE when conditions is empty
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'every' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision).not.toBeNull();
		expect(decision?.operator).toBe('every');
		// No conditions → everyHandler returns TRUE literal
		expect(decision?.conditions ?? []).toHaveLength(0);
	});

	it('convertWhereCondition mode:every with empty and() emits operator:"every" with no conditions', () => {
		// Vacuous via empty-and: same as undefined — must still emit operator:'every'
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: { kind: 'and' as const, conditions: [] as any[] },
			mode: 'every' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision).not.toBeNull();
		expect(decision?.operator).toBe('every');
		// convertExistsLike converts and([]) to [] subDecisions → no conditions on decision
		expect(decision?.conditions ?? []).toHaveLength(0);
	});

	it('convertWhereCondition mode:every with real predicate emits conditions (NOT pre-negated)', () => {
		// The raw conditions are passed as-is; everyHandler wraps them in NOT internally.
		// Regression lock: conditions must NOT already be wrapped in a 'not' decision.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq' as const,
				value: true,
			},
			mode: 'every' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision?.operator).toBe('every');
		expect(decision?.conditions).toHaveLength(1);
		// Conditions must be the raw comparison, NOT wrapped in 'whereNot'
		expect(decision?.conditions?.[0]?.type).not.toBe('whereNot');
		expect(decision?.conditions?.[0]?.operator).toBe('eq');
	});

	it('mode:some still emits operator:exists (regression lock)', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq' as const,
				value: true,
			},
			mode: 'some' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision?.operator).toBe('exists');
	});

	it('mode:none still emits operator:notExists (regression lock)', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq' as const,
				value: false,
			},
			mode: 'none' as const,
		};
		const decision = convertWhereCondition(intent as any, 'users');
		expect(decision?.operator).toBe('notExists');
	});
});

// ---------------------------------------------------------------------------
// FIX 2 (compile-where direct path): empty-and → vacuous TRUE (no EXISTS emitted)
// ---------------------------------------------------------------------------

describe('FIX 2 (compile-where direct): mode:every with empty-and is vacuously true', () => {
	it('single-hop every with and() emits TypeCast(1 as bool) — no EXISTS', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: { kind: 'and' as const, conditions: [] as any[] },
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		// Vacuous every: must NOT produce an EXISTS subquery
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		// Must produce a true-cast (CAST(1 AS bool) or TRUE literal)
		expect(sql.toLowerCase()).toMatch(/cast|true/);
	});

	it('multi-hop every with and() emits TypeCast(1 as bool) — no EXISTS', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: { kind: 'and' as const, conditions: [] as any[] },
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		expect(sql.toLowerCase()).toMatch(/cast|true/);
	});

	it('single-hop every with real predicate still produces NOT EXISTS (regression)', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq' as const,
				value: true,
			},
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		expect(sql.toUpperCase()).toContain('NOT');
		expect(sql.toUpperCase()).toContain('EXISTS');
		expect(ctx.paramState.parameters).toContain(true);
	});
});

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
		const adapter = createPgsqlCompileOnlyAdapter({ model: everySchema.model });
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

		const adapter = createPgsqlCompileOnlyAdapter({
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

describe('NEW-DEFECT-1 (vacuous-every relation validation): undeclared relation throws fail-closed', () => {
	it('single-hop vacuous every with typoed/undeclared relation throws', () => {
		// 'typoNotARelation' is not declared on the 'users' table in testSchema.
		// The vacuous-every short-circuit must validate the relation BEFORE returning
		// the all-rows TRUE literal; otherwise this silently produces a fail-open guard.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'typoNotARelation',
			where: undefined as any, // vacuous
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'typoNotARelation' declared on table 'users'/,
		);
	});

	it('multi-hop vacuous every with bad hop throws at the invalid hop', () => {
		// First hop 'posts' is valid, second hop 'typoHop' is not declared on 'posts'.
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'typoHop'] as unknown as string,
			where: undefined as any, // vacuous
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'typoHop' declared on table 'posts'/,
		);
	});

	it('multi-hop vacuous every where first hop is bad throws at first hop', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['badFirstHop', 'comments'] as unknown as string,
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'badFirstHop' declared on table 'users'/,
		);
	});

	it('vacuous every on a VALID single-hop relation still returns TRUE (no regression)', () => {
		// 'posts' IS declared on 'users' — vacuous every must still compile to TRUE.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		// Must produce a TRUE-cast, not EXISTS
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		expect(sql.toLowerCase()).toMatch(/cast|true/);
	});

	it('vacuous every on a VALID multi-hop relation still returns TRUE (no regression)', () => {
		// 'posts' → 'comments' both declared — vacuous every must still return TRUE.
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users');
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		expect(sql.toLowerCase()).toMatch(/cast|true/);
	});

	it('vacuous every without a model THROWS (DEFECT 3 FIX: fail-closed, not fail-open)', () => {
		// DEFECT 3 FIX: vacuous every with no model now throws fail-closed.
		// Without a model the adapter cannot validate the relation at all — returning
		// vacuous TRUE would match ALL rows regardless of whether the relation exists,
		// which is a silent security regression in mutation guards (DELETE/UPDATE).
		// The old behaviour (no-throw, convention-fallback) is intentionally replaced.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'anyRelation',
			where: undefined as any,
			mode: 'every' as const,
		};
		const ctx = makeCtx('users', { withoutModel: true });
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/every relation filter requires a model to validate the relation/,
		);
	});
});

// ============================================================================
// NEW DEFECT 2 (PR #130 correctness suite)
//
// Nested range/between in plan-decision-extractor convertWhereToDecisions was
// hand-rolling the value conversion, passing the { lower, upper } object
// unchanged into a decision that the BETWEEN handler requires to be a
// [min, max] two-element array — causing a runtime throw or wrong SQL inside
// a nested exists where clause.
//
// Fix: delegate to convertWhereCondition (the central converter) which handles
// all range sub-shapes correctly.
// ============================================================================

describe('NEW-DEFECT-2 (nested range/between delegation): nested between in exists where compiles correctly', () => {
	it('convertWhereToDecisions with range kind { lower, upper } produces correct BETWEEN decision', () => {
		// This is the shape produced by the NQL BETWEEN compiler:
		//   { kind: 'range', field: 'views', operator: 'between', value: { lower: 10, upper: 100 } }
		// Before fix: value passed as-is → BETWEEN handler received { lower, upper } object
		//             and threw "requires [min, max] array".
		// After fix:  delegated to convertWhereCondition → [10, 100] array.
		const rangeIntent = {
			kind: 'range' as const,
			field: 'views',
			operator: 'between' as const,
			value: { lower: 10, upper: 100 },
		};
		const decisions = convertWhereToDecisions(rangeIntent, 'posts');
		expect(decisions).toHaveLength(1);
		const d = decisions[0];
		expect(d?.type).toBe('where');
		expect(d?.operator).toBe('between');
		// CRITICAL: value must be a two-element array, not a { lower, upper } object
		expect(Array.isArray(d?.value)).toBe(true);
		expect(d?.value).toEqual([10, 100]);
		expect(d?.column).toBe('views');
	});

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

		const adapter = createPgsqlCompileOnlyAdapter({
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

	it('range operator:gte with scalar value passes through unchanged (regression lock)', () => {
		// The { operator:'gte', value:100 } shape is handled by the pass-through path —
		// the BETWEEN handler never sees it; the gte/lte handler does.
		// Regression lock: convertWhereToDecisions must NOT corrupt this shape.
		const singleSideRange = {
			kind: 'range' as const,
			field: 'price',
			operator: 'gte' as const,
			value: 100,
		};
		const decisions = convertWhereToDecisions(singleSideRange, 'products');
		expect(decisions).toHaveLength(1);
		const d = decisions[0];
		expect(d?.operator).toBe('gte');
		expect(d?.value).toBe(100);
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

	it('outerRef() result is recognized by isOuterRef() as a correlation marker', () => {
		const ref = outerRef('file_id');
		expect(isOuterRef(ref)).toBe(true);
	});

	it('a raw intent { kind:"ref", column, outer:true } is also recognized as an outer ref', () => {
		// An intent built directly per the exported SubqueryRefIntent type
		// (without going through outerRef()) must also be recognized.
		// This validates the API-compatibility contract: serialized/deserialized
		// intents with the outer field work correctly end-to-end.
		const rawRef = {
			kind: 'ref' as const,
			column: 'parentId',
			outer: true as const,
		};
		expect(isOuterRef(rawRef)).toBe(true);
	});

	it('an inner ref() without outer is NOT recognized as an outer ref', () => {
		// A plain { kind:'ref', column } without outer must NOT be misidentified.
		const innerRef = { kind: 'ref' as const, column: 'someColumn' };
		expect(isOuterRef(innerRef)).toBe(false);
	});

	it('convertWhereToDecisions recognizes outer:true on a comparison value as a FieldRef', () => {
		// A comparison where the value is an outerRef must produce a FieldRef decision
		// (scope:'outer'), not a parameter — regression lock for the correlated-value path.
		const comparisonIntent = {
			kind: 'comparison' as const,
			field: 'post_id',
			operator: 'eq',
			value: outerRef('id'),
		};
		const decisions = convertWhereToDecisions(comparisonIntent, 'comments');
		expect(decisions).toHaveLength(1);
		const d = decisions[0];
		// Value must be converted to a FieldRef (not the raw outerRef object)
		expect(d?.value).toMatchObject({
			kind: 'fieldRef',
			scope: 'outer',
			column: 'id',
		});
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

describe('NEW DEFECT 4 (single-hop undeclared relation fail-closed)', () => {
	it('single-hop with model + typo relation → throws fail-closed error', () => {
		// 'typoNotARelation' is not declared on 'users' in testSchema.
		// With a model present, this must throw instead of compiling against a
		// convention-derived fallback table.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'typoNotARelation',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'typoNotARelation' declared on table 'users'/,
		);
	});

	it('single-hop with model + typo relation (mode:none) → throws fail-closed error', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'doesNotExist',
			where: {
				kind: 'comparison' as const,
				field: 'title',
				operator: 'eq',
				value: 'hello',
			},
			mode: 'none' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'doesNotExist' declared on table 'users'/,
		);
	});

	it('single-hop with model + declared relation (posts) → compiles correctly (unchanged)', () => {
		// Regression lock: a declared relation must still compile without throwing.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison' as const,
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('single-hop WITHOUT model + undeclared relation → still falls back to convention (no throw)', () => {
		// Without a model, FK resolution is impossible; the convention-fallback path
		// is the only option. This must NOT throw — behavior unchanged.
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'anyTable',
			where: {
				kind: 'comparison' as const,
				field: 'col',
				operator: 'eq',
				value: 42,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx('users', { withoutModel: true });
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});
});

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

describe('NEW DEFECT 5 (correlated scalar subquery fail-closed)', () => {
	it('decisions path: scalar subquery with outerRef in WHERE → throws', () => {
		// outerRef('userId') in the inner WHERE: correlated scalar subquery.
		// convertSubquery must throw before emitting the Decision.
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'orders',
				select: { fields: ['user_id'] },
				where: {
					kind: 'comparison' as const,
					field: 'user_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/correlated outerRef.*not yet supported/i,
		);
	});

	it('direct path (compile-where): scalar subquery with outerRef in WHERE → throws', () => {
		// The direct path (handleSubqueryIntent → ctx.compileSubquery →
		// buildSubqueryFromIntent) already has the containsOuterRef guard.
		// This test locks that behaviour.
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'orders',
				select: { fields: ['user_id'] },
				where: {
					kind: 'comparison' as const,
					field: 'user_id',
					operator: 'eq',
					value: outerRef('id'),
				},
			},
		};
		const ctx = makeCtx('users');
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/correlated.*not.*supported/i,
		);
	});

	it('decisions path: non-correlated scalar subquery → compiles correctly (unchanged)', () => {
		// No outerRef: a plain subquery must still work.
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt',
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg', field: 'price' }],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'orders')).not.toThrow();
	});

	it('direct path: non-correlated scalar subquery → compiles correctly (unchanged)', () => {
		const intent = {
			kind: 'subquery' as const,
			field: 'price',
			operator: 'gt',
			subquery: {
				type: 'select' as const,
				from: 'products',
				select: {
					type: 'aggregate' as const,
					aggregates: [{ function: 'avg', field: 'price' }],
				},
			},
		};
		const ctx = makeCtx('orders');
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
	});

	it('decisions path: outerRef in nested AND inside scalar subquery WHERE → throws', () => {
		// outerRef inside a nested logical group must also be detected.
		const intent = {
			kind: 'subquery' as const,
			field: 'id',
			operator: 'eq',
			subquery: {
				type: 'select' as const,
				from: 'orders',
				select: { fields: ['user_id'] },
				where: {
					kind: 'and' as const,
					conditions: [
						{
							kind: 'comparison' as const,
							field: 'status',
							operator: 'eq',
							value: 'active',
						},
						{
							kind: 'comparison' as const,
							field: 'user_id',
							operator: 'eq',
							value: outerRef('id'),
						},
					],
				},
			},
		};
		expect(() => convertWhereCondition(intent as any, 'users')).toThrow(
			/correlated outerRef.*not yet supported/i,
		);
	});
});
