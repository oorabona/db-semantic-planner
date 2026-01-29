/**
 * Test Database Utilities
 *
 * Provides Kysely instance factory and schema management for E2E tests.
 * Supports dual-adapter comparison mode via DBSP_COMPARISON_MODE env var.
 *
 * Comparison modes:
 * - Not set / 'kysely': Use KyselyAdapter only (default, backward compatible)
 * - 'pgsql': Use PgsqlAdapter only
 * - 'compare': Run both adapters, log mismatches, use KyselyAdapter results
 * - 'strict': Run both adapters, fail on any mismatch
 */

import { createKyselyAdapter, type KyselyAdapter } from '@dbsp/adapter-kysely';
import {
	createPgsqlAdapter,
	getComparisonMode,
	type PgsqlAdapter,
} from '@dbsp/adapter-pgsql';
import type { Adapter } from '@dbsp/core';
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { describe } from 'vitest';

const { Pool } = pg;

// ============================================================================
// Singleton Instances
// ============================================================================

// Shared Kysely database instance
let db: Kysely<any> | undefined;

// Shared pg Pool instance (for PgsqlAdapter)
let pgPool: pg.Pool | undefined;

// Singleton adapters
let kyselyAdapter: Adapter<any> | undefined;
let pgsqlAdapter: PgsqlAdapter<any> | undefined;

// Default adapter (for backward compatibility with getTestAdapter)
let defaultAdapter: Adapter<any> | undefined;

// ============================================================================
// Database Connection
// ============================================================================

/**
 * Get or create the shared Kysely database instance.
 * Uses PostgreSQL connection from environment variables set by globalSetup.
 */
export async function getTestDb(): Promise<Kysely<any>> {
	if (db) {
		return db;
	}

	const connectionString = process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error('DATABASE_URL not set. Did globalSetup run successfully?');
	}

	db = new Kysely({
		dialect: new PostgresDialect({
			pool: new Pool({
				connectionString,
				max: 10,
			}),
		}),
		plugins: [new CamelCasePlugin()],
	});

	return db;
}

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
 * Get or create the shared KyselyAdapter instance.
 */
export async function getKyselyAdapter(): Promise<Adapter<any>> {
	if (kyselyAdapter) {
		return kyselyAdapter;
	}

	const database = await getTestDb();
	kyselyAdapter = createKyselyAdapter(
		database,
		undefined,
		undefined,
		undefined,
		'camelCase',
	);
	return kyselyAdapter;
}

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
 * Get the default test adapter based on DBSP_COMPARISON_MODE.
 * For backward compatibility with existing tests.
 *
 * - 'kysely' or not set: returns KyselyAdapter
 * - 'pgsql': returns PgsqlAdapter
 * - 'compare' or 'strict': returns KyselyAdapter (comparison handled separately)
 */
export async function getTestAdapter(): Promise<Adapter<any>> {
	if (defaultAdapter) {
		return defaultAdapter;
	}

	const mode = getComparisonMode();

	if (mode === 'pgsql') {
		const adapter = await getPgsqlAdapter();
		defaultAdapter = adapter;
		return adapter;
	}

	// Default to Kysely for backward compatibility
	const adapter = await getKyselyAdapter();
	defaultAdapter = adapter;
	return adapter;
}

/**
 * Get both adapters for comparison mode.
 */
export async function getComparisonAdapters(): Promise<{
	kysely: Adapter<any>;
	pgsql: PgsqlAdapter<any>;
}> {
	const [kysely, pgsql] = await Promise.all([
		getKyselyAdapter(),
		getPgsqlAdapter(),
	]);
	return { kysely, pgsql };
}

/**
 * Create an adapter for a specific schema (for introspection tests).
 * Unlike getTestAdapter(), this creates a new adapter each time with the schema set.
 * Returns KyselyAdapter specifically for use with getSchemaFromDb().
 */
export async function createAdapterForSchema(
	schemaName: string,
): Promise<KyselyAdapter<unknown>> {
	const database = await getTestDb();
	return createKyselyAdapter(
		database,
		schemaName,
		undefined,
		undefined,
		'camelCase',
	);
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
	if (db) {
		await db.destroy();
		db = undefined;
		kyselyAdapter = undefined;
		defaultAdapter = undefined;
	}
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
	const database = await getTestDb();
	await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(schemaName)}`.execute(
		database,
	);
}

/**
 * Drop a tenant schema and all its contents.
 */
export async function dropSchema(schemaName: string): Promise<void> {
	const database = await getTestDb();
	await sql`DROP SCHEMA IF EXISTS ${sql.ref(schemaName)} CASCADE`.execute(
		database,
	);
}

/**
 * Execute raw SQL in a specific schema.
 */
export async function execInSchema(
	schemaName: string,
	sqlStatement: string,
): Promise<void> {
	const database = await getTestDb();
	// Set search_path to the schema and execute
	await sql`SET search_path TO ${sql.ref(schemaName)}`.execute(database);
	await sql.raw(sqlStatement).execute(database);
	await sql`SET search_path TO public`.execute(database);
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

/**
 * Check if comparison mode is enabled.
 */
export function isComparisonModeEnabled(): boolean {
	const mode = getComparisonMode();
	return mode === 'compare' || mode === 'strict';
}

/**
 * Check if strict comparison mode (fail on mismatch).
 */
export function isStrictComparisonMode(): boolean {
	return getComparisonMode() === 'strict';
}
