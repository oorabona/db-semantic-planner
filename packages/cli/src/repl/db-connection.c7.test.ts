/**
 * Regression tests for db-connection.ts — Commit 7 fixes.
 *
 * SC-7: commitTransaction / rollbackTransaction use shared runTransactionControl.
 *       Both should: call the right SQL, release client, clear txClient.
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Per-test mock helpers (avoids hoisting / shared-state issues)
// ---------------------------------------------------------------------------

/**
 * Build a fresh isolated pg mock and inject it via a module-local override.
 * We avoid vi.mock() hoisting because the module-level vi.fn() values are
 * referenced before they are initialized in vitest's hoist pass.
 */
function makePgMock() {
	const release = vi.fn();
	const clientQuery = vi.fn().mockResolvedValue({ rows: [], fields: [] });
	const poolQuery = vi.fn().mockResolvedValue({ rows: [], fields: [] });
	const poolEnd = vi.fn().mockResolvedValue(undefined);
	const connect = vi.fn().mockResolvedValue({
		query: clientQuery,
		release,
	});

	class MockPool {
		query = poolQuery;
		connect = connect;
		end = poolEnd;
	}

	return { release, clientQuery, poolQuery, poolEnd, connect, MockPool };
}

describe('DbConnection — runTransactionControl (SC-7)', () => {
	/**
	 * Build a DbConnection against an in-memory mock pool.
	 * Returns both the connection and the mock handles.
	 */
	async function makeConnection() {
		const mocks = makePgMock();

		// Inline module mock scoped to this call
		vi.doMock('pg', () => ({
			default: { Pool: mocks.MockPool },
		}));

		// Reset module registry so the fresh mock is used
		const { createDbConnection } = await import('./db-connection.js');
		vi.doUnmock('pg');
		vi.resetModules();

		const conn = await createDbConnection('postgres://localhost/test');
		return { conn, mocks };
	}

	it('commitTransaction issues COMMIT and releases client', async () => {
		const { conn, mocks } = await makeConnection();
		await conn.beginTransaction();
		await conn.commitTransaction();
		expect(mocks.clientQuery).toHaveBeenCalledWith('BEGIN');
		expect(mocks.clientQuery).toHaveBeenCalledWith('COMMIT');
		expect(mocks.release).toHaveBeenCalledTimes(1);
		expect(conn.inTransaction).toBe(false);
	});

	it('rollbackTransaction issues ROLLBACK and releases client', async () => {
		const { conn, mocks } = await makeConnection();
		await conn.beginTransaction();
		await conn.rollbackTransaction();
		expect(mocks.clientQuery).toHaveBeenCalledWith('BEGIN');
		expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK');
		expect(mocks.release).toHaveBeenCalledTimes(1);
		expect(conn.inTransaction).toBe(false);
	});

	it('commitTransaction throws when no active transaction', async () => {
		const { conn } = await makeConnection();
		await expect(conn.commitTransaction()).rejects.toThrow(
			'No active transaction',
		);
	});

	it('rollbackTransaction throws when no active transaction', async () => {
		const { conn } = await makeConnection();
		await expect(conn.rollbackTransaction()).rejects.toThrow(
			'No active transaction',
		);
	});

	it('client is released even if COMMIT throws (finally path)', async () => {
		const { conn, mocks } = await makeConnection();
		await conn.beginTransaction();

		// Now override clientQuery: COMMIT call should reject
		mocks.clientQuery.mockRejectedValueOnce(new Error('commit error'));

		await expect(conn.commitTransaction()).rejects.toThrow('commit error');
		// release must still have been called via finally
		expect(mocks.release).toHaveBeenCalled();
		expect(conn.inTransaction).toBe(false);
	});

	it('client is released even if ROLLBACK throws (finally path)', async () => {
		const { conn, mocks } = await makeConnection();
		await conn.beginTransaction();

		mocks.clientQuery.mockRejectedValueOnce(new Error('rollback error'));

		await expect(conn.rollbackTransaction()).rejects.toThrow('rollback error');
		expect(mocks.release).toHaveBeenCalled();
		expect(conn.inTransaction).toBe(false);
	});
});
