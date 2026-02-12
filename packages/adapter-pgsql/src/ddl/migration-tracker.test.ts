/**
 * Tests for Migration Tracker — _dbsp_migrations table CRUD.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	acquireMigrationLock,
	ensureMigrationsTable,
	getAppliedMigrations,
	isMigrationApplied,
	recordMigration,
	releaseMigrationLock,
} from './migration-tracker.js';

// ============================================================================
// Helpers
// ============================================================================

function createMockPool(queryResult: { rows: unknown[] } = { rows: [] }) {
	return {
		query: vi.fn().mockResolvedValue(queryResult),
	};
}

// ============================================================================
// Advisory Lock
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
});

// ============================================================================
// CRUD Operations
// ============================================================================

describe('getAppliedMigrations', () => {
	it('should return mapped migration records ordered by name', async () => {
		const date1 = new Date('2026-01-01');
		const date2 = new Date('2026-01-02');
		const pool = createMockPool({
			rows: [
				{ name: '0001_init.sql', checksum: 'abc123', applied_at: date1 },
				{
					name: '0002_users.sql',
					checksum: 'def456',
					applied_at: date2,
				},
			],
		});

		const result = await getAppliedMigrations(pool as never);

		expect(result).toEqual([
			{ name: '0001_init.sql', checksum: 'abc123', appliedAt: date1 },
			{ name: '0002_users.sql', checksum: 'def456', appliedAt: date2 },
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
});

describe('recordMigration', () => {
	it('should insert migration with name and checksum', async () => {
		const pool = createMockPool();
		await recordMigration(pool as never, '0001_init.sql', 'abc123');
		expect(pool.query).toHaveBeenCalledWith(
			expect.stringContaining('INSERT INTO'),
			['0001_init.sql', 'abc123'],
		);
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
