import { join } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { create } from 'zustand';
import {
	type DbspSettings,
	DEFAULT_EXCLUDE,
	DEFAULT_INCLUDE,
	readSettings,
	resolveProjectSettings,
} from '@/lib/settings';

// ── Types ────────────────────────────────────────────────────────

export type ProjectMode = 'standalone' | 'project';

export interface ProjectFile {
	readonly path: string;
	readonly name: string;
	readonly isDirectory: boolean;
	readonly children?: readonly ProjectFile[];
}

// ── Store ────────────────────────────────────────────────────────

interface ProjectState {
	mode: ProjectMode;
	folderPath: string | null;
	settings: DbspSettings | null;
	files: ProjectFile[];
	loading: boolean;
	error: string | null;

	// ── Actions ──
	openFolder: (folderPath: string) => Promise<void>;
	closeFolder: () => void;
	refreshFiles: () => Promise<void>;
	/** Called when external file watcher detects settings change */
	onSettingsChanged: (exists: boolean) => Promise<void>;
}

/**
 * Match a file path against include/exclude glob patterns (simplified).
 * Supports `** /x` and `*.ext` patterns.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
	// **/*.ext → match any file ending in .ext
	if (pattern.startsWith('**/')) {
		const suffix = pattern.slice(3); // e.g., "*.dbsp"
		const fileName = filePath.split('/').pop() ?? filePath;
		return matchesGlob(fileName, suffix);
	}
	// *.ext → match filename
	if (pattern.startsWith('*.')) {
		return filePath.endsWith(pattern.slice(1));
	}
	// Exact match (for excludes like "node_modules")
	return (
		filePath === pattern ||
		filePath.includes(`/${pattern}/`) ||
		filePath.startsWith(`${pattern}/`)
	);
}

/**
 * Filter file path against include and exclude globs.
 * Returns true if the file should be included.
 */
export function shouldIncludeFile(
	relativePath: string,
	include: readonly string[],
	exclude: readonly string[],
): boolean {
	// Check excludes first
	for (const pattern of exclude) {
		if (matchesGlob(relativePath, pattern)) return false;
	}
	// Check includes
	for (const pattern of include) {
		if (matchesGlob(relativePath, pattern)) return true;
	}
	return false;
}

/**
 * Recursively discover .dbsp/.assert.dbsp files under a directory.
 * Uses Tauri readDir for filesystem access.
 */
export async function discoverFiles(
	basePath: string,
	include: readonly string[] = DEFAULT_INCLUDE,
	exclude: readonly string[] = DEFAULT_EXCLUDE,
	relativeTo = '',
): Promise<ProjectFile[]> {
	const entries = await readDir(basePath);
	const result: ProjectFile[] = [];

	for (const entry of entries) {
		const relativePath = relativeTo
			? `${relativeTo}/${entry.name}`
			: entry.name;

		if (entry.isDirectory) {
			// Skip excluded directories
			if (exclude.some((p) => entry.name === p)) continue;

			const childPath = await join(basePath, entry.name);
			const children = await discoverFiles(
				childPath,
				include,
				exclude,
				relativePath,
			);
			// Only include directories that have matching files
			if (children.length > 0) {
				result.push({
					path: relativePath,
					name: entry.name,
					isDirectory: true,
					children,
				});
			}
		} else {
			if (shouldIncludeFile(relativePath, include, exclude)) {
				result.push({
					path: relativePath,
					name: entry.name,
					isDirectory: false,
				});
			}
		}
	}

	// Sort: directories first, then alphabetical
	return result.sort((a, b) => {
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

// ── Store implementation ─────────────────────────────────────────

export const useProjectStore = create<ProjectState>((set, get) => ({
	mode: 'standalone',
	folderPath: null,
	settings: null,
	files: [],
	loading: false,
	error: null,

	openFolder: async (folderPath: string) => {
		set({ loading: true, error: null, folderPath });

		try {
			// Try to read dbsp.settings.json
			const settings = await readSettings(folderPath);

			if (settings) {
				// Project mode: settings found (precedence: defaults → project)
				const resolved = resolveProjectSettings(settings);
				const files = await discoverFiles(
					folderPath,
					resolved.include,
					resolved.exclude,
				);
				set({
					mode: 'project',
					settings,
					files,
					loading: false,
				});
			} else {
				// Standalone mode: no settings file
				set({
					mode: 'standalone',
					settings: null,
					files: [],
					loading: false,
				});
			}
		} catch (err) {
			set({
				error: err instanceof Error ? err.message : 'Failed to open folder',
				loading: false,
			});
		}
	},

	closeFolder: () => {
		set({
			mode: 'standalone',
			folderPath: null,
			settings: null,
			files: [],
			error: null,
		});
	},

	refreshFiles: async () => {
		const { folderPath, settings } = get();
		if (!folderPath || !settings) return;

		const resolved = resolveProjectSettings(settings);

		try {
			const files = await discoverFiles(
				folderPath,
				resolved.include,
				resolved.exclude,
			);
			set({ files });
		} catch (err) {
			set({
				error: err instanceof Error ? err.message : 'Failed to refresh files',
			});
		}
	},

	onSettingsChanged: async (exists: boolean) => {
		const { folderPath, mode } = get();
		if (!folderPath) return;

		if (exists && mode === 'standalone') {
			// SC-27: Settings file appeared → transition to project mode
			await get().openFolder(folderPath);
		} else if (!exists && mode === 'project') {
			// SC-28: Settings file deleted → transition to standalone
			set({
				mode: 'standalone',
				settings: null,
				files: [],
			});
		}
	},
}));
