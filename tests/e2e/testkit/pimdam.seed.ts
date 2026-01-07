/**
 * PIM/DAM Seed Data
 *
 * Test data for E2E scenarios:
 * - Q1: Products with approved FR main image (EXISTS)
 * - Q2: Products with both FR and EN approved images (CTE)
 * - Q4: Multi-tenant isolation
 */

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Seed Acme tenant with test data.
 *
 * Products:
 * - p1 (PROD-001): approved FR main ✓, approved EN main ✓ (Q1 + Q2 match)
 * - p2 (PROD-002): approved FR main ✓, EN missing (Q1 match only)
 * - p3 (PROD-003): EN approved ✓, FR missing (neither Q1 nor Q2)
 * - p4 (PROD-004): rejected FR (neither Q1 nor Q2)
 */
export async function seedAcmeTenant(): Promise<void> {
	const db = await getTestDb();
	const schema = 'acme';

	// Categories
	await sql`
    INSERT INTO ${sql.ref(schema)}.categories (id, name, parent_id)
    VALUES
      (1, 'Electronics', NULL),
      (2, 'Phones', 1)
  `.execute(db);

	// Assets
	await sql`
    INSERT INTO ${sql.ref(schema)}.assets (id, kind, sha256, mime, width, height, size_bytes, storage_key)
    VALUES
      (1, 'image', 'sha256-a1', 'image/jpeg', 800, 600, 50000, 'assets/a1.jpg'),
      (2, 'image', 'sha256-a2', 'image/jpeg', 800, 600, 51000, 'assets/a2.jpg'),
      (3, 'image', 'sha256-a3', 'image/jpeg', 800, 600, 52000, 'assets/a3.jpg'),
      (4, 'image', 'sha256-a4', 'image/jpeg', 800, 600, 53000, 'assets/a4.jpg'),
      (5, 'image', 'sha256-a5', 'image/jpeg', 800, 600, 54000, 'assets/a5.jpg'),
      (6, 'image', 'sha256-a6', 'image/jpeg', 800, 600, 55000, 'assets/a6.jpg')
  `.execute(db);

	// Products
	await sql`
    INSERT INTO ${sql.ref(schema)}.products (id, sku, title, category_id, active)
    VALUES
      (1, 'PROD-001', 'Product One', 1, true),
      (2, 'PROD-002', 'Product Two', 1, true),
      (3, 'PROD-003', 'Product Three', 2, true),
      (4, 'PROD-004', 'Product Four', 2, true)
  `.execute(db);

	// Product Images
	// p1: FR approved main + EN approved main (Q1 + Q2 match)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (1, 1, 'FR', 'approved', true, 0),
      (1, 2, 'EN', 'approved', true, 0)
  `.execute(db);

	// p2: FR approved main only (Q1 match only)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (2, 3, 'FR', 'approved', true, 0)
  `.execute(db);

	// p3: EN approved only (neither Q1 nor Q2)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (3, 4, 'EN', 'approved', true, 0)
  `.execute(db);

	// p4: FR rejected (neither Q1 nor Q2)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (4, 5, 'FR', 'rejected', true, 0)
  `.execute(db);

	// Variants
	await sql`
    INSERT INTO ${sql.ref(schema)}.variants (product_id, sku, name, price_cents, stock)
    VALUES
      (1, 'PROD-001-S', 'Small', 1999, 10),
      (1, 'PROD-001-M', 'Medium', 2199, 5),
      (2, 'PROD-002-S', 'Small', 2999, 15)
  `.execute(db);
}

/**
 * Seed Globex tenant with different data.
 *
 * Products:
 * - g1 (GLX-001): approved FR main ✓, approved EN main ✓ (Q1 + Q2 match)
 * - g2 (GLX-002): approved FR main ✓ (Q1 match only)
 * - g3 (GLX-003): approved FR main ✓ (Q1 match only)
 * - g4 (GLX-004): no images (neither Q1 nor Q2)
 * - g5 (GLX-005): EN only (neither Q1 nor Q2)
 */
export async function seedGlobexTenant(): Promise<void> {
	const db = await getTestDb();
	const schema = 'globex';

	// Categories
	await sql`
    INSERT INTO ${sql.ref(schema)}.categories (id, name, parent_id)
    VALUES
      (1, 'Clothing', NULL),
      (2, 'Tops', 1),
      (3, 'Bottoms', 1)
  `.execute(db);

	// Assets
	await sql`
    INSERT INTO ${sql.ref(schema)}.assets (id, kind, sha256, mime, width, height, size_bytes, storage_key)
    VALUES
      (1, 'image', 'sha256-g1', 'image/png', 1024, 768, 80000, 'assets/g1.png'),
      (2, 'image', 'sha256-g2', 'image/png', 1024, 768, 81000, 'assets/g2.png'),
      (3, 'image', 'sha256-g3', 'image/png', 1024, 768, 82000, 'assets/g3.png'),
      (4, 'image', 'sha256-g4', 'image/png', 1024, 768, 83000, 'assets/g4.png'),
      (5, 'image', 'sha256-g5', 'image/png', 1024, 768, 84000, 'assets/g5.png'),
      (6, 'image', 'sha256-g6', 'image/png', 1024, 768, 85000, 'assets/g6.png'),
      (7, 'image', 'sha256-g7', 'image/png', 1024, 768, 86000, 'assets/g7.png'),
      (8, 'image', 'sha256-g8', 'image/png', 1024, 768, 87000, 'assets/g8.png')
  `.execute(db);

	// Products
	await sql`
    INSERT INTO ${sql.ref(schema)}.products (id, sku, title, category_id, active)
    VALUES
      (1, 'GLX-001', 'Globex Product One', 1, true),
      (2, 'GLX-002', 'Globex Product Two', 2, true),
      (3, 'GLX-003', 'Globex Product Three', 2, true),
      (4, 'GLX-004', 'Globex Product Four', 3, true),
      (5, 'GLX-005', 'Globex Product Five', 3, true)
  `.execute(db);

	// Product Images
	// g1: FR approved main + EN approved main (Q1 + Q2 match)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (1, 1, 'FR', 'approved', true, 0),
      (1, 2, 'EN', 'approved', true, 0)
  `.execute(db);

	// g2: FR approved main only (Q1 match)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (2, 3, 'FR', 'approved', true, 0)
  `.execute(db);

	// g3: FR approved main only (Q1 match)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (3, 4, 'FR', 'approved', true, 0)
  `.execute(db);

	// g4: no images

	// g5: EN only
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, position)
    VALUES
      (5, 5, 'EN', 'approved', true, 0)
  `.execute(db);

	// Variants
	await sql`
    INSERT INTO ${sql.ref(schema)}.variants (product_id, sku, name, price_cents, stock)
    VALUES
      (1, 'GLX-001-RED', 'Red', 3999, 20),
      (1, 'GLX-001-BLUE', 'Blue', 3999, 15)
  `.execute(db);
}
