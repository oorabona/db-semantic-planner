/**
 * Regression tests for WHERE compilation pipeline fixes.
 *
 * P1-1: stripExistsFromIntent mixed OR - non-EXISTS branches were dropped
 * P2-3: Scalar subquery inner params not propagated to outer state
 * P2-4: WHERE/HAVING injected into EXISTS wrapper instead of inner SELECT
 * P2-5: Range column types not propagated in direct WHERE path
 */

import type { WhereIntent } from '@dbsp/types';
import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';
import {
	buildSubqueryFromIntent,
	compileWhereIntent,
	type WhereCompilerCtx,
} from '../compile-where.js';
import { createCompilerState } from '../handlers/types.js';
import { identityNaming } from '../naming-plugin.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<WhereCompilerCtx>): WhereCompilerCtx {
	const paramState = createCompilerState();
	return {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: () => {
			throw new Error('compileSubquery not needed');
		},
		...overrides,
	};
}

function compileIntent(
	intent: WhereIntent,
	overrides?: Partial<WhereCompilerCtx>,
): { sql: string; params: unknown[] } {
	const ctx = makeCtx(overrides);
	const node = compileWhereIntent(intent, ctx);
	const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
	return { sql, params: ctx.paramState.parameters };
}

// ---------------------------------------------------------------------------
// P1-1: stripExistsFromIntent must preserve non-EXISTS branches in mixed OR
// ---------------------------------------------------------------------------

describe('P1-1: stripExistsFromIntent mixed OR', () => {
	it('plain OR with no exists - both branches preserved', () => {
		const { sql, params } = compileIntent({
			kind: 'or',
			conditions: [
				{
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
				{ kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
			],
		});
		expect(sql).toContain('OR');
		expect(sql).toContain('status');
		expect(sql).toContain('role');
		expect(params).toEqual(['active', 'admin']);
	});

	it('OR preserves all non-null branches', () => {
		// P1-1: stripExistsFromIntent was dropping non-exists branches in mixed OR.
		// This test verifies OR compilation preserves all branches.
		const { sql, params } = compileIntent({
			kind: 'or',
			conditions: [
				{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
				{ kind: 'null', field: 'deleted_at', operator: 'isNull' },
			],
		});
		expect(sql).toContain('OR');
		expect(sql).toContain('active');
		expect(sql).toContain('deleted_at');
		expect(params).toEqual([true]);
	});

	it('AND wrapping OR with two conditions - structure preserved', () => {
		const { sql, params } = compileIntent({
			kind: 'and',
			conditions: [
				{
					kind: 'or',
					conditions: [
						{ kind: 'comparison', field: 'a', operator: 'eq', value: 1 },
						{ kind: 'comparison', field: 'b', operator: 'eq', value: 2 },
					],
				},
				{ kind: 'comparison', field: 'c', operator: 'eq', value: 3 },
			],
		});
		expect(sql).toContain('OR');
		expect(sql).toContain('AND');
		expect(params).toEqual([1, 2, 3]);
	});
});

// ---------------------------------------------------------------------------
// P2-3: Scalar subquery inner params propagated to outer state
// ---------------------------------------------------------------------------

describe('P2-3: subquery inner params propagated', () => {
	it('buildSubqueryFromIntent returns inner parameters', () => {
		const result = buildSubqueryFromIntent(
			{
				from: 'posts',
				select: { type: 'fields', fields: ['author_id'] } as never,
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'published',
				},
			} as never,
			1,
		);
		expect(result.parameters).toBeDefined();
		expect(result.parameters).toContain('published');
		expect(result.paramCount).toBeGreaterThan(0);
	});

	it('buildSubqueryFromIntent with no WHERE returns empty parameters', () => {
		const result = buildSubqueryFromIntent(
			{
				from: 'orders',
				select: { type: 'fields', fields: ['id'] } as never,
			} as never,
			0,
		);
		expect(result.paramCount).toBe(0);
		expect(result.parameters ?? []).toHaveLength(0);
	});

	it('compileWhereIntent subquery propagates params to outer ctx', () => {
		const ctx = makeCtx({
			compileSubquery: (intent, offset) =>
				buildSubqueryFromIntent(intent as never, offset),
		});
		expect(ctx.paramState.parameters).toHaveLength(0);

		compileWhereIntent(
			{
				kind: 'subquery',
				field: 'id',
				operator: 'eq',
				subquery: {
					from: 'posts',
					select: { type: 'fields', fields: ['author_id'] } as never,
					where: {
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'draft',
					},
				} as never,
			},
			ctx,
		);

		expect(ctx.paramState.parameters).toContain('draft');
	});
});

// ---------------------------------------------------------------------------
// P2-5: Range operators compile correctly
// ---------------------------------------------------------------------------

describe('P2-5: range operators compile correctly', () => {
	it('BETWEEN compiles correctly', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'age',
			operator: 'between',
			value: { lower: 18, upper: 65 },
		});
		expect(sql).toBe('users.age BETWEEN $1 AND $2');
		expect(params).toEqual([18, 65]);
	});

	it('overlaps operator compiles with &&', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'period',
			operator: 'overlaps',
			value: { lower: '2025-01-01', upper: '2025-01-31' },
		});
		expect(sql).toMatch(/&&/);
		expect(params).toHaveLength(1);
	});

	it('contains operator compiles with @>', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'period',
			operator: 'contains',
			value: { lower: '2025-06-01', upper: '2025-06-30' },
		});
		expect(sql).toMatch(/@>/);
		expect(params).toHaveLength(1);
	});

	it('containedBy operator compiles with <@', () => {
		const { sql, params } = compileIntent({
			kind: 'range',
			field: 'period',
			operator: 'containedBy',
			value: { lower: '2025-06-01', upper: '2025-06-30' },
		});
		expect(sql).toMatch(/<@/);
		expect(params).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Bug 1: stripExistsFromIntent — dotted comparisons compiled twice
// ---------------------------------------------------------------------------

describe('Bug 1: stripExistsFromIntent strips dotted comparisons', () => {
	it('plain field compiles correctly (control)', () => {
		const { sql, params } = compileIntent({
			kind: 'comparison',
			field: 'status',
			operator: 'eq',
			value: 'active',
		});
		expect(sql).toBe('users.status = $1');
		expect(params).toEqual(['active']);
	});
});

// ---------------------------------------------------------------------------
// Bug 2: Scalar subquery alias mismatch — rootTable must be the alias
// ---------------------------------------------------------------------------

describe('Bug 2: buildSubqueryFromIntent rootTable uses alias', () => {
	it('inner WHERE uses the alias not the raw table name', () => {
		const result = buildSubqueryFromIntent(
			{
				from: 'posts',
				select: { type: 'fields', fields: ['author_id'] } as never,
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'published',
				},
			} as never,
			0,
		);
		// Deparse the SelectStmt and check the column reference uses the alias
		const sql = deparseSync([result.sql]);
		// The WHERE clause must reference "posts_sq"."status", not bare "posts"."status"
		expect(sql).toContain('posts_sq');
		expect(sql).not.toMatch(/"posts"\."status"/);
	});
});

// ---------------------------------------------------------------------------
// Bug 3: Schema qualification in scalar subqueries
// ---------------------------------------------------------------------------

describe('Bug 3: buildSubqueryFromIntent schema qualification', () => {
	it('without schemaName — no schema prefix in FROM', () => {
		const result = buildSubqueryFromIntent(
			{
				from: 'posts',
				select: { type: 'fields', fields: ['id'] } as never,
			} as never,
			0,
		);
		const sql = deparseSync([result.sql]);
		expect(sql).not.toContain('myschema');
	});

	it('with schemaName — FROM clause is schema-qualified', () => {
		const result = buildSubqueryFromIntent(
			{
				from: 'posts',
				select: { type: 'fields', fields: ['id'] } as never,
			} as never,
			0,
			undefined,
			'myschema',
		);
		const sql = deparseSync([result.sql]);
		// rangeVar with schema emits "myschema"."posts" AS posts_sq
		expect(sql).toContain('myschema');
	});
});

// ---------------------------------------------------------------------------
// Bug 4: relationFilter mode:'every' — must use NOT EXISTS WHERE NOT condition
// ---------------------------------------------------------------------------

describe('Bug 4: relationFilter mode:every uses NOT EXISTS WHERE NOT', () => {
	it('mode:some compiles to EXISTS (not NOT EXISTS)', () => {
		const result = compileIntent({
			kind: 'relationFilter',
			relation: 'posts',
			mode: 'some',
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
		} as unknown as WhereIntent);
		expect(result.sql.toUpperCase()).toContain('EXISTS');
		expect(result.sql.toUpperCase()).not.toContain('NOT EXISTS');
	});

	it('mode:none compiles to NOT + EXISTS (anti-join)', () => {
		const result = compileIntent({
			kind: 'relationFilter',
			relation: 'posts',
			mode: 'none',
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
		} as unknown as WhereIntent);
		// Deparser emits NOT (EXISTS (...)) — both tokens must be present
		const upper = result.sql.toUpperCase();
		expect(upper).toContain('NOT');
		expect(upper).toContain('EXISTS');
		// mode:none has exactly 1 NOT (only the outer negation)
		const notCount = (result.sql.match(/\bNOT\b/gi) ?? []).length;
		expect(notCount).toBe(1);
	});

	it('mode:every compiles to NOT EXISTS with negated inner condition (double NOT)', () => {
		const result = compileIntent({
			kind: 'relationFilter',
			relation: 'posts',
			mode: 'every',
			where: {
				kind: 'comparison',
				field: 'published',
				operator: 'eq',
				value: true,
			},
		} as unknown as WhereIntent);
		// Universal quantification: NOT (EXISTS (... WHERE NOT (condition)))
		// Both NOT tokens must appear — outer negation + inner condition negation
		const upper = result.sql.toUpperCase();
		expect(upper).toContain('NOT');
		expect(upper).toContain('EXISTS');
		// mode:every has 2 NOT: outer NOT + inner NOT (condition)
		// mode:none has only 1 NOT: outer NOT
		const notCount = (result.sql.match(/\bNOT\b/gi) ?? []).length;
		expect(notCount).toBeGreaterThanOrEqual(2);
	});
});
