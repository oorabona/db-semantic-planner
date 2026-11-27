/**
 * PlanCompiler Tests
 *
 * Tests for the tree-to-tree compiler that transforms
 * PlanReport → PostgreSQL AST → SQL
 */

import {
	compilePlan,
	type SimplifiedPlanReport,
} from '@dbsp/adapter-pgsql/internal';
import {
	createOrm,
	type Dump,
	eq,
	gt,
	inSubquery,
	lt,
	type MutationDump,
	ref,
	schema,
	subquery,
} from '@dbsp/core';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';

const db = schema({
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'text',
		email: 'text',
		age: 'integer',
		active: 'boolean',
		created_at: 'text',
		createdAt: 'text',
		firstName: 'text',
		lastName: 'text',
	},
	customers: {
		id: { type: 'integer', primaryKey: true },
		active: 'boolean',
	},
	orders: {
		id: { type: 'integer', primaryKey: true },
		customer_id: ref('customers', { as: 'customer' }),
		total: 'integer',
		price: 'integer',
		quantity: 'integer',
		balance: 'integer',
	},
});
const orm = createOrm({
	schema: db,
	adapter: createPgCompileOnlyAdapter({ model: db.model }),
});

/** The compiled SQL and bound values of a query or mutation dump. */
function compiled(dump: Dump | MutationDump) {
	return {
		sql: dump.sql,
		params: 'parameters' in dump ? dump.parameters : dump.params,
	};
}

describe('PlanCompiler', () => {
	describe('SELECT queries', () => {
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
	});

	describe('DELETE queries', () => {
		it('compiles DELETE with RETURNING', () => {
			const dump = orm
				.delete('users')
				.where(eq('id', 1))
				.returning(['id', 'email'])
				.dump();

			expect(compiled(dump)).toEqual({
				sql: 'DELETE FROM users WHERE users.id = $1 RETURNING users.id AS id, users.email AS email',
				params: [1],
			});
		});
	});

	describe('Naming convention', () => {
		it('does not apply the legacy naming policy to direct compilation', () => {
			const { sql, params } = orm
				.select('users')
				.columns(['firstName', 'lastName'])
				.where(gt('createdAt', '2024-01-01'))
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT users."firstName", users."lastName" FROM users WHERE users."createdAt" > $1',
				params: ['2024-01-01'],
			});
		});
	});

	describe('Comparison operators', () => {
		const operators = [
			{
				op: '<',
				build: lt,
				sql: 'SELECT users.* FROM users WHERE users.age < $1',
			},
			{
				op: 'lt',
				build: lt,
				sql: 'SELECT users.* FROM users WHERE users.age < $1',
			},
			{
				op: '>',
				build: gt,
				sql: 'SELECT users.* FROM users WHERE users.age > $1',
			},
			{
				op: 'gt',
				build: gt,
				sql: 'SELECT users.* FROM users WHERE users.age > $1',
			},
		];

		for (const { op, build, sql } of operators) {
			it(`handles ${op} operator`, () => {
				const result = orm.select('users').where(build('age', 18)).dump();
				expect({ sql: result.sql, params: result.params }).toEqual({
					sql,
					params: [18],
				});
			});
		}
	});

	describe('Roundtrip verification', () => {
		it('compiled SQL parses correctly', () => {
			const { sql } = orm
				.select('users')
				.columns(['id', 'name'])
				.where(eq('active', true))
				.orderBy('created_at', 'desc')
				.limit(10)
				.dump();

			expect(sql).toBe(
				'SELECT users.id, users.name FROM users WHERE users.active = $1 ORDER BY users.created_at DESC LIMIT 10',
			);
			// Verify the SQL can be parsed
			const parsed = parseSync(sql);
			expect(parsed.stmts).toHaveLength(1);
		});

		it('complex query parses correctly', () => {
			const { sql, params } = orm
				.select('orders')
				.columns(['customer_id'])
				.join('customer')
				.groupBy(['customer_id'])
				.sum('total', 'total_spent')
				.having(gt('total_spent', 1000))
				.orderBy('total_spent', 'desc')
				.limit(10)
				.dump();

			expect(sql).toBe(
				'SELECT orders.customer_id, sum(orders.total) AS total_spent FROM orders JOIN customers AS customer ON orders.customer_id = customer.id GROUP BY orders.customer_id HAVING sum(orders.total) > $1 ORDER BY total_spent DESC LIMIT 10',
			);
			expect(params).toEqual([1000]);
			// Verify the SQL can be parsed
			const parsed = parseSync(sql);
			expect(parsed.stmts).toHaveLength(1);
		});
	});

	describe('IN (subquery) conditions', () => {
		it('compiles WHERE field NOT IN (SELECT col FROM table)', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'orders',
				decisions: [
					{ type: 'select', column: '*' },
					{
						type: 'where',
						column: 'customer_id',
						operator: 'notIn',
						subquery: {
							from: 'blocked_customers',
							select: 'id',
						},
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			expect(normalized).toContain('<> all');
			expect(normalized).toContain('select');
			expect(normalized).toContain('blocked_customers');
			expect(result.parameters).toHaveLength(0);
		});

		it('compiles WHERE field IN (SELECT col FROM table WHERE cond)', () => {
			const { sql, params } = orm
				.select('orders')
				.where(
					inSubquery(
						'customer_id',
						subquery('customers').select('id').where(eq('active', true)),
					),
				)
				.dump();

			expect({ sql, params }).toEqual({
				sql: 'SELECT orders.* FROM orders WHERE orders.customer_id = ANY (SELECT customers_subq_0.id FROM customers AS customers_subq_0 WHERE customers_subq_0.active = $1)',
				params: [true],
			});
		});
	});

	describe('selectArithmetic decisions', () => {
		it('compiles arithmetic expression price * quantity', () => {
			const dump = orm.nql`orders | select price * quantity as total`.dump();

			expect(compiled(dump)).toEqual({
				sql: 'SELECT orders.price * orders.quantity AS total FROM orders',
				params: [],
			});
		});

		it('compiles arithmetic with literal operand', () => {
			const dump = orm.nql`orders | select price * 1.1 as with_tax`.dump();

			expect(compiled(dump)).toEqual({
				sql: 'SELECT orders.price * $1 AS with_tax FROM orders',
				params: [1.1],
			});
		});

		it('compiles negation as arithmetic -1 * field', () => {
			const dump = orm.nql`orders | select -balance as negative_balance`.dump();

			expect(compiled(dump)).toEqual({
				sql: 'SELECT $1 * orders.balance AS negative_balance FROM orders',
				params: [-1],
			});
		});
	});

	describe('selectPseudoColumn decisions', () => {
		it('compiles pseudo-column (recursive traversal) via expression handler', () => {
			const plan: SimplifiedPlanReport = {
				rootTable: 'employees',
				decisions: [
					{
						type: 'selectPseudoColumn',
						traversal: 'ancestors',
						column: 'name',
						table: 'employees',
						pkColumn: 'id',
						alias: 'ancestor_names',
					},
				],
			};

			const result = compilePlan(plan);
			const normalized = normalizeSQL(result.sql);

			// Pseudo-column handler generates recursive CTE subquery
			expect(normalized).toContain('recursive');
			expect(normalized).toContain('employees');
		});
	});
});

// ============================================================================
// DISTINCT ON
// ============================================================================

describe('DISTINCT ON compilation', () => {
	it('compiles DISTINCT ON with multiple columns', () => {
		const { sql, params } = orm.select('users').distinctOn('id', 'name').dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT DISTINCT ON (id, name) users.* FROM users',
			params: [],
		});
	});

	it('does not apply the legacy naming policy to DISTINCT ON columns', () => {
		const { sql, params } = orm.select('users').distinctOn('createdAt').dump();

		expect({ sql, params }).toEqual({
			sql: 'SELECT DISTINCT ON ("createdAt") users.* FROM users',
			params: [],
		});
	});
});
