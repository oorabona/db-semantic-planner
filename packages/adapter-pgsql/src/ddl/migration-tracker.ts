/**
 * Migration Tracker — `_dbsp_migrations` table CRUD.
 *
 * Manages the tracking table that records which migrations
 * have been applied to a database.
 */

import type { Pool, PoolClient } from 'pg';

// ============================================================================
// Types
// ============================================================================

export interface MigrationRecord {
	/** Migration filename (e.g., "0001_create_users.sql") */
	readonly name: string;
	/** SHA-256 checksum of the migration file content */
	readonly checksum: string;
	/** When the migration was applied */
	readonly appliedAt: Date;
	/** Schema version at time of this migration */
	readonly schemaVersion: number;
	/** Whether this migration contains destructive changes */
	readonly destructive: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const MIGRATIONS_TABLE = '_dbsp_migrations';

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
  "id" serial PRIMARY KEY,
  "name" varchar(255) NOT NULL UNIQUE,
  "checksum" varchar(64) NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  "schema_version" integer NOT NULL DEFAULT 0,
  "destructive" boolean NOT NULL DEFAULT false
)`;

// ============================================================================
// Advisory Lock
// ============================================================================

/**
 * Acquire a session-level advisory lock for migration operations.
 *
 * @deprecated Use {@link withMigrationLock} instead — pool.query may release
 * the connection (and the lock) before the migration completes.
 */
export async function acquireMigrationLock(pool: Pool): Promise<void> {
	await pool.query(`SELECT pg_advisory_lock(hashtext('dbsp_migrate'))`);
}

/**
 * Release the session-level advisory lock for migration operations.
 *
 * @deprecated Use {@link withMigrationLock} instead.
 */
export async function releaseMigrationLock(pool: Pool): Promise<void> {
	await pool.query(`SELECT pg_advisory_unlock(hashtext('dbsp_migrate'))`);
}

/**
 * Execute a callback under an advisory lock using a dedicated client.
 * The lock is held for the duration of the callback.
 * The client is released (and lock freed) after the callback completes.
 */
export async function withMigrationLock<T>(
	pool: Pool,
	fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query(`SELECT pg_advisory_lock(hashtext('dbsp_migrate'))`);
		return await fn(client);
	} finally {
		await client
			.query(`SELECT pg_advisory_unlock(hashtext('dbsp_migrate'))`)
			.catch(() => {
				/* unlock failure is non-fatal — lock freed on client.release() */
			});
		client.release();
	}
}

// ============================================================================
// Table Management
// ============================================================================

/**
 * Ensure the migrations tracking table exists.
 * Auto-migrates existing tables that lack `schema_version`/`destructive` columns,
 * and backfills `schema_version` by `applied_at` order for rows still at 0.
 */
export async function ensureMigrationsTable(pool: Pool): Promise<void> {
	await pool.query(CREATE_TABLE_SQL);

	// Auto-migrate: add schema_version column if missing
	await pool.query(`
    ALTER TABLE "${MIGRATIONS_TABLE}"
    ADD COLUMN IF NOT EXISTS "schema_version" integer NOT NULL DEFAULT 0
  `);

	// Auto-migrate: add destructive column if missing
	await pool.query(`
    ALTER TABLE "${MIGRATIONS_TABLE}"
    ADD COLUMN IF NOT EXISTS "destructive" boolean NOT NULL DEFAULT false
  `);

	// Backfill schema_version for existing rows that still have default 0.
	// Uses ROW_NUMBER() OVER (ORDER BY applied_at) to assign sequential versions.
	await pool.query(`
    UPDATE "${MIGRATIONS_TABLE}"
    SET "schema_version" = sub.rn
    FROM (
      SELECT "id", ROW_NUMBER() OVER (ORDER BY "applied_at") AS rn
      FROM "${MIGRATIONS_TABLE}"
      WHERE "schema_version" = 0
    ) sub
    WHERE "${MIGRATIONS_TABLE}"."id" = sub."id"
  `);
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Get all applied migrations, ordered by name.
 */
export async function getAppliedMigrations(
	pool: Pool,
): Promise<readonly MigrationRecord[]> {
	const result = await pool.query<{
		name: string;
		checksum: string;
		applied_at: Date;
		schema_version: number;
		destructive: boolean;
	}>(
		`SELECT "name", "checksum", "applied_at", "schema_version", "destructive" FROM "${MIGRATIONS_TABLE}" ORDER BY "name"`,
	);

	return result.rows.map((row) => ({
		name: row.name,
		checksum: row.checksum,
		appliedAt: row.applied_at,
		schemaVersion: row.schema_version,
		destructive: row.destructive,
	}));
}

/**
 * Record a migration as applied.
 */
export async function recordMigration(
	pool: Pool,
	name: string,
	checksum: string,
	schemaVersion: number,
	destructive: boolean,
): Promise<void> {
	await pool.query(
		`INSERT INTO "${MIGRATIONS_TABLE}" ("name", "checksum", "schema_version", "destructive") VALUES ($1, $2, $3, $4)`,
		[name, checksum, schemaVersion, destructive],
	);
}

/**
 * Check if a specific migration has been applied.
 */
export async function isMigrationApplied(
	pool: Pool,
	name: string,
): Promise<boolean> {
	const result = await pool.query<{ count: string }>(
		`SELECT count(*) as count FROM "${MIGRATIONS_TABLE}" WHERE "name" = $1`,
		[name],
	);
	const row = result.rows[0];
	return row !== undefined && Number.parseInt(row.count, 10) > 0;
}

/**
 * Get the next schema version number (max + 1, or 1 if no migrations).
 */
export async function getNextSchemaVersion(pool: Pool): Promise<number> {
	const result = await pool.query<{ max_version: number | null }>(
		`SELECT MAX("schema_version") as max_version FROM "${MIGRATIONS_TABLE}"`,
	);
	const maxVersion = result.rows[0]?.max_version ?? 0;
	return maxVersion + 1;
}

/**
 * Remove a migration record (for rollback).
 */
export async function removeMigrationRecord(
	pool: Pool,
	name: string,
): Promise<void> {
	await pool.query(`DELETE FROM "${MIGRATIONS_TABLE}" WHERE "name" = $1`, [
		name,
	]);
}
