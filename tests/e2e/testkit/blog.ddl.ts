/**
 * Blog Schema DDL
 *
 * Simple blog schema for basic E2E validation.
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

/**
 * Create the Blog schema tables in a tenant schema.
 */
export async function createBlogSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	// Authors table
	await sql`
    CREATE TABLE ${s}.authors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `.execute(pool);

	// Posts table
	await sql`
    CREATE TABLE ${s}.posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      author_id INTEGER NOT NULL REFERENCES ${s}.authors(id),
      published BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(pool);

	// Comments table
	await sql`
    CREATE TABLE ${s}.comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES ${s}.posts(id),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(pool);

	// Indexes
	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_posts_author`)}
    ON ${s}.posts(author_id)
  `.execute(pool);

	await sql`
    CREATE INDEX ${sql.ref(`idx_${schemaName}_comments_post`)}
    ON ${s}.comments(post_id)
  `.execute(pool);
}

/**
 * Drop the Blog schema.
 */
export async function dropBlogSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
