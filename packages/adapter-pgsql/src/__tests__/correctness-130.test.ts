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

import { createOrm, eq, exists, ref, schema } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { convertWhereCondition } from '../intent-to-decisions.js';
import { identityNaming } from '../naming-plugin.js';
import { createPgsqlCompileOnlyAdapter } from '../pgsql-adapter.js';

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

function makeCtx(
	rootTable: string,
	overrides?: Partial<WhereCompilerCtx>,
): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable,
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		model: testSchema.model as any,
		compileSubquery: (subIntent, paramOffset) =>
			buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		...overrides,
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
		const ctx = makeCtx('users', { model: undefined });
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
});

// ============================================================================
// DEFECT 2 — mode:'every' with undefined/omitted where → vacuous TRUE (no crash)
// ============================================================================

describe('DEFECT 2: mode:every with no where clause returns vacuous TRUE', () => {
	it('single-hop every with no where does not crash and returns truthy SQL', () => {
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
		// vacuous-true: should produce a TRUE cast, not EXISTS.
		// The deparser renders the TypeCast as "cast(1 as )" or similar — the key
		// property is that the output does NOT contain EXISTS (which would mean the
		// vacuous-true optimisation is missing).
		const sql = nodeToSql(node!);
		expect(sql.toUpperCase()).not.toContain('EXISTS');
		// The cast expression should be present (TypeCast { arg: 1, typeName: bool })
		expect(sql.toLowerCase()).toMatch(/cast/);
	});

	it('multi-hop every with no where does not crash and returns truthy SQL', () => {
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
		expect(sql.toLowerCase()).toMatch(/cast/);
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
