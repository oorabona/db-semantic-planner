/**
 * E2E-ADV: Advanced Query Patterns
 *
 * Tests advanced query capabilities:
 * - Aggregations (COUNT, SUM, AVG, GROUP BY)
 * - Sorting & Pagination (ORDER BY, LIMIT, OFFSET)
 * - Nested Conditions (complex AND/OR/NOT)
 * - Soft Deletes (deleted_at filtering)
 */

import {
	and,
	createOrm,
	eq,
	exists,
	gt,
	gte,
	isNotNull,
	isNull,
	lt,
	not,
	or,
	ref,
	schema,
} from '@dbsp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestAdapter, getTestPool } from './testkit/index.js';
import { sql } from './testkit/sql.js';

// Schema name for this test suite
const SCHEMA = 'advanced_e2e';

// Define the model with all necessary fields (ARCH-005: schema() + ref() API)
const advancedSchema = schema({
	products: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
		category: 'string',
		price: 'decimal',
		stock: 'integer',
		createdAt: 'timestamp',
		deletedAt: { type: 'timestamp', nullable: true },
	},
	orders: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products'),
		quantity: 'integer',
		totalPrice: 'decimal',
		customerName: 'string',
		status: 'string',
		createdAt: 'timestamp',
	},
	reviews: {
		id: { type: 'integer', primaryKey: true },
		productId: ref('products'),
		rating: 'integer',
		comment: { type: 'string', nullable: true },
		reviewerName: 'string',
		createdAt: 'timestamp',
	},
});
const advancedModel = advancedSchema.model;

// Setup functions
async function createAdvancedSchema(): Promise<void> {
	const pool = await getTestPool();

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(SCHEMA)}`.execute(pool);

	// Products table with soft delete
	await sql`
    CREATE TABLE ${sql.ref(SCHEMA)}.products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      deleted_at TIMESTAMP DEFAULT NULL
    )
  `.execute(pool);

	// Orders table
	await sql`
    CREATE TABLE ${sql.ref(SCHEMA)}.orders (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(SCHEMA)}.products(id),
      quantity INTEGER NOT NULL,
      total_price DECIMAL(10,2) NOT NULL,
      customer_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(pool);

	// Reviews table
	await sql`
    CREATE TABLE ${sql.ref(SCHEMA)}.reviews (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(SCHEMA)}.products(id),
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      reviewer_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(pool);
}

async function seedAdvancedData(): Promise<void> {
	const pool = await getTestPool();

	// Products (10 products, 2 soft-deleted)
	await sql`
    INSERT INTO ${sql.ref(SCHEMA)}.products (id, name, category, price, stock, created_at, deleted_at)
    VALUES
      (1, 'Laptop Pro', 'electronics', 1299.99, 50, '2024-01-01', NULL),
      (2, 'Wireless Mouse', 'electronics', 29.99, 200, '2024-01-02', NULL),
      (3, 'Coffee Mug', 'home', 14.99, 500, '2024-01-03', NULL),
      (4, 'Standing Desk', 'furniture', 599.99, 25, '2024-01-04', NULL),
      (5, 'USB Cable', 'electronics', 9.99, 1000, '2024-01-05', NULL),
      (6, 'Desk Lamp', 'furniture', 49.99, 150, '2024-01-06', NULL),
      (7, 'Notebook Set', 'office', 19.99, 300, '2024-01-07', NULL),
      (8, 'Pen Pack', 'office', 5.99, 800, '2024-01-08', NULL),
      (9, 'Old Product', 'electronics', 99.99, 0, '2023-06-01', '2024-01-15'),
      (10, 'Discontinued Item', 'home', 24.99, 0, '2023-07-01', '2024-02-01')
  `.execute(pool);

	// Orders (15 orders across products)
	await sql`
    INSERT INTO ${sql.ref(SCHEMA)}.orders (id, product_id, quantity, total_price, customer_name, status, created_at)
    VALUES
      (1, 1, 1, 1299.99, 'Alice', 'completed', '2024-02-01'),
      (2, 1, 2, 2599.98, 'Bob', 'completed', '2024-02-02'),
      (3, 2, 5, 149.95, 'Charlie', 'completed', '2024-02-03'),
      (4, 3, 10, 149.90, 'Diana', 'completed', '2024-02-04'),
      (5, 4, 1, 599.99, 'Eve', 'pending', '2024-02-05'),
      (6, 5, 20, 199.80, 'Frank', 'completed', '2024-02-06'),
      (7, 1, 1, 1299.99, 'Grace', 'shipped', '2024-02-07'),
      (8, 2, 3, 89.97, 'Henry', 'completed', '2024-02-08'),
      (9, 6, 2, 99.98, 'Ivy', 'pending', '2024-02-09'),
      (10, 7, 5, 99.95, 'Jack', 'completed', '2024-02-10'),
      (11, 3, 3, 44.97, 'Kate', 'shipped', '2024-02-11'),
      (12, 4, 1, 599.99, 'Leo', 'completed', '2024-02-12'),
      (13, 8, 10, 59.90, 'Mia', 'completed', '2024-02-13'),
      (14, 1, 1, 1299.99, 'Noah', 'cancelled', '2024-02-14'),
      (15, 5, 50, 499.50, 'Olivia', 'completed', '2024-02-15')
  `.execute(pool);

	// Reviews (20 reviews)
	await sql`
    INSERT INTO ${sql.ref(SCHEMA)}.reviews (id, product_id, rating, comment, reviewer_name, created_at)
    VALUES
      (1, 1, 5, 'Excellent laptop!', 'Alice', '2024-02-02'),
      (2, 1, 4, 'Good performance, a bit pricey', 'Bob', '2024-02-03'),
      (3, 1, 5, 'Best laptop I have ever owned', 'Carol', '2024-02-04'),
      (4, 2, 4, 'Works great', 'Diana', '2024-02-05'),
      (5, 2, 3, 'Decent mouse', 'Eve', '2024-02-06'),
      (6, 3, 5, 'Love this mug!', 'Frank', '2024-02-07'),
      (7, 3, 4, 'Nice design', 'Grace', '2024-02-08'),
      (8, 4, 5, 'Worth every penny', 'Henry', '2024-02-09'),
      (9, 4, 5, 'My back thanks me', 'Ivy', '2024-02-10'),
      (10, 5, 2, 'Cable broke after a month', 'Jack', '2024-02-11'),
      (11, 5, 3, 'Average quality', 'Kate', '2024-02-12'),
      (12, 6, 4, 'Good lighting', 'Leo', '2024-02-13'),
      (13, 7, 5, 'Perfect for notes', 'Mia', '2024-02-14'),
      (14, 7, 4, 'Good paper quality', 'Noah', '2024-02-15'),
      (15, 8, 3, 'Basic pens', 'Olivia', '2024-02-16'),
      (16, 1, 4, 'Great for coding', 'Pete', '2024-02-17'),
      (17, 2, 5, 'Very responsive', 'Quinn', '2024-02-18'),
      (18, 3, 3, 'A bit small', 'Rose', '2024-02-19'),
      (19, 4, 4, 'Easy assembly', 'Sam', '2024-02-20'),
      (20, 6, 5, 'Bright and adjustable', 'Tina', '2024-02-21')
  `.execute(pool);
}

async function dropAdvancedSchema(): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(SCHEMA)} CASCADE`.execute(pool);
}

describe('E2E-ADV: Advanced Query Patterns', () => {
	beforeAll(async () => {
		await dropAdvancedSchema();
		await createAdvancedSchema();
		await seedAdvancedData();
	});

	afterAll(async () => {
		await dropAdvancedSchema();
		await closeTestDb();
	});

	// ============================================================
	// SECTION 1: AGGREGATIONS (COUNT, SUM, AVG, GROUP BY)
	// ============================================================
	describe('Aggregations', () => {
		describe('COUNT', () => {
			it('should count all products (excluding soft-deleted)', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.count()
					.execute();

				expect(result).toHaveLength(1);
				expect(Number((result[0] as { count: string }).count)).toBe(8);
			});

			it('should count products by category', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.count({ as: 'productCount' })
					.groupBy(['category'])
					.execute();

				expect(result.length).toBeGreaterThan(0);
				// Verify we have counts per category
				const electronics = result.find(
					(r: any) => r.category === 'electronics',
				) as { productCount: string };
				expect(Number(electronics?.productCount)).toBe(3); // Laptop, Mouse, USB Cable
			});
		});

		describe('SUM', () => {
			it('should sum total order value', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('orders')
					.where(eq('status', 'completed'))
					.sum('totalPrice', 'totalRevenue')
					.execute();

				expect(result).toHaveLength(1);
				const revenue = Number(
					(result[0] as { totalRevenue: string }).totalRevenue,
				);
				expect(revenue).toBeGreaterThan(5000); // Sum of completed orders
			});

			it('should sum quantities by product', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('orders')
					.sum('quantity', 'totalQuantity')
					.groupBy(['productId'])
					.execute();

				expect(result.length).toBeGreaterThan(0);
			});
		});

		describe('AVG', () => {
			it('should calculate average rating per product', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('reviews')
					.avg('rating', 'avgRating')
					.groupBy(['productId'])
					.execute();

				expect(result.length).toBeGreaterThan(0);

				// Laptop (productId=1) has 4 reviews: 5, 4, 5, 4 = avg 4.5
				const laptopReviews = result.find((r: any) => r.productId === 1) as {
					avgRating: string;
				};
				const avgRating = Number(laptopReviews?.avgRating);
				expect(avgRating).toBeCloseTo(4.5, 1);
			});
		});

		describe('MIN/MAX', () => {
			it('should find min and max prices', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const minResult = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.min('price', 'minPrice')
					.execute();

				const maxResult = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.max('price', 'maxPrice')
					.execute();

				const minPrice = Number(
					(minResult[0] as { minPrice: string }).minPrice,
				);
				const maxPrice = Number(
					(maxResult[0] as { maxPrice: string }).maxPrice,
				);

				expect(minPrice).toBe(5.99); // Pen Pack
				expect(maxPrice).toBe(1299.99); // Laptop Pro
			});
		});
	});

	// ============================================================
	// SECTION 2: SORTING & PAGINATION
	// ============================================================
	describe('Sorting & Pagination', () => {
		describe('ORDER BY', () => {
			it('should sort products by price ascending', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.columns(['id', 'name', 'price'])
					.orderBy('price', 'asc')
					.execute();

				const prices = result.map((p: any) => Number(p.price));
				for (let i = 1; i < prices.length; i++) {
					expect(prices[i]!).toBeGreaterThanOrEqual(prices[i - 1]!);
				}
			});

			it('should sort products by price descending', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.columns(['id', 'name', 'price'])
					.orderBy('price', 'desc')
					.execute();

				const prices = result.map((p: any) => Number(p.price));
				for (let i = 1; i < prices.length; i++) {
					expect(prices[i]!).toBeLessThanOrEqual(prices[i - 1]!);
				}
			});

			it('should sort by multiple fields', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.columns(['id', 'category', 'name'])
					.orderBy('category', 'asc')
					.orderBy('name', 'asc')
					.execute();

				expect(result.length).toBe(8);
				// Products should be sorted by category first, then by name within category
			});
		});

		describe('LIMIT', () => {
			it('should limit results to specified count', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.limit(3)
					.execute();

				expect(result).toHaveLength(3);
			});

			it('should return all when limit exceeds count', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.limit(100)
					.execute();

				expect(result).toHaveLength(8);
			});
		});

		describe('OFFSET', () => {
			it('should skip specified number of results', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const allProducts = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.orderBy('id', 'asc')
					.execute();

				const offsetProducts = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.orderBy('id', 'asc')
					.limit(100)
					.offset(3)
					.execute();

				expect(offsetProducts).toHaveLength(5);
				expect((offsetProducts[0] as { id: number }).id).toBe(
					(allProducts[3] as { id: number }).id,
				);
			});
		});

		describe('Pagination', () => {
			it('should implement cursor-style pagination', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });
				const pageSize = 3;

				// Page 1
				const page1 = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.orderBy('id', 'asc')
					.limit(pageSize)
					.offset(0)
					.execute();

				// Page 2
				const page2 = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.orderBy('id', 'asc')
					.limit(pageSize)
					.offset(pageSize)
					.execute();

				// Page 3
				const page3 = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.orderBy('id', 'asc')
					.limit(pageSize)
					.offset(pageSize * 2)
					.execute();

				expect(page1).toHaveLength(3);
				expect(page2).toHaveLength(3);
				expect(page3).toHaveLength(2); // Only 8 active products, so last page has 2

				// Verify no duplicates across pages
				const allIds = [...page1, ...page2, ...page3].map((p: any) => p.id);
				const uniqueIds = new Set(allIds);
				expect(uniqueIds.size).toBe(8);
			});

			it('should combine sorting with pagination', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Get top 5 most expensive products
				const top5 = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.columns(['name', 'price'])
					.orderBy('price', 'desc')
					.limit(5)
					.execute();

				expect(top5).toHaveLength(5);
				// First should be Laptop Pro at 1299.99
				expect((top5[0] as { name: string }).name).toBe('Laptop Pro');
			});
		});
	});

	// ============================================================
	// SECTION 3: NESTED CONDITIONS (complex AND/OR/NOT)
	// ============================================================
	describe('Nested Conditions', () => {
		describe('Simple combinations', () => {
			it('should filter with AND conditions', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Electronics category AND price > 100
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(
						and(
							isNull('deletedAt'),
							eq('category', 'electronics'),
							gt('price', 100),
						),
					)
					.execute();

				// Only Laptop Pro qualifies (1299.99)
				expect(result).toHaveLength(1);
				expect((result[0] as { name: string }).name).toBe('Laptop Pro');
			});

			it('should filter with OR conditions', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Either electronics OR furniture category
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(
						and(
							isNull('deletedAt'),
							or(eq('category', 'electronics'), eq('category', 'furniture')),
						),
					)
					.execute();

				// Electronics: 3 (Laptop, Mouse, USB) + Furniture: 2 (Desk, Lamp) = 5
				expect(result).toHaveLength(5);
			});

			it('should filter with NOT condition', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// NOT electronics category
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(and(isNull('deletedAt'), not(eq('category', 'electronics'))))
					.execute();

				// home: 1, furniture: 2, office: 2 = 5
				expect(result).toHaveLength(5);
			});
		});

		describe('Complex nested conditions', () => {
			it('should handle deeply nested AND/OR', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// (category = 'electronics' AND price > 20) OR (category = 'furniture' AND stock > 100)
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(
						and(
							isNull('deletedAt'),
							or(
								and(eq('category', 'electronics'), gt('price', 20)),
								and(eq('category', 'furniture'), gt('stock', 100)),
							),
						),
					)
					.execute();

				// Electronics > 20: Laptop (1299.99), Mouse (29.99) = 2
				// Furniture > 100 stock: Lamp (150) = 1
				// Total = 3
				expect(result).toHaveLength(3);
			});

			it('should handle NOT with nested OR', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// NOT (category = 'electronics' OR category = 'furniture')
				// Same as: category NOT IN ('electronics', 'furniture')
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(
						and(
							isNull('deletedAt'),
							not(
								or(eq('category', 'electronics'), eq('category', 'furniture')),
							),
						),
					)
					.execute();

				// home: 1, office: 2 = 3
				expect(result).toHaveLength(3);
			});

			it('should combine field conditions with relation filters', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Products with orders AND (high-rated OR expensive)
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(
						and(
							isNull('deletedAt'),
							exists('orders'),
							or(
								gt('price', 500),
								exists('reviews', { where: gte('rating', 5) }),
							),
						),
					)
					.execute();

				expect(result.length).toBeGreaterThan(0);
			});
		});

		describe('Range queries', () => {
			it('should filter products in price range', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Price between 10 and 100
				const result = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(and(isNull('deletedAt'), gte('price', 10), lt('price', 100)))
					.execute();

				// Mouse (29.99), Mug (14.99), Lamp (49.99), Notebook (19.99) = 4
				expect(result).toHaveLength(4);
			});
		});
	});

	// ============================================================
	// SECTION 4: SOFT DELETES (deleted_at filtering)
	// ============================================================
	describe('Soft Deletes', () => {
		describe('Active records only', () => {
			it('should exclude soft-deleted records by default pattern', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const activeProducts = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.execute();

				// 10 products - 2 deleted = 8 active
				expect(activeProducts).toHaveLength(8);
			});

			it('should count only active records', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const countResult = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.count()
					.execute();

				expect(Number((countResult[0] as { count: string }).count)).toBe(8);
			});
		});

		describe('Include deleted records', () => {
			it('should include soft-deleted records when explicitly requested', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// No deleted_at filter = all records including deleted
				const allProducts = await orm
					.withSchema(SCHEMA)
					.select('products')
					.execute();

				expect(allProducts).toHaveLength(10);
			});

			it('should query only deleted records', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const deletedProducts = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNotNull('deletedAt'))
					.columns(['id', 'name', 'deletedAt'])
					.execute();

				expect(deletedProducts).toHaveLength(2);
				const names = deletedProducts.map((p: any) => p.name);
				expect(names).toContain('Old Product');
				expect(names).toContain('Discontinued Item');
			});
		});

		describe('Soft delete with other conditions', () => {
			it('should combine soft delete filter with category filter', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Active electronics only
				const activeElectronics = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(and(isNull('deletedAt'), eq('category', 'electronics')))
					.execute();

				// 3 active electronics (Laptop, Mouse, USB Cable)
				// Old Product is electronics but deleted
				expect(activeElectronics).toHaveLength(3);
			});

			it('should combine soft delete with relation filter', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				// Active products with orders
				const activeWithOrders = await orm
					.withSchema(SCHEMA)
					.select('products')
					.where(and(isNull('deletedAt'), exists('orders')))
					.execute();

				expect(activeWithOrders.length).toBeGreaterThan(0);
				// Verify all returned products are not deleted
				for (const product of activeWithOrders) {
					expect((product as { deletedAt: unknown }).deletedAt).toBeNull();
				}
			});
		});

		describe('Observability', () => {
			it('should generate correct SQL for soft delete filter', async () => {
				const adapter = await getTestAdapter();
				const orm = createOrm({ model: advancedModel, adapter });

				const dump = orm
					.withSchema(SCHEMA)
					.select('products')
					.where(isNull('deletedAt'))
					.dump();

				expect(dump.sql.toLowerCase()).toContain('deleted_at');
				expect(dump.sql.toLowerCase()).toContain('is null');
			});
		});
	});

	// ============================================================
	// SECTION 5: COMBINED SCENARIOS
	// ============================================================
	describe('Combined Advanced Queries', () => {
		it('should combine aggregation with soft delete filter', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: advancedModel, adapter });

			// Count active products by category
			const result = await orm
				.withSchema(SCHEMA)
				.select('products')
				.where(isNull('deletedAt'))
				.count({ as: 'count' })
				.groupBy(['category'])
				.execute();

			expect(result.length).toBeGreaterThan(0);
			const totalCount = result.reduce(
				(sum: number, r: any) => sum + Number(r.count),
				0,
			);
			expect(totalCount).toBe(8);
		});

		it('should combine sorting, pagination, and filtering', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: advancedModel, adapter });

			// Top 3 most expensive active electronics
			const result = await orm
				.withSchema(SCHEMA)
				.select('products')
				.where(and(isNull('deletedAt'), eq('category', 'electronics')))
				.columns(['name', 'price'])
				.orderBy('price', 'desc')
				.limit(3)
				.execute();

			expect(result).toHaveLength(3);
			// Should be: Laptop Pro (1299.99), Wireless Mouse (29.99), USB Cable (9.99)
			expect((result[0] as { name: string }).name).toBe('Laptop Pro');
		});

		it('should combine nested conditions with aggregation', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: advancedModel, adapter });

			// Sum order totals for completed or shipped orders
			const result = await orm
				.withSchema(SCHEMA)
				.select('orders')
				.where(or(eq('status', 'completed'), eq('status', 'shipped')))
				.sum('totalPrice', 'total')
				.execute();

			const total = Number((result[0] as { total: string }).total);
			expect(total).toBeGreaterThan(0);
		});
	});
});
