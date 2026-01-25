/**
 * Test Database Utilities
 *
 * Provides Kysely instance factory and schema management for E2E tests.
 */

import { type Adapter, createKyselyAdapter } from '@dbsp/adapter-kysely';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const { Pool } = pg;

// Singleton adapter instance
let adapter: Adapter<any> | undefined;

// Singleton Kysely instance
let db: Kysely<any> | undefined;

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
	});

	return db;
}

/**
 * Get or create the shared Kysely adapter instance.
 * Uses the same connection as getTestDb().
 */
export async function getTestAdapter(): Promise<Adapter<any>> {
	if (adapter) {
		return adapter;
	}

	const database = await getTestDb();
	adapter = createKyselyAdapter(database);
	return adapter;
}

/**
 * Create an adapter for a specific schema (for introspection tests).
 * Unlike getTestAdapter(), this creates a new adapter each time with the schema set.
 */
export async function createAdapterForSchema(
	schemaName: string,
): Promise<Adapter<any>> {
	const database = await getTestDb();
	return createKyselyAdapter(database, schemaName);
}

/**
 * Close the database connection.
 * Called in test teardown.
 */
export async function closeTestDb(): Promise<void> {
	if (db) {
		await db.destroy();
		db = undefined;
		adapter = undefined;
	}
}

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
