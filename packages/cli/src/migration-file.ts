/**
 * Migration File — File I/O, naming conventions, checksums.
 *
 * Handles reading/writing migration SQL files and computing
 * SHA-256 checksums for tamper detection.
 */

import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
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
	/** Optional enum additions, applied before the main migration transaction. */
	readonly preContent?: string;
	/** SHA-256 checksum of content */
	readonly checksum: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default directory for migration files */
export const DEFAULT_MIGRATIONS_DIR = 'migrations';

/** Main migration file naming pattern: NNNN_description.sql */
const MIGRATION_FILENAME_PATTERN = /^\d{4}_[\w-]+\.sql$/;
const PRE_MIGRATION_FILENAME_PATTERN = /^(\d{4}_[\w-]+)\.pre\.sql$/;
/** A pre-phase file is meaningful only alongside its main migration. */
export class OrphanPreMigrationFileError extends Error {
	constructor(filename: string) {
		super(
			`Corrupt migration set: ${filename} has no matching main migration file.`,
		);
		this.name = 'OrphanPreMigrationFileError';
	}
}

export class InvalidMigrationFilenameError extends Error {
	constructor(filename: string) {
		super(`Invalid migration filename: ${JSON.stringify(filename)}.`);
		this.name = 'InvalidMigrationFilenameError';
	}
}

// ============================================================================
// Checksum
// ============================================================================

/**
 * Compute SHA-256 checksum of content.
 */
export function computeChecksum(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Compute a migration checksum. Legacy single-file migrations retain their
 * original checksum; phased migrations bind both sibling files into one hash.
 */
export function computeMigrationChecksum(
	content: string,
	preContent?: string,
): string {
	if (preContent === undefined) return computeChecksum(content);
	const frame = (tag: string, value: string) =>
		`${tag}:${Buffer.byteLength(value, 'utf8')}:`;
	return createHash('sha256')
		.update('dbsp:migration:v2\0', 'utf-8')
		.update(frame('main', content), 'utf-8')
		.update(content, 'utf-8')
		.update(frame('pre', preContent), 'utf-8')
		.update(preContent, 'utf-8')
		.digest('hex');
}

export function getPreMigrationFilename(filename: string): string {
	if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
		throw new InvalidMigrationFilenameError(filename);
	}
	return filename.replace(/\.sql$/, '.pre.sql');
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
	const directoryEntries = readdirSync(fullPath);
	const directoryEntrySet = new Set(directoryEntries);
	const entries = directoryEntries
		.filter((f) => MIGRATION_FILENAME_PATTERN.test(f))
		.sort();

	for (const name of directoryEntries) {
		const match = PRE_MIGRATION_FILENAME_PATTERN.exec(name);
		if (match && !directoryEntrySet.has(`${match[1]}.sql`)) {
			throw new OrphanPreMigrationFileError(name);
		}
	}

	return entries.map((name) => {
		const filePath = join(fullPath, name);
		const content = readFileSync(filePath, 'utf-8');
		const prePath = join(fullPath, getPreMigrationFilename(name));
		const preContent = existsSync(prePath)
			? readFileSync(prePath, 'utf-8')
			: undefined;
		return {
			name,
			path: filePath,
			content,
			...(preContent === undefined ? {} : { preContent }),
			checksum: computeMigrationChecksum(content, preContent),
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
	preContent?: string,
): MigrationFile {
	const fullDir = ensureMigrationsDir(dir);
	if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
		throw new InvalidMigrationFilenameError(filename);
	}
	const filePath = join(fullDir, filename);
	const preFilename = getPreMigrationFilename(filename);
	const prePath = join(fullDir, preFilename);
	// Migration files are generated source, not durable state: what has actually
	// been applied lives in the `_dbsp_migrations` table, and the files
	// themselves are versioned and regenerable. So publication is ordered, not
	// transactional. Ordinary failures restore the old sidecar from memory, but
	// a process crash between renames remains an accepted source-generation
	// window: applied state lives in `_dbsp_migrations`, and an orphan sidecar is
	// refused by scanMigrationFiles() with OrphanPreMigrationFileError.
	// Concurrent writers for the same migration name are out of scope; callers
	// must serialize generation of a named migration.
	let mainTemp: string | undefined;
	let preTemp: string | undefined;
	const oldPreContent = existsSync(prePath)
		? readFileSync(prePath, 'utf-8')
		: undefined;
	let prePublished = false;
	let mainPublished = false;
	try {
		mainTemp = writeTemporaryFile(fullDir, filename, content);
		if (preContent !== undefined) {
			preTemp = writeTemporaryFile(fullDir, preFilename, preContent);
			renameSync(preTemp, prePath);
			preTemp = undefined;
			prePublished = true;
			fsyncDirectory(fullDir);
		} else if (existsSync(prePath)) {
			// Rewriting a phased migration as unphased: drop the stale sidecar
			// before publishing the new main, never after.
			unlinkSync(prePath);
			prePublished = true;
			fsyncDirectory(fullDir);
		}
		renameSync(mainTemp, filePath);
		mainTemp = undefined;
		mainPublished = true;
		fsyncDirectory(fullDir);
	} catch (error) {
		if (mainTemp && existsSync(mainTemp)) unlinkSync(mainTemp);
		if (preTemp && existsSync(preTemp)) unlinkSync(preTemp);
		if (prePublished && !mainPublished) {
			if (oldPreContent === undefined) {
				if (existsSync(prePath)) unlinkSync(prePath);
			} else {
				writeFileSync(prePath, oldPreContent, 'utf-8');
			}
		}
		throw error;
	}

	return {
		name: filename,
		path: filePath,
		content,
		...(preContent === undefined ? {} : { preContent }),
		checksum: computeMigrationChecksum(content, preContent),
	};
}

function writeTemporaryFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const path = join(
		dir,
		`.${filename}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	let fd: number | undefined;
	try {
		fd = openSync(path, 'wx');
		writeFileSync(fd, content, 'utf-8');
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		return path;
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// The original write/sync/close error is the useful diagnostic.
			}
		}
		if (existsSync(path)) unlinkSync(path);
		throw error;
	}
}

function fsyncDirectory(dir: string): void {
	const fd = openSync(dir, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
