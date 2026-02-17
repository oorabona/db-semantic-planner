import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import {
	open as openDialog,
	message as showMessage,
} from '@tauri-apps/plugin-dialog';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { FolderOpen, History, Info, ScrollText, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Toaster, toast } from 'sonner';
import {
	ConnectionDialog,
	type ConnectionFormData,
} from '@/components/connection/ConnectionDialog';
import { ConnectionStatus } from '@/components/connection/ConnectionStatus';
import { EditorPanel } from '@/components/layout/EditorPanel';
import { ResultsPanel } from '@/components/layout/ResultsPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog';
import { NewProjectWizard } from '@/components/project/NewProjectWizard';
import { RecentProjectsDialog } from '@/components/project/RecentProjectsDialog';
import type { WizardData } from '@/components/project/wizard-types';
import { Button } from '@/components/ui/button';
import { useConnection } from '@/hooks/useConnection';
import { useMonacoSetup } from '@/hooks/useMonacoSetup';
import { useSchemaWatcher } from '@/hooks/useSchemaWatcher';
import { useSettingsWatcher } from '@/hooks/useSettingsWatcher';
import { useSidecarInit } from '@/hooks/useSidecarInit';
import { useThemeEffect } from '@/hooks/useThemeEffect';
import {
	listRecentProjects,
	type RecentProject,
	removeRecentProject,
} from '@/lib/app-db';
import {
	ASSERTION_TIMEOUT_MS,
	validateAssertionContent,
	validateDbspContent,
	withTimeout,
} from '@/lib/assertion-limits';
import { commandRegistry } from '@/lib/commands';
import { downloadCsv, toCsv } from '@/lib/csv-export';
import {
	languageFromPath,
	openFile,
	saveFile,
	saveFileAs,
} from '@/lib/file-io';
import { sidecarApi } from '@/lib/ipc';
import { MENU_IDS, onMenuEvent } from '@/lib/menu';
import { resolveSchemaPath } from '@/lib/settings';
import { useAssertionStore } from '@/stores/assertion-store';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import type { LogEntry, LogLevel } from '@/stores/log-store';
import { useLogStore } from '@/stores/log-store';
import { useProjectStore } from '@/stores/project-store';
import { useResultsStore } from '@/stores/results-store';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';

// ── App Log Popover ──────────────────────────────────────────────

const LEVEL_COLORS: Record<LogLevel, string> = {
	info: 'text-blue-500',
	warn: 'text-yellow-500',
	error: 'text-red-500',
	debug: 'text-muted-foreground',
};

function formatLogTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function AppLogPopover({
	entries,
	onClose,
}: {
	entries: readonly LogEntry[];
	onClose: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener('mousedown', handleClick);
		return () => document.removeEventListener('mousedown', handleClick);
	}, [onClose]);

	return (
		<div
			ref={ref}
			className="absolute bottom-full right-0 mb-1 w-96 max-h-64 overflow-y-auto rounded border bg-background shadow-lg z-50"
		>
			<div className="flex items-center justify-between border-b px-3 py-1.5">
				<span className="text-xs font-medium">App Logs</span>
				<button
					type="button"
					onClick={onClose}
					className="text-muted-foreground hover:text-foreground"
				>
					<X className="h-3 w-3" />
				</button>
			</div>
			{entries.length === 0 ? (
				<div className="px-3 py-4 text-center text-xs text-muted-foreground">
					No app logs yet
				</div>
			) : (
				<div className="divide-y">
					{entries.map((entry) => (
						<div
							key={entry.id}
							className="flex gap-2 px-3 py-1 text-xs font-mono"
						>
							<span className="shrink-0 text-muted-foreground">
								{formatLogTime(entry.timestamp)}
							</span>
							<span className={`shrink-0 w-12 ${LEVEL_COLORS[entry.level]}`}>
								[{entry.level}]
							</span>
							<span className="truncate">{entry.message}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export default function App() {
	useMonacoSetup();
	useSettingsWatcher();
	useSidecarInit();
	useThemeEffect();
	useSchemaWatcher({
		onReload: () => {
			toast.success('Schema reloaded');
		},
		onError: (msg) => {
			toast.error('Schema reload failed', { description: msg });
		},
	});

	// ── State declarations (must come before effects that reference them) ──
	const [dialogOpen, setDialogOpen] = useState(false);
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [resultsVisible, setResultsVisible] = useState(true);
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);
	const [wizardOpen, setWizardOpen] = useState(false);
	const [wizardCreating, setWizardCreating] = useState(false);
	const [recentOpen, setRecentOpen] = useState(false);
	const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);

	const [showAppLogs, setShowAppLogs] = useState(false);

	const { status, active, error } = useConnectionStore();
	const projectMode = useProjectStore((s) => s.mode);
	const appEntries = useLogStore((s) => s.appEntries);
	const appLogErrorCount = appEntries.filter(
		(e) => e.level === 'error' || e.level === 'warn',
	).length;
	const projectFolderPath = useProjectStore((s) => s.folderPath);
	const projectSettings = useProjectStore((s) => s.settings);
	const { connect, testConnection, testResult, disconnect } = useConnection();

	const schemaEditable =
		projectMode === 'project' && !!projectSettings?.project?.schemaPath;

	// Recent projects handlers
	const openRecentProjects = useCallback(async () => {
		const projects = await listRecentProjects(10);
		setRecentProjects(projects);
		setRecentOpen(true);
	}, []);

	const handleOpenRecent = useCallback(async (path: string) => {
		const pathExists = await exists(path);
		if (!pathExists) {
			toast.error('Project folder not found', {
				description: path,
			});
			await removeRecentProject(path);
			setRecentProjects((prev) => prev.filter((p) => p.path !== path));
			return;
		}
		setRecentOpen(false);
		await useProjectStore.getState().openFolder(path);
	}, []);

	const handleRemoveRecent = useCallback(async (path: string) => {
		await removeRecentProject(path);
		setRecentProjects((prev) => prev.filter((p) => p.path !== path));
	}, []);

	// Forward native menu events to the command registry
	useEffect(() => {
		const promise = onMenuEvent((menuId) => {
			commandRegistry.execute(menuId);
		});
		return () => {
			promise.then((unlisten) => unlisten());
		};
	}, []);

	// Register file commands
	useEffect(() => {
		commandRegistry.register({
			id: 'file.open',
			label: 'Open File',
			shortcut: '⌘O',
			category: 'file',
			menuId: MENU_IDS.FILE_OPEN_FILE,
			handler: async () => {
				const result = await openFile();
				if (!result) return;
				const { addTab, findTabByFilePath, setActiveTab } =
					useEditorStore.getState();
				// SC-26: Focus existing tab on duplicate open
				const existing = findTabByFilePath(result.filePath);
				if (existing) {
					setActiveTab(existing.id);
					return;
				}
				addTab(result.language, result.content, result.filePath);

				// Auto-load paired .dbsp file when opening .assert.dbsp
				if (result.language === 'assert' && result.filePath) {
					const dbspPath = result.filePath.replace('.assert.dbsp', '.dbsp');
					if (!findTabByFilePath(dbspPath)) {
						try {
							const dbspContent = await readTextFile(dbspPath);
							addTab(languageFromPath(dbspPath), dbspContent, dbspPath);
						} catch (err) {
							// File-not-found is expected (user may create it later).
							// Warn on unexpected errors (permission denied, disk full).
							const msg = err instanceof Error ? err.message : String(err);
							if (!msg.includes('not found') && !msg.includes('No such file')) {
								console.warn(`Failed to load paired file ${dbspPath}: ${msg}`);
							}
						}
					}
				}
			},
		});
		commandRegistry.register({
			id: 'file.save',
			label: 'Save',
			shortcut: '⌘S',
			category: 'file',
			menuId: MENU_IDS.FILE_SAVE,
			when: () => {
				const tab = getActiveTab(useEditorStore.getState());
				return !!tab?.filePath && !!tab.dirty;
			},
			handler: async () => {
				const tab = getActiveTab(useEditorStore.getState());
				if (!tab?.filePath) return;
				await saveFile(tab.filePath, tab.content);
				useEditorStore.getState().markSaved(tab.id);
			},
		});
		commandRegistry.register({
			id: 'file.save_as',
			label: 'Save As...',
			shortcut: '⇧⌘S',
			category: 'file',
			menuId: MENU_IDS.FILE_SAVE_AS,
			handler: async () => {
				const tab = getActiveTab(useEditorStore.getState());
				if (!tab) return;
				const path = await saveFileAs(tab.content, tab.title);
				if (!path) return;
				const { setFilePath, markSaved } = useEditorStore.getState();
				setFilePath(tab.id, path);
				markSaved(tab.id);
			},
		});
		commandRegistry.register({
			id: 'file.new_project',
			label: 'New Project',
			category: 'file',
			menuId: MENU_IDS.FILE_NEW_PROJECT,
			handler: () => {
				setWizardOpen(true);
			},
		});
		commandRegistry.register({
			id: 'file.recent_projects',
			label: 'Recent Projects',
			category: 'file',
			menuId: MENU_IDS.FILE_RECENT_PROJECTS,
			handler: openRecentProjects,
		});
		commandRegistry.register({
			id: 'file.open_folder',
			label: 'Open Project',
			category: 'file',
			menuId: MENU_IDS.FILE_OPEN_FOLDER,
			handler: async () => {
				const selected = await openDialog({
					title: 'Open Project Folder',
					directory: true,
				});
				if (!selected) return;
				await useProjectStore.getState().openFolder(selected);
			},
		});
		commandRegistry.register({
			id: 'file.preferences',
			label: 'Preferences',
			shortcut: '⌘,',
			category: 'file',
			menuId: MENU_IDS.FILE_PREFERENCES,
			handler: () => {
				useUserSettingsStore.getState().openPreferences();
			},
		});
	}, []);

	// Register new query + close tab + export CSV commands
	useEffect(() => {
		commandRegistry.register({
			id: 'file.new_query',
			label: 'New Query',
			shortcut: '⌘N',
			category: 'file',
			menuId: MENU_IDS.FILE_NEW_QUERY,
			handler: () => {
				useEditorStore.getState().addTab('sql');
			},
		});
		commandRegistry.register({
			id: 'file.close_tab',
			label: 'Close Tab',
			shortcut: '⌘W',
			category: 'file',
			menuId: MENU_IDS.FILE_CLOSE_TAB,
			when: () => !!useEditorStore.getState().activeTabId,
			handler: () => {
				const { activeTabId, closeTab } = useEditorStore.getState();
				if (activeTabId) closeTab(activeTabId);
			},
		});
		commandRegistry.register({
			id: 'file.export_csv',
			label: 'Export Results (CSV)',
			shortcut: '⌘E',
			category: 'file',
			menuId: MENU_IDS.FILE_EXPORT_CSV,
			when: () => !!useResultsStore.getState().result,
			handler: () => {
				const { result } = useResultsStore.getState();
				if (!result) return;
				const csv = toCsv(result.columns, result.rows);
				downloadCsv(csv, `results-${Date.now()}.csv`);
			},
		});
	}, []);

	// Register edit commands (find, replace, format → Monaco editor actions)
	useEffect(() => {
		commandRegistry.register({
			id: 'edit.find',
			label: 'Find',
			shortcut: '⌘F',
			category: 'edit',
			menuId: MENU_IDS.EDIT_FIND,
			handler: () => {
				// Trigger Monaco's built-in find action
				const editor = (window as unknown as Record<string, unknown>)
					.__monacoEditor as
					| { trigger: (source: string, action: string) => void }
					| undefined;
				editor?.trigger('menu', 'actions.find');
			},
		});
		commandRegistry.register({
			id: 'edit.replace',
			label: 'Replace',
			shortcut: '⌘H',
			category: 'edit',
			menuId: MENU_IDS.EDIT_REPLACE,
			handler: () => {
				const editor = (window as unknown as Record<string, unknown>)
					.__monacoEditor as
					| { trigger: (source: string, action: string) => void }
					| undefined;
				editor?.trigger('menu', 'editor.action.startFindReplaceAction');
			},
		});
		commandRegistry.register({
			id: 'edit.format',
			label: 'Format Document',
			shortcut: '⇧⌘F',
			category: 'edit',
			menuId: MENU_IDS.EDIT_FORMAT,
			handler: () => {
				const editor = (window as unknown as Record<string, unknown>)
					.__monacoEditor as
					| { trigger: (source: string, action: string) => void }
					| undefined;
				editor?.trigger('menu', 'editor.action.formatDocument');
			},
		});
	}, []);

	// Register assertion command
	useEffect(() => {
		commandRegistry.register({
			id: 'editor.runAssertions',
			label: 'Run Assertions',
			shortcut: '⇧⌘T',
			category: 'edit',
			when: () => {
				const tab = getActiveTab(useEditorStore.getState());
				return tab?.language === 'assert';
			},
			handler: async () => {
				const tab = getActiveTab(useEditorStore.getState());
				if (!tab || tab.language !== 'assert') return;
				const activeConn = useConnectionStore.getState().active;
				if (!activeConn) return;

				const { setRunning, setResult, setError } =
					useAssertionStore.getState();

				// Validate assertion content (F005: resource limits)
				const assertContent = tab.content;
				const assertValidation = validateAssertionContent(assertContent);
				if (assertValidation) {
					setError(assertValidation.message);
					return;
				}

				// Derive paired .dbsp file path from .assert.dbsp path
				let dbspContent = '';
				if (tab.filePath) {
					const dbspPath = tab.filePath.replace('.assert.dbsp', '.dbsp');
					const pairedTab = useEditorStore
						.getState()
						.findTabByFilePath(dbspPath);
					if (pairedTab) {
						dbspContent = pairedTab.content;
					} else {
						try {
							dbspContent = await readTextFile(dbspPath);
						} catch {
							setError(
								`No query file found: expected ${dbspPath.split('/').pop()}`,
							);
							return;
						}
					}
				}

				// Validate .dbsp content (F005: resource limits)
				const dbspValidation = validateDbspContent(dbspContent);
				if (dbspValidation) {
					setError(dbspValidation.message);
					return;
				}

				setRunning(tab.id, tab.id);
				useResultsStore.getState().setActiveTab('assertions');

				try {
					// F006: query execution timeout
					const result = await withTimeout(
						sidecarApi.runAssertions({
							connectionId: activeConn.connectionId,
							dbspContent,
							assertContent,
						}),
						ASSERTION_TIMEOUT_MS,
						'Assertion run',
					);
					setResult(result);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : 'Assertion run failed';
					setError(message);
				}
			},
		});
	}, []);

	// Register schema diff command
	useEffect(() => {
		commandRegistry.register({
			id: 'schema.diff',
			label: 'Compare Schema with Database',
			category: 'view',
			when: () => {
				const conn = useConnectionStore.getState().active;
				const folder = useProjectStore.getState().folderPath;
				return conn !== null && folder !== null;
			},
			handler: async () => {
				const conn = useConnectionStore.getState().active;
				if (!conn) {
					await showMessage('Connect to a database first', {
						kind: 'warning',
					});
					return;
				}

				const folderPath = useProjectStore.getState().folderPath;
				if (!folderPath) {
					await showMessage(
						'Open a project folder to compare schema (File > Open Folder)',
						{ kind: 'warning' },
					);
					return;
				}

				const { setLoading, setDiff, setError } = useSchemaDiffStore.getState();
				setLoading();
				useResultsStore.getState().setActiveTab('schema-diff');

				try {
					const result = await sidecarApi.schemaDiff(
						conn.connectionId,
						folderPath,
					);
					setDiff(result);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : 'Schema diff failed';
					setError(message);
				}
			},
		});
	}, []);

	// Register view commands (toggle sidebar, toggle results, zoom)
	useEffect(() => {
		commandRegistry.register({
			id: 'view.toggle_sidebar',
			label: 'Toggle Sidebar',
			shortcut: '⌘B',
			category: 'view',
			menuId: MENU_IDS.VIEW_TOGGLE_SIDEBAR,
			handler: () => {
				setSidebarVisible((prev) => !prev);
			},
		});
		commandRegistry.register({
			id: 'view.toggle_results',
			label: 'Toggle Results Panel',
			shortcut: '⌘J',
			category: 'view',
			menuId: MENU_IDS.VIEW_TOGGLE_RESULTS,
			handler: () => {
				setResultsVisible((prev) => !prev);
			},
		});
		commandRegistry.register({
			id: 'view.history',
			label: 'Show Query History',
			category: 'view',
			icon: History,
			handler: () => {
				useResultsStore.getState().setActiveTab('history');
			},
		});
		commandRegistry.register({
			id: 'view.zoom_in',
			label: 'Zoom In',
			shortcut: '⌘=',
			category: 'view',
			menuId: MENU_IDS.VIEW_ZOOM_IN,
			handler: () => {
				document.documentElement.style.fontSize = `${Math.min(
					Number.parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					) + 1,
					24,
				)}px`;
			},
		});
		commandRegistry.register({
			id: 'view.zoom_out',
			label: 'Zoom Out',
			shortcut: '⌘-',
			category: 'view',
			menuId: MENU_IDS.VIEW_ZOOM_OUT,
			handler: () => {
				document.documentElement.style.fontSize = `${Math.max(
					Number.parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					) - 1,
					10,
				)}px`;
			},
		});
		commandRegistry.register({
			id: 'view.zoom_reset',
			label: 'Reset Zoom',
			shortcut: '⌘0',
			category: 'view',
			menuId: MENU_IDS.VIEW_ZOOM_RESET,
			handler: () => {
				document.documentElement.style.fontSize = '';
			},
		});
	}, []);

	// Register connection commands
	useEffect(() => {
		commandRegistry.register({
			id: 'connection.new',
			label: 'New Connection...',
			category: 'connection',
			menuId: MENU_IDS.CONNECTION_NEW,
			handler: () => {
				setDialogOpen(true);
			},
		});
		commandRegistry.register({
			id: 'connection.disconnect',
			label: 'Disconnect',
			category: 'connection',
			menuId: MENU_IDS.CONNECTION_DISCONNECT,
			when: () => useConnectionStore.getState().status === 'connected',
			handler: () => {
				disconnect();
			},
		});
		commandRegistry.register({
			id: 'connection.manage',
			label: 'Manage Profiles...',
			category: 'connection',
			menuId: MENU_IDS.CONNECTION_MANAGE,
			handler: () => {
				useUserSettingsStore.getState().openPreferences('databases');
			},
		});
	}, [disconnect]);

	// Register help commands
	useEffect(() => {
		commandRegistry.register({
			id: 'help.shortcuts',
			label: 'Keyboard Shortcuts',
			shortcut: '⌘?',
			category: 'help',
			menuId: MENU_IDS.HELP_SHORTCUTS,
			handler: async () => {
				await showMessage(
					'Keyboard Shortcuts\n\n' +
						'⌘N  New Query\n' +
						'⌘O  Open File\n' +
						'⌘S  Save\n' +
						'⌘W  Close Tab\n' +
						'⌘K  Command Palette\n' +
						'⌘B  Toggle Sidebar\n' +
						'⌘J  Toggle Results\n' +
						'⌘E  Export CSV\n' +
						'⌘F  Find\n' +
						'⌘H  Replace',
					{ title: 'DBSP Explorer' },
				);
			},
		});
		commandRegistry.register({
			id: 'help.docs',
			label: 'Documentation',
			category: 'help',
			menuId: MENU_IDS.HELP_DOCS,
			handler: async () => {
				await openExternal(
					'https://github.com/nicosql/db-semantic-planner#readme',
				);
			},
		});
		commandRegistry.register({
			id: 'help.about',
			label: 'About DBSP Explorer',
			category: 'help',
			menuId: MENU_IDS.HELP_ABOUT,
			handler: async () => {
				const version = await invoke<string>('plugin:app|version').catch(
					() => '0.1.0',
				);
				await showMessage(
					`DBSP Explorer v${version}\n\nSemantic database exploration tool.`,
					{
						title: 'About',
					},
				);
			},
		});
		commandRegistry.register({
			id: 'help.updates',
			label: 'Check for Updates',
			category: 'help',
			menuId: MENU_IDS.HELP_UPDATES,
			handler: async () => {
				await showMessage('You are running the latest version.', {
					title: 'Updates',
				});
			},
		});
	}, []);

	// ── File select from project tree (SC-26: dedup) ─────────────
	const handleFileSelect = useCallback(async (relativePath: string) => {
		const { folderPath } = useProjectStore.getState();
		if (!folderPath) return;

		const fullPath = await join(folderPath, relativePath);
		const { addTab, findTabByFilePath, setActiveTab } =
			useEditorStore.getState();

		// SC-26: Focus existing tab on duplicate open
		const existing = findTabByFilePath(fullPath);
		if (existing) {
			setActiveTab(existing.id);
			return;
		}

		const content = await readTextFile(fullPath);
		addTab(languageFromPath(fullPath), content, fullPath);
	}, []);

	// ── Open schema.ts in editor (Block 9: Schema Editor) ─────────
	const handleEditSchema = useCallback(async () => {
		const { folderPath, settings } = useProjectStore.getState();
		if (!folderPath || !settings?.project?.schemaPath) return;

		const schemaRelPath = await resolveSchemaPath(
			folderPath,
			settings.project.schemaPath,
		);
		if (!schemaRelPath) {
			toast.error('Schema file not found');
			return;
		}

		const fullPath = await join(folderPath, schemaRelPath);
		const { addTab, findTabByFilePath, setActiveTab } =
			useEditorStore.getState();

		// Dedup: focus existing tab if already open
		const existing = findTabByFilePath(fullPath);
		if (existing) {
			setActiveTab(existing.id);
			return;
		}

		const content = await readTextFile(fullPath);
		addTab('typescript', content, fullPath);
	}, []);

	const handleConnect = async (data: ConnectionFormData) => {
		setConnecting(true);
		try {
			await connect(data);
			setDialogOpen(false);
		} catch {
			// error handled by store
		} finally {
			setConnecting(false);
		}
	};

	const handleTest = async (data: ConnectionFormData) => {
		setTesting(true);
		try {
			await testConnection(data);
		} finally {
			setTesting(false);
		}
	};

	const handleSave = (data: ConnectionFormData) => {
		const { addProfile } = useConnectionStore.getState();
		addProfile({
			id: crypto.randomUUID(),
			name: data.name || `${data.database}@${data.host}`,
			type: data.type,
			config: {
				host: data.host,
				port: data.port,
				database: data.database,
				user: data.user,
				schema: data.schema,
				sslMode: data.sslMode,
			},
			environment: null,
			createdAt: Date.now(),
			lastUsedAt: null,
		});
	};

	/** Extract current active connection as ConnectionFormData for wizard pre-population. */
	const getInitialConnection = (): ConnectionFormData | undefined => {
		const { active: conn, profiles } = useConnectionStore.getState();
		if (!conn) return undefined;
		const profile = profiles.find((p) => p.id === conn.profileId);
		if (!profile) return undefined;
		const cfg = profile.config as Record<string, unknown>;
		return {
			name: profile.name,
			type: profile.type,
			host: (cfg.host as string) ?? 'localhost',
			port: (cfg.port as number) ?? 5432,
			database: conn.database,
			user: (cfg.user as string) ?? '',
			password: '', // Not stored in profile — user re-enters if needed
			schema: conn.schema,
			sslMode: (cfg.sslMode as ConnectionFormData['sslMode']) ?? 'disable',
		};
	};

	const handleCreateProject = async (data: WizardData) => {
		setWizardCreating(true);
		try {
			await useProjectStore.getState().createProject({
				name: data.name,
				folderPath: data.folderPath,
				connections: data.connections.map((c) => ({
					formData: c.formData,
					environment: c.environment,
				})),
				generateSchema: data.generateSchema,
			});
			setWizardOpen(false);
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : 'Failed to create project',
			);
		} finally {
			setWizardCreating(false);
		}
	};

	return (
		<div className="flex h-screen w-screen flex-col">
			{/* F004: Context-aware banner for non-project folders */}
			{projectMode === 'standalone' && projectFolderPath && (
				<div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
					<Info className="h-3.5 w-3.5 shrink-0" />
					<span>
						This folder has no{' '}
						<code className="rounded bg-muted px-1 font-mono">
							dbsp.settings.json
						</code>
						. Features like schema diff and project history are unavailable.
					</span>
					<button
						type="button"
						className="ml-auto shrink-0 text-primary hover:underline"
						onClick={() => setWizardOpen(true)}
					>
						Convert to project
					</button>
				</div>
			)}
			{/* Main layout */}
			<div className="flex-1 overflow-hidden">
				<PanelGroup autoSaveId="dbsp-main-layout" direction="horizontal">
					{/* Left: Schema sidebar (toggleable via Cmd+B) */}
					{sidebarVisible && (
						<>
							<Panel defaultSize={20} minSize={15} maxSize={40} order={1}>
								<Sidebar
									onConnect={() => setDialogOpen(true)}
									onFileSelect={handleFileSelect}
									schemaEditable={schemaEditable}
									onEditSchema={handleEditSchema}
								/>
							</Panel>
							<PanelResizeHandle />
						</>
					)}

					{/* Right: Editor + Results (vertical split) */}
					<Panel defaultSize={80} minSize={40} order={2}>
						<PanelGroup autoSaveId="dbsp-right-layout" direction="vertical">
							{/* Top-right: Editor */}
							<Panel defaultSize={55} minSize={20} order={1}>
								<EditorPanel
									onConnect={() => setDialogOpen(true)}
									onNewProject={() => setWizardOpen(true)}
									onOpenProject={() =>
										commandRegistry.execute('file.open_folder')
									}
								/>
							</Panel>

							{/* Bottom-right: Results (toggleable via Cmd+J) */}
							{resultsVisible && (
								<>
									<PanelResizeHandle />
									<Panel defaultSize={45} minSize={15} order={2}>
										<ResultsPanel />
									</Panel>
								</>
							)}
						</PanelGroup>
					</Panel>
				</PanelGroup>
			</div>

			{/* Status bar */}
			<div className="relative flex h-6 items-center justify-between border-t bg-background px-2">
				<ConnectionStatus
					status={status}
					database={active?.database}
					schema={active?.schema}
					error={error}
					onReconnect={() => setDialogOpen(true)}
				/>
				<div className="flex items-center gap-1">
					{/* Save as Project — visible in standalone mode when connected */}
					{projectMode === 'standalone' && status === 'connected' && (
						<Button
							variant="ghost"
							size="sm"
							className="h-5 gap-1 px-2 text-xs"
							onClick={() => setWizardOpen(true)}
							title="Save current session as a project"
							data-testid="save-as-project"
						>
							<FolderOpen className="h-3 w-3" />
							Save as Project
						</Button>
					)}
					<button
						type="button"
						className="relative flex items-center text-xs text-muted-foreground hover:text-foreground"
						onClick={() => setShowAppLogs((prev) => !prev)}
						title="App logs (sidecar, boot events)"
					>
						<ScrollText className="h-3.5 w-3.5" />
						{appLogErrorCount > 0 && (
							<span className="absolute -top-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-destructive text-[8px] text-destructive-foreground">
								{appLogErrorCount > 9 ? '9+' : appLogErrorCount}
							</span>
						)}
					</button>
				</div>
				{showAppLogs && (
					<AppLogPopover
						entries={appEntries}
						onClose={() => setShowAppLogs(false)}
					/>
				)}
			</div>

			{/* Toast notifications */}
			<Toaster position="bottom-right" richColors closeButton />

			{/* Command palette */}
			<CommandPalette />

			{/* Preferences dialog */}
			<PreferencesDialog />

			{/* Connection dialog */}
			<ConnectionDialog
				open={dialogOpen}
				onClose={() => setDialogOpen(false)}
				onConnect={handleConnect}
				onTest={handleTest}
				onSave={handleSave}
				onDiscover={(params) => sidecarApi.listDatabases(params)}
				onListSchemas={(params) => sidecarApi.listSchemas(params)}
				testing={testing}
				connecting={connecting}
				testResult={testResult}
			/>

			{/* Recent Projects dialog */}
			<RecentProjectsDialog
				open={recentOpen}
				onClose={() => setRecentOpen(false)}
				projects={recentProjects}
				onOpen={handleOpenRecent}
				onRemove={handleRemoveRecent}
			/>

			{/* New Project Wizard */}
			<NewProjectWizard
				open={wizardOpen}
				onClose={() => setWizardOpen(false)}
				onCreate={handleCreateProject}
				initialConnection={wizardOpen ? getInitialConnection() : undefined}
				onDiscover={(params) => sidecarApi.listDatabases(params)}
				onListSchemas={(params) => sidecarApi.listSchemas(params)}
				onTestConnection={handleTest}
				testing={testing}
				testResult={testResult}
				creating={wizardCreating}
			/>
		</div>
	);
}
