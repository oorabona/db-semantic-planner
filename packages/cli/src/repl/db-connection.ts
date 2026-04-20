/**
 * CLI-020: Database Connection Manager
 *
 * Manages PostgreSQL connection for REPL execution mode.
 */

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
	/** Get the underlying pg Pool */
	getPool(): pg.Pool;
	/** Start a transaction (acquires dedicated client, sends BEGIN) */
	beginTransaction(): Promise<void>;
	/** Commit the active transaction and release the client */
	commitTransaction(): Promise<void>;
	/** Rollback the active transaction and release the client */
	rollbackTransaction(): Promise<void>;
	/** Whether a transaction is currently active */
	readonly inTransaction: boolean;
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

	// Test connection
	try {
		await pool.query('SELECT 1');
	} catch (error) {
		await pool.end();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to connect to database: ${message}`);
	}

	// Transaction state: dedicated client held for the duration of .begin → .commit/.rollback
	let txClient: pg.PoolClient | null = null;

	/**
	 * Execute COMMIT or ROLLBACK on the active transaction client, then release it.
	 * Extracted to avoid structural clone between commitTransaction and rollbackTransaction (SC-7).
	 */
	async function runTransactionControl(
		sql: 'COMMIT' | 'ROLLBACK',
	): Promise<void> {
		if (!txClient) {
			throw new Error('No active transaction. Use .begin first.');
		}
		try {
			await txClient.query(sql);
		} finally {
			txClient.release();
			txClient = null;
		}
	}

	/**
	 * Execute a query on the active target (transaction client or pool).
	 */
	async function executeRaw(
		query: string,
		params: readonly unknown[] = [],
	): Promise<ExecutionResult> {
		const startTime = performance.now();
		const target = txClient ?? pool;

		try {
			const poolResult = await target.query(query, [...params]);
			const endTime = performance.now();
			const executionTimeMs = Math.round(endTime - startTime);

			const rows = (poolResult.rows ?? []) as Record<string, unknown>[];
			const columns = poolResult.fields?.map((f) => f.name) ?? [];
			const rowCount = poolResult.rowCount ?? rows?.length ?? 0;
			const truncated = rows.length > MAX_ROWS;
			const limitedRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

			return {
				rows: limitedRows,
				columns,
				rowCount,
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
	}

	return {
		executeRaw,

		async ping(): Promise<boolean> {
			try {
				await pool.query('SELECT 1');
				return true;
			} catch {
				return false;
			}
		},

		async close(): Promise<void> {
			if (txClient) {
				try {
					await txClient.query('ROLLBACK');
				} catch {
					// Best-effort rollback on close
				}
				txClient.release();
				txClient = null;
			}
			await pool.end();
		},

		getPool(): pg.Pool {
			return pool;
		},

		async beginTransaction(): Promise<void> {
			if (txClient) {
				throw new Error(
					'Transaction already active. Use .commit or .rollback first.',
				);
			}
			txClient = await pool.connect();
			await txClient.query('BEGIN');
		},

		async commitTransaction(): Promise<void> {
			return runTransactionControl('COMMIT');
		},

		async rollbackTransaction(): Promise<void> {
			return runTransactionControl('ROLLBACK');
		},

		get inTransaction(): boolean {
			return txClient !== null;
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
