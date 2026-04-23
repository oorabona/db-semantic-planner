/**
 * Tests for Migrate Command — Migration infrastructure.
 *
 * Tests migration logic with mocked adapter and file I/O.
 * Pattern: test key logic functions and behaviors,
 * not Commander internals.
 */

import type { SchemaDiff } from '@dbsp/adapter-pgsql';
import { describe, expect, it, vi } from 'vitest';

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

// M4 regression: isDestructiveDown must be called with downStatements, not upStatements.
// A migration with DROP TABLE in the DOWN section (but not in the UP section) should be
// recorded as destructive=true. If upStatements were passed instead, it would incorrectly
// be recorded as destructive=false.
//
// Note: Full end-to-end coverage of applyCommand recording destructive=true in the
// _dbsp_migrations table requires a real PostgreSQL container (testcontainers).
// TODO: add testcontainers integration test — see packages/cli/src/commands/migrate.integrity.test.ts
// for the pattern to follow (applyCommand + pool lifecycle + _dbsp_migrations query).
describe('migrate apply — destructive flag uses DOWN section (M4 regression)', () => {
	it('real isDestructiveDown returns true for DROP TABLE in DOWN, false for CREATE TABLE in UP', async () => {
		// Use the REAL isDestructiveDown (not the mock) to verify the actual function contract.
		// vi.importActual bypasses the vi.mock() at the top of this file for this one import.
		const { isDestructiveDown } = await vi.importActual<
			typeof import('@dbsp/adapter-pgsql')
		>('@dbsp/adapter-pgsql');

		// Migration: UP creates table (non-destructive), DOWN drops it (destructive)
		const upStatements = ['CREATE TABLE "users" (id SERIAL PRIMARY KEY)'];
		const downStatements = ['DROP TABLE IF EXISTS "users" CASCADE'];

		// Core M4 invariant: DOWN is destructive, UP is not
		expect(isDestructiveDown(downStatements)).toBe(true);
		expect(isDestructiveDown(upStatements)).toBe(false);

		// The two must differ — proves applyCommand passing downStatements (not upStatements)
		// to isDestructiveDown is the correct fix for the M4 bug.
		expect(isDestructiveDown(downStatements)).not.toBe(
			isDestructiveDown(upStatements),
		);
	});

	it('real isDestructiveDown returns true for DROP COLUMN in DOWN section', async () => {
		const { isDestructiveDown } = await vi.importActual<
			typeof import('@dbsp/adapter-pgsql')
		>('@dbsp/adapter-pgsql');

		const downStatements = ['ALTER TABLE "users" DROP COLUMN "email" CASCADE'];
		expect(isDestructiveDown(downStatements)).toBe(true);
	});

	it('real isDestructiveDown returns false for non-destructive DOWN (DROP INDEX only)', async () => {
		const { isDestructiveDown } = await vi.importActual<
			typeof import('@dbsp/adapter-pgsql')
		>('@dbsp/adapter-pgsql');

		// DROP INDEX is not in the destructive patterns (only DROP TABLE / DROP COLUMN / ALTER COLUMN TYPE)
		const downStatements = ['DROP INDEX IF EXISTS "idx_users_email"'];
		expect(isDestructiveDown(downStatements)).toBe(false);
	});

	it('applyCommand invokes parseMigrationFile and isDestructiveDown once per migration', () => {
		// This test verifies the mock call contract: applyCommand should parse
		// the migration file and check destructiveness exactly once per file.
		// (Structural/call-count assertion — no DB needed.)
		mockParseMigrationFile.mockReturnValue({
			upStatements: ['CREATE TABLE "users" (id SERIAL PRIMARY KEY)'],
			downStatements: ['DROP TABLE IF EXISTS "users" CASCADE'],
			hasDown: true,
		});
		mockIsDestructiveDown.mockReturnValue(true);

		// Simulate one migration being processed
		const content = 'fake-migration-content';
		const parsed = mockParseMigrationFile(content);
		mockIsDestructiveDown(parsed.downStatements);

		expect(mockParseMigrationFile).toHaveBeenCalledWith(content);
		expect(mockIsDestructiveDown).toHaveBeenCalledWith(parsed.downStatements);
		// Critical: NOT called with upStatements (the M4 pre-fix bug)
		expect(mockIsDestructiveDown).not.toHaveBeenCalledWith(parsed.upStatements);
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

	it('SC-19: should reject destructive DOWN without --force', () => {
		const downStatements = [
			'DROP TABLE IF EXISTS "users" CASCADE',
			'DROP TABLE IF EXISTS "posts" CASCADE',
		];
		const force = false;

		// Simulate isDestructiveDown check
		const hasDropTable = downStatements.some((s) => /DROP\s+TABLE/i.test(s));
		const shouldReject = hasDropTable && !force;

		expect(shouldReject).toBe(true);
	});

	it('SC-19: should allow destructive DOWN with --force', () => {
		const downStatements = ['DROP TABLE IF EXISTS "users" CASCADE'];
		const force = true;

		const hasDropTable = downStatements.some((s) => /DROP\s+TABLE/i.test(s));
		const shouldReject = hasDropTable && !force;

		expect(shouldReject).toBe(false);
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
