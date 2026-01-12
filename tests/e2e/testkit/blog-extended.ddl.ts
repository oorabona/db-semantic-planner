/**
 * Extended Blog DDL - Schema creation/drop for complex testing
 */

import { sql } from 'kysely';
import { getTestDb } from './db.js';

export async function createBlogExtendedSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();

	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(db);

	// Authors
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.authors (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(200) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `.execute(db);

	// Categories (self-referential)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      parent_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id)
    )
  `.execute(db);

	// Posts
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.posts (
      id SERIAL PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      content TEXT NOT NULL,
      author_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.authors(id),
      category_id INTEGER REFERENCES ${sql.ref(schemaName)}.categories(id),
      published BOOLEAN NOT NULL DEFAULT false,
      featured BOOLEAN NOT NULL DEFAULT false,
      view_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `.execute(db);

	// Comments
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.posts(id),
      author_name VARCHAR(100) NOT NULL,
      content TEXT NOT NULL,
      approved BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `.execute(db);

	// Tags
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.tags (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      slug VARCHAR(50) NOT NULL UNIQUE
    )
  `.execute(db);

	// Junction: post_tags (M:N)
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.post_tags (
      post_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.posts(id),
      tag_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.tags(id),
      PRIMARY KEY (post_id, tag_id)
    )
  `.execute(db);
}

export async function dropBlogExtendedSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
