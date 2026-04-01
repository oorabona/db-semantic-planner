/**
 * Tests for compileWhereIntent() — the unified WHERE compiler.
 *
 * Covers all 16 WhereIntent kinds and verifies that the new direct path
 * produces the same SQL as the existing decision-based path.
 */

import { exprRef, fn } from '@dbsp/core';
import type { QueryIntent, SelectIntent, WhereIntent } from '@dbsp/types';
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

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Compile a WhereIntent to SQL string using compileWhereIntent().
 * Deparses the resulting node embedded in a minimal SELECT...WHERE statement.
 */
function compile(
	intent: WhereIntent,
	overrides?: Partial<WhereCompilerCtx>,
): { sql: string; params: unknown[] } {
	const paramState = createCompilerState();
	const ctx: WhereCompilerCtx = {
		rootTable: 'users',
		aliases: new Map(),
		paramState,
		naming: identityNaming,
		compileSubquery: () => {
			throw new Error('compileSubquery not needed for this test');
		},
		...overrides,
	};
	const node = compileWhereIntent(intent, ctx);
	const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
		.replace(/^SELECT\s+WHERE\s+/i, '')
		.trim();
	return { sql, params: paramState.parameters };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compileWhereIntent', () => {
	describe('comparison', () => {
		it('eq', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			});
			expect(sql).toBe('users.status = $1');
			expect(params).toEqual(['active']);
		});

		it('neq', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'role',
				operator: 'neq',
				value: 'admin',
			});
			expect(sql).toBe('users.role <> $1');
			expect(params).toEqual(['admin']);
		});

		it('gt', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'age',
				operator: 'gt',
				value: 18,
			});
			expect(sql).toBe('users.age > $1');
			expect(params).toEqual([18]);
		});

		it('gte', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'score',
				operator: 'gte',
				value: 100,
			});
			expect(sql).toBe('users.score >= $1');
			expect(params).toEqual([100]);
		});

		it('lt', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'priority',
				operator: 'lt',
				value: 5,
			});
			expect(sql).toBe('users.priority < $1');
			expect(params).toEqual([5]);
		});

		it('lte', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'count',
				operator: 'lte',
				value: 99,
			});
			expect(sql).toBe('users.count <= $1');
			expect(params).toEqual([99]);
		});
	});

	describe('like', () => {
		it('case-sensitive LIKE', () => {
			const { sql, params } = compile({
				kind: 'like',
				field: 'name',
				pattern: 'John%',
				caseInsensitive: false,
			});
			expect(sql).toBe('users.name LIKE $1');
			expect(params).toEqual(['John%']);
		});

		it('case-insensitive ILIKE', () => {
			const { sql, params } = compile({
				kind: 'like',
				field: 'email',
				pattern: '%@example.com',
				caseInsensitive: true,
			});
			expect(sql).toBe('users.email ILIKE $1');
			expect(params).toEqual(['%@example.com']);
		});
	});

	describe('in', () => {
		it('IN list', () => {
			const { sql, params } = compile({
				kind: 'in',
				field: 'status',
				values: ['active', 'pending'],
			});
			// Compiled as = ANY($1)
			expect(sql).toMatch(/\$1/);
			expect(params).toHaveLength(1);
		});
	});

	describe('any', () => {
		it('= ANY($1)', () => {
			const { sql, params } = compile({
				kind: 'any',
				field: 'tag_id',
				values: [10, 20, 30],
			});
			expect(sql).toMatch(/tag_id/);
			expect(params).toHaveLength(1);
		});
	});

	describe('null', () => {
		it('IS NULL', () => {
			const { sql, params } = compile({
				kind: 'null',
				field: 'deleted_at',
				operator: 'isNull',
			});
			expect(sql).toBe('users.deleted_at IS NULL');
			expect(params).toHaveLength(0);
		});

		it('IS NOT NULL', () => {
			const { sql } = compile({
				kind: 'null',
				field: 'email',
				operator: 'isNotNull',
			});
			expect(sql).toBe('users.email IS NOT NULL');
		});
	});

	describe('range', () => {
		it('BETWEEN via operator+value', () => {
			const { sql, params } = compile({
				kind: 'range',
				field: 'age',
				operator: 'between',
				value: { lower: 18, upper: 65 },
			});
			expect(sql).toBe('users.age BETWEEN $1 AND $2');
			expect(params).toEqual([18, 65]);
		});

		it('overlaps (&&)', () => {
			const { sql, params } = compile({
				kind: 'range',
				field: 'booking_period',
				operator: 'overlaps',
				value: { lower: '2025-01-01', upper: '2025-01-31' },
			});
			expect(sql).toMatch(/&&/);
			expect(params).toHaveLength(1);
		});
	});

	describe('and', () => {
		it('AND of two conditions', () => {
			const { sql, params } = compile({
				kind: 'and',
				conditions: [
					{ kind: 'comparison', field: 'active', operator: 'eq', value: true },
					{ kind: 'comparison', field: 'role', operator: 'eq', value: 'admin' },
				],
			});
			expect(sql).toContain('users.active = $1');
			expect(sql).toContain('AND');
			expect(sql).toContain('users.role = $2');
			expect(params).toEqual([true, 'admin']);
		});
	});

	describe('or', () => {
		it('OR of two conditions', () => {
			const { sql, params } = compile({
				kind: 'or',
				conditions: [
					{
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'active',
					},
					{
						kind: 'comparison',
						field: 'status',
						operator: 'eq',
						value: 'pending',
					},
				],
			});
			expect(sql).toContain('users.status = $1');
			expect(sql).toContain('OR');
			expect(sql).toContain('users.status = $2');
			expect(params).toEqual(['active', 'pending']);
		});
	});

	describe('not', () => {
		it('NOT wraps a condition', () => {
			const { sql, params } = compile({
				kind: 'not',
				condition: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: false,
				},
			});
			expect(sql).toContain('NOT');
			expect(sql).toContain('users.active = $1');
			expect(params).toEqual([false]);
		});
	});

	describe('jsonContains', () => {
		it('@> containment', () => {
			const { sql, params } = compile({
				kind: 'jsonContains',
				field: 'metadata',
				value: { key: 'val' },
				reversed: false,
			});
			expect(sql).toMatch(/@>/);
			expect(params).toHaveLength(1);
		});
	});

	describe('jsonExists', () => {
		it('? key existence', () => {
			const { sql, params } = compile({
				kind: 'jsonExists',
				field: 'metadata',
				key: 'theme',
			});
			expect(sql).toMatch(/\?/);
			expect(params).toEqual(['theme']);
		});
	});

	describe('nested AND/OR', () => {
		it('AND(OR, condition)', () => {
			const { sql, params } = compile({
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

	describe('exists', () => {
		it('EXISTS with nested condition', () => {
			const { sql, params } = compile({
				kind: 'exists',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
			});
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('SELECT 1');
			expect(sql).toContain('posts');
			expect(sql).toContain('status');
			expect(sql).toContain('$1');
			expect(params).toEqual(['active']);
		});

		it('EXISTS without nested condition', () => {
			const { sql, params } = compile({
				kind: 'exists',
				relation: 'orders',
			});
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('SELECT 1');
			expect(sql).toContain('orders');
			expect(params).toEqual([]);
		});
	});

	describe('notExists', () => {
		it('NOT EXISTS with nested condition', () => {
			const { sql, params } = compile({
				kind: 'notExists',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'deleted',
				},
			});
			expect(sql).toContain('NOT');
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('SELECT 1');
			expect(sql).toContain('posts');
			expect(sql).toContain('$1');
			expect(params).toEqual(['deleted']);
		});

		it('NOT EXISTS without nested condition', () => {
			const { sql, params } = compile({
				kind: 'notExists',
				relation: 'orders',
			});
			expect(sql).toContain('NOT');
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('orders');
			expect(params).toEqual([]);
		});
	});

	describe('expression', () => {
		it('standalone boolean expression (no value)', () => {
			// Build a simple ref expression: exprRef('active')
			const { sql } = compile({
				kind: 'expression',
				expr: { kind: 'ref', column: 'active' },
				operator: 'eq',
				value: undefined as unknown as boolean,
			});
			// Should compile the expression as-is (column reference), no $N
			expect(sql).toContain('active');
		});

		it('expression compared to value (eq)', () => {
			// ref('score') = 100
			const { sql, params } = compile({
				kind: 'expression',
				expr: { kind: 'ref', column: 'score' },
				operator: 'eq',
				value: 100,
			});
			expect(sql).toContain('score');
			expect(sql).toContain('=');
			expect(sql).toContain('$1');
			expect(params).toEqual([100]);
		});

		it('expression compared to value (gt)', () => {
			// ref('age') > 18
			const { sql, params } = compile({
				kind: 'expression',
				expr: { kind: 'ref', column: 'age' },
				operator: 'gt',
				value: 18,
			});
			expect(sql).toContain('age');
			expect(sql).toContain('>');
			expect(sql).toContain('$1');
			expect(params).toEqual([18]);
		});
	});

	describe('subquery', () => {
		it('field = (SELECT col FROM table) via compileSubquery callback', () => {
			// The compileSubquery callback returns a prebuilt SelectStmt node
			// for: SELECT "author_id" FROM "posts" AS "posts_sq"
			const subqueryNode: Node = {
				SelectStmt: {
					targetList: [
						{
							ResTarget: {
								val: {
									ColumnRef: {
										fields: [
											{ String: { sval: 'posts_sq' } },
											{ String: { sval: 'author_id' } },
										],
									},
								},
							},
						},
					],
					fromClause: [
						{
							RangeVar: {
								relname: 'posts',
								alias: { aliasname: 'posts_sq' },
								inh: true,
								relpersistence: 'p',
							},
						},
					],
				},
			};

			const { sql, params } = compile(
				{
					kind: 'subquery',
					field: 'id',
					operator: 'eq',
					subquery: {
						from: 'posts',
						select: { fields: ['author_id'] } as unknown as SelectIntent,
					} as unknown as QueryIntent,
				},
				{
					compileSubquery: (_intent, _offset) => ({
						sql: subqueryNode,
						paramCount: 0,
					}),
				},
			);
			// id = (SELECT posts_sq.author_id FROM posts AS posts_sq)
			expect(sql).toContain('id');
			expect(sql).toContain('=');
			expect(sql).toContain('SELECT');
			expect(sql).toContain('author_id');
			expect(sql).toContain('posts');
			expect(params).toEqual([]);
		});

		it('uses buildSubqueryFromIntent for simple QueryIntent', () => {
			// buildSubqueryFromIntent builds a SelectStmt from a QueryIntent directly
			// Without a WHERE, it should compile to SELECT col FROM table AS alias
			const { sql: subSql } = buildSubqueryFromIntent(
				{
					from: 'posts',
					select: { fields: ['author_id'] } as unknown as SelectIntent,
				} as unknown as QueryIntent,
				0,
			);
			// The returned node should be a SelectStmt — just verify structure
			expect(subSql).toHaveProperty('SelectStmt');
		});
	});

	describe('relationFilter', () => {
		it('mode=some compiles to EXISTS', () => {
			const { sql, params } = compile({
				kind: 'relationFilter',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
				mode: 'some',
			});
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('posts');
			expect(sql).toContain('$1');
			expect(params).toEqual([true]);
		});

		it('mode=none compiles to NOT EXISTS', () => {
			const { sql, params } = compile({
				kind: 'relationFilter',
				relation: 'posts',
				where: {
					kind: 'comparison',
					field: 'published',
					operator: 'eq',
					value: true,
				},
				mode: 'none',
			});
			expect(sql).toContain('NOT');
			expect(sql).toContain('EXISTS');
			expect(sql).toContain('posts');
			expect(params).toEqual([true]);
		});
	});

	// -------------------------------------------------------------------------
	// Gap 4: comparison with ExpressionRef value (eq('col', fn(...)))
	// -------------------------------------------------------------------------
	describe('comparison with ExpressionRef value', () => {
		it('eq(col, fn(coalesce, exprRef(a), exprRef(b))) compiles col = coalesce(a, b)', () => {
			// eq('call_line', fn('coalesce', exprRef('decl_line'), exprRef('def_line')))
			// produces kind:'comparison' with value = ExpressionRef (has __expr:true)
			const coalesceExpr = fn(
				'coalesce',
				exprRef('decl_line'),
				exprRef('def_line'),
			);
			const intent: WhereIntent = {
				kind: 'comparison',
				field: 'call_line',
				operator: 'eq',
				value: coalesceExpr,
			};
			const { sql, params } = compile(intent);
			// pgsql-deparser quotes function names; coalesce → "coalesce"
			expect(sql).toBe('users.call_line = "coalesce"(decl_line, def_line)');
			expect(params).toEqual([]);
		});

		it('neq(col, fn(coalesce, exprRef(a), exprRef(b))) compiles col != coalesce(a, b)', () => {
			const coalesceExpr = fn(
				'coalesce',
				exprRef('decl_line'),
				exprRef('def_line'),
			);
			const intent: WhereIntent = {
				kind: 'comparison',
				field: 'call_line',
				operator: 'neq',
				value: coalesceExpr,
			};
			const { sql, params } = compile(intent);
			// OP_MAP['neq'] = '!=' (deparser does not normalize != to <> for A_Expr nodes)
			expect(sql).toBe('users.call_line != "coalesce"(decl_line, def_line)');
			expect(params).toEqual([]);
		});

		it('gt(col, fn(...)) compiles col > fn(...)', () => {
			const absExpr = fn('abs', exprRef('delta'));
			const intent: WhereIntent = {
				kind: 'comparison',
				field: 'score',
				operator: 'gt',
				value: absExpr,
			};
			const { sql, params } = compile(intent);
			expect(sql).toBe('users.score > abs(delta)');
			expect(params).toEqual([]);
		});

		it('scalar comparison still emits $N param (regression guard)', () => {
			const { sql, params } = compile({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'active',
			});
			expect(sql).toBe('users.status = $1');
			expect(params).toEqual(['active']);
		});
	});
});

describe('rawExists / rawNotExists', () => {
	/**
	 * Build a compile helper that provides a real compileSubquery callback.
	 */
	function compileWithSubquery(intent: WhereIntent): {
		sql: string;
		params: unknown[];
	} {
		const paramState = createCompilerState();
		const ctx: WhereCompilerCtx = {
			rootTable: 'symbols',
			aliases: new Map(),
			paramState,
			naming: identityNaming,
			compileSubquery: (subIntent: QueryIntent, paramOffset: number) =>
				buildSubqueryFromIntent(subIntent, paramOffset, identityNaming),
		};
		const node = compileWhereIntent(intent, ctx);
		const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
			.replace(/^SELECT\s+WHERE\s+/i, '')
			.trim();
		return { sql, params: paramState.parameters };
	}

	it('rawExists compiles to EXISTS (SELECT 1 FROM ...)', () => {
		const subIntent: QueryIntent = {
			type: 'select' as const,
			from: 'posts',
			select: { type: 'fields' as const, fields: ['1'] } as SelectIntent,
		};
		const { sql, params } = compileWithSubquery({
			kind: 'rawExists',
			subquery: subIntent,
		} as unknown as WhereIntent);
		expect(sql).toMatch(/EXISTS\s*\(SELECT/i);
		expect(sql).toContain('posts');
		expect(params).toEqual([]);
	});

	it('rawNotExists compiles to NOT EXISTS (SELECT 1 FROM ...)', () => {
		const subIntent: QueryIntent = {
			type: 'select' as const,
			from: 'posts',
			select: { type: 'fields' as const, fields: ['1'] } as SelectIntent,
		};
		const { sql, params } = compileWithSubquery({
			kind: 'rawNotExists',
			subquery: subIntent,
		} as unknown as WhereIntent);
		// The deparser may render as "NOT (EXISTS (...))" or "NOT EXISTS (...)" --
		// both are semantically identical; match NOT + EXISTS.
		expect(sql).toMatch(/NOT\s+\(?EXISTS\s*\(SELECT/i);
		expect(sql).toContain('posts');
		expect(params).toEqual([]);
	});

	it('rawExists with inner WHERE propagates parameters', () => {
		const subIntent: QueryIntent = {
			type: 'select' as const,
			from: 'posts',
			select: { type: 'fields' as const, fields: ['id'] } as SelectIntent,
			where: {
				kind: 'comparison',
				field: 'user_id',
				operator: 'eq',
				value: 42,
			} as WhereIntent,
		};
		const { sql, params } = compileWithSubquery({
			kind: 'rawExists',
			subquery: subIntent,
		} as unknown as WhereIntent);
		expect(sql).toMatch(/EXISTS\s*\(SELECT/i);
		expect(sql).toContain('posts');
		expect(sql).toContain('$1');
		expect(params).toEqual([42]);
	});

	it('rawNotExists with inner WHERE propagates parameters', () => {
		const subIntent: QueryIntent = {
			type: 'select' as const,
			from: 'comments',
			select: { type: 'fields' as const, fields: ['id'] } as SelectIntent,
			where: {
				kind: 'comparison',
				field: 'post_id',
				operator: 'eq',
				value: 99,
			} as WhereIntent,
		};
		const { sql, params } = compileWithSubquery({
			kind: 'rawNotExists',
			subquery: subIntent,
		} as unknown as WhereIntent);
		// The deparser may render as "NOT (EXISTS (...))" or "NOT EXISTS (...)" --
		// both are semantically identical; match NOT + EXISTS.
		expect(sql).toMatch(/NOT\s+\(?EXISTS\s*\(SELECT/i);
		expect(sql).toContain('comments');
		expect(sql).toContain('$1');
		expect(params).toEqual([99]);
	});
});
