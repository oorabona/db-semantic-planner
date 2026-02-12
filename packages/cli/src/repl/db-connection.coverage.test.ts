// @ts-nocheck — coverage test: runtime assertions
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock pg before importing the module under test
const mockQuery = vi.fn();
const mockEnd = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();
const mockClientQuery = vi.fn();

vi.mock('pg', () => {
	class MockPool {
		query = mockQuery;
		end = mockEnd;
		connect = mockConnect;
	}
	return { default: { Pool: MockPool } };
});

import { createDbConnection, getDatabaseName } from './db-connection.js';

beforeEach(() => {
	vi.clearAllMocks();
	// Default: initial connection test passes
	mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
	mockEnd.mockResolvedValue(undefined);
	mockConnect.mockResolvedValue({
		query: mockClientQuery,
		release: mockRelease,
	});
	mockClientQuery.mockResolvedValue({ rows: [] });
	mockRelease.mockReturnValue(undefined);
});

describe('createDbConnection', () => {
	describe('validation', () => {
		it('rejects non-postgres URL', async () => {
			await expect(
				createDbConnection('mysql://localhost/db'),
			).rejects.toThrow('Invalid connection URL');
		});

		it('rejects arbitrary string', async () => {
			await expect(createDbConnection('not-a-url')).rejects.toThrow(
				'Invalid connection URL',
			);
		});

		it('accepts postgres:// URL', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			expect(conn).toBeDefined();
			expect(conn.inTransaction).toBe(false);
		});

		it('accepts postgresql:// URL', async () => {
			const conn = await createDbConnection(
				'postgresql://localhost/testdb',
			);
			expect(conn).toBeDefined();
		});
	});

	describe('connection failure', () => {
		it('throws and closes pool on initial connection failure', async () => {
			mockQuery.mockRejectedValueOnce(new Error('ECONNREFUSED'));
			await expect(
				createDbConnection('postgres://localhost/db'),
			).rejects.toThrow('Failed to connect to database: ECONNREFUSED');
			expect(mockEnd).toHaveBeenCalled();
		});

		it('handles non-Error throw on initial connection', async () => {
			mockQuery.mockRejectedValueOnce('string error');
			await expect(
				createDbConnection('postgres://localhost/db'),
			).rejects.toThrow('Failed to connect to database: string error');
		});
	});

	describe('executeRaw', () => {
		it('returns rows, columns, rowCount on success', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [{ id: 1, name: 'Alice' }],
				fields: [{ name: 'id' }, { name: 'name' }],
				rowCount: 1,
			});

			const result = await conn.executeRaw('SELECT * FROM users');
			expect(result.rows).toEqual([{ id: 1, name: 'Alice' }]);
			expect(result.columns).toEqual(['id', 'name']);
			expect(result.rowCount).toBe(1);
			expect(result.error).toBeUndefined();
			expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
		});

		it('returns error on query failure', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockRejectedValueOnce(new Error('syntax error'));

			const result = await conn.executeRaw('INVALID SQL');
			expect(result.error).toBe('syntax error');
			expect(result.rows).toEqual([]);
			expect(result.columns).toEqual([]);
			expect(result.rowCount).toBe(0);
		});

		it('handles non-Error throw in executeRaw', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockRejectedValueOnce('raw string error');

			const result = await conn.executeRaw('SELECT 1');
			expect(result.error).toBe('raw string error');
		});

		it('truncates when rows exceed MAX_ROWS (100)', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			const manyRows = Array.from({ length: 150 }, (_, i) => ({
				id: i,
			}));
			mockQuery.mockResolvedValueOnce({
				rows: manyRows,
				fields: [{ name: 'id' }],
				rowCount: 150,
			});

			const result = await conn.executeRaw('SELECT * FROM big_table');
			expect(result.truncated).toBe(true);
			expect(result.rows).toHaveLength(100);
		});

		it('does not truncate when rows <= MAX_ROWS', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [{ id: 1 }],
				fields: [{ name: 'id' }],
				rowCount: 1,
			});

			const result = await conn.executeRaw('SELECT 1');
			expect(result.truncated).toBe(false);
		});

		it('handles null/undefined fields gracefully', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [],
				fields: undefined,
				rowCount: 0,
			});

			const result = await conn.executeRaw('SELECT 1');
			expect(result.columns).toEqual([]);
		});

		it('handles null rowCount', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [{ id: 1 }],
				fields: [{ name: 'id' }],
				rowCount: null,
			});

			const result = await conn.executeRaw('SELECT 1');
			// Falls back to rows.length
			expect(result.rowCount).toBe(1);
		});

		it('passes params to query', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [],
				fields: [],
				rowCount: 0,
			});

			await conn.executeRaw('SELECT $1', [42]);
			// Second call (first is SELECT 1 for connection test)
			expect(mockQuery).toHaveBeenCalledWith('SELECT $1', [42]);
		});

		it('defaults params to empty array', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: [],
				fields: [],
				rowCount: 0,
			});

			await conn.executeRaw('SELECT 1');
			expect(mockQuery).toHaveBeenCalledWith('SELECT 1', []);
		});

		it('handles null rows in response', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({
				rows: null,
				fields: [],
				rowCount: 0,
			});

			const result = await conn.executeRaw('SELECT 1');
			expect(result.rows).toEqual([]);
		});

		it('uses txClient when in transaction', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();

			mockClientQuery.mockResolvedValueOnce({
				rows: [{ id: 1 }],
				fields: [{ name: 'id' }],
				rowCount: 1,
			});

			const result = await conn.executeRaw('SELECT 1');
			// Should use client query, not pool query
			expect(mockClientQuery).toHaveBeenCalledWith('SELECT 1', []);
			expect(result.rows).toEqual([{ id: 1 }]);

			await conn.rollbackTransaction();
		});
	});

	describe('ping', () => {
		it('returns true on success', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });

			const result = await conn.ping();
			expect(result).toBe(true);
		});

		it('returns false on failure', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			mockQuery.mockRejectedValueOnce(new Error('connection lost'));

			const result = await conn.ping();
			expect(result).toBe(false);
		});
	});

	describe('close', () => {
		it('closes pool', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.close();
			expect(mockEnd).toHaveBeenCalled();
		});

		it('rolls back active transaction on close', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();

			await conn.close();
			expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
			expect(mockRelease).toHaveBeenCalled();
			expect(mockEnd).toHaveBeenCalled();
		});

		it('handles rollback error during close gracefully', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();

			// Make ROLLBACK fail during close — should still close cleanly
			mockClientQuery.mockRejectedValueOnce(new Error('rollback failed'));

			await conn.close();
			expect(mockRelease).toHaveBeenCalled();
			expect(mockEnd).toHaveBeenCalled();
		});
	});

	describe('getPool', () => {
		it('returns the pool instance', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			const pool = conn.getPool();
			expect(pool).toBeDefined();
			expect(pool.query).toBeDefined();
		});
	});

	describe('transaction lifecycle', () => {
		it('beginTransaction sends BEGIN', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			expect(conn.inTransaction).toBe(true);
			expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
			await conn.rollbackTransaction();
		});

		it('commitTransaction sends COMMIT and releases', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			await conn.commitTransaction();
			expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
			expect(mockRelease).toHaveBeenCalled();
			expect(conn.inTransaction).toBe(false);
		});

		it('rollbackTransaction sends ROLLBACK and releases', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			await conn.rollbackTransaction();
			expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
			expect(mockRelease).toHaveBeenCalled();
			expect(conn.inTransaction).toBe(false);
		});

		it('throws on double beginTransaction', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			await expect(conn.beginTransaction()).rejects.toThrow(
				'Transaction already active',
			);
			await conn.rollbackTransaction();
		});

		it('throws on commit without active transaction', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await expect(conn.commitTransaction()).rejects.toThrow(
				'No active transaction',
			);
		});

		it('throws on rollback without active transaction', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await expect(conn.rollbackTransaction()).rejects.toThrow(
				'No active transaction',
			);
		});

		it('releases client even if COMMIT fails', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			mockClientQuery.mockRejectedValueOnce(new Error('commit error'));

			await expect(conn.commitTransaction()).rejects.toThrow('commit error');
			expect(mockRelease).toHaveBeenCalled();
			expect(conn.inTransaction).toBe(false);
		});

		it('releases client even if ROLLBACK fails', async () => {
			const conn = await createDbConnection('postgres://localhost/testdb');
			await conn.beginTransaction();
			mockClientQuery.mockRejectedValueOnce(new Error('rollback error'));

			await expect(conn.rollbackTransaction()).rejects.toThrow(
				'rollback error',
			);
			expect(mockRelease).toHaveBeenCalled();
			expect(conn.inTransaction).toBe(false);
		});
	});
});

describe('getDatabaseName', () => {
	it('extracts database name from postgres URL', () => {
		expect(getDatabaseName('postgres://localhost/mydb')).toBe('mydb');
	});

	it('extracts database name from postgresql URL', () => {
		expect(getDatabaseName('postgresql://localhost/mydb')).toBe('mydb');
	});

	it('extracts database name from full URL with auth', () => {
		expect(getDatabaseName('postgres://user:pass@host:5432/testdb')).toBe(
			'testdb',
		);
	});

	it('falls back to hostname when no path', () => {
		expect(getDatabaseName('postgres://myhost')).toBe('myhost');
	});

	it('falls back to hostname when path is just /', () => {
		expect(getDatabaseName('postgres://myhost/')).toBe('myhost');
	});

	it('returns "database" for invalid URL', () => {
		expect(getDatabaseName('not-a-valid-url')).toBe('database');
	});

	it('returns "database" for empty string', () => {
		expect(getDatabaseName('')).toBe('database');
	});
});
