/**
 * CLI-020: Database Connection Manager
 *
 * Manages PostgreSQL connection for REPL execution mode.
 */

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

const { Pool } = pg;

/** Maximum rows to return from a query */
const MAX_ROWS = 100;

export interface DbConnection {
	/** Execute a raw SQL query */
	executeRaw(
		query: string,
		params?: readonly unknown[],
	): Promise<ExecutionResult>;
	/** Test the connection */
	ping(): Promise<boolean>;
	/** Close the connection */
	close(): Promise<void>;
	/** Get the underlying Kysely instance */
	getKysely(): Kysely<Record<string, unknown>>;
}

export interface ExecutionResult {
	rows: Record<string, unknown>[];
	columns: string[];
	rowCount: number;
	executionTimeMs: number;
	error?: string;
	truncated?: boolean;
}

/**
 * Create a database connection from a PostgreSQL URL.
 *
 * @param connectionString - PostgreSQL connection URL (e.g., postgres://localhost/mydb)
 * @returns Database connection instance
 * @throws Error if connection fails
 */
export async function createDbConnection(
	connectionString: string,
): Promise<DbConnection> {
	// Validate connection string format
	if (
		!connectionString.startsWith('postgres://') &&
		!connectionString.startsWith('postgresql://')
	) {
		throw new Error(
			`Invalid connection URL: must start with postgres:// or postgresql://`,
		);
	}

	// Create pg Pool
	const pool = new Pool({
		connectionString,
		max: 1, // Single connection for REPL
		connectionTimeoutMillis: 10000,
		idleTimeoutMillis: 30000,
	});

	// Create Kysely instance
	const db = new Kysely<Record<string, unknown>>({
		dialect: new PostgresDialect({ pool }),
	});

	// Test connection
	try {
		await sql`SELECT 1`.execute(db);
	} catch (error) {
		await pool.end();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to connect to database: ${message}`);
	}

	return {
		async executeRaw(
			query: string,
			params: readonly unknown[] = [],
		): Promise<ExecutionResult> {
			const startTime = performance.now();

			try {
				// For parameterized queries, use the pool directly
				if (params.length > 0) {
					const poolResult = await pool.query(query, [...params]);
					const endTime = performance.now();
					const executionTimeMs = Math.round(endTime - startTime);

					const rows = poolResult.rows as Record<string, unknown>[];
					const columns = poolResult.fields?.map((f) => f.name) ?? [];
					const truncated = rows.length > MAX_ROWS;
					const limitedRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

					return {
						rows: limitedRows,
						columns,
						rowCount: rows.length,
						executionTimeMs,
						truncated,
					};
				}

				// No params - use sql.raw
				const result = await sql
					.raw<Record<string, unknown>>(query)
					.execute(db);

				const endTime = performance.now();
				const executionTimeMs = Math.round(endTime - startTime);

				// Get column names from first row or empty array
				const rows = result.rows as Record<string, unknown>[];
				const columns = rows.length > 0 && rows[0] ? Object.keys(rows[0]) : [];

				// Truncate if needed
				const truncated = rows.length > MAX_ROWS;
				const limitedRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

				return {
					rows: limitedRows,
					columns,
					rowCount: rows.length,
					executionTimeMs,
					truncated,
				};
			} catch (error) {
				const endTime = performance.now();
				const executionTimeMs = Math.round(endTime - startTime);
				const message = error instanceof Error ? error.message : String(error);

				return {
					rows: [],
					columns: [],
					rowCount: 0,
					executionTimeMs,
					error: message,
				};
			}
		},

		async ping(): Promise<boolean> {
			try {
				await sql`SELECT 1`.execute(db);
				return true;
			} catch {
				return false;
			}
		},

		async close(): Promise<void> {
			await db.destroy();
		},

		getKysely(): Kysely<Record<string, unknown>> {
			return db;
		},
	};
}

/**
 * Extract database name from connection URL for display.
 */
export function getDatabaseName(connectionString: string): string {
	try {
		const url = new URL(connectionString);
		// Remove leading slash from pathname
		return url.pathname.slice(1) || url.hostname;
	} catch {
		return 'database';
	}
}
