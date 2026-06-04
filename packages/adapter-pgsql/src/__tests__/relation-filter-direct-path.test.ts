/**
 * Tests for multi-hop relationFilter on the direct compileWhereIntent path
 * (used by compileBatchUpdate / mutations).
 *
 * Before the fix, handleRelationFilterIntent took only the first element of a
 * multi-hop relation array, producing a truncated single-hop EXISTS.
 *
 * Fix: the direct path now builds the full nested EXISTS chain, hop by hop,
 * with fail-closed validation of every hop against the model.
 */

import { ref, schema } from '@dbsp/core';
import type { Node } from '@pgsql/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';

/** Deparse a WHERE AST node to a normalised SQL string for assertion. */
function nodeToSql(node: Node): string {
	return deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

// ---------------------------------------------------------------------------
// Schema: users → posts → comments
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

function makeCtx(overrides?: Partial<WhereCompilerCtx>): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		model: testSchema.model as any,
		compileSubquery: (subIntent, paramOffset) =>
			buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Defect 2: multi-hop relationFilter on the direct compileWhereIntent path
// ---------------------------------------------------------------------------

describe('multi-hop relationFilter on direct compileWhereIntent path', () => {
	it('["posts","comments"] mode=some — compiles without error, binds the inner param', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'hello',
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		// The innermost WHERE param must be bound — proves it was not dropped.
		expect(ctx.paramState.parameters).toContain('hello');
	});

	it('["posts","comments"] — param count > 0 (inner condition not silently dropped)', () => {
		// Old code produced a single-hop EXISTS; no param was bound for the inner
		// condition because the inner hop was never emitted.  After the fix, the inner
		// param 'nested-body' must appear in paramState.
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'like',
				value: '%nested-body%',
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		compileWhereIntent(intent as any, ctx);
		expect(ctx.paramState.paramIndex).toBeGreaterThan(0);
		expect(ctx.paramState.parameters).toContain('%nested-body%');
	});

	it('mode:none multi-hop — compiles without error', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'bad',
			},
			mode: 'none' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		expect(ctx.paramState.parameters).toContain('bad');
	});

	it('mode:every multi-hop — compiles without error', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'all',
			},
			mode: 'every' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		expect(ctx.paramState.parameters).toContain('all');
	});

	it('undeclared second hop — throws fail-closed', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'undeclared'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'col',
				operator: 'eq',
				value: 1,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'undeclared' declared on table 'posts'/i,
		);
	});

	it('undeclared first hop — throws fail-closed', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['badRelation', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'col',
				operator: 'eq',
				value: 1,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/no relation 'badRelation' declared on table 'users'/i,
		);
	});

	it('multi-hop with no model — throws fail-closed (not silent truncation)', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'x',
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx({ model: undefined });
		expect(() => compileWhereIntent(intent as any, ctx)).toThrow(
			/require a model on the direct compile path/i,
		);
	});

	// Regression: single-hop (string and single-element array) unchanged
	it('single-hop string relationFilter — unchanged', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: 'posts',
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		expect(ctx.paramState.parameters).toContain(true);
	});

	it('single-element array relationFilter — unchanged', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		expect(() => compileWhereIntent(intent as any, ctx)).not.toThrow();
		expect(ctx.paramState.parameters).toContain(true);
	});
});

// ---------------------------------------------------------------------------
// DEFECT-2 fix: per-hop FK metadata threading — correct correlation columns
//
// Schema facts (verified from model introspection):
//   users.posts    → hasMany,  foreignKey='author_id'  (posts.author_id  → users.id)
//   posts.comments → hasMany,  foreignKey='post_id'    (comments.post_id → posts.id)
//   posts.author   → belongsTo, foreignKey='author_id' (posts.author_id  → users.id)
//
// Bug: before fix, multi-hop used convention fallback for FK column names:
//   users→posts    wrong correlation: users.id = posts_exists_0.user_id     ✗
//   posts→comments wrong correlation: posts_exists_0.id = comments_exists_1.posts_id ✗
//
// After fix, model-declared FKs are threaded into each hop's nested intent
// so buildExistsSubquery emits the correct column names at every hop.
//
// Note: single-hop goes through the legacy path (hops.length <= 1) which does
// NOT thread FK metadata — it relies on the convention fallback. That is
// pre-existing behaviour outside the scope of this fix and is tested separately.
// ---------------------------------------------------------------------------

describe('DEFECT-2: multi-hop relationFilter emits correct FK correlation columns', () => {
	it('two-hop hasMany→hasMany: first hop uses author_id, second hop uses post_id', () => {
		// users -[hasMany posts via author_id]-> posts -[hasMany comments via post_id]-> comments
		//
		// Expected SQL structure (normalised):
		//   EXISTS (SELECT 1 FROM posts AS posts_exists_0
		//     WHERE users.id = posts_exists_0.author_id
		//     AND EXISTS (SELECT 1 FROM comments AS comments_exists_1
		//                  WHERE posts_exists_0.id = comments_exists_1.post_id
		//                  AND comments_exists_1.body = $1))
		//
		// Before fix the correlations were:
		//   users.id = posts_exists_0.user_id        (convention: singularize('users')+'_id')
		//   posts_exists_0.id = comments_exists_1.posts_id  (convention: singularize('posts')+'_id')
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'hello',
			},
			mode: 'some' as const,
		};
		const ctx = makeCtx();
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		// Outer hop correlation: users.id = posts_exists_N.author_id
		// (NOT the convention-derived 'user_id')
		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');

		// Inner hop correlation: posts_exists_N.id = comments_exists_M.post_id
		// (NOT the convention-derived 'posts_id')
		expect(sql).toMatch(
			/posts_exists_\d+\.id\s*=\s*comments_exists_\d+\.post_id/,
		);
		expect(sql).not.toContain('posts_id');

		// Innermost WHERE param still bound (proves full chain was compiled)
		expect(ctx.paramState.parameters).toContain('hello');
	});

	it('two-hop mode:none — NOT EXISTS still uses declared FK columns', () => {
		// mode:none wraps the outermost hop in NOT EXISTS
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'bad',
			},
			mode: 'none' as const,
		};
		const ctx = makeCtx();
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
		expect(sql).toMatch(
			/posts_exists_\d+\.id\s*=\s*comments_exists_\d+\.post_id/,
		);
		expect(sql).not.toContain('posts_id');
	});

	it('two-hop mode:every — NOT EXISTS(NOT condition) still uses declared FK columns', () => {
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['posts', 'comments'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'body',
				operator: 'eq',
				value: 'all',
			},
			mode: 'every' as const,
		};
		const ctx = makeCtx();
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		expect(sql).toMatch(/users\.id\s*=\s*posts_exists_\d+\.author_id/);
		expect(sql).not.toContain('user_id');
	});

	it('two-hop belongsTo→hasMany: posts.author→comments uses correct FK direction per hop', () => {
		// From posts (rootTable=posts):
		//   hop 0: 'author' → belongsTo users (foreignKey='author_id' on posts side)
		//          sourceColumn=author_id, targetColumn=id
		//          correlation: posts.author_id = users_exists_0.id
		//   hop 1: 'posts' on users → hasMany posts (foreignKey='author_id' on posts side)
		//          sourceColumn=id (users.id), targetColumn=author_id
		//          correlation: users_exists_0.id = posts_exists_1.author_id
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'posts',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			model: testSchema.model as any,
			compileSubquery: (subIntent, paramOffset) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
		const intent = {
			kind: 'relationFilter' as const,
			relation: ['author', 'posts'] as unknown as string,
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
			mode: 'some' as const,
		};
		const node = compileWhereIntent(intent as any, ctx);
		const sql = nodeToSql(node);

		// First hop (belongsTo): posts.author_id = users_exists_N.id
		expect(sql).toMatch(/posts\.author_id\s*=\s*users_exists_\d+\.id/);
		// Second hop (hasMany): users_exists_N.id = posts_exists_M.author_id
		expect(sql).toMatch(
			/users_exists_\d+\.id\s*=\s*posts_exists_\d+\.author_id/,
		);
		// Convention-derived columns must NOT appear
		expect(sql).not.toContain('user_id');
		expect(sql).not.toContain('post_id');
	});
});
