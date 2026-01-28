/**
 * Q3-Q5: Variants and Assets
 *
 * Q3: Variants with locale-specific images (Shopify-like)
 * Q4: Expiring assets used by published products
 * Q5: Unused assets (NOT EXISTS pattern)
 *
 * @see E2E-002 Block 7
 *
 * ## Test Structure (GWT - Given/When/Then)
 *
 * - **Given**: Extended PIM/DAM schema with variants, assets, variant_images (beforeAll)
 * - **When**: Execute SQL/ORM query for variant-asset relationships
 * - **Then**: Verify correct asset associations, expiration detection, unused assets
 *
 * Test data:
 * - T-Shirt (id=4): Has variants with locale-specific images (en-US, fr-FR)
 * - Asset (id=2): Expires 2024-12-31, used by published product
 * - Unused assets: Some assets not linked to any variant
 */

import { and, createOrm, eq, exists, notExists } from '@dbsp/core';
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

const SCHEMA = 'q3q5_variants_assets';

describe.skipIf(shouldSkipE2E())('Q3-Q5: Variants and Assets', () => {
	beforeAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await createExtendedPimdamSchema(SCHEMA);
		await seedExtendedPimdam(SCHEMA);
	});

	afterAll(async () => {
		await dropExtendedPimdamSchema(SCHEMA);
		await closeTestDb();
	});

	// =========================================================================
	// Q3: Variants with Images (Shopify-like)
	// =========================================================================
	describe('Q3: Variants with locale-specific images', () => {
		it('Q3-01: should load product with variants and their images', async () => {
			const db = await getTestDb();

			// Get T-Shirt (id=4) with its variants and their images
			const result = await kyselySql`
				SELECT
					p.id AS product_id,
					p.sku AS product_sku,
					v.id AS variant_id,
					v.sku AS variant_sku,
					v.name AS variant_name,
					vi.locale,
					a.storage_key AS image_path
				FROM ${kyselySql.ref(SCHEMA)}.products p
				JOIN ${kyselySql.ref(SCHEMA)}.variants v ON v.product_id = p.id
				LEFT JOIN ${kyselySql.ref(SCHEMA)}.variant_images vi ON vi.variant_id = v.id
				LEFT JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = vi.asset_id
				WHERE p.sku = 'TSHIRT-001'
				ORDER BY v.name, vi.locale
			`.execute(db);

			// T-Shirt has 3 variants: S, M, L
			// Small (S) has FR and EN images
			// Medium (M) has FR and EN images (same asset)
			// Large (L) has no images
			const rows = result.rows as {
				variantSku: string;
				variantName: string;
				locale: string | null;
			}[];

			// Verify we have variants (CamelCasePlugin transforms variant_name → variantName)
			const smallVariants = rows.filter((r) => r.variantName === 'Small');
			expect(smallVariants.length).toBe(2); // FR and EN
			expect(smallVariants.map((r) => r.locale).sort()).toEqual(['EN', 'FR']);

			const mediumVariants = rows.filter((r) => r.variantName === 'Medium');
			expect(mediumVariants.length).toBe(2); // FR and EN (same asset)

			const largeVariants = rows.filter((r) => r.variantName === 'Large');
			expect(largeVariants.length).toBe(1); // No images, just one row with NULL
			expect(largeVariants[0].locale).toBeNull();
		});

		it('Q3-02: should filter variants by stock availability', async () => {
			const db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Query variants with stock > 0 using ORM
			const dump = orm
				.withSchema(SCHEMA)
				.select('variants')
				.where(
					and(
						eq('productId', 4), // T-Shirt
						// Stock > 0 - need gt operator or raw
					),
				)
				.columns(['id', 'sku', 'name', 'stock'])
				.dump();

			expect(dump.sql).toContain(`"${SCHEMA}"`);

			// Direct SQL to verify in-stock variants
			const result = await kyselySql`
				SELECT sku, name, stock
				FROM ${kyselySql.ref(SCHEMA)}.variants
				WHERE product_id = 4 AND stock > 0
				ORDER BY name
			`.execute(db);

			const inStock = result.rows as {
				sku: string;
				name: string;
				stock: number;
			}[];
			// Small (10) and Medium (5) are in stock, Large (0) is out
			expect(inStock).toHaveLength(2);
			expect(inStock.map((v) => v.name)).toEqual(['Medium', 'Small']);
		});

		it('Q3-03: should get variant image with locale fallback', async () => {
			const db = await getTestDb();

			// Variant "Medium" has same image for FR and EN
			// Simulating fallback: prefer FR, fallback to EN
			const result = await kyselySql`
				SELECT
					v.sku,
					COALESCE(
						(SELECT a.storage_key FROM ${kyselySql.ref(SCHEMA)}.variant_images vi
						 JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = vi.asset_id
						 WHERE vi.variant_id = v.id AND vi.locale = 'FR' LIMIT 1),
						(SELECT a.storage_key FROM ${kyselySql.ref(SCHEMA)}.variant_images vi
						 JOIN ${kyselySql.ref(SCHEMA)}.assets a ON a.id = vi.asset_id
						 WHERE vi.variant_id = v.id AND vi.locale = 'EN' LIMIT 1)
					) AS image_path
				FROM ${kyselySql.ref(SCHEMA)}.variants v
				WHERE v.product_id = 4
				ORDER BY v.name
			`.execute(db);

			const variants = result.rows as {
				sku: string;
				imagePath: string | null;
			}[];
			// Large has no images
			const large = variants.find((v) => v.sku === 'TSHIRT-001-L');
			expect(large?.imagePath).toBeNull();

			// Small and Medium have images
			const small = variants.find((v) => v.sku === 'TSHIRT-001-S');
			expect(small?.imagePath).toBeDefined();
		});
	});

	// =========================================================================
	// Q4: Expiring Assets + Used by Published Products
	// =========================================================================
	describe('Q4: Expiring assets used by active products', () => {
		it('Q4-01: should find expiring assets used by active products', async () => {
			const db = await getTestDb();

			// Asset 5 (expiring-soon.jpg) expires in 7 days and is used by active product 5
			const result = await kyselySql`
				SELECT a.id, a.storage_key, a.expires_at
				FROM ${kyselySql.ref(SCHEMA)}.assets a
				WHERE a.expires_at IS NOT NULL
				  AND a.expires_at < NOW() + INTERVAL '30 days'
				  AND EXISTS (
					SELECT 1 FROM ${kyselySql.ref(SCHEMA)}.product_images pi
					JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.id = pi.product_id
					WHERE pi.asset_id = a.id
					  AND p.active = true
					  AND p.deleted_at IS NULL
				  )
				ORDER BY a.expires_at
			`.execute(db);

			const expiring = result.rows as { id: number; storageKey: string }[];
			expect(expiring.length).toBeGreaterThanOrEqual(1);
			expect(expiring.some((a) => a.storageKey.includes('expiring-soon'))).toBe(
				true,
			);
		});

		it('Q4-02: should exclude assets used only by inactive products', async () => {
			const db = await getTestDb();

			// Asset 12 is only used by deleted product 6
			const result = await kyselySql`
				SELECT a.id, a.storage_key
				FROM ${kyselySql.ref(SCHEMA)}.assets a
				WHERE EXISTS (
					SELECT 1 FROM ${kyselySql.ref(SCHEMA)}.product_images pi
					WHERE pi.asset_id = a.id
				)
				AND NOT EXISTS (
					SELECT 1 FROM ${kyselySql.ref(SCHEMA)}.product_images pi
					JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.id = pi.product_id
					WHERE pi.asset_id = a.id
					  AND p.active = true
					  AND p.deleted_at IS NULL
				)
			`.execute(db);

			const inactiveOnly = result.rows as { id: number; storageKey: string }[];
			// Asset 12 (deleted-product.jpg) is only used by deleted product
			expect(
				inactiveOnly.some((a) => a.storageKey.includes('deleted-product')),
			).toBe(true);
		});

		it('Q4-03: should join assets with product details', async () => {
			const db = await getTestDb();

			// Get expiring assets with their product information
			const result = await kyselySql`
				SELECT
					a.storage_key,
					a.expires_at,
					p.sku AS product_sku,
					p.title AS product_title
				FROM ${kyselySql.ref(SCHEMA)}.assets a
				JOIN ${kyselySql.ref(SCHEMA)}.product_images pi ON pi.asset_id = a.id
				JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.id = pi.product_id
				WHERE a.expires_at IS NOT NULL
				  AND a.expires_at < NOW() + INTERVAL '30 days'
				  AND p.active = true
				ORDER BY a.expires_at
			`.execute(db);

			const expiring = result.rows as {
				storageKey: string;
				productSku: string;
				productTitle: string;
			}[];
			expect(expiring.length).toBeGreaterThanOrEqual(1);

			// Verify we have product context
			const expiringAsset = expiring.find((a) =>
				a.storageKey.includes('expiring'),
			);
			expect(expiringAsset?.productSku).toBe('EXPIRING-001');
		});
	});

	// =========================================================================
	// Q5: Unused Assets (NOT EXISTS)
	// =========================================================================
	describe('Q5: Unused assets (NOT EXISTS)', () => {
		it('Q5-01: should find assets not linked to any product', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Use ORM with notExists
			const dump = orm
				.withSchema(SCHEMA)
				.select('assets')
				.where(notExists('productImages'))
				.columns(['id', 'storageKey', 'kind'])
				.dump();

			expect(dump.sql.toUpperCase()).toContain('NOT EXISTS');

			// Execute to verify
			const assets = await orm
				.withSchema(SCHEMA)
				.select('assets')
				.where(notExists('productImages'))
				.columns(['id', 'storageKey', 'kind'])
				.execute();

			// Asset 6 (orphan.jpg) has no product_images
			// Asset 7, 8 (video, document) also have no product_images
			const orphans = assets as { storageKey: string }[];
			expect(orphans.some((a) => a.storageKey.includes('orphan'))).toBe(true);
		});

		it('Q5-02: should find assets not used by active products', async () => {
			const db = await getTestDb();

			// Assets used only by deleted/inactive products
			const result = await kyselySql`
				SELECT a.id, a.storage_key, a.kind
				FROM ${kyselySql.ref(SCHEMA)}.assets a
				WHERE NOT EXISTS (
					SELECT 1 FROM ${kyselySql.ref(SCHEMA)}.product_images pi
					JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.id = pi.product_id
					WHERE pi.asset_id = a.id
					  AND p.deleted_at IS NULL
					  AND p.active = true
				)
			`.execute(db);

			const unused = result.rows as { storageKey: string; kind: string }[];
			// orphan.jpg, deleted-product.jpg, video, document should be "unused"
			expect(unused.some((a) => a.storageKey.includes('orphan'))).toBe(true);
			expect(unused.some((a) => a.storageKey.includes('deleted-product'))).toBe(
				true,
			);
		});

		it('Q5-03: should count unused assets by kind', async () => {
			const db = await getTestDb();

			// Count unused assets grouped by kind
			const result = await kyselySql`
				SELECT a.kind, COUNT(*) AS count
				FROM ${kyselySql.ref(SCHEMA)}.assets a
				WHERE NOT EXISTS (
					SELECT 1 FROM ${kyselySql.ref(SCHEMA)}.product_images pi
					JOIN ${kyselySql.ref(SCHEMA)}.products p ON p.id = pi.product_id
					WHERE pi.asset_id = a.id
					  AND p.deleted_at IS NULL
					  AND p.active = true
				)
				GROUP BY a.kind
				ORDER BY a.kind
			`.execute(db);

			const counts = result.rows as { kind: string; count: string }[];
			// Should have counts for image, video, document
			expect(counts.length).toBeGreaterThanOrEqual(1);

			// At least orphan.jpg + deleted-product.jpg (2 images)
			const imageCount = counts.find((c) => c.kind === 'image');
			expect(Number(imageCount?.count)).toBeGreaterThanOrEqual(2);
		});
	});

	// =========================================================================
	// ORM API Tests
	// =========================================================================
	describe('ORM API: exists/notExists patterns', () => {
		it('should generate EXISTS SQL for variant images filter', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			// Find variants that have images
			const dump = orm
				.withSchema(SCHEMA)
				.select('variants')
				.where(exists('variantImages'))
				.columns(['id', 'sku', 'name'])
				.dump();

			expect(dump.sql.toUpperCase()).toContain('EXISTS');
			expect(dump.sql).toContain(`"${SCHEMA}"`);
		});

		it('should generate NOT EXISTS SQL for orphan assets', async () => {
			const _db = await getTestDb();
			const adapter = await getTestAdapter();
			const orm = createOrm({ model: pimdamExtendedModel, adapter });

			const dump = orm
				.withSchema(SCHEMA)
				.select('assets')
				.where(notExists('productImages'))
				.dump();

			expect(dump.sql.toUpperCase()).toContain('NOT EXISTS');
		});
	});
});
