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

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Create the extended PIM/DAM schema tables in a tenant schema.
 */
export async function createExtendedPimdamSchema(
	schemaName: string,
): Promise<void> {
	const db = await getTestDb();

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(db);

	// Users table (for Q8 ambiguity tests)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'member'
    )
  `.execute(db);

	// Families table (for Q1 completeness)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.families (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE
    )
  `.execute(db);

	// Channels table (for Q1 completeness)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.channels (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE
    )
  `.execute(db);

	// Categories table (extended with path for Q6)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id),
      path TEXT NOT NULL DEFAULT '/'
    )
  `.execute(db);

	// Products table (extended with locale fields and user refs)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      name_fr TEXT,
      name_en TEXT,
      name_default TEXT,
      description_fr TEXT,
      description_en TEXT,
      category_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id),
      family_id INTEGER REFERENCES ${sql.ref(schemaName)}.families(id),
      active BOOLEAN DEFAULT true,
      is_bundle BOOLEAN DEFAULT false,
      deleted_at TIMESTAMP,
      author_id INTEGER REFERENCES ${sql.ref(schemaName)}.users(id),
      reviewer_id INTEGER REFERENCES ${sql.ref(schemaName)}.users(id)
    )
  `.execute(db);

	// Assets table
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.assets (
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
  `.execute(db);

	// Product Images (with role for Q8)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      asset_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.assets(id),
      locale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_main BOOLEAN DEFAULT false,
      role TEXT DEFAULT 'gallery',
      position INTEGER DEFAULT 0,
      deleted_at TIMESTAMP
    )
  `.execute(db);

	// Variants
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.variants (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      stock INTEGER DEFAULT 0
    )
  `.execute(db);

	// Family attributes (Q1 completeness requirements)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.family_attributes (
      id SERIAL PRIMARY KEY,
      family_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.families(id),
      channel_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.channels(id),
      attribute_name TEXT NOT NULL,
      is_required BOOLEAN DEFAULT true,
      UNIQUE(family_id, channel_id, attribute_name)
    )
  `.execute(db);

	// Product attributes (Q1 completeness values)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.product_attributes (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      attribute_name TEXT NOT NULL,
      value TEXT,
      locale TEXT
    )
  `.execute(db);

	// Bundle components (Q7 BOM)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.bundle_components (
      id SERIAL PRIMARY KEY,
      bundle_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      component_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      position INTEGER DEFAULT 0,
      UNIQUE(bundle_id, component_id)
    )
  `.execute(db);

	// Variant images (Q3)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.variant_images (
      id SERIAL PRIMARY KEY,
      variant_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.variants(id),
      asset_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.assets(id),
      locale TEXT NOT NULL,
      is_main BOOLEAN DEFAULT false,
      position INTEGER DEFAULT 0
    )
  `.execute(db);

	// Indexes for performance
	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_products_family ON ${sql.ref(schemaName)}.products(family_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_products_category ON ${sql.ref(schemaName)}.products(category_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_categories_path ON ${sql.ref(schemaName)}.categories(path)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_product_images_product_id ON ${sql.ref(schemaName)}.product_images(product_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_product_images_lookup ON ${sql.ref(schemaName)}.product_images(product_id, locale, is_main, status)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_family_attributes_family ON ${sql.ref(schemaName)}.family_attributes(family_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_product_attributes_product ON ${sql.ref(schemaName)}.product_attributes(product_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_bundle_components_bundle ON ${sql.ref(schemaName)}.bundle_components(bundle_id)
  `.execute(db);
}

/**
 * Drop the extended PIM/DAM schema.
 */
export async function dropExtendedPimdamSchema(
	schemaName: string,
): Promise<void> {
	const db = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
