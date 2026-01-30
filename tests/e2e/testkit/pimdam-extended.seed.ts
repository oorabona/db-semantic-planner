/**
 * Extended PIM/DAM Seed Data for E2E-002
 *
 * Test data for scenarios:
 * - Q1: Completeness (families, attributes, channels)
 * - Q2: Locale fallback with COALESCE
 * - Q3: Variants with images
 * - Q4: Expiring assets
 * - Q5: Unused assets
 * - Q6: Category tree (materialized path)
 * - Q7: BOM/Bundles
 * - Q8: Ambiguous relations (author/reviewer)
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Seed extended PIM/DAM test data for a tenant.
 */
export async function seedExtendedPimdam(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const schema = schemaName;

	// =========================================================================
	// Users (Q8: Ambiguity tests)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.users (id, name, email, role)
    VALUES
      (1, 'Alice Author', 'alice@example.com', 'author'),
      (2, 'Bob Reviewer', 'bob@example.com', 'reviewer'),
      (3, 'Charlie Admin', 'charlie@example.com', 'admin')
  `.execute(pool);

	// =========================================================================
	// Families (Q1: Completeness)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.families (id, name, code)
    VALUES
      (1, 'Smartphones', 'smartphones'),
      (2, 'Accessories', 'accessories'),
      (3, 'Bundles', 'bundles')
  `.execute(pool);

	// =========================================================================
	// Channels (Q1: Completeness)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.channels (id, name, code)
    VALUES
      (1, 'Web', 'web'),
      (2, 'Print', 'print'),
      (3, 'Mobile', 'mobile')
  `.execute(pool);

	// =========================================================================
	// Family Attributes (Q1: Required attributes per family/channel)
	// =========================================================================
	// Smartphones family requires: name, description, price for web
	await sql`
    INSERT INTO ${sql.ref(schema)}.family_attributes (family_id, channel_id, attribute_name, is_required)
    VALUES
      (1, 1, 'name', true),
      (1, 1, 'description', true),
      (1, 1, 'price', true),
      (1, 2, 'name', true),
      (1, 2, 'description', true),
      (1, 2, 'print_resolution', true),
      (1, 2, 'price', true),
      (2, 1, 'name', true),
      (2, 1, 'price', true)
  `.execute(pool);

	// =========================================================================
	// Categories (Q6: Materialized path hierarchy)
	// =========================================================================
	// Electronics (/1/)
	//   ├── Phones (/1/2/)
	//   │   └── Smartphones (/1/2/3/)
	//   └── Audio (/1/4/)
	// Clothing (/5/)
	//   └── T-Shirts (/5/6/)
	await sql`
    INSERT INTO ${sql.ref(schema)}.categories (id, name, parent_id, path)
    VALUES
      (1, 'Electronics', NULL, '/1/'),
      (2, 'Phones', 1, '/1/2/'),
      (3, 'Smartphones', 2, '/1/2/3/'),
      (4, 'Audio', 1, '/1/4/'),
      (5, 'Clothing', NULL, '/5/'),
      (6, 'T-Shirts', 5, '/5/6/')
  `.execute(pool);

	// =========================================================================
	// Assets
	// =========================================================================
	// Asset expiration for Q4 tests
	await sql`
    INSERT INTO ${sql.ref(schema)}.assets (id, kind, sha256, mime, width, height, size_bytes, storage_key, expires_at, created_at)
    VALUES
      (1, 'image', 'sha256-a1', 'image/jpeg', 800, 600, 50000, 'assets/hero-fr.jpg', NULL, NOW()),
      (2, 'image', 'sha256-a2', 'image/jpeg', 800, 600, 51000, 'assets/hero-en.jpg', NULL, NOW()),
      (3, 'image', 'sha256-a3', 'image/jpeg', 800, 600, 52000, 'assets/gallery1.jpg', NULL, NOW()),
      (4, 'image', 'sha256-a4', 'image/jpeg', 800, 600, 53000, 'assets/gallery2.jpg', NOW() + INTERVAL '15 days', NOW()),
      (5, 'image', 'sha256-a5', 'image/jpeg', 800, 600, 54000, 'assets/expiring-soon.jpg', NOW() + INTERVAL '7 days', NOW()),
      (6, 'image', 'sha256-a6', 'image/jpeg', 800, 600, 55000, 'assets/orphan.jpg', NULL, NOW()),
      (7, 'video', 'sha256-v1', 'video/mp4', 1920, 1080, 5000000, 'assets/video1.mp4', NULL, NOW()),
      (8, 'document', 'sha256-d1', 'application/pdf', NULL, NULL, 100000, 'assets/spec.pdf', NULL, NOW()),
      (9, 'image', 'sha256-a9', 'image/jpeg', 400, 400, 20000, 'assets/variant-s-fr.jpg', NULL, NOW()),
      (10, 'image', 'sha256-a10', 'image/jpeg', 400, 400, 21000, 'assets/variant-s-en.jpg', NULL, NOW()),
      (11, 'image', 'sha256-a11', 'image/jpeg', 400, 400, 22000, 'assets/variant-m.jpg', NULL, NOW()),
      (12, 'image', 'sha256-a12', 'image/jpeg', 400, 400, 23000, 'assets/deleted-product.jpg', NULL, NOW())
  `.execute(pool);

	// =========================================================================
	// Products (Q2: Locale fallback + Q8: Ambiguity)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.products (id, sku, title, name_fr, name_en, name_default, description_fr, description_en, category_id, family_id, active, is_bundle, author_id, reviewer_id)
    VALUES
      -- Q2: Widget - has EN but no FR (fallback to EN)
      (1, 'WIDGET-001', 'Widget', NULL, 'Widget Pro', 'Default Widget', NULL, 'A great widget', 3, 1, true, false, 1, 2),
      -- Q2: Gadget - has both FR and EN (use FR primary)
      (2, 'GADGET-001', 'Gadget', 'Super Bidule', 'Super Gadget', 'Default Gadget', 'Un super bidule', 'A super gadget', 3, 1, true, false, 1, 2),
      -- Q2: Gizmo - has neither FR nor EN (fallback to default)
      (3, 'GIZMO-001', 'Gizmo', NULL, NULL, 'Default Gizmo', NULL, NULL, 3, 1, true, false, 1, 2),
      -- Q3: T-Shirt with variants
      (4, 'TSHIRT-001', 'T-Shirt Basic', 'T-Shirt Basique', 'Basic T-Shirt', 'T-Shirt', 'Un basique', 'A basic tee', 6, 2, true, false, 1, 3),
      -- Q4/Q5: Product with expiring asset
      (5, 'EXPIRING-001', 'Expiring Product', 'Produit Expirant', 'Expiring Product', 'Expiring', NULL, NULL, 1, 1, true, false, 2, 1),
      -- Q5: Deleted product (for unused asset test)
      (6, 'DELETED-001', 'Deleted Product', NULL, NULL, 'Deleted', NULL, NULL, 1, 1, false, false, 1, 2),
      -- Q7: Bundle starter kit
      (7, 'BUNDLE-001', 'Starter Kit', 'Kit Démarrage', 'Starter Kit', 'Starter Kit', NULL, NULL, 1, 3, true, true, 1, 2),
      -- Q7: Component products
      (8, 'COMPONENT-A', 'Charger', 'Chargeur', 'Charger', 'Charger', NULL, NULL, 1, 2, true, false, 1, 2),
      (9, 'COMPONENT-B', 'Case', 'Étui', 'Case', 'Case', NULL, NULL, 1, 2, true, false, 1, 2),
      -- Q1: Product for completeness test (66% complete)
      (10, 'IPHONE-15', 'iPhone 15', 'iPhone 15', 'iPhone 15', 'iPhone 15', 'Le dernier iPhone', NULL, 3, 1, true, false, 1, 2)
  `.execute(pool);

	// Mark product 6 as deleted
	await sql`
    UPDATE ${sql.ref(schema)}.products SET deleted_at = NOW() WHERE id = 6
  `.execute(pool);

	// =========================================================================
	// Product Images
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_images (product_id, asset_id, locale, status, is_main, role, position)
    VALUES
      -- Product 1 (Widget): EN only
      (1, 2, 'EN', 'approved', true, 'main', 0),
      -- Product 2 (Gadget): FR + EN
      (2, 1, 'FR', 'approved', true, 'main', 0),
      (2, 2, 'EN', 'approved', true, 'main', 0),
      (2, 3, 'FR', 'approved', false, 'gallery', 1),
      -- Product 4 (T-Shirt): gallery images
      (4, 3, 'FR', 'approved', true, 'main', 0),
      (4, 4, 'EN', 'approved', true, 'main', 0),
      -- Product 5 (Expiring): uses expiring asset
      (5, 5, 'EN', 'approved', true, 'main', 0),
      -- Product 6 (Deleted): has image (for Q5 test)
      (6, 12, 'EN', 'approved', true, 'main', 0),
      -- Product 10 (iPhone): for Q8 role-based images
      (10, 1, 'FR', 'approved', true, 'main', 0),
      (10, 3, 'FR', 'approved', false, 'gallery', 1),
      (10, 4, 'FR', 'approved', false, 'thumbnail', 2)
  `.execute(pool);

	// =========================================================================
	// Variants (Q3)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.variants (id, product_id, sku, name, price_cents, stock)
    VALUES
      (1, 4, 'TSHIRT-001-S', 'Small', 1999, 10),
      (2, 4, 'TSHIRT-001-M', 'Medium', 2199, 5),
      (3, 4, 'TSHIRT-001-L', 'Large', 2199, 0),
      (4, 8, 'COMPONENT-A-V1', 'Standard Charger', 999, 100),
      (5, 9, 'COMPONENT-B-V1', 'Standard Case', 499, 50)
  `.execute(pool);

	// =========================================================================
	// Variant Images (Q3)
	// =========================================================================
	await sql`
    INSERT INTO ${sql.ref(schema)}.variant_images (variant_id, asset_id, locale, is_main, position)
    VALUES
      (1, 9, 'FR', true, 0),
      (1, 10, 'EN', true, 0),
      (2, 11, 'FR', true, 0),
      (2, 11, 'EN', true, 0)
  `.execute(pool);

	// =========================================================================
	// Product Attributes (Q1: Completeness)
	// =========================================================================
	// iPhone 15: 2/3 required attributes filled (name + description, missing price)
	await sql`
    INSERT INTO ${sql.ref(schema)}.product_attributes (product_id, attribute_name, value, locale)
    VALUES
      (10, 'name', 'iPhone 15', 'fr'),
      (10, 'name', 'iPhone 15', 'en'),
      (10, 'description', 'Le dernier iPhone', 'fr')
  `.execute(pool);

	// =========================================================================
	// Bundle Components (Q7: BOM)
	// =========================================================================
	// Starter Kit = 2x Charger + 1x Case
	await sql`
    INSERT INTO ${sql.ref(schema)}.bundle_components (bundle_id, component_id, quantity, position)
    VALUES
      (7, 8, 2, 0),
      (7, 9, 1, 1)
  `.execute(pool);
}

/**
 * Seed a second tenant with different data for isolation tests.
 */
export async function seedExtendedPimdamTenant2(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const schema = schemaName;

	// Minimal data for tenant isolation tests
	await sql`
    INSERT INTO ${sql.ref(schema)}.users (id, name, email, role)
    VALUES
      (1, 'Tenant2 User', 'user@tenant2.com', 'member')
  `.execute(pool);

	await sql`
    INSERT INTO ${sql.ref(schema)}.families (id, name, code)
    VALUES
      (1, 'Electronics', 'electronics')
  `.execute(pool);

	await sql`
    INSERT INTO ${sql.ref(schema)}.channels (id, name, code)
    VALUES
      (1, 'Web', 'web')
  `.execute(pool);

	await sql`
    INSERT INTO ${sql.ref(schema)}.categories (id, name, parent_id, path)
    VALUES
      (1, 'All Products', NULL, '/1/')
  `.execute(pool);

	await sql`
    INSERT INTO ${sql.ref(schema)}.products (id, sku, title, name_fr, name_en, category_id, family_id, active, author_id)
    VALUES
      (1, 'TENANT2-001', 'Tenant2 Product', 'Produit T2', 'T2 Product', 1, 1, true, 1)
  `.execute(pool);
}
