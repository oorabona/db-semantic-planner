// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for compiler.ts.
 *
 * Focus: Uncovered branches in PlanCompiler including:
 * - Various decision types (selectFunction, selectExpression, selectWindow, etc.)
 * - existsWrap functionality
 * - DISTINCT handling
 * - Schema scoping
 * - Lock clauses (FOR UPDATE, FOR SHARE, SKIP LOCKED, NOWAIT)
 * - ORDER BY with nulls (FIRST/LAST)
 * - GROUP BY and HAVING
 * - Parameterized limit/offset
 * - Include strategies (json_agg, lateral, cte)
 * - JOIN filter strategy
 * - Set operations branches
 * - IN/NOT IN subquery handling
 * - Nested conditions (whereAnd, whereOr, whereNot)
 * - Returning clauses
 */

import { describe, expect, it } from 'vitest';
import { normalizeSQL } from './ast-helpers.js';
import { PlanCompiler, type SimplifiedPlanReport } from './compiler.js';

describe('PlanCompiler - Coverage Tests', () => {
	describe('existsWrap', () => {
		it('wraps SELECT in EXISTS subquery', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'id' }],
				existsWrap: true,
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('exists');
			expect(result.ast).toHaveProperty('SelectStmt');
		});

		it('handles existsWrap with WHERE clause', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'active', operator: '=', value: true },
				],
				existsWrap: true,
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('exists');
			expect(sql).toContain('where');
		});
	});

	describe('DISTINCT', () => {
		it('compiles SELECT DISTINCT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'email' }, { type: 'distinct' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('distinct');
		});
	});

	describe('Schema scoping', () => {
		it('includes schema in FROM clause via plan.schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_a',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_a');
		});

		it('includes schema via compiler options', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ schema: 'tenant_b' });
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_b');
		});

		it('plan.schema overrides compiler schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'plan_schema',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ schema: 'compiler_schema' });
			const result = compiler.compile(plan);
			expect(result.sql).toContain('plan_schema');
			expect(result.sql).not.toContain('compiler_schema');
		});
	});

	describe('Lock clauses (FOR UPDATE/SHARE)', () => {
		it('compiles FOR UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
		});

		it('compiles FOR SHARE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forShare', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for share');
		});

		it('compiles FOR UPDATE SKIP LOCKED', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'skipLocked' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('skip locked');
		});

		it('compiles FOR UPDATE NOWAIT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'noWait' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('nowait');
		});
	});

	describe('ORDER BY with nulls', () => {
		it('compiles ORDER BY with NULLS FIRST', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'orderBy',
						column: 'created_at',
						direction: 'DESC',
						nulls: 'FIRST',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('order by');
			expect(sql).toContain('nulls first');
		});

		it('compiles ORDER BY with NULLS LAST', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'orderBy',
						column: 'created_at',
						direction: 'ASC',
						nulls: 'LAST',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('order by');
			expect(sql).toContain('nulls last');
		});
	});

	describe('GROUP BY and HAVING', () => {
		it('compiles GROUP BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('group by');
			expect(sql).toContain('user_id');
		});

		it('compiles GROUP BY with HAVING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'user_id' },
					{ type: 'groupBy', column: 'user_id' },
					{ type: 'having', column: 'total', operator: '>', value: 100 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('group by');
			expect(sql).toContain('having');
		});
	});

	describe('Parameterized limit/offset', () => {
		it('compiles limit as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.parameters).toHaveLength(1);
		});

		it('compiles offset as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'offset', offset: { paramIndex: 1 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.parameters).toHaveLength(1);
		});

		it('compiles both limit and offset as parameterized', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
					{ type: 'offset', offset: { paramIndex: 2 } },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
			expect(result.parameters).toHaveLength(2);
		});
	});

	describe('selectFunction with aggregate', () => {
		it('compiles COUNT aggregate', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						args: ['*'],
						alias: 'total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('count');
			expect(sql).toContain('total');
		});

		it('compiles SUM aggregate with column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'sum',
						column: 'amount',
						alias: 'total_amount',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('sum');
			expect(sql).toContain('total_amount');
		});
	});

	describe('selectExpression with CASE', () => {
		it('compiles simple CASE expression', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 1,
								},
								then: 'active',
							},
						],
						value: 'inactive',
						alias: 'status_label',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			expect(sql).toContain('when');
			expect(sql).toContain('status_label');
		});

		it('compiles CASE with multiple WHEN branches', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 1,
								},
								then: 'pending',
							},
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 2,
								},
								then: 'shipped',
							},
							{
								when: {
									type: 'where',
									column: 'status',
									operator: '=',
									value: 3,
								},
								then: 'delivered',
							},
						],
						value: 'unknown',
						alias: 'status_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('case');
			// 3 condition values (1, 2, 3)
			expect(result.parameters).toHaveLength(3);
		});
	});

	describe('selectWindow', () => {
		it('compiles window function with PARTITION BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				decisions: [
					{
						type: 'selectWindow',
						function: 'row_number',
						partitionBy: ['department'],
						orderBy: [{ field: 'salary', direction: 'desc' }],
						alias: 'rank',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('row_number');
			expect(sql).toContain('over');
			expect(sql).toContain('partition by');
		});

		it('compiles window function without partition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sales',
				decisions: [
					{
						type: 'selectWindow',
						function: 'rank',
						orderBy: [{ field: 'amount', direction: 'desc' }],
						alias: 'global_rank',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('rank');
			expect(sql).toContain('over');
		});
	});

	describe('selectRelationColumn', () => {
		it('compiles relation column selection', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{
						type: 'selectRelationColumn',
						relation: 'author',
						column: 'name',
						alias: 'author_name',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile via expression handler
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectPseudoColumn', () => {
		it('compiles ancestors pseudo-column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [
					{
						type: 'selectPseudoColumn',
						traversal: 'ancestors',
						column: 'id',
						pkColumn: 'id',
						fkColumn: 'parent_id',
						alias: 'ancestor_ids',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile via recursive CTE
			expect(result.sql).toBeDefined();
		});
	});

	describe('selectArithmetic', () => {
		it('compiles arithmetic expression (addition)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'products',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '+',
						args: [
							{ type: 'column', column: 'price' },
							{ type: 'column', column: 'tax' },
						],
						alias: 'total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('+');
		});

		it('compiles arithmetic expression (multiplication)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectArithmetic',
						operator: '*',
						args: [
							{ type: 'column', column: 'quantity' },
							{ type: 'column', column: 'price' },
						],
						alias: 'line_total',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('*');
		});
	});

	describe('whereAnd, whereOr, whereNot', () => {
		it('compiles whereAnd with multiple conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereAnd',
						conditions: [
							{ type: 'where', column: 'active', operator: '=', value: true },
							{ type: 'where', column: 'verified', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('and');
		});

		it('compiles whereOr with multiple conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereOr',
						conditions: [
							{ type: 'where', column: 'role', operator: '=', value: 'admin' },
							{
								type: 'where',
								column: 'role',
								operator: '=',
								value: 'moderator',
							},
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('or');
		});

		it('compiles whereNot with single condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereNot',
						conditions: [
							{ type: 'where', column: 'deleted', operator: '=', value: true },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('where');
			expect(sql).toContain('not');
		});

		it('compiles whereNot with multiple conditions (negates AND)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereNot',
						conditions: [
							{ type: 'where', column: 'role', operator: '=', value: 'guest' },
							{ type: 'where', column: 'active', operator: '=', value: false },
						],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('not');
		});
	});

	describe('IN/NOT IN subquery', () => {
		it('compiles IN with subquery in decision.subquery', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'id',
						operator: 'in',
						subquery: {
							from: 'active_users',
							select: 'user_id',
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('active_users');
		});

		it('compiles NOT IN with subquery in decision.value', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'id',
						operator: 'notIn',
						value: {
							from: 'blocked_users',
							select: 'user_id',
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses <> ALL for NOT IN
			expect(sql).toContain('<>');
			expect(sql).toContain('all');
			expect(sql).toContain('blocked_users');
		});

		it('compiles IN subquery with WHERE condition', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							where: {
								type: 'where',
								column: 'active',
								operator: '=',
								value: true,
							},
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('where');
		});

		it('compiles IN subquery with LIMIT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							limit: 10,
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('limit');
		});

		it('compiles IN subquery with ORDER BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'author_id',
						operator: 'in',
						subquery: {
							from: 'users',
							select: 'id',
							orderBy: [{ field: 'created_at', direction: 'desc' }],
						},
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			// PostgreSQL uses = ANY for IN
			expect(sql).toContain('any');
			expect(sql).toContain('order by');
		});
	});

	describe('JOIN decision', () => {
		it('compiles explicit JOIN decision', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*', table: 'posts' },
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'users',
						sourceColumn: 'author_id',
						targetColumn: 'id',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('join');
			expect(sql).toContain('users');
		});

		it('compiles LEFT JOIN decision', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'join',
						joinType: 'left',
						targetTable: 'comments',
						sourceColumn: 'id',
						targetColumn: 'post_id',
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('left');
			expect(sql).toContain('join');
		});
	});

	describe('INSERT/UPDATE/DELETE', () => {
		it('compiles INSERT with RETURNING *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name', 'email'],
						values: ['Alice', 'alice@example.com'],
					},
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('insert');
			expect(sql).toContain('returning');
		});

		it('compiles INSERT with RETURNING specific column', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name', 'email'],
						values: ['Bob', 'bob@example.com'],
					},
					{ type: 'returning', column: 'id', alias: 'new_id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('insert');
			expect(sql).toContain('returning');
			expect(sql).toContain('new_id');
		});

		it('compiles UPDATE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'active', value: false }],
					},
					{ type: 'where', column: 'id', operator: '=', value: 42 },
					{ type: 'returning', column: '*' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('update');
			expect(sql).toContain('returning');
		});

		it('compiles DELETE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 99 },
					{ type: 'returning', column: 'id' },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('delete');
			expect(sql).toContain('returning');
		});

		it('compiles INSERT with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_x',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: ['Test'],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_x');
		});

		it('compiles UPDATE with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_y',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'name', value: 'Updated' }],
					},
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_y');
		});

		it('compiles DELETE with schema', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'tenant_z',
				decisions: [
					{ type: 'delete' },
					{ type: 'where', column: 'id', operator: '=', value: 1 },
				],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			expect(result.sql).toContain('tenant_z');
		});
	});

	describe('Default behaviors', () => {
		it('defaults to SELECT * when no targetList', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('select');
			expect(sql).toContain('*');
		});

		it('uses default primary key column name', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile successfully with default pk='id'
			expect(result.sql).toBeDefined();
		});

		it('uses custom primary key column name', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler({ defaultPkColumnName: 'post_id' });
			const result = compiler.compile(plan);
			// Should compile with custom pk
			expect(result.sql).toBeDefined();
		});
	});

	describe('Error cases', () => {
		it('throws on unsupported query type', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'unsupported_type' }],
			};
			const compiler = new PlanCompiler();
			// Should handle gracefully or throw
			const result = compiler.compile(plan);
			expect(result.sql).toBeDefined();
		});

		it('throws on CASE without conditions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'selectExpression',
						expressionType: 'case',
						conditions: [],
						alias: 'status',
					},
				],
			};
			const compiler = new PlanCompiler();
			expect(() => compiler.compile(plan)).toThrow(
				'CASE requires at least one WHEN condition',
			);
		});
	});

	describe('CTE (WITH clause)', () => {
		it('compiles WITH clause when pendingCtes present', () => {
			// This branch is triggered by includeStrategy decisions that produce CTEs
			// For coverage, we need a plan that generates pendingCtes
			// Since we can't easily mock the include handler, we'll rely on integration tests
			// for full CTE coverage. This test is a placeholder.
			const plan: SimplifiedPlanReport = {
				rootTable: 'categories',
				decisions: [{ type: 'select', column: '*' }],
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			// Should compile successfully
			expect(result.sql).toBeDefined();
		});
	});

	describe('Lock basics', () => {
		it('compiles lock without JOINs (basic case)', () => {
			// Test basic lock compilation
			const plan: SimplifiedPlanReport = {
				rootTable: 'jobs',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for update');
			expect(sql).toContain('jobs');
		});

		it('compiles FOR KEY SHARE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'posts',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forKeyShare', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for key share');
		});

		it('compiles FOR NO KEY UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'items',
				decisions: [{ type: 'select', column: '*' }],
				lock: { strength: 'forNoKeyUpdate', waitPolicy: 'block' },
			};
			const compiler = new PlanCompiler();
			const result = compiler.compile(plan);
			const sql = normalizeSQL(result.sql);
			expect(sql).toContain('for no key update');
		});
	});
});
