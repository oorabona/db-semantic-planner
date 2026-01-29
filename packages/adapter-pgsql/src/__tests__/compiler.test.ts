/**
 * PlanCompiler Tests
 *
 * Tests for the tree-to-tree compiler that transforms
 * PlanReport → PostgreSQL AST → SQL
 */

import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-compare.js';
import {
	compilePlan,
	PlanCompiler,
	type SimplifiedPlanReport,
} from '../compiler.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';

describe('PlanCompiler', () => {
	describe('SELECT queries', () => {
		it('compiles simple SELECT *', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [],
			};

			const result = compilePlan(plan);

			expect(normalizeSQL(result.sql)).toContain('select');
			expect(normalizeSQL(result.sql)).toMatch(/from\s+"?users"?/);
		});

		it('compiles SELECT with columns', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{ type: 'select', column: 'name' },
					{ type: 'select', column: 'email' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('id');
			expect(normalized).toContain('name');
			expect(normalized).toContain('email');
		});

		it('compiles SELECT with column aliases', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id', alias: 'user_id' },
					{ type: 'select', column: 'name', alias: 'user_name' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('as');
		});

		it('compiles SELECT with WHERE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'active', operator: '=', value: true },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('where');
			expect(normalized).toContain('active');
		});

		it('compiles SELECT with parameterized WHERE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'id',
						operator: '=',
						paramIndex: 1,
						value: 42,
					},
				],
			};

			const result = compilePlan(plan);

			expect(result.sql).toContain('$1');
			expect(result.parameters).toContain(42);
		});

		it('compiles SELECT with multiple WHERE conditions (AND)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'whereAnd',
						conditions: [
							{ type: 'where', column: 'active', operator: '=', value: true },
							{
								type: 'where',
								column: 'role',
								operator: '=',
								paramIndex: 1,
								value: 'admin',
							},
						],
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('and');
		});

		it('compiles SELECT with OR conditions', () => {
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

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('or');
		});

		it('compiles SELECT with ORDER BY', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'orderBy', column: 'created_at', direction: 'DESC' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('order by');
			expect(normalized).toContain('desc');
		});

		it('compiles SELECT with LIMIT and OFFSET', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: 10 },
					{ type: 'offset', offset: 20 },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('limit');
			expect(normalized).toContain('offset');
		});

		it('compiles SELECT with parameterized LIMIT/OFFSET', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'limit', limit: { paramIndex: 1 } },
					{ type: 'offset', offset: { paramIndex: 2 } },
				],
			};

			const result = compilePlan(plan);

			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
		});

		it('compiles SELECT DISTINCT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [{ type: 'select', column: 'role' }, { type: 'distinct' }],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('distinct');
		});

		it('compiles SELECT with GROUP BY and HAVING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'products',
				decisions: [
					{ type: 'select', column: 'category' },
					{
						type: 'selectFunction',
						function: 'count',
						column: '*',
						alias: 'count',
					},
					{ type: 'groupBy', column: 'category' },
					{ type: 'having', column: 'count', operator: '>', value: 5 },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('group by');
			expect(normalized).toContain('having');
		});

		it('compiles SELECT with JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*', table: 'users' },
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'orders',
						alias: 'o',
						sourceColumn: 'id',
						targetColumn: 'user_id',
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('join');
		});

		it('compiles SELECT with LEFT JOIN', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'join',
						joinType: 'left',
						targetTable: 'profiles',
						sourceColumn: 'id',
						targetColumn: 'user_id',
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('left');
			expect(normalized).toContain('join');
		});

		it('compiles SELECT with aggregate functions', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						column: '*',
						alias: 'total',
					},
					{
						type: 'selectFunction',
						function: 'sum',
						column: 'amount',
						alias: 'total_amount',
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('count');
			expect(normalized).toContain('sum');
		});
	});

	describe('INSERT queries', () => {
		it('compiles simple INSERT', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name', 'email'],
						values: [
							{ paramIndex: 1, value: 'John' },
							{ paramIndex: 2, value: 'john@example.com' },
						],
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('insert into');
			expect(normalized).toContain('users');
			expect(result.sql).toContain('$1');
			expect(result.sql).toContain('$2');
		});

		it('compiles INSERT with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'insert',
						columns: ['name'],
						values: [{ paramIndex: 1, value: 'John' }],
					},
					{ type: 'returning', column: 'id' },
					{ type: 'returning', column: 'created_at' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('returning');
		});
	});

	describe('UPDATE queries', () => {
		it('compiles simple UPDATE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'name', value: { paramIndex: 1, value: 'Jane' } }],
					},
					{
						type: 'where',
						column: 'id',
						operator: '=',
						paramIndex: 2,
						value: 1,
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('update');
			expect(normalized).toContain('set');
			expect(normalized).toContain('where');
		});

		it('compiles UPDATE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{
						type: 'update',
						set: [{ column: 'status', value: 'active' }],
					},
					{
						type: 'where',
						column: 'id',
						operator: '=',
						paramIndex: 1,
						value: 1,
					},
					{ type: 'returning', column: '*' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('returning');
		});
	});

	describe('DELETE queries', () => {
		it('compiles simple DELETE', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'sessions',
				decisions: [
					{ type: 'delete' },
					{
						type: 'where',
						column: 'id',
						operator: '=',
						paramIndex: 1,
						value: 42,
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('delete from');
			expect(normalized).toContain('where');
		});

		it('compiles DELETE with RETURNING', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'delete' },
					{
						type: 'where',
						column: 'id',
						operator: '=',
						paramIndex: 1,
						value: 1,
					},
					{ type: 'returning', column: 'id' },
					{ type: 'returning', column: 'email' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('returning');
		});
	});

	describe('Naming convention', () => {
		it('applies CamelCase naming plugin', () => {
			const compiler = new PlanCompiler({
				naming: new CamelCaseNamingPlugin(),
			});

			const plan: SimplifiedPlanReport = {
				rootTable: 'userProfiles',
				decisions: [
					{ type: 'select', column: 'firstName' },
					{ type: 'select', column: 'lastName' },
					{
						type: 'where',
						column: 'createdAt',
						operator: '>',
						paramIndex: 1,
						value: '2024-01-01',
					},
				],
			};

			const result = compiler.compile(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('user_profiles');
			expect(normalized).toContain('first_name');
			expect(normalized).toContain('last_name');
			expect(normalized).toContain('created_at');
		});
	});

	describe('Schema support', () => {
		it('includes schema in table reference', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				schema: 'public',
				decisions: [{ type: 'select', column: '*' }],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toMatch(/"?public"?\."?users"?/);
		});
	});

	describe('Comparison operators', () => {
		const operators = [
			{ op: '=', sql: '=' },
			{ op: 'eq', sql: '=' },
			{ op: '!=', sql: '<>' },
			{ op: 'ne', sql: '<>' },
			{ op: '<', sql: '<' },
			{ op: 'lt', sql: '<' },
			{ op: '<=', sql: '<=' },
			{ op: 'lte', sql: '<=' },
			{ op: '>', sql: '>' },
			{ op: 'gt', sql: '>' },
			{ op: '>=', sql: '>=' },
			{ op: 'gte', sql: '>=' },
		];

		for (const { op, sql } of operators) {
			it(`handles ${op} operator`, () => {
				const plan: SimplifiedPlanReport = {
					rootTable: 'users',
					decisions: [
						{ type: 'select', column: '*' },
						{ type: 'where', column: 'age', operator: op, value: 18 },
					],
				};

				const result = compilePlan(plan);
				expect(result.sql).toContain(sql);
			});
		}

		it('handles LIKE operator', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'name', operator: 'like', value: '%john%' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);
			// PostgreSQL LIKE can be output as 'like' or '~~'
			expect(normalized.includes('like') || normalized.includes('~~')).toBe(
				true,
			);
		});

		it('handles IS NULL', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'deleted_at', operator: 'isNull' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('is null');
		});

		it('handles IS NOT NULL', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'email', operator: 'isNotNull' },
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);
			expect(normalized).toContain('is not null');
		});
	});

	describe('Roundtrip verification', () => {
		it('compiled SQL parses correctly', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: 'id' },
					{ type: 'select', column: 'name' },
					{ type: 'where', column: 'active', operator: '=', value: true },
					{ type: 'orderBy', column: 'created_at', direction: 'DESC' },
					{ type: 'limit', limit: 10 },
				],
			};

			const result = compilePlan(plan);

			// Verify the SQL can be parsed
			const parsed = parseSync(result.sql);
			expect(parsed.stmts).toHaveLength(1);
		});

		it('complex query parses correctly', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: 'customer_id' },
					{
						type: 'selectFunction',
						function: 'sum',
						column: 'total',
						alias: 'total_spent',
					},
					{
						type: 'join',
						joinType: 'inner',
						targetTable: 'customers',
						sourceColumn: 'customer_id',
						targetColumn: 'id',
						alias: 'c',
					},
					{ type: 'groupBy', column: 'customer_id' },
					{ type: 'having', column: 'sum', operator: '>', value: 1000 },
					{ type: 'orderBy', column: 'total_spent', direction: 'DESC' },
					{ type: 'limit', limit: 10 },
				],
			};

			const result = compilePlan(plan);

			// Verify the SQL can be parsed
			const parsed = parseSync(result.sql);
			expect(parsed.stmts).toHaveLength(1);
		});
	});
});
