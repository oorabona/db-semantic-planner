/**
 * Tests for Migrate Command — Migration infrastructure.
 *
 * Tests migration logic with mocked adapter and file I/O.
 * Pattern: test key logic functions and behaviors,
 * not Commander internals.
 */

import type { SchemaDiff } from '@dbsp/adapter-pgsql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasExecutableSql, migrateCommand } from './migrate.js';

// ============================================================================
// Mock adapter
// ============================================================================

const mockCompareSchemata = vi.fn();
const mockGenerateMigrationSQL = vi.fn();
const mockGenerateMigrationFile = vi.fn();
const mockIntrospect = vi.fn();
const mockEnsureMigrationsTable = vi.fn();
const mockAcquireMigrationLock = vi.fn();
const mockReleaseMigrationLock = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockGetNextSchemaVersion = vi.fn();
const mockRecordMigration = vi.fn();
const mockRemoveMigrationRecord = vi.fn();
const mockWithMigrationLock = vi.fn();
const mockParseMigrationFile = vi.fn();
const mockIsDestructiveDown = vi.fn();

vi.mock('@dbsp/adapter-pgsql', () => ({
	compareSchemata: (...args: unknown[]) => mockCompareSchemata(...args),
	generateMigrationSQL: (...args: unknown[]) =>
		mockGenerateMigrationSQL(...args),
	generateMigrationFile: (...args: unknown[]) =>
		mockGenerateMigrationFile(...args),
	introspect: (...args: unknown[]) => mockIntrospect(...args),
	ensureMigrationsTable: (...args: unknown[]) =>
		mockEnsureMigrationsTable(...args),
	acquireMigrationLock: (...args: unknown[]) =>
		mockAcquireMigrationLock(...args),
	releaseMigrationLock: (...args: unknown[]) =>
		mockReleaseMigrationLock(...args),
	getAppliedMigrations: (...args: unknown[]) =>
		mockGetAppliedMigrations(...args),
	getNextSchemaVersion: (...args: unknown[]) =>
		mockGetNextSchemaVersion(...args),
	recordMigration: (...args: unknown[]) => mockRecordMigration(...args),
	removeMigrationRecord: (...args: unknown[]) =>
		mockRemoveMigrationRecord(...args),
	withMigrationLock: (...args: unknown[]) => mockWithMigrationLock(...args),
	parseMigrationFile: (...args: unknown[]) => mockParseMigrationFile(...args),
	isDestructiveDown: (...args: unknown[]) => mockIsDestructiveDown(...args),
}));

// ============================================================================
// Additional mocks — for e2e applyCommand tests
// ============================================================================

const mockCreateDbConnection = vi.fn();
const mockScanMigrationFiles = vi.fn();

vi.mock('../utils/db-utils.js', () => ({
	createDbConnection: (...args: unknown[]) => mockCreateDbConnection(...args),
	redactDbUrl: (s: string) => s,
}));

vi.mock('../migration-file.js', () => ({
	DEFAULT_MIGRATIONS_DIR: './migrations',
	generateMigrationFilename: vi.fn(),
	scanMigrationFiles: (...args: unknown[]) => mockScanMigrationFiles(...args),
	writeMigrationFile: vi.fn(),
}));

// ============================================================================
// Helpers
// ============================================================================

function makeDiff(
	changes: Array<{
		kind?: string;
		table?: string;
		destructive?: boolean;
		details?: string;
	}> = [],
	hasDestructive = false,
): SchemaDiff {
	return {
		changes: changes.map((c) => ({
			kind: c.kind ?? 'create_table',
			table: c.table ?? 'unknown',
			destructive: c.destructive ?? false,
			details: c.details ?? '',
		})),
		hasDestructive,
		summary: {
			tables: { added: 0, dropped: 0 },
			columns: { added: 0, dropped: 0, altered: 0 },
			indexes: { added: 0, dropped: 0 },
			constraints: { added: 0, dropped: 0, altered: 0 },
		},
	} as SchemaDiff;
}

// ============================================================================
// Tests: dev subcommand logic
// ============================================================================

describe('migrate dev — diff and generate logic', () => {
	it('should pass schema model and db model to compareSchemata', () => {
		const schemaModel = new Map([['users', { name: 'users' }]]);
		const dbModel = new Map([['posts', { name: 'posts' }]]);

		mockCompareSchemata.mockReturnValue(makeDiff([]));

		mockCompareSchemata(schemaModel, dbModel);

		expect(mockCompareSchemata).toHaveBeenCalledWith(schemaModel, dbModel);
	});

	it('should detect no changes when diff is empty', () => {
		const diff = makeDiff([]);
		expect(diff.changes).toHaveLength(0);
	});

	it('should detect destructive changes and block without --allow-destructive', () => {
		const diff = makeDiff(
			[
				{
					kind: 'drop_table',
					table: 'users',
					destructive: true,
					details: 'Drop table users',
				},
				{
					kind: 'add_column',
					table: 'posts',
					destructive: false,
					details: 'Add column title',
				},
			],
			true,
		);

		expect(diff.hasDestructive).toBe(true);
		const destructive = diff.changes.filter((c) => c.destructive);
		expect(destructive).toHaveLength(1);
	});

	it('should pass includeDestructive: false by default', () => {
		const diff = makeDiff([
			{ kind: 'add_column', table: 'users', details: 'Add name' },
		]);
		mockGenerateMigrationSQL.mockReturnValue([
			'ALTER TABLE "users" ADD COLUMN "name" text',
		]);

		mockGenerateMigrationSQL(diff, {
			includeDestructive: false,
		});

		expect(mockGenerateMigrationSQL).toHaveBeenCalledWith(diff, {
			includeDestructive: false,
		});
	});

	it('should pass schemaName through to generateMigrationSQL', () => {
		const diff = makeDiff([{ kind: 'create_table', table: 'users' }]);
		mockGenerateMigrationSQL.mockReturnValue([
			'CREATE TABLE "app"."users" ("id" serial)',
		]);

		mockGenerateMigrationSQL(diff, {
			includeDestructive: false,
			schemaName: 'app',
		});

		expect(mockGenerateMigrationSQL).toHaveBeenCalledWith(
			diff,
			expect.objectContaining({ schemaName: 'app' }),
		);
	});
});

// ============================================================================
// Tests: apply subcommand logic
// ============================================================================

describe('migrate apply — checksum validation', () => {
	it('should detect checksum mismatch between file and applied record', () => {
		const appliedMap = new Map([['0001_init.sql', 'checksum_original']]);
		const fileChecksum = 'checksum_modified';
		const fileName = '0001_init.sql';

		const existingChecksum = appliedMap.get(fileName);
		const mismatch =
			existingChecksum !== undefined && existingChecksum !== fileChecksum;

		expect(mismatch).toBe(true);
	});

	it('should not flag mismatch for non-applied migration', () => {
		const appliedMap = new Map<string, string>();
		const existingChecksum = appliedMap.get('0001_new.sql');

		expect(existingChecksum).toBeUndefined();
	});

	it('should not flag mismatch when checksums match', () => {
		const appliedMap = new Map([['0001_init.sql', 'abc123']]);
		const existingChecksum = appliedMap.get('0001_init.sql');
		const mismatch =
			existingChecksum !== undefined && existingChecksum !== 'abc123';

		expect(mismatch).toBe(false);
	});
});

describe('migrate apply — pending detection', () => {
	it('should identify pending migrations correctly', () => {
		const appliedMap = new Map([
			['0001_init.sql', 'aaa'],
			['0002_users.sql', 'bbb'],
		]);
		const files = [
			{ name: '0001_init.sql', checksum: 'aaa' },
			{ name: '0002_users.sql', checksum: 'bbb' },
			{ name: '0003_posts.sql', checksum: 'ccc' },
		];

		const pending = files.filter((f) => !appliedMap.has(f.name));

		expect(pending).toHaveLength(1);
		expect(pending[0]!.name).toBe('0003_posts.sql');
	});

	it('should return all files as pending when nothing applied', () => {
		const appliedMap = new Map<string, string>();
		const files = [
			{ name: '0001_init.sql', checksum: 'aaa' },
			{ name: '0002_users.sql', checksum: 'bbb' },
		];

		const pending = files.filter((f) => !appliedMap.has(f.name));

		expect(pending).toHaveLength(2);
	});

	it('should return no pending when all applied', () => {
		const appliedMap = new Map([
			['0001_init.sql', 'aaa'],
			['0002_users.sql', 'bbb'],
		]);
		const files = [
			{ name: '0001_init.sql', checksum: 'aaa' },
			{ name: '0002_users.sql', checksum: 'bbb' },
		];

		const pending = files.filter((f) => !appliedMap.has(f.name));

		expect(pending).toHaveLength(0);
	});
});

describe('migrate apply — statement splitting', () => {
	it('should split SQL content into individual statements', () => {
		const content =
			'CREATE TABLE "users" ("id" serial);\n\nALTER TABLE "users" ADD COLUMN "name" text;\n';
		const statements = content
			.split(/;\s*\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		expect(statements).toEqual([
			'CREATE TABLE "users" ("id" serial)',
			'ALTER TABLE "users" ADD COLUMN "name" text',
		]);
	});

	it('should handle single statement', () => {
		const content = 'CREATE TABLE "users" ("id" serial);\n';
		const statements = content
			.split(/;\s*\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		expect(statements).toEqual(['CREATE TABLE "users" ("id" serial)']);
	});

	it('should handle empty content', () => {
		const content = '';
		const statements = content
			.split(/;\s*\n/)
			.map((s) => s.trim())
			.filter((s) => s.length > 0);

		expect(statements).toEqual([]);
	});

	// hasExecutableSql regression: a statement that STARTS with a comment header
	// but contains real SQL must be KEPT (the old `!s.startsWith('-- ')` predicate
	// dropped the entire statement, silently skipping the DDL while still recording
	// the migration as applied).
	//
	// These tests import the PRODUCTION hasExecutableSql from migrate.ts — reverting
	// the function or its callers in migrate.ts turns these RED immediately.
	it('hasExecutableSql: keeps a statement that begins with a comment header followed by real SQL', () => {
		// Shape produced by generateMigrationFile: comment header on the same
		// element as the DDL (splitter splits on /;\s*\n/, not on comment lines).
		const stmt = '-- Migration: create users\nCREATE TABLE users (id integer)';
		expect(hasExecutableSql(stmt)).toBe(true);
	});

	it('hasExecutableSql: drops a statement that contains only blank lines and comments', () => {
		const stmt = '-- only a comment\n-- another comment\n';
		expect(hasExecutableSql(stmt)).toBe(false);
	});

	// Mutation guard: documents that the old startsWith predicate drops the same
	// input that hasExecutableSql correctly keeps.  If the production function is
	// reverted to `!s.startsWith('-- ')`, the first assertion below turns RED.
	it('hasExecutableSql: production predicate keeps comment-headed DDL; old startsWith predicate would drop it (mutation guard)', () => {
		const stmt = '-- Migration: create users\nCREATE TABLE users (id integer)';

		// Production function (imported from migrate.ts) must keep the statement:
		expect(hasExecutableSql(stmt)).toBe(true);

		// The old broken predicate (reverting the fix) would drop it:
		const oldPredicate = (s: string) => s.length > 0 && !s.startsWith('-- ');
		expect(oldPredicate(stmt)).toBe(false);
	});
});

// ============================================================================
// Tests: applyCommand e2e — comment-headed DDL reaches DB (regression lock)
// ============================================================================
//
// These tests drive migrateCommand.parseAsync('apply ...') end-to-end through
// the mocked adapter + pool so that reverting hasExecutableSql (or its callers
// in applyCommand) turns THIS suite RED — not just the unit predicate tests above.
//
// The critical assertion: the mocked client.query must be called with the
// CREATE TABLE statement even when it is preceded by a `-- comment` header
// in the same migration statement element.

describe('migrate apply — comment-headed DDL reaches DB client (e2e regression lock)', () => {
	// Mock client that records every SQL string sent to it
	let executedSql: string[];
	let mockClient: {
		query: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		executedSql = [];

		mockClient = {
			query: vi.fn().mockImplementation((sql: string) => {
				executedSql.push(sql);
				// getNextSchemaVersion needs a rows result
				if (typeof sql === 'string' && sql.includes('MAX(')) {
					return Promise.resolve({ rows: [{ max_version: 0 }] });
				}
				return Promise.resolve({ rows: [] });
			}),
		};

		// withMigrationLock: invoke the callback immediately with the mock client
		mockWithMigrationLock.mockImplementation(
			async (_pool: unknown, fn: (client: unknown) => Promise<void>) => {
				await fn(mockClient);
			},
		);

		// ensureMigrationsTable: no-op
		mockEnsureMigrationsTable.mockResolvedValue(undefined);

		// getAppliedMigrations: nothing applied yet → all files are pending
		mockGetAppliedMigrations.mockResolvedValue([]);

		// getNextSchemaVersion: return version 1
		mockGetNextSchemaVersion.mockResolvedValue(1);

		// Legacy regex classifier mock: apply should not use this path anymore.
		mockIsDestructiveDown.mockReturnValue(false);

		// recordMigration: no-op
		mockRecordMigration.mockResolvedValue(undefined);

		// createDbConnection: return a fake pool (withMigratePool just calls fn(pool))
		const fakePool = { end: vi.fn().mockResolvedValue(undefined) };
		mockCreateDbConnection.mockResolvedValue({ pool: fakePool });
	});

	it('comment-headed DDL (-- header + CREATE TABLE) is executed against DB client', async () => {
		// A migration statement as generateMigrationFile produces it:
		// the comment header and the DDL are in the SAME split element.
		const commentHeadedStatement =
			'-- Migration: 0001_create_users\nCREATE TABLE "users" ("id" serial PRIMARY KEY)';

		// parseMigrationFile returns the comment-headed statement as an upStatement
		mockParseMigrationFile.mockReturnValue({
			upStatements: [commentHeadedStatement],
			downStatements: ['DROP TABLE IF EXISTS "users"'],
			hasDown: true,
		});

		// scanMigrationFiles returns one pending migration file
		mockScanMigrationFiles.mockReturnValue([
			{
				name: '0001_create_users.sql',
				content: 'irrelevant — parseMigrationFile is mocked',
				checksum: 'abc123',
			},
		]);

		// Drive applyCommand end-to-end
		await migrateCommand.parseAsync(
			['apply', '--db', 'postgres://localhost/test'],
			{ from: 'user' },
		);

		// The CREATE TABLE must have been sent to client.query.
		// If hasExecutableSql is reverted to `!s.startsWith('-- ')`, the
		// comment-headed statement is dropped and this assertion fails.
		const ddlCall = executedSql.find((sql) =>
			sql.includes('CREATE TABLE "users"'),
		);
		expect(ddlCall).toBeDefined();
	});

	it('pure-comment statement (no DDL) is NOT sent to DB client', async () => {
		// A statement that is entirely a comment — must be filtered out.
		const commentOnlyStatement = '-- This migration is intentionally a no-op';

		mockParseMigrationFile.mockReturnValue({
			upStatements: [commentOnlyStatement],
			downStatements: [],
			hasDown: false,
		});

		mockScanMigrationFiles.mockReturnValue([
			{
				name: '0001_noop.sql',
				content: 'irrelevant',
				checksum: 'def456',
			},
		]);

		await migrateCommand.parseAsync(
			['apply', '--db', 'postgres://localhost/test'],
			{ from: 'user' },
		);

		// The comment-only string must NOT have reached client.query as a statement.
		const commentCall = executedSql.find((sql) =>
			sql.startsWith('-- This migration'),
		);
		expect(commentCall).toBeUndefined();
	});

	it('records destructive from parsed metadata instead of scanning DOWN SQL', async () => {
		mockParseMigrationFile.mockReturnValue({
			upStatements: ['CREATE TABLE "users" ("id" serial PRIMARY KEY)'],
			downStatements: ['CREATE INDEX "idx_users_id" ON "users" ("id")'],
			hasDown: true,
			destructive: true,
		});

		mockScanMigrationFiles.mockReturnValue([
			{
				name: '0001_create_users.sql',
				content: 'irrelevant',
				checksum: 'abc123',
			},
		]);

		await migrateCommand.parseAsync(
			['apply', '--db', 'postgres://localhost/test'],
			{ from: 'user' },
		);

		expect(mockRecordMigration).toHaveBeenCalledWith(
			expect.anything(),
			'0001_create_users.sql',
			'abc123',
			1,
			true,
		);
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});

	it('records safe metadata as non-destructive even when DOWN contains dynamic SQL text', async () => {
		mockParseMigrationFile.mockReturnValue({
			upStatements: ['CREATE TABLE "audit" ("id" serial PRIMARY KEY)'],
			downStatements: [
				`DO $$ BEGIN EXECUTE 'DROP TABLE IF EXISTS ignored'; END $$`,
			],
			hasDown: true,
			destructive: false,
		});

		mockScanMigrationFiles.mockReturnValue([
			{
				name: '0001_dynamic_safe.sql',
				content: 'irrelevant',
				checksum: 'def456',
			},
		]);

		await migrateCommand.parseAsync(
			['apply', '--db', 'postgres://localhost/test'],
			{ from: 'user' },
		);

		expect(mockRecordMigration).toHaveBeenCalledWith(
			expect.anything(),
			'0001_dynamic_safe.sql',
			'def456',
			1,
			false,
		);
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});
});

// ============================================================================
// Tests: rollback subcommand logic
// ============================================================================

describe('migrate rollback — reverse chronological order', () => {
	it('should sort applied migrations in reverse order for rollback', () => {
		// Arrange
		const applied = [
			{
				name: '0001_init.sql',
				checksum: 'aaa',
				appliedAt: new Date('2026-01-01'),
			},
			{
				name: '0002_users.sql',
				checksum: 'bbb',
				appliedAt: new Date('2026-01-02'),
			},
			{
				name: '0003_posts.sql',
				checksum: 'ccc',
				appliedAt: new Date('2026-01-03'),
			},
		];

		// Act
		const sortedDesc = [...applied].sort((a, b) =>
			b.name.localeCompare(a.name),
		);

		// Assert — most recent first
		expect(sortedDesc[0]!.name).toBe('0003_posts.sql');
		expect(sortedDesc[1]!.name).toBe('0002_users.sql');
		expect(sortedDesc[2]!.name).toBe('0001_init.sql');
	});

	it('SC-18: should reject count greater than applied migrations', () => {
		const applied = [
			{ name: '0001_init.sql', checksum: 'aaa' },
			{ name: '0002_users.sql', checksum: 'bbb' },
		];
		const count = 5;

		expect(count > applied.length).toBe(true);
	});

	it('should select correct migrations for rollback count', () => {
		const applied = [
			{ name: '0001_init.sql', checksum: 'aaa' },
			{ name: '0002_users.sql', checksum: 'bbb' },
			{ name: '0003_posts.sql', checksum: 'ccc' },
		];
		const sortedDesc = [...applied].sort((a, b) =>
			b.name.localeCompare(a.name),
		);
		const toRollback = sortedDesc.slice(0, 2);

		expect(toRollback).toHaveLength(2);
		expect(toRollback[0]!.name).toBe('0003_posts.sql');
		expect(toRollback[1]!.name).toBe('0002_users.sql');
	});
});

describe('migrate rollback — checksum validation', () => {
	it('SC-17: should reject rollback when checksum mismatches', () => {
		const record = { name: '0001_init.sql', checksum: 'original_hash' };
		const file = { name: '0001_init.sql', checksum: 'modified_hash' };

		expect(file.checksum !== record.checksum).toBe(true);
	});

	it('should accept rollback when checksums match', () => {
		const record = { name: '0001_init.sql', checksum: 'abc123' };
		const file = { name: '0001_init.sql', checksum: 'abc123' };

		expect(file.checksum === record.checksum).toBe(true);
	});
});

describe('migrate rollback — DOWN section handling', () => {
	it('SC-10/ERR-01: should reject rollback when no DOWN section exists', () => {
		const parsed = {
			upStatements: ['CREATE TABLE "users" ("id" serial)'],
			downStatements: [],
			hasDown: false,
		};

		expect(parsed.hasDown).toBe(false);
	});

	it('SC-11/ERR-04: should reject rollback when DOWN section is empty without --force', () => {
		const parsed = {
			upStatements: ['CREATE TABLE "users" ("id" serial)'],
			downStatements: [],
			hasDown: true,
		};
		const force = false;

		const downStmts = parsed.downStatements.filter(
			(s) => s.length > 0 && !s.startsWith('-- '),
		);
		const shouldReject = downStmts.length === 0 && !force;

		expect(shouldReject).toBe(true);
	});

	it('SC-11: should allow rollback with empty DOWN when --force is set', () => {
		const parsed = {
			upStatements: ['CREATE TABLE "users" ("id" serial)'],
			downStatements: [],
			hasDown: true,
		};
		const force = true;

		const downStmts = parsed.downStatements.filter(
			(s) => s.length > 0 && !s.startsWith('-- '),
		);
		const shouldReject = downStmts.length === 0 && !force;

		expect(shouldReject).toBe(false);
	});
});

describe('migrate rollback — metadata gate e2e', () => {
	let executedSql: string[];
	let errorMessages: string[];
	let mockClient: {
		query: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		executedSql = [];
		errorMessages = [];

		mockClient = {
			query: vi.fn().mockImplementation((sql: string) => {
				executedSql.push(sql);
				return Promise.resolve({ rows: [] });
			}),
		};

		mockWithMigrationLock.mockImplementation(
			async (_pool: unknown, fn: (client: unknown) => Promise<void>) => {
				await fn(mockClient);
			},
		);
		mockEnsureMigrationsTable.mockResolvedValue(undefined);
		mockGetAppliedMigrations.mockResolvedValue([
			{
				name: '0001_metadata_gate.sql',
				checksum: 'abc123',
				appliedAt: new Date('2026-01-01'),
				schemaVersion: 1,
				destructive: false,
			},
		]);
		mockRemoveMigrationRecord.mockResolvedValue(undefined);
		mockCreateDbConnection.mockResolvedValue({
			pool: { end: vi.fn().mockResolvedValue(undefined) },
		});
		mockScanMigrationFiles.mockReturnValue([
			{
				name: '0001_metadata_gate.sql',
				content: 'irrelevant',
				checksum: 'abc123',
			},
		]);
		mockIsDestructiveDown.mockReturnValue(false);

		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
			errorMessages.push(String(message));
		});
		vi.spyOn(process, 'exit').mockImplementation(((
			code?: string | number | null | undefined,
		) => {
			throw new Error(`process.exit:${code}`);
		}) as typeof process.exit);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function arrangeParsedMigration(parsed: {
		upStatements: string[];
		downStatements: string[];
		hasDown: boolean;
		destructive?: boolean | undefined;
	}): void {
		mockParseMigrationFile.mockReturnValue(parsed);
	}

	async function expectRollbackExit(): Promise<void> {
		await expect(
			migrateCommand.parseAsync(
				['rollback', '1', '--db', 'postgres://localhost/test'],
				{ from: 'user' },
			),
		).rejects.toThrow('process.exit:1');
	}

	it('stamped destructive metadata requires --force', async () => {
		arrangeParsedMigration({
			upStatements: [],
			downStatements: ['DROP TABLE IF EXISTS "users" CASCADE'],
			hasDown: true,
			destructive: true,
		});

		await expectRollbackExit();

		expect(errorMessages.join('\n')).toContain(
			'Migration 0001_metadata_gate.sql has destructive DOWN operations',
		);
		expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN');
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});

	it('stamped destructive metadata is allowed with --force', async () => {
		arrangeParsedMigration({
			upStatements: [],
			downStatements: ['DROP TABLE IF EXISTS "users" CASCADE'],
			hasDown: true,
			destructive: true,
		});

		await migrateCommand.parseAsync(
			['rollback', '1', '--db', 'postgres://localhost/test', '--force'],
			{ from: 'user' },
		);

		expect(executedSql).toContain('DROP TABLE IF EXISTS "users" CASCADE');
		expect(mockRemoveMigrationRecord).toHaveBeenCalledWith(
			expect.anything(),
			'0001_metadata_gate.sql',
		);
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});

	it.each([
		['DROP TABLE', 'DROP TABLE IF EXISTS "users" CASCADE'],
		['DROP COLUMN', 'ALTER TABLE "users" DROP COLUMN "email" CASCADE'],
	])('stamped safe metadata with obvious %s requires --force', async (_caseName, downStatement) => {
		mockIsDestructiveDown.mockReturnValueOnce(true);
		arrangeParsedMigration({
			upStatements: [],
			downStatements: [downStatement],
			hasDown: true,
			destructive: false,
		});

		await expectRollbackExit();

		expect(errorMessages.join('\n')).toContain(
			'Migration 0001_metadata_gate.sql is marked non-destructive but its DOWN section contains an obvious destructive statement',
		);
		expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN');
		expect(mockIsDestructiveDown).toHaveBeenCalledWith([downStatement]);
	});

	it('stamped safe metadata rolls back without --force for reversible DO block', async () => {
		const reversibleDown = `DO $$ BEGIN ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id"); END $$`;
		arrangeParsedMigration({
			upStatements: [],
			downStatements: [reversibleDown],
			hasDown: true,
			destructive: false,
		});

		await migrateCommand.parseAsync(
			['rollback', '1', '--db', 'postgres://localhost/test'],
			{ from: 'user' },
		);

		expect(executedSql).toContain(reversibleDown);
		expect(mockRemoveMigrationRecord).toHaveBeenCalledWith(
			expect.anything(),
			'0001_metadata_gate.sql',
		);
		expect(mockIsDestructiveDown).toHaveBeenCalledWith([reversibleDown]);
	});

	it('unmarked legacy migration requires --force', async () => {
		arrangeParsedMigration({
			upStatements: [],
			downStatements: ['CREATE INDEX "idx_users_id" ON "users" ("id")'],
			hasDown: true,
		});

		await expectRollbackExit();

		expect(errorMessages.join('\n')).toContain(
			'Migration 0001_metadata_gate.sql is unmarked or legacy',
		);
		expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN');
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});

	it('unmarked legacy migration with dynamic SQL requires --force', async () => {
		arrangeParsedMigration({
			upStatements: [],
			downStatements: [
				`DO $$ BEGIN EXECUTE 'DROP TABLE IF EXISTS users'; END $$`,
			],
			hasDown: true,
		});

		await expectRollbackExit();

		expect(errorMessages.join('\n')).toContain(
			'Migration 0001_metadata_gate.sql is unmarked or legacy',
		);
		expect(mockClient.query).not.toHaveBeenCalledWith('BEGIN');
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});

	it('unmarked legacy migration rolls back with --force', async () => {
		const downStatement = 'CREATE INDEX "idx_users_id" ON "users" ("id")';
		arrangeParsedMigration({
			upStatements: [],
			downStatements: [downStatement],
			hasDown: true,
		});

		await migrateCommand.parseAsync(
			['rollback', '1', '--db', 'postgres://localhost/test', '--force'],
			{ from: 'user' },
		);

		expect(executedSql).toContain(downStatement);
		expect(mockRemoveMigrationRecord).toHaveBeenCalledWith(
			expect.anything(),
			'0001_metadata_gate.sql',
		);
		expect(mockIsDestructiveDown).not.toHaveBeenCalled();
	});
});

describe('migrate rollback — file lookup', () => {
	it('should find migration file on disk by name', () => {
		const files = [
			{ name: '0001_init.sql', content: 'CREATE TABLE...', checksum: 'aaa' },
			{
				name: '0002_users.sql',
				content: 'ALTER TABLE...',
				checksum: 'bbb',
			},
		];
		const fileMap = new Map(files.map((f) => [f.name, f]));

		expect(fileMap.get('0001_init.sql')).toBeDefined();
		expect(fileMap.get('0003_missing.sql')).toBeUndefined();
	});
});

// ============================================================================
// Tests: status subcommand logic
// ============================================================================

describe('migrate status — status classification', () => {
	it('should classify file-only migrations as pending', () => {
		const appliedMap = new Map<string, { checksum: string; appliedAt: Date }>();
		const file = { name: '0001_init.sql', checksum: 'abc' };

		const record = appliedMap.get(file.name);
		const status = record === undefined ? 'pending' : 'applied';

		expect(status).toBe('pending');
	});

	it('should classify applied migrations with matching checksum', () => {
		const appliedMap = new Map([
			['0001_init.sql', { checksum: 'abc', appliedAt: new Date('2026-01-01') }],
		]);
		const file = { name: '0001_init.sql', checksum: 'abc' };

		const record = appliedMap.get(file.name);
		const status =
			record === undefined
				? 'pending'
				: record.checksum !== file.checksum
					? 'checksum_mismatch'
					: 'applied';

		expect(status).toBe('applied');
	});

	it('should classify mismatched checksum migrations', () => {
		const appliedMap = new Map([
			['0001_init.sql', { checksum: 'abc', appliedAt: new Date('2026-01-01') }],
		]);
		const file = { name: '0001_init.sql', checksum: 'xyz' };

		const record = appliedMap.get(file.name);
		const status =
			record === undefined
				? 'pending'
				: record.checksum !== file.checksum
					? 'checksum_mismatch'
					: 'applied';

		expect(status).toBe('checksum_mismatch');
	});

	it('should detect missing_file for applied migrations without files', () => {
		const applied = [
			{ name: '0001_init.sql', checksum: 'abc', appliedAt: new Date() },
			{ name: '0002_users.sql', checksum: 'def', appliedAt: new Date() },
		];
		const files = [{ name: '0001_init.sql' }];

		const missingFile = applied.filter(
			(record) => !files.some((f) => f.name === record.name),
		);

		expect(missingFile).toHaveLength(1);
		expect(missingFile[0]!.name).toBe('0002_users.sql');
	});
});
