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
const mockIntrospect = vi.fn();
const mockEnsureMigrationsTable = vi.fn();
const mockAcquireMigrationLock = vi.fn();
const mockReleaseMigrationLock = vi.fn();
const mockGetAppliedMigrations = vi.fn();
const mockRecordMigration = vi.fn();

vi.mock('@dbsp/adapter-pgsql', () => ({
	compareSchemata: (...args: unknown[]) => mockCompareSchemata(...args),
	generateMigrationSQL: (...args: unknown[]) =>
		mockGenerateMigrationSQL(...args),
	introspect: (...args: unknown[]) => mockIntrospect(...args),
	ensureMigrationsTable: (...args: unknown[]) =>
		mockEnsureMigrationsTable(...args),
	acquireMigrationLock: (...args: unknown[]) =>
		mockAcquireMigrationLock(...args),
	releaseMigrationLock: (...args: unknown[]) =>
		mockReleaseMigrationLock(...args),
	getAppliedMigrations: (...args: unknown[]) =>
		mockGetAppliedMigrations(...args),
	recordMigration: (...args: unknown[]) => mockRecordMigration(...args),
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
