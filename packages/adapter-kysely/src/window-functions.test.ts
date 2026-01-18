/**
 * @file Window Functions Integration Tests (DX-021)
 * Tests for window function integration with QueryBuilder via columns() API
 */

import {
	createOrm,
	defineSchema,
	denseRank,
	lag,
	lead,
	rank,
	rowNumber,
	wAvg,
	wCount,
	wMax,
	wMin,
	wSum,
} from '@dbsp/core';
import { Kysely, PostgresDialect } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createKyselyAdapter } from './kysely-adapter.js';

// ============================================================================
// Test Schema
// ============================================================================

const testModel = defineSchema({
	products: {
		id: 'integer',
		name: { type: 'string' },
		price: { type: 'number' },
		categoryId: 'integer',
		createdAt: { type: 'date' },
	},
	sales: {
		id: 'integer',
		productId: 'integer',
		amount: { type: 'number' },
		date: { type: 'date' },
	},
	employees: {
		id: 'integer',
		name: { type: 'string' },
		department: { type: 'string' },
		salary: { type: 'number' },
	},
}).build();

// Create a mock Kysely instance for testing SQL generation only (no actual execution)
const mockKysely = new Kysely<any>({
	dialect: {
		createAdapter: () =>
			new PostgresDialect({ pool: {} as any }).createAdapter(),
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

describe('DX-021: Window Functions Integration with columns() API', () => {
	describe('ranking functions', () => {
		it('should add ROW_NUMBER window function via columns()', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns([
					'id',
					'name',
					rowNumber().orderBy('price', 'desc').as('row_num'),
				])
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql).toContain('OVER');
			expect(dump.sql).toContain('ORDER BY');
			expect(dump.sql).toContain('"row_num"');
		});

		it('should add RANK with PARTITION BY via columns()', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns([
					'id',
					'categoryId',
					rank()
						.partitionBy('categoryId')
						.orderBy('price', 'desc')
						.as('category_rank'),
				])
				.dump();

			expect(dump.sql).toContain('RANK()');
			expect(dump.sql).toContain('PARTITION BY');
			expect(dump.sql).toContain('"categoryId"');
			expect(dump.sql).toContain('"category_rank"');
		});

		it('should add DENSE_RANK window function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns(['name', denseRank().orderBy('createdAt').as('dense_rank')])
				.dump();

			expect(dump.sql).toContain('DENSE_RANK()');
		});
	});

	describe('aggregate window functions', () => {
		it('should add SUM aggregate window function with field', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('sales')
				.columns([
					'productId',
					'date',
					wSum('amount')
						.partitionBy('productId')
						.orderBy('date')
						.as('running_total'),
				])
				.dump();

			expect(dump.sql).toContain('SUM(');
			expect(dump.sql).toContain('"amount"');
			expect(dump.sql).toContain('PARTITION BY');
			expect(dump.sql).toContain('"running_total"');
		});

		it('should add AVG aggregate window function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('employees')
				.columns([
					'name',
					'department',
					wAvg('salary').partitionBy('department').as('dept_avg_salary'),
				])
				.dump();

			expect(dump.sql).toContain('AVG(');
			expect(dump.sql).toContain('"salary"');
			expect(dump.sql).toContain('"dept_avg_salary"');
		});

		it('should add COUNT aggregate window function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns([
					'name',
					wCount('id').partitionBy('categoryId').as('products_in_category'),
				])
				.dump();

			expect(dump.sql).toContain('COUNT(');
			expect(dump.sql).toContain('"products_in_category"');
		});

		it('should add MIN window function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns([
					'name',
					wMin('price').partitionBy('categoryId').as('min_price'),
				])
				.dump();

			expect(dump.sql).toContain('MIN(');
		});

		it('should add MAX window function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns([
					'name',
					wMax('price').partitionBy('categoryId').as('max_price'),
				])
				.dump();

			expect(dump.sql).toContain('MAX(');
		});
	});

	describe('offset window functions', () => {
		it('should add LAG offset function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('sales')
				.columns([
					'date',
					'amount',
					lag('amount').orderBy('date').as('prev_amount'),
				])
				.dump();

			expect(dump.sql).toContain('LAG(');
		});

		it('should add LEAD offset function', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('sales')
				.columns([
					'date',
					'amount',
					lead('amount').orderBy('date').as('next_amount'),
				])
				.dump();

			expect(dump.sql).toContain('LEAD(');
		});
	});

	describe('multiple window functions in columns()', () => {
		it('should support multiple window functions in single columns() call', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('employees')
				.columns([
					'name',
					'salary',
					'department',
					rank().partitionBy('department').orderBy('salary', 'desc').as('rank'),
					wAvg('salary').partitionBy('department').as('dept_avg'),
					rowNumber().orderBy('name').as('row_num'),
				])
				.dump();

			expect(dump.sql).toContain('RANK()');
			expect(dump.sql).toContain('AVG(');
			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql).toContain('"rank"');
			expect(dump.sql).toContain('"dept_avg"');
			expect(dump.sql).toContain('"row_num"');
		});
	});

	describe('window functions with other query features', () => {
		it('should work with where()', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns(['id', 'name', rowNumber().orderBy('price').as('rn')])
				.where({ categoryId: 1 })
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql.toLowerCase()).toContain('where');
		});

		it('should work with orderBy() and limit()', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const dump = orm
				.select('products')
				.columns(['id', 'name', rowNumber().orderBy('price').as('rn')])
				.orderBy('name')
				.limit(10)
				.dump();

			expect(dump.sql).toContain('ROW_NUMBER()');
			expect(dump.sql.toLowerCase()).toContain('limit');
		});
	});

	describe('builder immutability', () => {
		it('should be immutable - original builder unchanged', () => {
			const orm = createOrm({
				model: testModel,
				adapter: createKyselyAdapter(mockKysely),
			});

			const builder1 = orm.select('products').columns(['id', 'name']);
			const builder2 = builder1.columns([
				rowNumber().orderBy('price').as('rn'),
			]);

			const dump1 = builder1.dump();
			const dump2 = builder2.dump();

			expect(dump1.sql).not.toContain('ROW_NUMBER()');
			expect(dump2.sql).toContain('ROW_NUMBER()');
		});
	});
});
