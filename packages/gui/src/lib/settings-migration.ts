/**
 * One-time migration from legacy include/exclude settings to explicit files[].
 *
 * When a project is opened with the old format (include/exclude glob patterns
 * but no files[]), this module scans the filesystem using those patterns and
 * populates the explicit files[] list.
 */
import { join } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { type DbspSettings, writeSettings } from './settings';

// ── Legacy glob matching (migration-only) ────────────────────────

const LEGACY_DEFAULT_INCLUDE = ['**/*.dbsp', '**/*.assert.dbsp'] as const;
const LEGACY_DEFAULT_EXCLUDE = ['node_modules', 'dist', '.git'] as const;

function matchesGlob(filePath: string, pattern: string): boolean {
	if (pattern.startsWith('**/')) {
		const suffix = pattern.slice(3);
		const fileName = filePath.split('/').pop() ?? filePath;
		return matchesGlob(fileName, suffix);
	}
	if (pattern.startsWith('*.')) {
		return filePath.endsWith(pattern.slice(1));
	}
	return (
		filePath === pattern ||
		filePath.includes(`/${pattern}/`) ||
		filePath.startsWith(`${pattern}/`)
	);
}

function shouldIncludeFile(
	relativePath: string,
	include: readonly string[],
	exclude: readonly string[],
): boolean {
	for (const pattern of exclude) {
		if (matchesGlob(relativePath, pattern)) return false;
	}
	for (const pattern of include) {
		if (matchesGlob(relativePath, pattern)) return true;
	}
	return false;
}

// ── Filesystem scan (migration-only) ─────────────────────────────

async function scanFiles(
	basePath: string,
	include: readonly string[],
	exclude: readonly string[],
	relativeTo = '',
): Promise<string[]> {
	let entries: Awaited<ReturnType<typeof readDir>>;
	try {
		entries = await readDir(basePath);
	} catch {
		return [];
	}

	const result: string[] = [];

	for (const entry of entries) {
		const relativePath = relativeTo
			? `${relativeTo}/${entry.name}`
			: entry.name;

		if (entry.isDirectory) {
			if (exclude.some((p) => entry.name === p)) continue;

			const childPath = await join(basePath, entry.name);
			try {
				const children = await scanFiles(
					childPath,
					include,
					exclude,
					relativePath,
				);
				result.push(...children);
			} catch {
				// Skip inaccessible directories
			}
		} else if (shouldIncludeFile(relativePath, include, exclude)) {
			result.push(relativePath);
		}
	}

	return result.sort((a, b) => a.localeCompare(b));
}

// ── Public API ───────────────────────────────────────────────────

/** Check if settings use the legacy include/exclude format and need migration. */
export function needsMigration(settings: DbspSettings): boolean {
	const proj = settings.project;
	if (!proj) return false;

	// Already has explicit files[] → no migration needed
	if (proj.files) return false;

	// Has legacy include/exclude → needs migration
	// Also trigger migration for projects that had implicit defaults
	// (no include/exclude means they relied on DEFAULT_INCLUDE/EXCLUDE)
	return true;
}

/**
 * Migrate legacy settings to explicit files[].
 *
 * Scans the filesystem using the old include/exclude patterns (or legacy defaults),
 * populates `project.files[]`, removes include/exclude, and saves the updated settings.
 *
 * Returns the migrated settings.
 */
export async function migrateSettings(
	settings: DbspSettings,
	folderPath: string,
): Promise<DbspSettings> {
	const proj = settings.project;

	// Use legacy patterns or defaults for scanning
	const rawProj = proj as Record<string, unknown> | undefined;
	const include =
		(rawProj?.include as readonly string[] | undefined) ??
		LEGACY_DEFAULT_INCLUDE;
	const exclude =
		(rawProj?.exclude as readonly string[] | undefined) ??
		LEGACY_DEFAULT_EXCLUDE;

	// Scan filesystem with legacy patterns
	const files = await scanFiles(folderPath, include, exclude);

	// Build migrated settings — strip include/exclude, add files
	const {
		include: _inc,
		exclude: _exc,
		...restProj
	} = (rawProj ?? {}) as Record<string, unknown>;
	const migrated: DbspSettings = {
		...settings,
		project: {
			...(restProj as Omit<typeof proj, 'include' | 'exclude'>),
			files,
		},
	};

	// Persist migrated settings
	await writeSettings(folderPath, migrated);

	return migrated;
}
