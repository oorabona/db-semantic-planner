/**
 * Tests for Migration Tracker — _dbsp_migrations table CRUD.
 */

import { describe, expect, it, vi } from 'vitest';
import * as adapterSurface from '../index.js';
import * as ddlSurface from './index.js';
import * as migrationTracker from './migration-tracker.js';
import {
	ensureMigrationsTable,
	getAppliedMigrations,
	getNextSchemaVersion,
	isMigrationApplied,
	MIGRATION_LOCK_KEY,
	recordMigration,
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
		query: vi.fn().mockImplementation((input: string) => {
			if (input.includes('pg_advisory_unlock')) {
				return Promise.resolve({
					rows: [{ unlocked: true }],
					rowCount: 1,
					command: 'SELECT',
				});
			}
			return Promise.resolve(queryResult);
		}),
		release: vi.fn(),
	};
}

// ============================================================================
// Advisory Lock public surface
// ============================================================================

describe('migration lock public surface', () => {
	it('exports only withMigrationLock for advisory migration locking', () => {
		for (const surface of [migrationTracker, ddlSurface, adapterSurface]) {
			expect(Object.hasOwn(surface, 'acquireMigrationLock')).toBe(false);
			expect(Object.hasOwn(surface, 'releaseMigrationLock')).toBe(false);
			expect(Object.hasOwn(surface, 'withMigrationLock')).toBe(true);
		}
	});
});

// ============================================================================
// withMigrationLock
// ============================================================================

describe('withMigrationLock', () => {
	it('pins the legacy migration lock key and passes the pinned client to fn', async () => {
		const client = createMockClient();
		const pool = createMockPool();
		pool.connect.mockResolvedValue(client);
		let callbackClient: unknown;

		const result = await withMigrationLock(pool as never, async (locked) => {
			callbackClient = locked;
			return 'done';
		});

		expect(result).toBe('done');
		expect(callbackClient).toBe(client);
		expect(pool.connect).toHaveBeenCalledOnce();
		expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_lock($1)', [
			MIGRATION_LOCK_KEY,
		]);
		expect(client.query).toHaveBeenCalledWith(
			'SELECT pg_advisory_unlock($1) AS unlocked',
			[MIGRATION_LOCK_KEY],
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
			'SELECT pg_advisory_unlock($1) AS unlocked',
			[MIGRATION_LOCK_KEY],
		);
		expect(client.release).toHaveBeenCalledOnce();
	});

	it('destroys the client if unlock query fails', async () => {
		const client = createMockClient();
		const unlockError = new Error('unlock failed');
		client.query.mockImplementation((input: string) => {
			if (input.includes('pg_advisory_unlock')) {
				return Promise.reject(unlockError);
			}
			return Promise.resolve({ rows: [] });
		});
		const pool = createMockPool();
		pool.connect.mockResolvedValue(client);

		await expect(
			withMigrationLock(pool as never, async () => 'ok'),
		).rejects.toThrow('unlock failed');

		expect(client.release).toHaveBeenCalledOnce();
		expect(client.release).toHaveBeenCalledWith(unlockError);
	});

	it('pins the migration lock key constant', () => {
		expect(MIGRATION_LOCK_KEY).toBe(-1232477147n);
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
