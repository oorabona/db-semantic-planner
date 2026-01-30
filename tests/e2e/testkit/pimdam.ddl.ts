/**
 * PIM/DAM Schema DDL
 *
 * Product Information Management / Digital Asset Management schema
 * for E2E testing.
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Create the PIM/DAM schema tables in a tenant schema.
 */
export async function createPimdamSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	// Categories table (self-referential for hierarchy)
	await sql`
    CREATE TABLE ${s}.categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES ${s}.categories(id)
    )
  `.execute(pool);

	// Products table
	await sql`
    CREATE TABLE ${s}.products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category_id INTEGER REFERENCES ${s}.categories(id),
      active BOOLEAN DEFAULT true,
      deleted_at TIMESTAMP
    )
  `.execute(pool);

	// Assets table (DAM)
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

	// Product Images (junction with metadata)
	await sql`
    CREATE TABLE ${s}.product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${s}.products(id),
      asset_id INTEGER NOT NULL REFERENCES ${s}.assets(id),
      locale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_main BOOLEAN DEFAULT false,
      position INTEGER DEFAULT 0,
      deleted_at TIMESTAMP
    )
  `.execute(pool);

	// Product Variants
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

	// Indexes for performance
	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_product_images_product_id`)}
    ON ${s}.product_images(product_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_product_images_lookup`)}
    ON ${s}.product_images(product_id, locale, is_main, status)
  `.execute(pool);
}

/**
 * Drop the PIM/DAM schema.
 */
export async function dropPimdamSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
