/**
 * Tests for Migration File — filename generation, checksums, file I/O.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
	renameSync: vi.fn(),
	actualRenameSync: undefined as
		| ((oldPath: string, newPath: string) => void)
		| undefined,
	fsyncSync: vi.fn(),
	actualFsyncSync: undefined as ((fd: number) => void) | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	fsMock.actualRenameSync = actual.renameSync;
	fsMock.renameSync.mockImplementation(actual.renameSync);
	fsMock.actualFsyncSync = actual.fsyncSync;
	fsMock.fsyncSync.mockImplementation(actual.fsyncSync);
	return {
		...actual,
		renameSync: fsMock.renameSync,
		fsyncSync: fsMock.fsyncSync,
	};
});

import {
	computeChecksum,
	computeMigrationChecksum,
	generateMigrationFilename,
	getPreMigrationFilename,
	OrphanPreMigrationFileError,
	scanMigrationFiles,
	writeMigrationFile,
} from './migration-file.js';

// ============================================================================
// Checksum
// ============================================================================

describe('computeChecksum', () => {
	it('should produce consistent SHA-256 hex for same input', () => {
		const a = computeChecksum('CREATE TABLE "users" ("id" serial)');
		const b = computeChecksum('CREATE TABLE "users" ("id" serial)');
		expect(a).toBe(b);
		expect(a).toHaveLength(64); // SHA-256 = 64 hex chars
	});

	it('should produce different checksums for different input', () => {
		const a = computeChecksum('CREATE TABLE "users" ("id" serial)');
		const b = computeChecksum('CREATE TABLE "posts" ("id" serial)');
		expect(a).not.toBe(b);
	});

	it('should handle empty string', () => {
		const result = computeChecksum('');
		expect(result).toHaveLength(64);
	});
});

describe('computeMigrationChecksum', () => {
	it('binds a pre-phase file to its main migration checksum', () => {
		const main = 'CREATE TABLE "jobs" (id integer);\n';
		const pre = "ALTER TYPE status ADD VALUE IF NOT EXISTS 'pending';\n";

		expect(computeMigrationChecksum(main, pre)).not.toBe(
			computeMigrationChecksum(main, `${pre}-- edited\n`),
		);
		expect(computeMigrationChecksum(main, pre)).not.toBe(
			computeMigrationChecksum(`${main}-- edited\n`, pre),
		);
		expect(computeMigrationChecksum(main)).toBe(computeChecksum(main));
	});
});

// ============================================================================
// Filename Generation
// ============================================================================

describe('generateMigrationFilename', () => {
	it('should generate 0001 for empty list', () => {
		const name = generateMigrationFilename([], 'create_users');
		expect(name).toBe('0001_create_users.sql');
	});

	it('should increment from highest existing number', () => {
		const existing = [
			'0001_init.sql',
			'0002_add_users.sql',
			'0003_add_posts.sql',
		];
		const name = generateMigrationFilename(existing, 'add_comments');
		expect(name).toBe('0004_add_comments.sql');
	});

	it('should handle gaps in numbering', () => {
		const existing = ['0001_init.sql', '0005_jump.sql'];
		const name = generateMigrationFilename(existing, 'fill');
		expect(name).toBe('0006_fill.sql');
	});

	it('should sanitize description', () => {
		const name = generateMigrationFilename([], 'Add Users Table!');
		expect(name).toBe('0001_add_users_table.sql');
	});

	it('should collapse multiple underscores', () => {
		const name = generateMigrationFilename([], 'a   b---c');
		expect(name).toBe('0001_a_b---c.sql');
	});

	it('should use default description when sanitized is empty', () => {
		const name = generateMigrationFilename([], '!!!');
		expect(name).toBe('0001_migration.sql');
	});

	it('should zero-pad numbers', () => {
		const name = generateMigrationFilename([], 'test');
		expect(name).toMatch(/^\d{4}_/);
	});

	it('should handle non-migration files in existing list gracefully', () => {
		const existing = ['README.md', '0001_init.sql', 'notes.txt'];
		const name = generateMigrationFilename(existing, 'next');
		expect(name).toBe('0002_next.sql');
	});
});

// ============================================================================
// Scan Migration Files
// ============================================================================

describe('scanMigrationFiles', () => {
	it('should return empty array for non-existent directory', () => {
		const result = scanMigrationFiles('/tmp/nonexistent-dir-xyz-12345');
		expect(result).toEqual([]);
	});
});

// ============================================================================
// Write + Scan Integration (tmpdir)
// ============================================================================

describe('writeMigrationFile + scanMigrationFiles', () => {
	const tmpDir = join(
		'/tmp',
		`dbsp-test-migrations-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);

	afterEach(() => {
		// Clean up
		vi.restoreAllMocks();
	});

	it('should write file and scan it back with matching checksum', () => {
		const content = 'CREATE TABLE "users" ("id" serial PRIMARY KEY);\n';
		const file = writeMigrationFile(tmpDir, '0001_create_users.sql', content);

		expect(file.name).toBe('0001_create_users.sql');
		expect(file.content).toBe(content);
		expect(file.checksum).toBe(computeChecksum(content));
		expect(existsSync(file.path)).toBe(true);

		// Verify file on disk
		const diskContent = readFileSync(file.path, 'utf-8');
		expect(diskContent).toBe(content);

		// Scan should find it
		const scanned = scanMigrationFiles(tmpDir);
		expect(scanned).toHaveLength(1);
		const first = scanned[0]!;
		expect(first.name).toBe('0001_create_users.sql');
		expect(first.checksum).toBe(file.checksum);
	});

	it('should sort scanned files by name', () => {
		// Write in reverse order
		writeMigrationFile(
			tmpDir,
			'0003_third.sql',
			'CREATE TABLE "c" ("id" serial);\n',
		);
		writeMigrationFile(
			tmpDir,
			'0002_second.sql',
			'CREATE TABLE "b" ("id" serial);\n',
		);

		const scanned = scanMigrationFiles(tmpDir);
		const names = scanned.map((f) => f.name);
		// 0001 was written by previous test
		expect(names).toEqual([
			'0001_create_users.sql',
			'0002_second.sql',
			'0003_third.sql',
		]);
	});

	it('should ignore non-migration files', () => {
		// Write a non-migration file
		writeFileSync(join(tmpDir, 'README.md'), '# Migrations\n');
		writeFileSync(join(tmpDir, '.gitkeep'), '');

		const scanned = scanMigrationFiles(tmpDir);
		// Only .sql files matching NNNN_desc.sql pattern
		const names = scanned.map((f) => f.name);
		expect(names.every((n) => n.endsWith('.sql'))).toBe(true);
		expect(names).not.toContain('README.md');
		expect(names).not.toContain('.gitkeep');
	});

	it('keeps pre files out of discovery while binding them to the main file', () => {
		const main = 'CREATE TABLE "enum_jobs" (id integer);\n';
		const pre = "ALTER TYPE status ADD VALUE IF NOT EXISTS '$tag$';\n";
		const file = writeMigrationFile(tmpDir, '0004_enum_jobs.sql', main, pre);

		expect(existsSync(join(tmpDir, getPreMigrationFilename(file.name)))).toBe(
			true,
		);
		const scanned = scanMigrationFiles(tmpDir);
		expect(scanned.map((migration) => migration.name)).not.toContain(
			'0004_enum_jobs.pre.sql',
		);
		expect(
			scanned.find((migration) => migration.name === file.name),
		).toMatchObject({
			preContent: pre,
			checksum: file.checksum,
		});
	});

	it('fails closed when a pre file has no main sibling', () => {
		writeFileSync(join(tmpDir, '0005_orphan.pre.sql'), 'SELECT 1;\n');
		expect(() => scanMigrationFiles(tmpDir)).toThrow(
			OrphanPreMigrationFileError,
		);
	});

	it('replaces phased and unphased siblings as one recoverable publication set', () => {
		unlinkSync(join(tmpDir, '0005_orphan.pre.sql'));
		const filename = '0006_rewrite.sql';
		writeMigrationFile(tmpDir, filename, 'SELECT 1;\n', 'SELECT 2;\n');
		writeMigrationFile(tmpDir, filename, 'SELECT 3;\n');

		let scanned = scanMigrationFiles(tmpDir);
		const unphased = scanned.find((file) => file.name === filename);
		expect(unphased).toMatchObject({
			name: filename,
			content: 'SELECT 3;\n',
		});
		expect(unphased).not.toHaveProperty('preContent');

		writeMigrationFile(tmpDir, filename, 'SELECT 4;\n', 'SELECT 5;\n');
		scanned = scanMigrationFiles(tmpDir);
		expect(scanned.find((file) => file.name === filename)).toMatchObject({
			content: 'SELECT 4;\n',
			preContent: 'SELECT 5;\n',
		});
	});

	it('restores the old sidecar when publishing the replacement main file fails', () => {
		const filename = '0007_restore_sidecar.sql';
		const mainPath = join(tmpDir, filename);
		const prePath = join(tmpDir, getPreMigrationFilename(filename));
		writeMigrationFile(
			tmpDir,
			filename,
			'SELECT old_main;\n',
			'SELECT old_pre;\n',
		);
		fsMock.renameSync.mockImplementation((from, to) => {
			if (to === mainPath) throw new Error('main rename failed');
			return fsMock.actualRenameSync!(from, to);
		});

		expect(() =>
			writeMigrationFile(
				tmpDir,
				filename,
				'SELECT new_main;\n',
				'SELECT new_pre;\n',
			),
		).toThrow('main rename failed');
		expect(readFileSync(mainPath, 'utf-8')).toBe('SELECT old_main;\n');
		expect(readFileSync(prePath, 'utf-8')).toBe('SELECT old_pre;\n');
		// The mock is module-wide: leave it delegating so a test added below
		// does not inherit a failing renameSync.
		fsMock.renameSync.mockImplementation(fsMock.actualRenameSync!);
	});

	it('keeps the new sidecar when the final directory fsync fails after main publication', () => {
		const filename = '0008_keep_published_pair.sql';
		const mainPath = join(tmpDir, filename);
		const prePath = join(tmpDir, getPreMigrationFilename(filename));
		writeMigrationFile(
			tmpDir,
			filename,
			'SELECT old_main;\n',
			'SELECT old_pre;\n',
		);

		let fsyncCalls = 0;
		fsMock.fsyncSync.mockImplementation((fd: number) => {
			fsyncCalls++;
			if (fsyncCalls === 4) throw new Error('final directory fsync failed');
			return fsMock.actualFsyncSync!(fd);
		});

		expect(() =>
			writeMigrationFile(
				tmpDir,
				filename,
				'SELECT new_main;\n',
				'SELECT new_pre;\n',
			),
		).toThrow('final directory fsync failed');
		expect(readFileSync(mainPath, 'utf-8')).toBe('SELECT new_main;\n');
		expect(readFileSync(prePath, 'utf-8')).toBe('SELECT new_pre;\n');
		fsMock.fsyncSync.mockImplementation(fsMock.actualFsyncSync!);
	});
});
