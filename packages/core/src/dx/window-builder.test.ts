/**
 * @file WindowBuilder Unit Tests (DX-021)
 * Tests for the fluent window function builder pattern
 */

import { describe, expect, it } from 'vitest';
import type { WindowIntent } from '../intent-ast.js';
import {
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
} from './filters.js';
import { ref, schema } from './schema.js';
import type { ExpressionSpec } from './types.js';

// ============================================================================
// Helper to extract WindowIntent from ExpressionSpec
// ============================================================================

function getWindowIntent(spec: ExpressionSpec): WindowIntent {
	expect(spec.__expr).toBe(true);
	expect(spec.intent).toBeDefined();
	expect((spec.intent as WindowIntent).kind).toBe('window');
	return spec.intent as WindowIntent;
}

// ============================================================================
// Scenario 1: Basic rowNumber with orderBy
// ============================================================================

describe('DX-021: Window Functions Builder Pattern', () => {
	describe('rowNumber()', () => {
		it('should create ROW_NUMBER window function', () => {
			const spec = rowNumber().orderBy('price', 'desc').as('rn');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('row_number');
			expect(intent.alias).toBe('rn');
			expect(intent.over.orderBy).toEqual([
				{ field: 'price', direction: 'desc' },
			]);
			expect(intent.over.partitionBy).toBeUndefined();
			expect(intent.field).toBeUndefined();
		});

		it('should default orderBy direction to asc', () => {
			const spec = rowNumber().orderBy('id').as('rn');
			const intent = getWindowIntent(spec);

			expect(intent.over.orderBy).toEqual([{ field: 'id', direction: 'asc' }]);
		});
	});

	// ============================================================================
	// Scenario 2: rank with partitionBy and orderBy
	// ============================================================================

	describe('rank()', () => {
		it('should create RANK with partition and order', () => {
			const spec = rank()
				.partitionBy('categoryId')
				.orderBy('price')
				.as('price_rank');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('rank');
			expect(intent.alias).toBe('price_rank');
			expect(intent.over.partitionBy).toEqual(['categoryId']);
			expect(intent.over.orderBy).toEqual([
				{ field: 'price', direction: 'asc' },
			]);
		});
	});

	// ============================================================================
	// Scenario 3: Aggregate window function with field
	// ============================================================================

	describe('wSum()', () => {
		it('should create SUM window function with field', () => {
			const spec = wSum('amount')
				.partitionBy('userId')
				.orderBy('date')
				.as('running_total');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('sum');
			expect(intent.field).toBe('amount');
			expect(intent.alias).toBe('running_total');
			expect(intent.over.partitionBy).toEqual(['userId']);
			expect(intent.over.orderBy).toEqual([
				{ field: 'date', direction: 'asc' },
			]);
		});
	});

	// ============================================================================
	// Scenario 4: Multiple partitionBy calls append
	// ============================================================================

	describe('partitionBy chaining', () => {
		it('should append multiple partition fields', () => {
			const spec = rank()
				.partitionBy('region')
				.partitionBy('year')
				.orderBy('sales')
				.as('rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['region', 'year']);
		});

		it('should accept multiple fields in single call', () => {
			const spec = rank()
				.partitionBy('region', 'year')
				.orderBy('sales')
				.as('rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['region', 'year']);
		});
	});

	// ============================================================================
	// Scenario 5: Multiple orderBy calls append
	// ============================================================================

	describe('orderBy chaining', () => {
		it('should append multiple order fields', () => {
			const spec = rowNumber().orderBy('date').orderBy('id', 'desc').as('rn');
			const intent = getWindowIntent(spec);

			expect(intent.over.orderBy).toEqual([
				{ field: 'date', direction: 'asc' },
				{ field: 'id', direction: 'desc' },
			]);
		});
	});

	// ============================================================================
	// Scenario 6: Immutability
	// ============================================================================

	describe('builder immutability', () => {
		it('should not mutate original builder', () => {
			const b1 = rowNumber();
			const b2 = b1.orderBy('price');
			const b3 = b1.orderBy('name');

			const spec1 = b1.as('rn1');
			const spec2 = b2.as('rn2');
			const spec3 = b3.as('rn3');

			const intent1 = getWindowIntent(spec1);
			const intent2 = getWindowIntent(spec2);
			const intent3 = getWindowIntent(spec3);

			// b1 should have no orderBy
			expect(intent1.over.orderBy).toBeUndefined();

			// b2 should have price orderBy
			expect(intent2.over.orderBy).toEqual([
				{ field: 'price', direction: 'asc' },
			]);

			// b3 should have name orderBy (not price)
			expect(intent3.over.orderBy).toEqual([
				{ field: 'name', direction: 'asc' },
			]);
		});

		it('should not mutate when chaining partitionBy', () => {
			const b1 = wSum('amount').partitionBy('user');
			const b2 = b1.partitionBy('category');

			const intent1 = getWindowIntent(b1.as('sum1'));
			const intent2 = getWindowIntent(b2.as('sum2'));

			expect(intent1.over.partitionBy).toEqual(['user']);
			expect(intent2.over.partitionBy).toEqual(['user', 'category']);
		});
	});

	// ============================================================================
	// Scenario 7: denseRank
	// ============================================================================

	describe('denseRank()', () => {
		it('should create DENSE_RANK window function', () => {
			const spec = denseRank()
				.partitionBy('dept')
				.orderBy('salary', 'desc')
				.as('salary_rank');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('dense_rank');
			expect(intent.alias).toBe('salary_rank');
		});
	});

	// ============================================================================
	// Scenario 8: avg, count, min, max functions
	// ============================================================================

	describe('aggregate window functions', () => {
		it('wAvg should create AVG window function', () => {
			const spec = wAvg('salary').partitionBy('dept').as('avg_salary');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('avg');
			expect(intent.field).toBe('salary');
		});

		it('wCount should create COUNT window function', () => {
			const spec = wCount('id').partitionBy('category').as('items_count');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('count');
			expect(intent.field).toBe('id');
		});

		it('wMin should create MIN window function', () => {
			const spec = wMin('price').partitionBy('category').as('min_price');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('min');
			expect(intent.field).toBe('price');
		});

		it('wMax should create MAX window function', () => {
			const spec = wMax('price').partitionBy('category').as('max_price');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('max');
			expect(intent.field).toBe('price');
		});
	});

	// ============================================================================
	// Scenario 9: lag and lead offset functions
	// ============================================================================

	describe('offset window functions', () => {
		it('lag should create LAG window function', () => {
			const spec = lag('amount').orderBy('date').as('prev_amount');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('lag');
			expect(intent.field).toBe('amount');
		});

		it('lead should create LEAD window function', () => {
			const spec = lead('amount').orderBy('date').as('next_amount');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('lead');
			expect(intent.field).toBe('amount');
		});
	});

	// ============================================================================
	// Edge Cases
	// ============================================================================

	describe('edge cases', () => {
		it('E1: should work with no partitionBy (entire result set)', () => {
			const spec = rowNumber().orderBy('id').as('global_rn');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toBeUndefined();
			expect(intent.over.orderBy).toEqual([{ field: 'id', direction: 'asc' }]);
		});

		it('E2: should work with no orderBy (unordered partition)', () => {
			const spec = wCount('id').partitionBy('category').as('cat_count');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['category']);
			expect(intent.over.orderBy).toBeUndefined();
		});

		it('E3: should work with empty window (neither partition nor order)', () => {
			const spec = wCount('id').as('total_count');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toBeUndefined();
			expect(intent.over.orderBy).toBeUndefined();
		});
	});

	// ============================================================================
	// ExpressionSpec compatibility
	// ============================================================================

	describe('ExpressionSpec compatibility', () => {
		it('should return valid ExpressionSpec with __expr marker', () => {
			const spec = rowNumber().orderBy('id').as('rn');

			expect(spec.__expr).toBe(true);
			expect(spec.intent).toBeDefined();
			expect(spec.intent.kind).toBe('window');
		});

		it('should be usable in arrays with string columns (type test)', () => {
			// This is mainly a type test - ensuring ExpressionSpec works in ColumnSpec[]
			const columns: (string | ExpressionSpec)[] = [
				'id',
				'name',
				rowNumber().orderBy('created_at').as('rn'),
				wSum('amount').partitionBy('user_id').as('total'),
			];

			expect(columns).toHaveLength(4);
			expect(typeof columns[0]).toBe('string');
			expect(typeof columns[1]).toBe('string');
			expect((columns[2] as ExpressionSpec).__expr).toBe(true);
			expect((columns[3] as ExpressionSpec).__expr).toBe(true);
		});
	});

	// ============================================================================
	// DX-040: Type-safe ColumnRef support
	// ============================================================================

	describe('DX-040: Type-safe ColumnRef support', () => {
		// Test schema
		function createTestSchema() {
			return schema({
				employees: {
					id: 'uuid',
					department: 'string',
					salary: 'decimal',
					hireDate: 'timestamp',
				},
				sales: {
					id: 'uuid',
					product: ref('products'),
					amount: 'decimal',
					date: 'timestamp',
				},
				products: {
					id: 'uuid',
					category: 'string',
					price: 'decimal',
				},
			});
		}

		it('should accept ColumnRef in partitionBy()', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = rank()
				.partitionBy(employees.department)
				.orderBy('salary', 'desc')
				.as('dept_rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['department']);
		});

		it('should accept ColumnRef in orderBy()', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = rowNumber()
				.orderBy(employees.salary, 'desc')
				.as('salary_rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.orderBy).toEqual([
				{ field: 'salary', direction: 'desc' },
			]);
		});

		it('should accept ColumnRef in both partitionBy() and orderBy()', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = rank()
				.partitionBy(employees.department)
				.orderBy(employees.salary, 'desc')
				.as('salary_rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['department']);
			expect(intent.over.orderBy).toEqual([
				{ field: 'salary', direction: 'desc' },
			]);
		});

		it('should accept multiple ColumnRefs in partitionBy()', () => {
			const s = createTestSchema();
			const { sales, products } = s.tables;

			const spec = wSum('amount')
				.partitionBy(products.category, sales.date)
				.as('category_total');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['category', 'date']);
		});

		it('should mix strings and ColumnRefs in partitionBy()', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = denseRank()
				.partitionBy('region', employees.department)
				.orderBy('salary')
				.as('regional_dept_rank');
			const intent = getWindowIntent(spec);

			expect(intent.over.partitionBy).toEqual(['region', 'department']);
		});

		it('wAvg() with ColumnRef partition', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = wAvg('salary')
				.partitionBy(employees.department)
				.as('dept_avg_salary');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('avg');
			expect(intent.field).toBe('salary');
			expect(intent.over.partitionBy).toEqual(['department']);
		});

		it('lag() with ColumnRef orderBy', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = lag('salary').orderBy(employees.hireDate).as('prev_salary');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('lag');
			expect(intent.over.orderBy).toEqual([
				{ field: 'hireDate', direction: 'asc' },
			]);
		});

		it('lead() with ColumnRef orderBy desc', () => {
			const s = createTestSchema();
			const { employees } = s.tables;

			const spec = lead('salary')
				.orderBy(employees.salary, 'desc')
				.as('next_higher_salary');
			const intent = getWindowIntent(spec);

			expect(intent.function).toBe('lead');
			expect(intent.over.orderBy).toEqual([
				{ field: 'salary', direction: 'desc' },
			]);
		});
	});
});
