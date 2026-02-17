import { join } from '@tauri-apps/api/path';
import { readDir } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { create } from 'zustand';
import { addRecentProject } from '@/lib/app-db';
import { migrateFromLocalStorage } from '@/lib/migration';
import {
	closeProjectDb,
	getProjectDb,
	openDefaultDb,
	openProjectDb,
} from '@/lib/project-db';
import { sanitizeFolderName } from '@/lib/project-id';
import {
	type DbspSettings,
	DEFAULT_EXCLUDE,
	DEFAULT_INCLUDE,
	readSettings,
	resolveProjectSettings,
	writeSettings,
} from '@/lib/settings';
import { useConnectionStore } from './connection-store';
import { setHistoryDbAccessor, useHistoryStore } from './history-store';

/**
 * Shared DB-reset logic for transitioning back to standalone mode.
 * Used by closeFolder() and onSettingsChanged() (F009 DRY extraction).
 */
async function resetToStandalone(): Promise<void> {
	await closeProjectDb();
	await openDefaultDb((uri) => {
		toast.warning(
			`Database appears corrupted (${uri}). A fresh database was created.`,
		);
	});
	setHistoryDbAccessor(getProjectDb);
	useConnectionStore.setState({ profiles: [] });
	useHistoryStore.setState({ entries: [], loaded: false });
}

/**
 * Extract a human-readable message from any thrown value.
 * Tauri plugin errors are often plain strings or objects, not Error instances.
 */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'string') return err;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

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
	/** Sanitized folder name used for project DB storage path */
	folderName: string | null;
	settings: DbspSettings | null;
	files: ProjectFile[];
	loading: boolean;
	error: string | null;

	// ── Actions ──
	openFolder: (folderPath: string) => Promise<void>;
	closeFolder: () => Promise<void>;
	refreshFiles: () => Promise<void>;
	/** Called when external file watcher detects settings change */
	onSettingsChanged: (exists: boolean) => Promise<void>;
	/** Create a new project: write settings, open folder, save connections */
	createProject: (data: {
		name: string;
		folderPath: string;
		connections: ReadonlyArray<{
			formData: import('@/components/connection/ConnectionDialog').ConnectionFormData;
			environment: string;
		}>;
		generateSchema: boolean;
	}) => Promise<void>;
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
			let children: ProjectFile[];
			try {
				children = await discoverFiles(
					childPath,
					include,
					exclude,
					relativePath,
				);
			} catch {
				// Skip directories we can't read (Tauri scope restrictions, permissions, etc.)
				continue;
			}
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
	folderName: null,
	settings: null,
	files: [],
	loading: false,
	error: null,

	openFolder: async (folderPath: string) => {
		set({ loading: true, error: null, folderPath });

		try {
			// Step 1: Try to read dbsp.settings.json
			let settings: DbspSettings | null;
			try {
				settings = await readSettings(folderPath);
			} catch (err) {
				throw new Error(`Read settings: ${errorMessage(err)}`);
			}

			if (settings) {
				// Project mode: settings found (precedence: defaults → project)
				const resolved = resolveProjectSettings(settings);

				// Step 2: Discover project files
				let files: ProjectFile[];
				try {
					files = await discoverFiles(
						folderPath,
						resolved.include,
						resolved.exclude,
					);
				} catch (err) {
					throw new Error(`Discover files: ${errorMessage(err)}`);
				}

				// Derive folder name from project name (preferred) or path basename
				const rawName =
					settings.project?.name ?? folderPath.split('/').pop() ?? 'project';
				const folderName = sanitizeFolderName(rawName);

				// Step 3: Open project-specific SQLite database
				await closeProjectDb();
				try {
					await openProjectDb(folderName, (uri) => {
						toast.warning(
							`Database appears corrupted (${uri}). A fresh database was created.`,
						);
					});
				} catch (err) {
					throw new Error(`Open project DB: ${errorMessage(err)}`);
				}

				// Wire history store to project DB
				setHistoryDbAccessor(getProjectDb);

				// Migrate localStorage data to SQLite (idempotent, first-open only)
				const db = getProjectDb();
				if (db) {
					await migrateFromLocalStorage(db).catch((err) =>
						console.warn('[migration]', err),
					);
				}

				// Step 4: Load persisted data from project DB
				try {
					await useConnectionStore.getState().loadProfiles();
					await useHistoryStore.getState().loadHistory();
				} catch (err) {
					throw new Error(`Load profiles/history: ${errorMessage(err)}`);
				}

				// Track as recent project in app.sqlite
				addRecentProject(folderPath, rawName, folderName).catch(() => {});

				set({
					mode: 'project',
					folderName,
					settings,
					files,
					loading: false,
				});
			} else {
				// Standalone mode: no settings file
				set({
					mode: 'standalone',
					folderName: null,
					settings: null,
					files: [],
					loading: false,
				});
			}
		} catch (err) {
			const msg = errorMessage(err);
			console.error('[project-store] openFolder failed:', msg, err);
			set({ error: msg, loading: false });
		}
	},

	closeFolder: async () => {
		await resetToStandalone();
		set({
			mode: 'standalone',
			folderPath: null,
			folderName: null,
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
			set({ error: `Refresh files: ${errorMessage(err)}` });
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
			await resetToStandalone();
			set({
				mode: 'standalone',
				folderName: null,
				settings: null,
				files: [],
			});
		}
	},

	createProject: async (data) => {
		set({ loading: true, error: null });

		try {
			// 1. Write dbsp.settings.json to the chosen folder
			const settings: DbspSettings = {
				version: 1,
				project: { name: data.name },
			};
			await writeSettings(data.folderPath, settings);

			// 2. Open the folder (transitions to project mode, inits DB)
			await get().openFolder(data.folderPath);

			// Check openFolder succeeded (it catches errors internally)
			const state = get();
			if (state.error) {
				throw new Error(state.error);
			}
			if (state.mode !== 'project') {
				throw new Error('Failed to initialize project database');
			}

			// 3. Save wizard connections as connection profiles
			const store = useConnectionStore.getState();
			for (const conn of data.connections) {
				const { formData, environment } = conn;
				store.addProfile({
					id: crypto.randomUUID(),
					name: formData.name || `${formData.database}@${formData.host}`,
					type: formData.type,
					config: {
						host: formData.host,
						port: formData.port,
						database: formData.database,
						user: formData.user,
						schema: formData.schema,
						sslMode: formData.sslMode,
					},
					environment,
					createdAt: Date.now(),
					lastUsedAt: null,
				});
			}
		} catch (err) {
			const msg = errorMessage(err);
			console.error('[project-store] createProject failed:', msg, err);
			set({ error: msg, loading: false });
			throw err;
		}
	},
}));
