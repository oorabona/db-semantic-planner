/**
 * Migration File — File I/O, naming conventions, checksums.
 *
 * Handles reading/writing migration SQL files and computing
 * SHA-256 checksums for tamper detection.
 */

import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface MigrationFile {
	/** Filename (e.g., "0001_create_users.sql") */
	readonly name: string;
	/** Full path to the file */
	readonly path: string;
	/** SQL content */
	readonly content: string;
	/** SHA-256 checksum of content */
	readonly checksum: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default directory for migration files */
export const DEFAULT_MIGRATIONS_DIR = 'migrations';

/** Migration file naming pattern: NNNN_description.sql */
const MIGRATION_FILENAME_PATTERN = /^\d{4}_[\w-]+\.sql$/;

// ============================================================================
// Checksum
// ============================================================================

/**
 * Compute SHA-256 checksum of content.
 */
export function computeChecksum(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex');
}

// ============================================================================
// File Naming
// ============================================================================

/**
 * Generate the next migration filename.
 *
 * @param existingFiles - List of existing migration filenames
 * @param description - Human-readable description (e.g., "create_users")
 * @returns Filename (e.g., "0001_create_users.sql")
 */
export function generateMigrationFilename(
	existingFiles: readonly string[],
	description: string,
): string {
	const maxNum = existingFiles.reduce((max, f) => {
		const match = f.match(/^(\d{4})/);
		return match?.[1] ? Math.max(max, Number.parseInt(match[1], 10)) : max;
	}, 0);

	const nextNum = String(maxNum + 1).padStart(4, '0');
	const sanitized = description
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');

	return `${nextNum}_${sanitized || 'migration'}.sql`;
}

// ============================================================================
// File I/O
// ============================================================================

/**
 * Ensure the migrations directory exists.
 */
export function ensureMigrationsDir(dir: string): string {
	const fullPath = resolve(dir);
	if (!existsSync(fullPath)) {
		mkdirSync(fullPath, { recursive: true });
	}
	return fullPath;
}

/**
 * Scan migrations directory and return all valid migration files,
 * sorted by name (lexicographic = chronological with zero-padded numbers).
 */
export function scanMigrationFiles(dir: string): readonly MigrationFile[] {
	const fullPath = resolve(dir);
	if (!existsSync(fullPath)) {
		return [];
	}

	const entries = readdirSync(fullPath)
		.filter((f) => MIGRATION_FILENAME_PATTERN.test(f))
		.sort();

	return entries.map((name) => {
		const filePath = join(fullPath, name);
		const content = readFileSync(filePath, 'utf-8');
		return {
			name,
			path: filePath,
			content,
			checksum: computeChecksum(content),
		};
	});
}

/**
 * Write a migration file to the migrations directory.
 *
 * @returns The created MigrationFile
 */
export function writeMigrationFile(
	dir: string,
	filename: string,
	content: string,
): MigrationFile {
	const fullDir = ensureMigrationsDir(dir);
	const filePath = join(fullDir, filename);
	writeFileSync(filePath, content, 'utf-8');

	return {
		name: filename,
		path: filePath,
		content,
		checksum: computeChecksum(content),
	};
}
