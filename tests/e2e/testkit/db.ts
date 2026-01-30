/**
 * Test Database Utilities
 *
 * Provides pg Pool and PgsqlAdapter for E2E tests.
 */

import { createPgsqlAdapter, type PgsqlAdapter } from '@dbsp/adapter-pgsql';
import type { Adapter } from '@dbsp/core';
import pg from 'pg';
import { describe } from 'vitest';
import { sql } from './sql.js';

const { Pool } = pg;

// ============================================================================
// Singleton Instances
// ============================================================================

// Shared pg Pool instance
let pgPool: pg.Pool | undefined;

// Singleton adapter
let pgsqlAdapter: PgsqlAdapter<any> | undefined;

// ============================================================================
// Database Connection
// ============================================================================

/**
 * Get or create the shared pg Pool instance.
 */
export async function getTestPool(): Promise<pg.Pool> {
	if (pgPool) {
		return pgPool;
	}

	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error('DATABASE_URL not set. Did globalSetup run successfully?');
	}

	pgPool = new Pool({
		connectionString,
		max: 10,
	});

	return pgPool;
}

// ============================================================================
// Adapter Factories
// ============================================================================

/**
 * Get or create the shared PgsqlAdapter instance.
 */
export async function getPgsqlAdapter(): Promise<PgsqlAdapter<any>> {
	if (pgsqlAdapter) {
		return pgsqlAdapter;
	}

	const pool = await getTestPool();
	pgsqlAdapter = createPgsqlAdapter(pool, {
		namingConvention: 'camelCase',
	});
	return pgsqlAdapter;
}

/**
 * Get the default test adapter.
 * Returns PgsqlAdapter (sole adapter).
 */
export async function getTestAdapter(): Promise<Adapter<any>> {
	return getPgsqlAdapter();
}

/**
 * Create a PgsqlAdapter for a specific schema.
 */
export async function createPgsqlAdapterForSchema(
	schemaName: string,
): Promise<PgsqlAdapter<unknown>> {
	const pool = await getTestPool();
	return createPgsqlAdapter(pool, {
		schemaName,
		namingConvention: 'camelCase',
	});
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Close the database connection.
 * Called in test teardown.
 */
export async function closeTestDb(): Promise<void> {
	if (pgPool) {
		await pgPool.end();
		pgPool = undefined;
		pgsqlAdapter = undefined;
	}
}

// ============================================================================
// Schema Management
// ============================================================================

/**
 * Create a tenant schema if it doesn't exist.
 */
export async function createSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(pool);
}

/**
 * Drop a tenant schema and all its contents.
 */
export async function dropSchema(schemaName: string): Promise<void> {
	const pool = await getTestPool();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(pool);
}

/**
 * Execute raw SQL in a specific schema.
 */
export async function execInSchema(
	schemaName: string,
	sqlStatement: string,
): Promise<void> {
	const pool = await getTestPool();
	await sql`SET search_path TO ${sql.ref(schemaName)}`.execute(pool);
	await pool.query(sqlStatement);
	await sql`SET search_path TO public`.execute(pool);
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Check if Docker/E2E tests should be skipped.
 * Skips if SKIP_E2E_TESTS=true OR if DATABASE_URL is not set.
 */
export function shouldSkipE2E(): boolean {
	if (process.env.SKIP_E2E_TESTS === 'true') return true;
	if (!process.env.DATABASE_URL) return true;
	return false;
}

/**
 * Skip test helper for use in describe blocks.
 */
export function describeE2E(
	name: string,
	fn: () => void,
): ReturnType<typeof describe> | undefined {
	if (shouldSkipE2E()) {
		return describe.skip(name, fn);
	}
	return describe(name, fn);
}
