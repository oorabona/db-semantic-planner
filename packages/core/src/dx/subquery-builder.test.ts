/**
 * @module subquery-builder.test
 * Tests for SubqueryBuilder and related functions.
 * DX-012 Block 3
 */

import { describe, expect, it } from 'vitest';
import { objectToWhereIntent } from './object-filter.js';
import {
	isSubqueryExpression,
	outerRef,
	SubqueryBuilder,
	SubqueryExpression,
	subquery,
} from './subquery-builder.js';

// ============================================================================
// SubqueryBuilder Factory
// ============================================================================

describe('subquery factory', () => {
	it('should create a SubqueryBuilder instance', () => {
		const builder = subquery('products');
		expect(builder).toBeInstanceOf(SubqueryBuilder);
	});

	it('should preserve table name in intent', () => {
		const intent = subquery('orders').select('total').dump();
		expect(intent.from).toBe('orders');
	});
});

// ============================================================================
// outerRef() Function
// ============================================================================

describe('outerRef function', () => {
	it('should create a SubqueryRefIntent with outer:true discriminator', () => {
		const refIntent = outerRef('parentId');
		// outer:true is the discriminator that distinguishes outerRef() from an
		// inner ref() (RefExpressionIntent) which has the same { kind:'ref', column }
		// shape.  containsOuterRef() checks outer===true to avoid false positives.
		expect(refIntent).toEqual({
			kind: 'ref',
			column: 'parentId',
			outer: true,
		});
	});

	it('should support qualified column names', () => {
		const refIntent = outerRef('t0.categoryId');
		expect(refIntent).toEqual({
			kind: 'ref',
			column: 't0.categoryId',
			outer: true,
		});
	});
});

// ============================================================================
// SubqueryBuilder Methods
// ============================================================================

describe('SubqueryBuilder', () => {
	describe('select()', () => {
		it('should set the select field', () => {
			const intent = subquery('products').select('price').dump();
			expect(intent.select).toEqual({ type: 'fields', fields: ['price'] });
		});

		it('should be immutable (return new builder)', () => {
			const builder1 = subquery('products');
			const builder2 = builder1.select('price');
			expect(builder1).not.toBe(builder2);
		});
	});

	describe('where()', () => {
		it('should set the where condition', () => {
			const intent = subquery('orders')
				.select('total')
				.where({
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'completed',
				})
				.dump();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'status',
				operator: 'eq',
				value: 'completed',
			});
		});

		it('should support outerRef() in where conditions', () => {
			const intent = subquery('order_items')
				.select('price')
				.where({
					kind: 'comparison',
					field: 'orderId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.dump();

			expect(intent.where).toEqual({
				kind: 'comparison',
				field: 'orderId',
				operator: 'eq',
				value: { kind: 'ref', column: 'id', outer: true },
			});
		});

		it('should be immutable', () => {
			const builder1 = subquery('products').select('price');
			const builder2 = builder1.where({
				kind: 'comparison',
				field: 'active',
				operator: 'eq',
				value: true,
			});
			expect(builder1).not.toBe(builder2);
		});
	});

	describe('build()', () => {
		it('should throw if no select or aggregate', () => {
			const builder = subquery('products');
			expect(() => builder.build()).toThrow(
				'Subquery must have either select() or an aggregate function',
			);
		});

		it('should return SubqueryExpression with select', () => {
			const expr = subquery('products').select('price').build();
			expect(expr).toBeInstanceOf(SubqueryExpression);
			expect(expr.intent.select).toEqual({ type: 'fields', fields: ['price'] });
		});
	});

	describe('dump()', () => {
		it('should return the QueryIntent', () => {
			const intent = subquery('products')
				.select('price')
				.where({
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: true,
				})
				.dump();

			expect(intent).toEqual({
				type: 'select',
				from: 'products',
				select: { type: 'fields', fields: ['price'] },
				where: {
					kind: 'comparison',
					field: 'active',
					operator: 'eq',
					value: true,
				},
			});
		});

		it('should include aggregate when present', () => {
			const intent = subquery('reviews')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.avg('rating');

			expect(intent.intent).toEqual({
				type: 'select',
				from: 'reviews',
				select: {
					type: 'aggregate',
					aggregates: [{ function: 'avg', field: 'rating' }],
				},
				where: {
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: { kind: 'ref', column: 'id', outer: true },
				},
			});
		});
	});
});

// ============================================================================
// Aggregate Functions
// ============================================================================

describe('SubqueryBuilder aggregates', () => {
	describe('count()', () => {
		it('should create count aggregate with default field', () => {
			const expr = subquery('reviews')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.count();

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'count', field: '*' }],
			});
		});

		it('should create count aggregate with specific field', () => {
			const expr = subquery('reviews')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.count('id');

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'count', field: 'id' }],
			});
		});
	});

	describe('sum()', () => {
		it('should create sum aggregate', () => {
			const expr = subquery('order_items')
				.where({
					kind: 'comparison',
					field: 'orderId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.sum('quantity');

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'sum', field: 'quantity' }],
			});
		});
	});

	describe('avg()', () => {
		it('should create avg aggregate', () => {
			const expr = subquery('reviews')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.avg('rating');

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'avg', field: 'rating' }],
			});
		});
	});

	describe('min()', () => {
		it('should create min aggregate', () => {
			const expr = subquery('prices')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.min('price');

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'min', field: 'price' }],
			});
		});
	});

	describe('max()', () => {
		it('should create max aggregate', () => {
			const expr = subquery('prices')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.max('price');

			expect(expr.intent.select).toEqual({
				type: 'aggregate',
				aggregates: [{ function: 'max', field: 'price' }],
			});
		});
	});
});

// ============================================================================
// SubqueryExpression
// ============================================================================

describe('SubqueryExpression', () => {
	it('should have _type set to "subquery"', () => {
		const expr = subquery('products').select('price').build();
		expect(expr._type).toBe('subquery');
	});

	describe('toIntent()', () => {
		it('should return the underlying QueryIntent', () => {
			const expr = subquery('products').select('price').build();
			const intent = expr.toIntent();
			expect(intent).toEqual({
				type: 'select',
				from: 'products',
				select: { type: 'fields', fields: ['price'] },
			});
		});
	});

	describe('toWhereIntent()', () => {
		it('should create WhereSubqueryIntent with field and operator', () => {
			const expr = subquery('prices')
				.where({
					kind: 'comparison',
					field: 'productId',
					operator: 'eq',
					value: outerRef('id'),
				})
				.max('price');

			const whereIntent = expr.toWhereIntent('price', 'eq');
			expect(whereIntent).toEqual({
				kind: 'subquery',
				field: 'price',
				operator: 'eq',
				subquery: {
					type: 'select',
					from: 'prices',
					select: {
						type: 'aggregate',
						aggregates: [{ function: 'max', field: 'price' }],
					},
					where: {
						kind: 'comparison',
						field: 'productId',
						operator: 'eq',
						value: { kind: 'ref', column: 'id', outer: true },
					},
				},
			});
		});
	});
});

// ============================================================================
// Type Guard
// ============================================================================

describe('isSubqueryExpression', () => {
	it('should return true for SubqueryExpression', () => {
		const expr = subquery('products').select('price').build();
		expect(isSubqueryExpression(expr)).toBe(true);
	});

	it('should return false for plain objects', () => {
		expect(isSubqueryExpression({ _type: 'something' })).toBe(false);
		expect(isSubqueryExpression({ from: 'products' })).toBe(false);
		expect(isSubqueryExpression({})).toBe(false);
	});

	it('should return false for primitives', () => {
		expect(isSubqueryExpression(null)).toBe(false);
		expect(isSubqueryExpression(undefined)).toBe(false);
		expect(isSubqueryExpression('string')).toBe(false);
		expect(isSubqueryExpression(123)).toBe(false);
	});

	it('should return false for arrays', () => {
		expect(isSubqueryExpression([])).toBe(false);
	});
});

// ============================================================================
// Integration with Object Filter Syntax
// ============================================================================

describe('subquery + object filter integration', () => {
	it('should convert subquery with $eq operator', () => {
		const expr = subquery('prices')
			.where({
				kind: 'comparison',
				field: 'productId',
				operator: 'eq',
				value: outerRef('id'),
			})
			.max('price');

		const intent = objectToWhereIntent({
			price: { $eq: expr },
		});

		expect(intent).toEqual({
			kind: 'subquery',
			field: 'price',
			operator: 'eq',
			subquery: expr.intent,
		});
	});

	it('should convert subquery with $gt operator', () => {
		const expr = subquery('reviews')
			.where({
				kind: 'comparison',
				field: 'productId',
				operator: 'eq',
				value: outerRef('id'),
			})
			.avg('rating');

		const intent = objectToWhereIntent({
			rating: { $gt: expr },
		});

		expect(intent).toEqual({
			kind: 'subquery',
			field: 'rating',
			operator: 'gt',
			subquery: expr.intent,
		});
	});

	it('should convert subquery with $lt operator', () => {
		const expr = subquery('competitors')
			.where({
				kind: 'comparison',
				field: 'categoryId',
				operator: 'eq',
				value: outerRef('categoryId'),
			})
			.min('price');

		const intent = objectToWhereIntent({
			price: { $lt: expr },
		});

		expect(intent).toEqual({
			kind: 'subquery',
			field: 'price',
			operator: 'lt',
			subquery: expr.intent,
		});
	});

	it('should combine subquery with regular filter conditions', () => {
		const expr = subquery('reviews')
			.where({
				kind: 'comparison',
				field: 'productId',
				operator: 'eq',
				value: outerRef('id'),
			})
			.count();

		const intent = objectToWhereIntent({
			status: 'active',
			reviewCount: { $gte: expr },
		});

		expect(intent).toEqual({
			kind: 'and',
			conditions: [
				{
					kind: 'comparison',
					field: 'status',
					operator: 'eq',
					value: 'active',
				},
				{
					kind: 'subquery',
					field: 'reviewCount',
					operator: 'gte',
					subquery: expr.intent,
				},
			],
		});
	});

	it('should handle subquery with $lte operator', () => {
		const expr = subquery('inventory')
			.where({
				kind: 'comparison',
				field: 'productId',
				operator: 'eq',
				value: outerRef('id'),
			})
			.sum('quantity');

		const intent = objectToWhereIntent({
			stock: { $lte: expr },
		});

		expect(intent).toEqual({
			kind: 'subquery',
			field: 'stock',
			operator: 'lte',
			subquery: expr.intent,
		});
	});

	it('should handle subquery with $neq operator', () => {
		const expr = subquery('defaults')
			.select('defaultPrice')
			.where({
				kind: 'comparison',
				field: 'categoryId',
				operator: 'eq',
				value: outerRef('categoryId'),
			})
			.build();

		const intent = objectToWhereIntent({
			price: { $neq: expr },
		});

		expect(intent).toEqual({
			kind: 'subquery',
			field: 'price',
			operator: 'neq',
			subquery: expr.intent,
		});
	});
});

// ============================================================================
// Chaining and Immutability
// ============================================================================

describe('chaining and immutability', () => {
	it('should support full method chain', () => {
		const expr = subquery('order_items')
			.select('unit_price')
			.where({
				kind: 'comparison',
				field: 'orderId',
				operator: 'eq',
				value: outerRef('id'),
			})
			.max('unit_price');

		expect(expr.intent).toEqual({
			type: 'select',
			from: 'order_items',
			select: {
				type: 'aggregate',
				aggregates: [{ function: 'max', field: 'unit_price' }],
			},
			where: {
				kind: 'comparison',
				field: 'orderId',
				operator: 'eq',
				value: { kind: 'ref', column: 'id', outer: true },
			},
		});
	});

	it('should not mutate original builder when chaining', () => {
		const base = subquery('products');
		const withSelect = base.select('price');
		const withWhere = withSelect.where({
			kind: 'comparison',
			field: 'active',
			operator: 'eq',
			value: true,
		});

		// Verify each builder is independent
		const selectIntent = withSelect.dump();
		const whereIntent = withWhere.dump();

		expect(selectIntent.where).toBeUndefined();
		expect(whereIntent.where).toBeDefined();
	});

	it('should allow reusing builder with different aggregates', () => {
		const base = subquery('sales').where({
			kind: 'comparison',
			field: 'productId',
			operator: 'eq',
			value: outerRef('id'),
		});

		const sumExpr = base.sum('amount');
		const avgExpr = base.avg('amount');
		const countExpr = base.count();

		expect(
			(
				sumExpr.intent.select as {
					type: string;
					aggregates: { function: string }[];
				}
			).aggregates[0]?.function,
		).toBe('sum');
		expect(
			(
				avgExpr.intent.select as {
					type: string;
					aggregates: { function: string }[];
				}
			).aggregates[0]?.function,
		).toBe('avg');
		expect(
			(
				countExpr.intent.select as {
					type: string;
					aggregates: { function: string }[];
				}
			).aggregates[0]?.function,
		).toBe('count');
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
	it('should handle subquery without where clause', () => {
		const intent = subquery('settings').select('max_items').dump();
		expect(intent).toEqual({
			type: 'select',
			from: 'settings',
			select: { type: 'fields', fields: ['max_items'] },
		});
	});

	it('should handle aggregate without explicit select', () => {
		const expr = subquery('products').count();
		expect(expr.intent.select).toEqual({
			type: 'aggregate',
			aggregates: [{ function: 'count', field: '*' }],
		});
	});

	it('should use aggregate select even when explicit select was set', () => {
		const expr = subquery('products').select('some_field').sum('total');
		// Aggregate overrides explicit select
		expect(expr.intent.select).toEqual({
			type: 'aggregate',
			aggregates: [{ function: 'sum', field: 'total' }],
		});
	});
});
