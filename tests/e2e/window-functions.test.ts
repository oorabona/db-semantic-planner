/**
 * DX-021: Window Functions E2E Tests
 *
 * Tests window function execution against real PostgreSQL using the
 * new fluent builder pattern (rowNumber(), rank(), wSum(), etc.)
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with variants (price_cents, stock)
 * - **When**: Execute ORM query with window functions via columns()
 * - **Then**: Verify window function results in returned data
 *
 * Test data (from pimdam-extended.seed.ts):
 * - Variant 1: Small, price_cents=1999, stock=10
 * - Variant 2: Medium, price_cents=2199, stock=5
 * - Variant 3: Large, price_cents=2199, stock=0
 * - Variant 4: Standard Charger, price_cents=999, stock=100
 * - Variant 5: Standard Case, price_cents=499, stock=50
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createOrm,
	denseRank,
	rank,
	rowNumber,
	wAvg,
	wSum,
} from '@db-semantic-planner/core';
import {
	closeTestDb,
	createExtendedPimdamSchema,
	dropExtendedPimdamSchema,
	getTestAdapter,
	getTestDb,
	pimdamExtendedModel,
	seedExtendedPimdam,
	shouldSkipE2E,
} from './testkit/index.js';

const SCHEMA = 'dx021_window_functions';
const SCHEMA_TENANT2 = 'dx021_window_tenant2';

describe.skipIf(shouldSkipE2E())('DX-021: Window Functions E2E', () => {
	beforeAll(async () => {
		// Set up test schema
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	// =========================================================================
	// ROW_NUMBER() Tests
	// =========================================================================
	describe('ROW_NUMBER()', () => {
		it('should generate row numbers ordered by price ascending', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Query variants with row_number ordered by price
			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'id',
					'name',
					'price_cents',
					rowNumber().orderBy('price_cents').as('row_num'),
				])
				.all()) as Array<{
				id: number;
				name: string;
				price_cents: number;
				row_num: string;
			}>;

			expect(results.length).toBeGreaterThan(0);

			// Verify row numbers are assigned
			const rowNums = results.map((r) => Number(r.row_num));
			expect(rowNums).toContain(1);

			// Verify ordering: cheapest first
			const cheapest = results.find((r) => Number(r.row_num) === 1);
			expect(cheapest).toBeDefined();
			expect(cheapest?.price_cents).toBe(499); // Standard Case is cheapest
		});

		it('should generate row numbers ordered by price descending', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'id',
					'name',
					'price_cents',
					rowNumber().orderBy('price_cents', 'desc').as('row_num'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				row_num: string;
			}>;

			// Verify most expensive is row_num = 1
			const mostExpensive = results.find((r) => Number(r.row_num) === 1);
			expect(mostExpensive).toBeDefined();
			expect(mostExpensive?.price_cents).toBe(2199); // Medium or Large
		});
	});

	// =========================================================================
	// RANK() Tests
	// =========================================================================
	describe('RANK()', () => {
		it('should assign same rank to items with equal values', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Query variants with rank by price (Medium and Large have same price)
			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'id',
					'name',
					'price_cents',
					rank().orderBy('price_cents', 'desc').as('price_rank'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				price_rank: string;
			}>;

			// Find Medium and Large (both 2199 cents)
			const tiedItems = results.filter((r) => r.price_cents === 2199);
			expect(tiedItems.length).toBe(2);

			// Both should have rank 1 (tied for first)
			const ranks = tiedItems.map((r) => Number(r.price_rank));
			expect(ranks).toEqual([1, 1]);
		});

		it('should rank with PARTITION BY product_id', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Rank variants within each product
			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'id',
					'product_id',
					'name',
					'price_cents',
					rank().partitionBy('product_id').orderBy('price_cents').as('rank_in_product'),
				])
				.all()) as Array<{
				product_id: number;
				name: string;
				price_cents: number;
				rank_in_product: string;
			}>;

			// T-Shirt variants (product_id=4): Small=1999, Medium=2199, Large=2199
			const tshirtVariants = results.filter((r) => r.product_id === 4);
			expect(tshirtVariants.length).toBe(3);

			// Small should be rank 1 within T-Shirt (cheapest)
			const small = tshirtVariants.find((r) => r.name === 'Small');
			expect(Number(small?.rank_in_product)).toBe(1);

			// Medium and Large should be rank 2 (tied)
			const medium = tshirtVariants.find((r) => r.name === 'Medium');
			const large = tshirtVariants.find((r) => r.name === 'Large');
			expect(Number(medium?.rank_in_product)).toBe(2);
			expect(Number(large?.rank_in_product)).toBe(2);
		});
	});

	// =========================================================================
	// DENSE_RANK() Tests
	// =========================================================================
	describe('DENSE_RANK()', () => {
		it('should not skip ranks after ties', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					'price_cents',
					denseRank().orderBy('price_cents', 'desc').as('dense_rank_price'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				dense_rank_price: string;
			}>;

			// With dense_rank: 2199 (rank 1), 1999 (rank 2), 999 (rank 3), 499 (rank 4)
			// (rank doesn't skip to 3 after tie at 2199)
			const ranks = [...new Set(results.map((r) => Number(r.dense_rank_price)))].sort(
				(a, b) => a - b,
			);
			// Should have consecutive ranks: 1, 2, 3, 4
			expect(ranks).toEqual([1, 2, 3, 4]);
		});
	});

	// =========================================================================
	// SUM() Running Total Tests
	// =========================================================================
	describe('SUM() Running Total', () => {
		it('should compute running total of price_cents', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					'price_cents',
					wSum('price_cents').orderBy('price_cents').as('running_total'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				running_total: string;
			}>;

			// Order by price: 499, 999, 1999, 2199, 2199
			// Running totals: 499, 1498, 3497, 5696, 7895
			expect(results.length).toBe(5);

			// Find the row with cheapest item (first in order)
			const sortedByPrice = [...results].sort(
				(a, b) => a.price_cents - b.price_cents,
			);

			// First item running total = its own price
			const first = sortedByPrice[0];
			expect(Number(first.running_total)).toBe(first.price_cents);

			// Last item running total = sum of all
			const totalPrice = results.reduce((sum, r) => sum + r.price_cents, 0);
			const lastResult = results.find(
				(r) => Number(r.running_total) === totalPrice,
			);
			expect(lastResult).toBeDefined();
		});

		it('should compute running total partitioned by product_id', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'product_id',
					'name',
					'price_cents',
					wSum('price_cents').partitionBy('product_id').orderBy('price_cents').as('product_running_total'),
				])
				.all()) as Array<{
				product_id: number;
				name: string;
				price_cents: number;
				product_running_total: string;
			}>;

			// T-Shirt (product_id=4) total: 1999 + 2199 + 2199 = 6397
			const tshirtVariants = results.filter((r) => r.product_id === 4);
			const maxTshirtTotal = Math.max(
				...tshirtVariants.map((r) => Number(r.product_running_total)),
			);
			expect(maxTshirtTotal).toBe(6397);

			// Charger (product_id=8) has only one variant: 999
			const chargerVariants = results.filter((r) => r.product_id === 8);
			expect(chargerVariants.length).toBe(1);
			expect(Number(chargerVariants[0].product_running_total)).toBe(999);
		});
	});

	// =========================================================================
	// AVG() Window Tests
	// =========================================================================
	describe('AVG() Window', () => {
		it('should compute moving average of stock', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					'stock',
					wAvg('stock').orderBy('stock').as('avg_stock'),
				])
				.all()) as Array<{
				name: string;
				stock: number;
				avg_stock: string;
			}>;

			// Verify avg is computed
			expect(results.length).toBe(5);
			// biome-ignore lint/complexity/noForEach: test iteration
			results.forEach((r) => {
				expect(r.avg_stock).toBeDefined();
				expect(Number(r.avg_stock)).toBeGreaterThanOrEqual(0);
			});
		});
	});

	// =========================================================================
	// Multi-tenant Window Functions
	// =========================================================================
	describe('Multi-tenant window functions', () => {
		beforeAll(async () => {
			// Create second tenant schema
			await dropExtendedPimdamSchema(SCHEMA_TENANT2);
			await createExtendedPimdamSchema(SCHEMA_TENANT2);
			// Seed with different data
			const db = await getTestDb();
			const { sql } = await import('kysely');
			// Insert only 2 variants with different prices
			await sql`
				INSERT INTO ${sql.ref(SCHEMA_TENANT2)}.users (id, name, email, role)
				VALUES (1, 'T2 User', 't2@test.com', 'admin')
			`.execute(db);
			await sql`
				INSERT INTO ${sql.ref(SCHEMA_TENANT2)}.families (id, name, code)
				VALUES (1, 'Test Family', 'test')
			`.execute(db);
			await sql`
				INSERT INTO ${sql.ref(SCHEMA_TENANT2)}.categories (id, name, parent_id, path)
				VALUES (1, 'Test Cat', NULL, '/1/')
			`.execute(db);
			await sql`
				INSERT INTO ${sql.ref(SCHEMA_TENANT2)}.products (id, sku, title, category_id, family_id, active, author_id)
				VALUES (1, 'T2-PROD', 'Tenant2 Product', 1, 1, true, 1)
			`.execute(db);
			await sql`
				INSERT INTO ${sql.ref(SCHEMA_TENANT2)}.variants (id, product_id, sku, name, price_cents, stock)
				VALUES
					(1, 1, 'T2-V1', 'Variant A', 5000, 20),
					(2, 1, 'T2-V2', 'Variant B', 3000, 30)
			`.execute(db);
		});

		afterAll(async () => {
			await dropExtendedPimdamSchema(SCHEMA_TENANT2);
		});

		it('should isolate window function results between tenants', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Query tenant 1
			const tenant1Results = (await orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					'price_cents',
					rank().orderBy('price_cents', 'desc').as('rank'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				rank: string;
			}>;

			// Query tenant 2
			const tenant2Results = (await orm
				.forTenant(SCHEMA_TENANT2)
				.select('variants')
				.columns([
					'name',
					'price_cents',
					rank().orderBy('price_cents', 'desc').as('rank'),
				])
				.all()) as Array<{
				name: string;
				price_cents: number;
				rank: string;
			}>;

			// Tenant 1 has 5 variants
			expect(tenant1Results.length).toBe(5);

			// Tenant 2 has only 2 variants
			expect(tenant2Results.length).toBe(2);

			// Tenant 2 prices are different (5000, 3000 vs tenant 1's 2199, 1999, etc.)
			const t2Prices = tenant2Results.map((r) => r.price_cents).sort((a, b) => b - a);
			expect(t2Prices).toEqual([5000, 3000]);

			// Verify ranks are computed correctly for each tenant
			const t2HighestRank = tenant2Results.find((r) => r.price_cents === 5000);
			expect(Number(t2HighestRank?.rank)).toBe(1);
		});

		it('should include schema prefix in window function SQL', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					'price_cents',
					rowNumber().orderBy('price_cents').as('row_num'),
				])
				.dump();

			// Verify schema prefix in SQL
			expect(dump.sql).toContain(`"${SCHEMA}"`);
			expect(dump.sql.toUpperCase()).toContain('ROW_NUMBER()');
			expect(dump.sql.toUpperCase()).toContain('OVER');
		});
	});

	// =========================================================================
	// Dump API Integration
	// =========================================================================
	describe('Dump API', () => {
		it('should include WindowIntent in dump SQL', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'name',
					rowNumber().orderBy('price_cents').as('row_num'),
				])
				.dump();

			// Verify SQL contains window function syntax
			expect(dump.sql.toUpperCase()).toContain('ROW_NUMBER()');
			expect(dump.sql.toUpperCase()).toContain('OVER');
			expect(dump.sql.toUpperCase()).toContain('ORDER BY');
			expect(dump.sql).toContain('"row_num"');
		});

		it('should generate correct SQL for PARTITION BY + ORDER BY', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm
				.forTenant(SCHEMA)
				.select('variants')
				.columns([
					'product_id',
					'name',
					rank().partitionBy('product_id').orderBy('price_cents', 'desc').as('product_rank'),
				])
				.dump();

			expect(dump.sql.toUpperCase()).toContain('PARTITION BY');
			expect(dump.sql.toUpperCase()).toContain('ORDER BY');
			expect(dump.sql.toUpperCase()).toContain('DESC');
		});
	});
});
