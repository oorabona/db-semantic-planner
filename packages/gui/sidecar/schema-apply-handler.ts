/**
 * Schema Apply Handler — executes UP SQL from schema diff.
 * Runs statements sequentially within a transaction.
 */
import type { Pool } from 'pg';
import { getPool } from './connection-manager.js';

export interface SchemaApplyParams {
	connectionId: string;
	statements: readonly string[];
}

export interface SchemaApplyResult {
	readonly applied: number;
	readonly success: boolean;
	readonly error?: string;
}

export async function handleSchemaApply(
	params: SchemaApplyParams,
	getPoolFn: (connectionId: string) => Pool = getPool,
): Promise<SchemaApplyResult> {
	const { connectionId, statements } = params;

	if (statements.length === 0) {
		return { applied: 0, success: true };
	}

	const pool = getPoolFn(connectionId);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		let applied = 0;
		for (const sql of statements) {
			await client.query(sql);
			applied++;
		}
		await client.query('COMMIT');
		return { applied, success: true };
	} catch (err) {
		await client.query('ROLLBACK').catch(() => {});
		const message = err instanceof Error ? err.message : String(err);
		return { applied: 0, success: false, error: message };
	} finally {
		client.release();
	}
}
