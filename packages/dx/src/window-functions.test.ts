/**
 * @file Window Functions Tests (P3-A)
 * Tests for the window() method on QueryBuilder
 */

import { defineSchema } from '@db-semantic-planner/core';
import { Kysely, PostgresDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createOrm } from './orm.js';

// ============================================================================
// Test Schema
// ============================================================================

const testModel = defineSchema({
	products: {
		id: 'integer',
		name: 'string',
		price: 'number',
		categoryId: 'integer',
		createdAt: 'date',
	},
	sales: {
		id: 'integer',
		productId: 'integer',
		amount: 'number',
		date: 'date',
	},
	employees: {
		id: 'integer',
		name: 'string',
		department: 'string',
		salary: 'number',
	},
}).build();

// Create a mock Kysely instance
// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
const mockKysely = new Kysely<any>({
	dialect: {
		createAdapter: () => new PostgresDialect({ pool: {} as any }).createAdapter(),
		createDriver: () =>
			({
				init: async () => {},
				destroy: async () => {},
				acquireConnection: async () => ({ executeQuery: async () => ({}) }),
				releaseConnection: () => {},
				beginTransaction: async () => {},
				commitTransaction: async () => {},
				rollbackTransaction: async () => {},
			}) as any,
		createIntrospector: (db) =>
			new PostgresDialect({ pool: {} as any }).createIntrospector(db),
		createQueryCompiler: () =>
			new PostgresDialect({ pool: {} as any }).createQueryCompiler(),
	},
});

// ============================================================================
// Tests
// ============================================================================

describe('P3-A: Window Functions DX API', () => {
	describe('window() method', () => {
		it('should add ROW_NUMBER window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('row_num', {
					function: 'row_number',
					orderBy: [{ field: 'price', direction: 'desc' }],
				})
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql).toContain('OVER');
			expect(dump.sql).toContain('ORDER BY');
			expect(dump.sql).toContain('"row_num"');
		});

		it('should add RANK window function with PARTITION BY', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('category_rank', {
					function: 'rank',
					partitionBy: ['categoryId'],
					orderBy: [{ field: 'price', direction: 'desc' }],
				})
				.dump();

			expect(dump.sql).toContain('RANK()');
			expect(dump.sql).toContain('PARTITION BY');
			expect(dump.sql).toContain('"categoryId"');
			expect(dump.sql).toContain('"category_rank"');
		});

		it('should add DENSE_RANK window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('dense_rank', {
					function: 'dense_rank',
					orderBy: [{ field: 'createdAt' }],
				})
				.dump();

			expect(dump.sql).toContain('DENSE_RANK()');
		});

		it('should add SUM aggregate window function with field', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('sales')
				.window('running_total', {
					function: 'sum',
					field: 'amount',
					partitionBy: ['productId'],
					orderBy: [{ field: 'date', direction: 'asc' }],
				})
				.dump();

			expect(dump.sql).toContain('SUM(');
			expect(dump.sql).toContain('"amount"');
			expect(dump.sql).toContain('PARTITION BY');
			expect(dump.sql).toContain('"running_total"');
		});

		it('should add AVG aggregate window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('employees')
				.window('dept_avg_salary', {
					function: 'avg',
					field: 'salary',
					partitionBy: ['department'],
				})
				.dump();

			expect(dump.sql).toContain('AVG(');
			expect(dump.sql).toContain('"salary"');
			expect(dump.sql).toContain('"dept_avg_salary"');
		});

		it('should add COUNT aggregate window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('products_in_category', {
					function: 'count',
					field: 'id',
					partitionBy: ['categoryId'],
				})
				.dump();

			expect(dump.sql).toContain('COUNT(');
			expect(dump.sql).toContain('"products_in_category"');
		});

		it('should add MIN window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('min_price', {
					function: 'min',
					field: 'price',
					partitionBy: ['categoryId'],
				})
				.dump();

			expect(dump.sql).toContain('MIN(');
		});

		it('should add MAX window function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('max_price', {
					function: 'max',
					field: 'price',
					partitionBy: ['categoryId'],
				})
				.dump();

			expect(dump.sql).toContain('MAX(');
		});

		it('should add LAG offset function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('sales')
				.window('prev_amount', {
					function: 'lag',
					field: 'amount',
					orderBy: [{ field: 'date' }],
				})
				.dump();

			expect(dump.sql).toContain('LAG(');
		});

		it('should add LEAD offset function', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('sales')
				.window('next_amount', {
					function: 'lead',
					field: 'amount',
					orderBy: [{ field: 'date' }],
				})
				.dump();

			expect(dump.sql).toContain('LEAD(');
		});
	});

	describe('window() chaining', () => {
		it('should support multiple window functions via chaining', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('employees')
				.window('rank', {
					function: 'rank',
					partitionBy: ['department'],
					orderBy: [{ field: 'salary', direction: 'desc' }],
				})
				.window('dept_avg', {
					function: 'avg',
					field: 'salary',
					partitionBy: ['department'],
				})
				.window('row_num', {
					function: 'row_number',
					orderBy: [{ field: 'name' }],
				})
				.dump();

			expect(dump.sql).toContain('RANK()');
			expect(dump.sql).toContain('AVG(');
			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql).toContain('"rank"');
			expect(dump.sql).toContain('"dept_avg"');
			expect(dump.sql).toContain('"row_num"');
		});

		it('should preserve window functions when cloning via other methods', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('rn', {
					function: 'row_number',
					orderBy: [{ field: 'price' }],
				})
				.orderBy('name')
				.limit(10)
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql).toContain('ORDER BY');
			expect(dump.sql.toLowerCase()).toContain('limit');
		});
	});

	describe('window() with other query features', () => {
		it('should work with where()', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.window('rn', {
					function: 'row_number',
					orderBy: [{ field: 'price' }],
				})
				.where({ categoryId: 1 })
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql.toLowerCase()).toContain('where');
		});

		it('should work with select()', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const dump = orm
				.query('products')
				.select(['id', 'name', 'price'])
				.window('rn', {
					function: 'row_number',
					orderBy: [{ field: 'price' }],
				})
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
		});
	});

	describe('window() immutability', () => {
		it('should be immutable - original builder unchanged', () => {
			const orm = createOrm({ model: testModel, db: mockKysely });

			const builder1 = orm.query('products');
			const builder2 = builder1.window('rn', {
				function: 'row_number',
				orderBy: [{ field: 'price' }],
			});

			const dump1 = builder1.dump();
			const dump2 = builder2.dump();

			expect(dump1.sql).not.toContain('ROW_NUMBER()');
			expect(dump2.sql).toContain('ROW_NUMBER()');
		});
	});
});
