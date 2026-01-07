/**
 * Blog Schema DDL
 *
 * Simple blog schema for basic E2E validation.
 */

import { sql } from 'kysely';
import { getTestDb } from './db.js';

/**
 * Create the Blog schema tables in a tenant schema.
 */
export async function createBlogSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();

	// Create schema
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(db);

	// Authors table
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.authors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    )
  `.execute(db);

	// Posts table
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      author_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.authors(id),
      published BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(db);

	// Comments table
	await sql`
    CREATE TABLE ${sql.ref(schemaName)}.comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES ${sql.ref(schemaName)}.posts(id),
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `.execute(db);

	// Indexes
	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_posts_author
    ON ${sql.ref(schemaName)}.posts(author_id)
  `.execute(db);

	await sql`
    CREATE INDEX idx_${sql.raw(schemaName)}_comments_post
    ON ${sql.ref(schemaName)}.comments(post_id)
  `.execute(db);
}

/**
 * Drop the Blog schema.
 */
export async function dropBlogSchema(schemaName: string): Promise<void> {
	const db = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(db);
}
