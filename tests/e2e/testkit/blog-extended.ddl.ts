/**
 * Extended Blog DDL - Schema creation/drop for complex testing
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function createBlogExtendedSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	// Authors
	await sql`
    CREATE TABLE ${s}.authors (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(200) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `.execute(pool);

	// Categories (self-referential)
	await sql`
    CREATE TABLE ${s}.categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      parent_id INTEGER REFERENCES ${s}.categories(id)
    )
  `.execute(pool);

	// Posts
	await sql`
    CREATE TABLE ${s}.posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES ${s}.authors(id),
      category_id INTEGER REFERENCES ${s}.categories(id),
      published BOOLEAN NOT NULL DEFAULT false,
      featured BOOLEAN NOT NULL DEFAULT false,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `.execute(pool);

	// Comments
	await sql`
    CREATE TABLE ${s}.comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES ${s}.posts(id),
      author_name VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      approved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `.execute(pool);

	// Tags
	await sql`
    CREATE TABLE ${s}.tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      slug VARCHAR(50) NOT NULL UNIQUE
    )
  `.execute(pool);

	// Junction: post_tags (M:N)
	await sql`
    CREATE TABLE ${s}.post_tags (
      post_id INTEGER NOT NULL REFERENCES ${s}.posts(id),
      tag_id INTEGER NOT NULL REFERENCES ${s}.tags(id),
      PRIMARY KEY (post_id, tag_id)
    )
  `.execute(pool);
}

export async function dropBlogExtendedSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
