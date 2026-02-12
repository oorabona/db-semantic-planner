/**
 * Migration Tracker — `_dbsp_migrations` table CRUD.
 *
 * Manages the tracking table that records which migrations
 * have been applied to a database.
 */

import type { Pool } from 'pg';

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
  "applied_at" timestamptz NOT NULL DEFAULT now()
)`;

// ============================================================================
// Advisory Lock
// ============================================================================

/**
 * Acquire a session-level advisory lock for migration operations.
 * Must be called on a single client connection (not pool).
 *
 * Uses `pg_advisory_lock(hashtext('dbsp_migrate'))` — session-level,
 * released when the connection is closed.
 */
export async function acquireMigrationLock(pool: Pool): Promise<void> {
	await pool.query(`SELECT pg_advisory_lock(hashtext('dbsp_migrate'))`);
}

/**
 * Release the session-level advisory lock for migration operations.
 */
export async function releaseMigrationLock(pool: Pool): Promise<void> {
	await pool.query(`SELECT pg_advisory_unlock(hashtext('dbsp_migrate'))`);
}

// ============================================================================
// Table Management
// ============================================================================

/**
 * Ensure the migrations tracking table exists.
 */
export async function ensureMigrationsTable(pool: Pool): Promise<void> {
	await pool.query(CREATE_TABLE_SQL);
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
	}>(
		`SELECT "name", "checksum", "applied_at" FROM "${MIGRATIONS_TABLE}" ORDER BY "name"`,
	);

	return result.rows.map((row) => ({
		name: row.name,
		checksum: row.checksum,
		appliedAt: row.applied_at,
	}));
}

/**
 * Record a migration as applied.
 */
export async function recordMigration(
	pool: Pool,
	name: string,
	checksum: string,
): Promise<void> {
	await pool.query(
		`INSERT INTO "${MIGRATIONS_TABLE}" ("name", "checksum") VALUES ($1, $2)`,
		[name, checksum],
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
