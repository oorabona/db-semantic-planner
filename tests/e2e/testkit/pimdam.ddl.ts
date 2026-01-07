/**
 * PIM/DAM Schema DDL
 *
 * Product Information Management / Digital Asset Management schema
 * for E2E testing.
 */

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Create the PIM/DAM schema tables in a tenant schema.
 */
export async function createPimdamSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(db);

	// Categories table (self-referential for hierarchy)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id)
    )
  `.execute(db);

	// Products table
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      category_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id),
      active BOOLEAN DEFAULT true,
      deleted_at TIMESTAMP
    )
  `.execute(db);

	// Assets table (DAM)
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

	// Product Images (junction with metadata)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.product_images (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.products(id),
      asset_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.assets(id),
      locale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_main BOOLEAN DEFAULT false,
      position INTEGER DEFAULT 0,
      deleted_at TIMESTAMP
    )
  `.execute(db);

	// Product Variants
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

	// Indexes for performance
	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_product_images_product_id
    ON ${sql.ref(schemaName)}.product_images(product_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_product_images_lookup
    ON ${sql.ref(schemaName)}.product_images(product_id, locale, is_main, status)
  `.execute(db);
}

/**
 * Drop the PIM/DAM schema.
 */
export async function dropPimdamSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
