/**
 * Extended PIM/DAM Schema DDL for E2E-002
 *
 * Creates additional tables for:
 * - Q1: Completeness (families, family_attributes, product_attributes)
 * - Q2: Locale fallback (extended products table)
 * - Q3: Variants with locale images (variant_images)
 * - Q6: Category tree (path column)
 * - Q7: BOM/Bundles (bundle_components)
 * - Q8: Ambiguous relations (users table)
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Create the extended PIM/DAM schema tables in a tenant schema.
 */
export async function createExtendedPimdamSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	// Users table (for Q8 ambiguity tests)
	await sql`
    CREATE TABLE ${s}.users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member'
    )
  `.execute(pool);

	// Families table (for Q1 completeness)
	await sql`
    CREATE TABLE ${s}.families (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE
    )
  `.execute(pool);

	// Channels table (for Q1 completeness)
	await sql`
    CREATE TABLE ${s}.channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE
    )
  `.execute(pool);

	// Categories table (extended with path for Q6)
	await sql`
    CREATE TABLE ${s}.categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES ${s}.categories(id),
      path TEXT NOT NULL DEFAULT '/'
    )
  `.execute(pool);

	// Products table (extended with locale fields and user refs)
	await sql`
    CREATE TABLE ${s}.products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      name_fr TEXT,
      name_en TEXT,
      name_default TEXT,
      description_fr TEXT,
      description_en TEXT,
      category_id INTEGER REFERENCES ${s}.categories(id),
      family_id INTEGER REFERENCES ${s}.families(id),
      active BOOLEAN DEFAULT true,
      is_bundle BOOLEAN DEFAULT false,
      deleted_at TIMESTAMP,
      author_id INTEGER REFERENCES ${s}.users(id),
      reviewer_id INTEGER REFERENCES ${s}.users(id)
    )
  `.execute(pool);

	// Assets table
	await sql`
    CREATE TABLE ${s}.assets (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      size_bytes INTEGER,
      storage_key TEXT NOT NULL,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(pool);

	// Product Images (with role for Q8)
	await sql`
    CREATE TABLE ${s}.product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      asset_id INTEGER NOT NULL REFERENCES ${s}.assets(id),
      locale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_main BOOLEAN DEFAULT false,
      role TEXT DEFAULT 'gallery',
      position INTEGER DEFAULT 0,
      deleted_at TIMESTAMP
    )
  `.execute(pool);

	// Variants
	await sql`
    CREATE TABLE ${s}.variants (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      stock INTEGER DEFAULT 0
    )
  `.execute(pool);

	// Family attributes (Q1 completeness requirements)
	await sql`
    CREATE TABLE ${s}.family_attributes (
      id SERIAL PRIMARY KEY,
      family_id INTEGER NOT NULL REFERENCES ${s}.families(id),
      channel_id INTEGER NOT NULL REFERENCES ${s}.channels(id),
      attribute_name TEXT NOT NULL,
      is_required BOOLEAN DEFAULT true,
      UNIQUE(family_id, channel_id, attribute_name)
    )
  `.execute(pool);

	// Product attributes (Q1 completeness values)
	await sql`
    CREATE TABLE ${s}.product_attributes (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      attribute_name TEXT NOT NULL,
      value TEXT,
      locale TEXT
    )
  `.execute(pool);

	// Bundle components (Q7 BOM)
	await sql`
    CREATE TABLE ${s}.bundle_components (
      id SERIAL PRIMARY KEY,
      bundle_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      component_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      position INTEGER DEFAULT 0,
      UNIQUE(bundle_id, component_id)
    )
  `.execute(pool);

	// Variant images (Q3)
	await sql`
    CREATE TABLE ${s}.variant_images (
      id SERIAL PRIMARY KEY,
      variant_id INTEGER NOT NULL REFERENCES ${s}.variants(id),
      asset_id INTEGER NOT NULL REFERENCES ${s}.assets(id),
      locale TEXT NOT NULL,
      is_main BOOLEAN DEFAULT false,
      position INTEGER DEFAULT 0
    )
  `.execute(pool);

	// Indexes for performance
	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_products_family`)} ON ${s}.products(family_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_products_category`)} ON ${s}.products(category_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_categories_path`)} ON ${s}.categories(path)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_product_images_product_id`)} ON ${s}.product_images(product_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_product_images_lookup`)} ON ${s}.product_images(product_id, locale, is_main, status)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_family_attributes_family`)} ON ${s}.family_attributes(family_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_product_attributes_product`)} ON ${s}.product_attributes(product_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_bundle_components_bundle`)} ON ${s}.bundle_components(bundle_id)
  `.execute(pool);
}

/**
 * Drop the extended PIM/DAM schema.
 */
export async function dropExtendedPimdamSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
