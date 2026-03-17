import { join } from '@tauri-apps/api/path';
import { remove, rename } from '@tauri-apps/plugin-fs';
import { toast } from 'sonner';
import { create } from 'zustand';
import { addRecentProject } from '@/lib/app-db';
import { migrateFromLocalStorage } from '@/lib/migration';
import { buildPairedTree, type PairedTreeNode } from '@/lib/paired-tree';
import {
	closeProjectDb,
	getProjectDb,
	openDefaultDb,
	openProjectDb,
} from '@/lib/project-db';
import { sanitizeFolderName } from '@/lib/project-id';
import {
	type DbspSettings,
	readSettings,
	resolveProjectSettings,
	writeSettings,
} from '@/lib/settings';
import { migrateSettings, needsMigration } from '@/lib/settings-migration';
import { useConnectionStore } from './connection-store';
import { useEditorStore } from './editor-store';
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

// ── Store ────────────────────────────────────────────────────────

interface ProjectState {
	mode: ProjectMode;
	folderPath: string | null;
	/** Sanitized folder name used for project DB storage path */
	folderName: string | null;
	settings: DbspSettings | null;
	files: PairedTreeNode[];
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
		files?: readonly string[];
		generateSchema: boolean;
	}) => Promise<void>;
	/** Add a file path to the project's explicit files[] list */
	addFile: (relativePath: string) => Promise<void>;
	/** Remove a file path from the project's files[] list (does NOT delete from disk) */
	removeFile: (relativePath: string) => Promise<void>;
	/** Remove from files[] AND delete from disk */
	deleteFile: (relativePath: string) => Promise<void>;
	/** Rename a file on disk and update files[] */
	renameFile: (
		oldRelativePath: string,
		newRelativePath: string,
	) => Promise<void>;
	/** File search filter for the file tree */
	fileSearchFilter: string;
	setFileSearchFilter: (filter: string) => void;
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
	fileSearchFilter: '',
	setFileSearchFilter: (filter: string) => set({ fileSearchFilter: filter }),

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
				// Migrate legacy include/exclude → explicit files[] (one-time)
				if (needsMigration(settings)) {
					try {
						settings = await migrateSettings(settings, folderPath);
					} catch (err) {
						throw new Error(`Migrate settings: ${errorMessage(err)}`);
					}
				}

				// Project mode: build file tree from explicit files[]
				const resolved = resolveProjectSettings(settings);
				const files = buildPairedTree(resolved.files, resolved.roots);

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
		set({ files: buildPairedTree(resolved.files, resolved.roots) });
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
				project: {
					name: data.name,
					...(data.files && data.files.length > 0
						? { files: [...data.files].sort((a, b) => a.localeCompare(b)) }
						: {}),
				},
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

	addFile: async (relativePath: string) => {
		const { folderPath, settings } = get();
		if (!folderPath || !settings) return;

		// Normalize: convert absolute path to relative if needed
		const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
		let normalized: string;
		if (relativePath.startsWith(prefix)) {
			normalized = relativePath.slice(prefix.length);
		} else if (relativePath.startsWith('/')) {
			// Absolute path outside project root → reject (ERR-01)
			toast.error('File is outside project roots');
			return;
		} else {
			normalized = relativePath;
		}

		const currentFiles = settings.project?.files ?? [];
		if (currentFiles.includes(normalized)) return; // already tracked

		const updatedSettings: DbspSettings = {
			...settings,
			project: {
				...settings.project,
				files: [...currentFiles, normalized].sort((a, b) => a.localeCompare(b)),
			},
		};

		await writeSettings(folderPath, updatedSettings);
		const resolved = resolveProjectSettings(updatedSettings);
		set({
			settings: updatedSettings,
			files: buildPairedTree(resolved.files, resolved.roots),
		});
	},

	removeFile: async (relativePath: string) => {
		const { folderPath, settings } = get();
		if (!folderPath || !settings) return;

		const currentFiles = settings.project?.files ?? [];
		const updatedSettings: DbspSettings = {
			...settings,
			project: {
				...settings.project,
				files: currentFiles.filter((f) => f !== relativePath),
			},
		};

		await writeSettings(folderPath, updatedSettings);
		const resolved = resolveProjectSettings(updatedSettings);
		set({
			settings: updatedSettings,
			files: buildPairedTree(resolved.files, resolved.roots),
		});
	},

	deleteFile: async (relativePath: string) => {
		const { folderPath, settings } = get();
		if (!folderPath || !settings) return;

		// Remove from files[] and save settings
		const currentFiles = settings.project?.files ?? [];
		const updatedSettings: DbspSettings = {
			...settings,
			project: {
				...settings.project,
				files: currentFiles.filter((f) => f !== relativePath),
			},
		};

		// Delete from disk
		const fullPath = await join(folderPath, relativePath);
		try {
			await remove(fullPath);
		} catch {
			// File may already be gone — continue with settings update
		}

		await writeSettings(folderPath, updatedSettings);
		const resolved = resolveProjectSettings(updatedSettings);
		set({
			settings: updatedSettings,
			files: buildPairedTree(resolved.files, resolved.roots),
		});
	},

	renameFile: async (oldRelativePath: string, newRelativePath: string) => {
		const { folderPath, settings } = get();
		if (!folderPath || !settings) return;

		try {
			const oldFull = await join(folderPath, oldRelativePath);
			const newFull = await join(folderPath, newRelativePath);
			await rename(oldFull, newFull);

			// Update any open tab that references the old path
			useEditorStore.getState().updateTabPath(oldRelativePath, newRelativePath);

			const currentFiles = settings.project?.files ?? [];
			const updatedSettings: DbspSettings = {
				...settings,
				project: {
					...settings.project,
					files: currentFiles
						.map((f) => (f === oldRelativePath ? newRelativePath : f))
						.sort((a, b) => a.localeCompare(b)),
				},
			};
			await writeSettings(folderPath, updatedSettings);
			const resolved = resolveProjectSettings(updatedSettings);
			set({
				settings: updatedSettings,
				files: buildPairedTree(resolved.files, resolved.roots),
			});
		} catch (err) {
			toast.error(`Rename failed: ${errorMessage(err)}`);
		}
	},
}));
