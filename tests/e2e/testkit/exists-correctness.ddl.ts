/**
 * EXISTS-correctness DDL
 *
 * Schema: users → posts → comments
 *   users.author_id is the FK column on posts (non-conventional — "user_id" would
 *   be the convention, so mis-wiring FK columns is detectable).
 *   comments has TWO FK columns: post_id (→ posts) and user_id (→ users), which
 *   enables the cross-source same-name discrimination tests (case 9).
 */

import { getTestPool } from './db.js';
import { sql } from './sql.js';

export async function createExistsCorrectnessSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	const s = sql.ref(schemaName);

	await sql`CREATE SCHEMA IF NOT EXISTS ${s}`.execute(pool);

	await sql`
    CREATE TABLE ${s}.users (
      id   SERIAL PRIMARY KEY,
      name TEXT    NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `.execute(pool);

	// posts.author_id → users.id  (non-conventional; conventional would be user_id)
	await sql`
    CREATE TABLE ${s}.posts (
      id        SERIAL PRIMARY KEY,
      title     TEXT    NOT NULL,
      author_id INTEGER NOT NULL REFERENCES ${s}.users(id),
      published BOOLEAN NOT NULL DEFAULT false
    )
  `.execute(pool);

	// comments has DUAL FKs:
	//   post_id → posts (the post this comment belongs to)
	//   user_id → users (the user who wrote it — direct relationship)
	// This lets us discriminate: user.comments (direct via user_id)
	//                          vs posts.comments (via post_id → posts)
	await sql`
    CREATE TABLE ${s}.comments (
      id      SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES ${s}.posts(id),
      user_id INTEGER NOT NULL REFERENCES ${s}.users(id),
      body    TEXT    NOT NULL,
      flagged BOOLEAN NOT NULL DEFAULT false
    )
  `.execute(pool);
}

export async function dropExistsCorrectnessSchema(
	schemaName: string,
): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}
