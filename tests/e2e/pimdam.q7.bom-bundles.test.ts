/**
 * Q7: BOM / Bundles
 *
 * Tests Bundle component queries using junction table pattern.
 * bundle_components links bundle products to component products.
 *
 * @see E2E-002 Block 9
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with bundles, components, and variants (beforeAll)
 * - **When**: Execute SQL/ORM query joining bundles to components via junction table
 * - **Then**: Verify correct bundle pricing and component aggregation
 *
 * Bundle data:
 * - Starter Kit (bundle, id=7): 2x Charger (999) + 1x Case (499) = 2497 total
 */

import { createOrm, eq, exists } from '@dbsp/core';
import { sql as kyselySql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const SCHEMA = 'q7_bom_bundles';

/**
 * Bundle data in test:
 * - Starter Kit (bundle, id=7)
 *   - 2x Charger (component, id=8, variant price: 999)
 *   - 1x Case (component, id=9, variant price: 499)
 */
describe.skipIf(shouldSkipE2E())('Q7: BOM / Bundles', () => {
	beforeAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	describe('Q7-01: Calculate bundle total price from components', () => {
		it('should calculate total from component variants', async () => {
			const db = await getTestDb();

			// Starter Kit total = 2*999 + 1*499 = 2497
			const result = await kyselySql`
				SELECT
					b.sku AS bundle_sku,
					b.title AS bundle_title,
					SUM(bc.quantity * v.price_cents) AS total_price_cents
				FROM ${kyselySql.ref(SCHEMA)}.products b
				JOIN ${kyselySql.ref(SCHEMA)}.bundle_components bc ON bc.bundle_id = b.id
				JOIN ${kyselySql.ref(SCHEMA)}.products c ON c.id = bc.component_id
				JOIN ${kyselySql.ref(SCHEMA)}.variants v ON v.product_id = c.id
				WHERE b.is_bundle = true AND b.sku = 'BUNDLE-001'
				GROUP BY b.id, b.sku, b.title
			`.execute(db);

			const bundle = (
				result.rows as { bundleSku: string; totalPriceCents: string }[]
			)[0];
			expect(bundle).toBeDefined();
			expect(bundle.bundleSku).toBe('BUNDLE-001');
			// 2*999 + 1*499 = 2497
			expect(Number(bundle.totalPriceCents)).toBe(2497);
		});

		it('should list bundle components with quantities', async () => {
			const db = await getTestDb();

			const result = await kyselySql`
				SELECT
					c.sku AS component_sku,
					c.title AS component_name,
					bc.quantity
				FROM ${kyselySql.ref(SCHEMA)}.bundle_components bc
				JOIN ${kyselySql.ref(SCHEMA)}.products c ON c.id = bc.component_id
				WHERE bc.bundle_id = 7
				ORDER BY bc.position
			`.execute(db);

			const components = result.rows as {
				componentSku: string;
				componentName: string;
				quantity: number;
			}[];
			expect(components).toHaveLength(2);
			expect(components[0].componentSku).toBe('COMPONENT-A');
			expect(components[0].quantity).toBe(2);
			expect(components[1].componentSku).toBe('COMPONENT-B');
			expect(components[1].quantity).toBe(1);
		});
	});

	describe('Q7-02: Check bundle component availability', () => {
		it('should find bundles with all components in stock', async () => {
			const db = await getTestDb();

			// Find bundles where ALL components have stock > 0
			const result = await kyselySql`
				SELECT b.sku, b.title
				FROM ${kyselySql.ref(SCHEMA)}.products b
				WHERE b.is_bundle = true
				  AND NOT EXISTS (
					-- Check if any component has stock = 0
					SELECT 1
					FROM ${kyselySql.ref(SCHEMA)}.bundle_components bc
					JOIN ${kyselySql.ref(SCHEMA)}.products c ON c.id = bc.component_id
					JOIN ${kyselySql.ref(SCHEMA)}.variants v ON v.product_id = c.id
					WHERE bc.bundle_id = b.id
					  AND v.stock = 0
				  )
			`.execute(db);

			const availableBundles = result.rows as { sku: string }[];
			// Starter Kit has components: Charger (stock 100) and Case (stock 50)
			expect(availableBundles.some((b) => b.sku === 'BUNDLE-001')).toBe(true);
		});

		it('should flag bundles with out-of-stock components', async () => {
			const db = await getTestDb();

			// Find components with stock = 0 for each bundle
			const result = await kyselySql`
				SELECT
					b.sku AS bundle_sku,
					c.sku AS component_sku,
					v.name AS variant_name,
					v.stock
				FROM ${kyselySql.ref(SCHEMA)}.products b
				JOIN ${kyselySql.ref(SCHEMA)}.bundle_components bc ON bc.bundle_id = b.id
				JOIN ${kyselySql.ref(SCHEMA)}.products c ON c.id = bc.component_id
				JOIN ${kyselySql.ref(SCHEMA)}.variants v ON v.product_id = c.id
				WHERE b.is_bundle = true
				ORDER BY b.sku, c.sku
			`.execute(db);

			const components = result.rows as {
				bundle_sku: string;
				component_sku: string;
				stock: number;
			}[];
			// All components have stock > 0
			expect(components.every((c) => c.stock > 0)).toBe(true);
		});
	});

	describe('Q7-03: Recursive BOM (multi-level)', () => {
		it('should support nested bundles via recursive CTE', async () => {
			const db = await getTestDb();

			// This demonstrates the pattern for recursive BOM
			// Even though our test data has only one level, the query supports multi-level
			const result = await kyselySql`
				WITH RECURSIVE bom AS (
					-- Base case: direct components of the bundle
					SELECT
						bc.bundle_id,
						bc.component_id,
						bc.quantity,
						1 AS level,
						c.sku AS component_sku,
						c.is_bundle AS is_sub_bundle
					FROM ${kyselySql.ref(SCHEMA)}.bundle_components bc
					JOIN ${kyselySql.ref(SCHEMA)}.products c ON c.id = bc.component_id
					WHERE bc.bundle_id = 7

					UNION ALL

					-- Recursive case: components of sub-bundles
					SELECT
						bom.bundle_id,
						bc2.component_id,
						bom.quantity * bc2.quantity AS quantity,
						bom.level + 1,
						c2.sku,
						c2.is_bundle
					FROM bom
					JOIN ${kyselySql.ref(SCHEMA)}.bundle_components bc2 ON bc2.bundle_id = bom.component_id
					JOIN ${kyselySql.ref(SCHEMA)}.products c2 ON c2.id = bc2.component_id
					WHERE bom.is_sub_bundle = true
				)
				SELECT component_sku, SUM(quantity) AS total_quantity, MAX(level) AS max_level
				FROM bom
				WHERE is_sub_bundle = false  -- Only leaf products
				GROUP BY component_sku
				ORDER BY component_sku
			`.execute(db);

			const flatBom = result.rows as {
				componentSku: string;
				totalQuantity: string;
				maxLevel: number;
			}[];
			// Our bundle has 2 leaf components at level 1
			expect(flatBom).toHaveLength(2);
			expect(
				flatBom.find((c) => c.componentSku === 'COMPONENT-A')?.totalQuantity,
			).toBe('2');
			expect(
				flatBom.find((c) => c.componentSku === 'COMPONENT-B')?.totalQuantity,
			).toBe('1');
		});
	});

	describe('ORM API: Bundle queries', () => {
		it('should find products that are bundles', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const bundles = await orm
				.withSchema(SCHEMA)
				.select('products')
				.where(eq('isBundle', true))
				.columns(['id', 'sku', 'title'])
				.execute();

			expect((bundles as unknown[]).length).toBeGreaterThanOrEqual(1);
			expect(
				(bundles as { sku: string }[]).some((b) => b.sku === 'BUNDLE-001'),
			).toBe(true);
		});

		it('should find bundles with components using EXISTS', async () => {
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Find products that have components (i.e., are bundles)
			const dump = orm
				.withSchema(SCHEMA)
				.select('products')
				.where(exists('components'))
				.columns(['id', 'sku'])
				.dump();

			expect(dump.sql.toUpperCase()).toContain('EXISTS');

			const bundles = await orm
				.withSchema(SCHEMA)
				.select('products')
				.where(exists('components'))
				.columns(['id', 'sku'])
				.execute();

			expect(
				(bundles as { sku: string }[]).some((b) => b.sku === 'BUNDLE-001'),
			).toBe(true);
		});
	});
});
