/**
 * Tests for Migration Tracker — _dbsp_migrations table CRUD.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	acquireMigrationLock,
	ensureMigrationsTable,
	getAppliedMigrations,
	getNextSchemaVersion,
	isMigrationApplied,
	recordMigration,
	releaseMigrationLock,
	removeMigrationRecord,
	withMigrationLock,
} from './migration-tracker.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockPool(queryResult: { rows: unknown[] } = { rows: [] }) {
	return {
		query: vi.fn().mockResolvedValue(queryResult),
		connect: vi.fn(),
	};
}

function createMockClient(queryResult: { rows: unknown[] } = { rows: [] }) {
	return {
		query: vi.fn().mockResolvedValue(queryResult),
		release: vi.fn(),
	};
}

// ============================================================================
// Advisory Lock (legacy)
// ============================================================================

describe('acquireMigrationLock', () => {
	it('should execute pg_advisory_lock', async () => {
		const pool = createMockPool();
		await acquireMigrationLock(pool as never);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_lock'),
		);
	});
});

describe('releaseMigrationLock', () => {
	it('should execute pg_advisory_unlock', async () => {
		const pool = createMockPool();
		await releaseMigrationLock(pool as never);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_unlock'),
		);
	});
});

// ============================================================================
// withMigrationLock
// ============================================================================

describe('withMigrationLock', () => {
	it('should acquire lock, execute fn, then release lock', async () => {
		const client = createMockClient();
		const pool = createMockPool();
		pool.connect.mockResolvedValue(client);

		const result = await withMigrationLock(pool as never, async () => {
			return 'done';
		});

		expect(result).toBe('done');
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(client.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_lock'),
		);
		expect(client.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_unlock'),
		);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('should release lock even if fn throws', async () => {
		const client = createMockClient();
		const pool = createMockPool();
		pool.connect.mockResolvedValue(client);

		await expect(
			withMigrationLock(pool as never, async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');

		expect(client.query).toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_unlock'),
		);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('should release client even if unlock query fails', async () => {
		const client = createMockClient();
		// Lock succeeds, callback succeeds, unlock fails
		let callCount = 0;
		client.query.mockImplementation(() => {
			callCount++;
			if (callCount === 2) {
				// Second call is the unlock in finally
				return Promise.reject(new Error('unlock failed'));
			}
			return Promise.resolve({ rows: [] });
		});
		const pool = createMockPool();
		pool.connect.mockResolvedValue(client);

		const result = await withMigrationLock(pool as never, async () => 'ok');

		expect(result).toBe('ok');
		expect(client.release).toHaveBeenCalledOnce();
	});
});

// ============================================================================
// Table Management
// ============================================================================

describe('ensureMigrationsTable', () => {
	it('should execute CREATE TABLE IF NOT EXISTS', async () => {
		const pool = createMockPool();
		await ensureMigrationsTable(pool as never);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS'),
		);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('_dbsp_migrations'),
		);
	});

	it('should auto-add schema_version column to existing table', async () => {
		const pool = createMockPool();
		await ensureMigrationsTable(pool as never);

		const calls = pool.query.mock.calls.map((c: unknown[]) => c[0] as string);
		const alterCall = calls.find(
			(sql: string) =>
				sql.includes('ADD COLUMN IF NOT EXISTS') &&
				sql.includes('schema_version'),
		);
		expect(alterCall).toBeDefined();
	});

	it('should auto-add destructive column to existing table', async () => {
		const pool = createMockPool();
		await ensureMigrationsTable(pool as never);

		const calls = pool.query.mock.calls.map((c: unknown[]) => c[0] as string);
		const alterCall = calls.find(
			(sql: string) =>
				sql.includes('ADD COLUMN IF NOT EXISTS') && sql.includes('destructive'),
		);
		expect(alterCall).toBeDefined();
	});

	it('should backfill schema_version by applied_at order', async () => {
		const pool = createMockPool();
		await ensureMigrationsTable(pool as never);

		const calls = pool.query.mock.calls.map((c: unknown[]) => c[0] as string);
		const backfillCall = calls.find(
			(sql: string) =>
				sql.includes('ROW_NUMBER()') && sql.includes('ORDER BY "applied_at"'),
		);
		expect(backfillCall).toBeDefined();
	});

	it('should call 4 queries: CREATE + 2 ALTER + 1 UPDATE', async () => {
		const pool = createMockPool();
		await ensureMigrationsTable(pool as never);
		expect(pool.query).toHaveBeenCalledTimes(4);
	});
});

// ============================================================================
// CRUD Operations
// ============================================================================

describe('getAppliedMigrations', () => {
	it('should return mapped migration records with schema_version and destructive', async () => {
		const date1 = new Date('2026-01-01');
		const date2 = new Date('2026-01-02');
		const pool = createMockPool({
			rows: [
				{
					name: '0001_init.sql',
					checksum: 'abc123',
					applied_at: date1,
					schema_version: 1,
					destructive: false,
				},
				{
					name: '0002_users.sql',
					checksum: 'def456',
					applied_at: date2,
					schema_version: 2,
					destructive: true,
				},
			],
		});

		const result = await getAppliedMigrations(pool as never);

		expect(result).toEqual([
			{
				name: '0001_init.sql',
				checksum: 'abc123',
				appliedAt: date1,
				schemaVersion: 1,
				destructive: false,
			},
			{
				name: '0002_users.sql',
				checksum: 'def456',
				appliedAt: date2,
				schemaVersion: 2,
				destructive: true,
			},
		]);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('ORDER BY "name"'),
		);
	});

	it('should return empty array when no migrations applied', async () => {
		const pool = createMockPool({ rows: [] });
		const result = await getAppliedMigrations(pool as never);
		expect(result).toEqual([]);
	});

	it('should select schema_version and destructive columns', async () => {
		const pool = createMockPool({ rows: [] });
		await getAppliedMigrations(pool as never);
		const sql = String(pool.query.mock.calls[0]?.[0]);
		expect(sql).toContain('"schema_version"');
		expect(sql).toContain('"destructive"');
	});
});

describe('recordMigration', () => {
	it('should insert migration with schema_version and destructive flag', async () => {
		const pool = createMockPool();
		await recordMigration(pool as never, '0001_init.sql', 'abc123', 1, false);
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('INSERT INTO'),
			['0001_init.sql', 'abc123', 1, false],
		);
	});

	it('should include schema_version and destructive in SQL', async () => {
		const pool = createMockPool();
		await recordMigration(pool as never, '0002_drop.sql', 'def456', 2, true);
		const sql = String(pool.query.mock.calls[0]?.[0]);
		expect(sql).toContain('"schema_version"');
		expect(sql).toContain('"destructive"');
	});
});

describe('isMigrationApplied', () => {
	it('should return true when count > 0', async () => {
		const pool = createMockPool({ rows: [{ count: '1' }] });
		const result = await isMigrationApplied(pool as never, '0001_init.sql');
		expect(result).toBe(true);
	});

	it('should return false when count is 0', async () => {
		const pool = createMockPool({ rows: [{ count: '0' }] });
		const result = await isMigrationApplied(pool as never, '0001_init.sql');
		expect(result).toBe(false);
	});

	it('should return false when no rows returned', async () => {
		const pool = createMockPool({ rows: [] });
		const result = await isMigrationApplied(pool as never, '0001_init.sql');
		expect(result).toBe(false);
	});
});

// ============================================================================
// getNextSchemaVersion
// ============================================================================

describe('getNextSchemaVersion', () => {
	it('should return 1 for empty table', async () => {
		const pool = createMockPool({ rows: [{ max_version: null }] });
		const result = await getNextSchemaVersion(pool as never);
		expect(result).toBe(1);
	});

	it('should return max + 1 for existing migrations', async () => {
		const pool = createMockPool({ rows: [{ max_version: 5 }] });
		const result = await getNextSchemaVersion(pool as never);
		expect(result).toBe(6);
	});

	it('should query MAX(schema_version)', async () => {
		const pool = createMockPool({ rows: [{ max_version: null }] });
		await getNextSchemaVersion(pool as never);
		const sql = String(pool.query.mock.calls[0]?.[0]);
		expect(sql).toContain('MAX("schema_version")');
	});
});

// ============================================================================
// removeMigrationRecord
// ============================================================================

describe('removeMigrationRecord', () => {
	it('should delete the migration record by name', async () => {
		const pool = createMockPool();
		await removeMigrationRecord(pool as never, '0001_init.sql');
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('DELETE FROM'),
			['0001_init.sql'],
		);
	});

	it('should target _dbsp_migrations table', async () => {
		const pool = createMockPool();
		await removeMigrationRecord(pool as never, '0001_init.sql');
		const sql = String(pool.query.mock.calls[0]?.[0]);
		expect(sql).toContain('_dbsp_migrations');
	});
});
