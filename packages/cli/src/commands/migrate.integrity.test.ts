/**
 * Tests for migrate.ts — lock integrity, atomic transactions, process.exit safety,
 * cleanup masking, pg error sanitization, and DRY pool lifecycle.
 *
 * Observable success gates:
 *   S-1: Lock client is the SAME client used for DDL + record insert.
 *   S-2: Apply: throw between DDL and record -> ROLLBACK; no partial apply.
 *   S-3: Rollback: throw between DOWN SQL and remove-record -> ROLLBACK; no partial rollback.
 *   S-4: process.exit is NOT called while lock client is held.
 *   M-1: cleanup finally does not mask the original error.
 *   M-2: withMigratePool is used by migrate commands.
 *   M-3: pg SQLSTATE errors are sanitized.
 */

import { withMigrationLock } from '@dbsp/adapter-pgsql';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeChecksum, type MigrationFile } from '../migration-file.js';
import {
	type MigrateDeps,
	MigrationError,
	runApply,
	runRollback,
	sanitizePgError,
} from './migrate.js';

// ============================================================================
// Helpers
// ============================================================================

function makePgError(code: string, message: string): Error & { code: string } {
	const err = new Error(message) as Error & { code: string };
	err.code = code;
	return err;
}

function makeMigrationFile(name: string, content: string): MigrationFile {
	return {
		name,
		path: `/tmp/${name}`,
		content,
		checksum: computeChecksum(content),
	};
}

function sqlText(call: readonly unknown[]): string {
	return String(call[0]);
}

function poolDeps(pool: Pool, files: readonly MigrationFile[]): MigrateDeps {
	return {
		withMigratePool: async (_dbUrl, fn) => fn(pool),
		ensureMigrationsTable: async () => {},
		withMigrationLock,
		scanMigrationFiles: () => files,
	};
}

async function readMigrateSource(): Promise<string> {
	const fs = await import('node:fs/promises');
	const path = await import('node:path');
	const url = await import('node:url');
	const dirname = path.dirname(url.fileURLToPath(import.meta.url));
	return fs.readFile(path.resolve(dirname, 'migrate.ts'), 'utf8');
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock('../utils/db-utils.js');
});

// ============================================================================
// MigrationError class
// ============================================================================

describe('MigrationError', () => {
	it('should be an instance of Error', () => {
		const err = new MigrationError('test');
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(MigrationError);
	});

	it('should have name MigrationError', () => {
		const err = new MigrationError('test');
		expect(err.name).toBe('MigrationError');
	});

	it('should carry the message', () => {
		const err = new MigrationError('something went wrong');
		expect(err.message).toBe('something went wrong');
	});
});

// ============================================================================
// sanitizePgError (M-3: pg SQLSTATE sanitization)
// ============================================================================

describe('sanitizePgError — M-3: pg error sanitization', () => {
	it('should return original error when not a pg error', () => {
		const err = new Error('generic');
		const result = sanitizePgError(err);
		expect(result).toBe(err);
		expect(result.message).toBe('generic');
	});

	it('should sanitize 5-char SQLSTATE errors (uppercase letters/digits)', () => {
		const pgErr = makePgError(
			'42P01',
			'relation "secret_table" does not exist',
		);
		const result = sanitizePgError(pgErr);
		expect(result).toBeInstanceOf(MigrationError);
		expect(result.message).toBe('Migration failed: database error 42P01');
		expect(result.message).not.toContain('secret_table');
	});

	it('should sanitize numeric SQLSTATE (e.g. 08006 connection failure)', () => {
		const pgErr = makePgError('08006', 'connection closed unexpectedly');
		const result = sanitizePgError(pgErr);
		expect(result).toBeInstanceOf(MigrationError);
		expect(result.message).toBe('Migration failed: database error 08006');
	});

	it('should not sanitize errors with non-SQLSTATE codes', () => {
		const err = new Error('some app error') as Error & { code?: string };
		err.code = 'ECONNREFUSED';
		const result = sanitizePgError(err);
		expect(result).toBe(err);
		expect(result.message).toBe('some app error');
	});

	it('should handle non-Error thrown values', () => {
		const result = sanitizePgError('just a string');
		expect(result).toBeInstanceOf(Error);
		expect(result.message).toBe('just a string');
	});

	it('should handle null/undefined thrown values', () => {
		const result = sanitizePgError(undefined);
		expect(result).toBeInstanceOf(Error);
	});

	it('should gate raw pg message behind DEBUG=dbsp', () => {
		const consoleErrorSpy = vi
			.spyOn(console, 'error')
			.mockImplementation(() => {});
		const original = process.env.DEBUG;

		delete process.env.DEBUG;
		const pgErr = makePgError('42P01', 'relation "secret" does not exist');
		sanitizePgError(pgErr);
		expect(consoleErrorSpy).not.toHaveBeenCalled();

		process.env.DEBUG = 'dbsp';
		sanitizePgError(pgErr);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('secret'),
		);

		if (original === undefined) {
			delete process.env.DEBUG;
		} else {
			process.env.DEBUG = original;
		}
	});
});

// ============================================================================
// withMigratePool (M-1/M-2: real pool lifecycle)
// ============================================================================

describe('withMigratePool — real cleanup behavior', () => {
	it('should call pool.end() after successful fn', async () => {
		const fakePool = {
			end: vi.fn().mockResolvedValue(undefined),
		};

		vi.resetModules();
		vi.doMock('../utils/db-utils.js', () => ({
			createDbConnection: vi.fn().mockResolvedValue({ pool: fakePool }),
			redactDbUrl: (value: string) => value,
		}));

		const { withMigratePool } = await import('./migrate.js');

		await expect(
			withMigratePool('postgres://example/db', async (pool) => {
				expect(pool).toBe(fakePool);
				return 'ok';
			}),
		).resolves.toBe('ok');
		expect(fakePool.end).toHaveBeenCalledOnce();
	});

	it('should not mask the original error when pool.end() also throws', async () => {
		const originalError = new Error('real failure');
		const cleanupError = new Error('cleanup failure');
		const fakePool = {
			end: vi.fn().mockRejectedValue(cleanupError),
		};
		const consoleErrorSpy = vi
			.spyOn(console, 'error')
			.mockImplementation(() => {});

		vi.resetModules();
		vi.doMock('../utils/db-utils.js', () => ({
			createDbConnection: vi.fn().mockResolvedValue({ pool: fakePool }),
			redactDbUrl: (value: string) => value,
		}));

		const { withMigratePool } = await import('./migrate.js');

		await expect(
			withMigratePool('postgres://example/db', async () => {
				throw originalError;
			}),
		).rejects.toBe(originalError);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('pool.end() failed: cleanup failure'),
		);
	});
});

// ============================================================================
// S-1: Lock client isolation
// ============================================================================

describe('S-1 — Lock client: dedicated client used for advisory lock and DDL', () => {
	it('should use withMigrationLock on a dedicated client, not pool.query, during apply', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const file = makeMigrationFile(
			'0001_create_users.sql',
			`-- dbsp:destructive: false

CREATE TABLE users (id serial);

-- DOWN

DROP TABLE users;
`,
		);

		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('SELECT "name"')) {
					return { rows: [] };
				}
				if (sql.includes('SELECT MAX')) {
					return { rows: [{ max_version: 0 }] };
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			connect: vi.fn().mockResolvedValue(client),
			query: vi.fn(async (sql: string) => {
				if (sql.includes('pg_advisory_lock')) {
					throw new Error('advisory lock used pool.query');
				}
				return { rows: [] };
			}),
		} as unknown as Pool;

		await runApply(
			{ db: 'postgres://example/db', dir: 'migrations' },
			poolDeps(pool, [file]),
		);

		expect(pool.connect).toHaveBeenCalledOnce();
		expect(pool.query).not.toHaveBeenCalledWith(
			expect.stringContaining('pg_advisory_lock'),
		);
		expect(client.release).toHaveBeenCalledOnce();

		const sqls = client.query.mock.calls.map(sqlText);
		expect(sqls[0]).toContain('pg_advisory_lock');
		expect(sqls.some((sql) => sql.includes('CREATE TABLE users'))).toBe(true);
		expect(
			sqls.some((sql) => sql.includes('INSERT INTO "_dbsp_migrations"')),
		).toBe(true);
		expect(sqls.at(-1)).toContain('pg_advisory_unlock');

		const beginIndex = sqls.indexOf('BEGIN');
		const createIndex = sqls.findIndex((sql) =>
			sql.includes('CREATE TABLE users'),
		);
		const insertIndex = sqls.findIndex((sql) =>
			sql.includes('INSERT INTO "_dbsp_migrations"'),
		);
		const commitIndex = sqls.indexOf('COMMIT');
		expect(beginIndex).toBeGreaterThan(-1);
		expect(createIndex).toBeGreaterThan(beginIndex);
		expect(insertIndex).toBeGreaterThan(createIndex);
		expect(commitIndex).toBeGreaterThan(insertIndex);
	});
});

// ============================================================================
// S-2: Apply atomicity
// ============================================================================

describe('S-2 — Apply atomicity: DDL + record in one transaction', () => {
	it('should ROLLBACK when DDL succeeds but recordMigration throws', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const file = makeMigrationFile(
			'0001_create_users.sql',
			`-- dbsp:destructive: false

CREATE TABLE users (id serial);

-- DOWN

DROP TABLE users;
`,
		);
		const successfulRecords: string[] = [];
		const insertFailure = new Error('insert failed');

		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('SELECT "name"')) {
					return { rows: [] };
				}
				if (sql.includes('SELECT MAX')) {
					return { rows: [{ max_version: 0 }] };
				}
				if (sql.includes('INSERT INTO "_dbsp_migrations"')) {
					throw insertFailure;
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			connect: vi.fn().mockResolvedValue(client),
			query: vi.fn(async () => ({ rows: [] })),
		} as unknown as Pool;

		await expect(
			runApply(
				{ db: 'postgres://example/db', dir: 'migrations' },
				poolDeps(pool, [file]),
			),
		).rejects.toBe(insertFailure);

		const sqls = client.query.mock.calls.map(sqlText);
		const createIndex = sqls.findIndex((sql) =>
			sql.includes('CREATE TABLE users'),
		);
		const insertIndex = sqls.findIndex((sql) =>
			sql.includes('INSERT INTO "_dbsp_migrations"'),
		);
		const rollbackIndex = sqls.indexOf('ROLLBACK');
		expect(sqls).toContain('BEGIN');
		expect(createIndex).toBeGreaterThan(sqls.indexOf('BEGIN'));
		expect(insertIndex).toBeGreaterThan(createIndex);
		expect(rollbackIndex).toBeGreaterThan(insertIndex);
		expect(sqls).not.toContain('COMMIT');
		expect(successfulRecords).toEqual([]);
	});
});

// ============================================================================
// S-3: Rollback atomicity
// ============================================================================

describe('S-3 — Rollback atomicity: DOWN SQL + remove-record in one transaction', () => {
	it('should ROLLBACK when DOWN SQL succeeds but removeMigrationRecord throws', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const file = makeMigrationFile(
			'0001_create_users.sql',
			`-- dbsp:destructive: true

CREATE TABLE users (id serial);

-- DOWN

DROP TABLE users;
`,
		);
		const removedRecords: string[] = [];
		const deleteFailure = new Error('delete failed');

		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('SELECT "name"')) {
					return {
						rows: [
							{
								name: file.name,
								checksum: file.checksum,
								applied_at: new Date('2026-01-01T00:00:00Z'),
								schema_version: 1,
								destructive: true,
							},
						],
					};
				}
				if (sql.includes('DELETE FROM "_dbsp_migrations"')) {
					throw deleteFailure;
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		};
		const pool = {
			connect: vi.fn().mockResolvedValue(client),
			query: vi.fn(async () => ({ rows: [] })),
		} as unknown as Pool;

		await expect(
			runRollback(
				{
					count: 1,
					db: 'postgres://example/db',
					dir: 'migrations',
					force: true,
				},
				poolDeps(pool, [file]),
			),
		).rejects.toBe(deleteFailure);

		const sqls = client.query.mock.calls.map(sqlText);
		const downIndex = sqls.findIndex((sql) => sql.includes('DROP TABLE users'));
		const deleteIndex = sqls.findIndex((sql) =>
			sql.includes('DELETE FROM "_dbsp_migrations"'),
		);
		const rollbackIndex = sqls.indexOf('ROLLBACK');
		expect(sqls).toContain('BEGIN');
		expect(downIndex).toBeGreaterThan(sqls.indexOf('BEGIN'));
		expect(deleteIndex).toBeGreaterThan(downIndex);
		expect(rollbackIndex).toBeGreaterThan(deleteIndex);
		expect(sqls).not.toContain('COMMIT');
		expect(removedRecords).toEqual([]);
	});
});

// ============================================================================
// S-4: process.exit is NOT called inside lock scope
// ============================================================================

describe('S-4 — No process.exit inside lock scope', () => {
	it('should throw from runApply without calling process.exit while the lock is held', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const file = makeMigrationFile(
			'0001_create_users.sql',
			`-- dbsp:destructive: false

CREATE TABLE users (id serial);

-- DOWN

DROP TABLE users;
`,
		);
		let lockHeld = false;
		let exitObservedWhileLocked = false;
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
			code?: string | number | null,
		) => {
			exitObservedWhileLocked = lockHeld;
			throw new Error(`process.exit(${String(code)})`);
		}) as never);

		const client = {
			query: vi.fn(async (sql: string) => {
				if (sql.includes('SELECT "name"')) {
					return {
						rows: [
							{
								name: file.name,
								checksum: 'different-checksum',
								applied_at: new Date('2026-01-01T00:00:00Z'),
								schema_version: 1,
								destructive: false,
							},
						],
					};
				}
				return { rows: [] };
			}),
			release: vi.fn(),
		} as unknown as PoolClient;
		const pool = {} as Pool;

		await expect(
			runApply(
				{ db: 'postgres://example/db', dir: 'migrations' },
				{
					withMigratePool: async (_dbUrl, fn) => fn(pool),
					ensureMigrationsTable: async () => {},
					withMigrationLock: async (_pool, fn) => {
						lockHeld = true;
						try {
							return await fn(client);
						} finally {
							lockHeld = false;
						}
					},
					scanMigrationFiles: () => [file],
				},
			),
		).rejects.toBeInstanceOf(MigrationError);

		expect(exitSpy).not.toHaveBeenCalled();
		expect(exitObservedWhileLocked).toBe(false);
		expect(lockHeld).toBe(false);
	});
});

// ============================================================================
// Integration-level: verify removed unsafe paths stay removed
// ============================================================================

describe('Lock API — migrate.ts source scan', () => {
	it('should not import acquireMigrationLock or releaseMigrationLock', async () => {
		const source = await readMigrateSource();

		expect(source).not.toContain('acquireMigrationLock');
		expect(source).not.toContain('releaseMigrationLock');
		expect(source).toContain('withMigrationLock');
	});

	it('should not contain executeDdl (removed split-transaction path)', async () => {
		const source = await readMigrateSource();

		expect(source).not.toContain('executeDdl');
	});

	it('should contain withMigratePool used by migrate command paths', async () => {
		const source = await readMigrateSource();

		const matches = source.match(/withMigratePool\(/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});
});
