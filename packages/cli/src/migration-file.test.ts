/**
 * Tests for Migration File — filename generation, checksums, file I/O.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	computeChecksum,
	generateMigrationFilename,
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
});
