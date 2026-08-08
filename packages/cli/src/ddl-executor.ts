/**
 * DDL Executor — Transaction-wrapped DDL execution.
 *
 * Test and caller-owned DDL helper. Executes an array of SQL statements inside
 * a single transaction; it is not a managed CLI execution path.
 */

import type { Pool, PoolClient } from 'pg';

// ============================================================================
// Types
// ============================================================================

export interface DdlExecutionResult {
	/** Number of statements executed */
	statementsExecuted: number;
	/** Whether execution was a dry-run (no actual changes) */
	dryRun: boolean;
}

// ============================================================================
// Executor
// ============================================================================

/**
 * Execute DDL statements in a transaction.
 *
 * @param pool - pg Pool instance
 * @param statements - SQL statements to execute
 * @param options - Execution options
 * @returns Execution result
 */
export async function executeDdl(
	pool: Pool,
	statements: readonly string[],
	options?: { dryRun?: boolean },
): Promise<DdlExecutionResult> {
	if (statements.length === 0) {
		return { statementsExecuted: 0, dryRun: options?.dryRun ?? false };
	}

	if (options?.dryRun) {
		return { statementsExecuted: statements.length, dryRun: true };
	}

	let client: PoolClient | undefined;
	try {
		client = await pool.connect();
		await client.query('BEGIN');

		for (const stmt of statements) {
			await client.query(stmt);
		}

		await client.query('COMMIT');
		return { statementsExecuted: statements.length, dryRun: false };
	} catch (error) {
		if (client) {
			await client.query('ROLLBACK');
		}
		throw error;
	} finally {
		if (client) {
			client.release();
		}
	}
}
