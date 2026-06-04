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
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';

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
