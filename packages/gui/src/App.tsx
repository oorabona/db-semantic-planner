import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { join } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
	open as openDialog,
	message as showMessage,
} from '@tauri-apps/plugin-dialog';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import {
	FolderOpen,
	History,
	Info,
	Maximize2,
	ScrollText,
	Trash2,
	X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	Group,
	Panel,
	Separator,
	useDefaultLayout,
} from 'react-resizable-panels';
import { Toaster, toast } from 'sonner';
import { AppLogModal } from '@/components/AppLogModal';
import {
	ConnectionDialog,
	type ConnectionFormData,
} from '@/components/connection/ConnectionDialog';
import { ConnectionQuickPick } from '@/components/connection/ConnectionQuickPick';
import { PasswordPrompt } from '@/components/connection/PasswordPrompt';
import { EditorPanel } from '@/components/layout/EditorPanel';
import { ResultsPanel } from '@/components/layout/ResultsPanel';
import { Sidebar } from '@/components/layout/Sidebar';
import { CommandPalette } from '@/components/palette/CommandPalette';
import { PreferencesDialog } from '@/components/preferences/PreferencesDialog';
import { NewProjectWizard } from '@/components/project/NewProjectWizard';
import { RecentProjectsDialog } from '@/components/project/RecentProjectsDialog';
import type { WizardData } from '@/components/project/wizard-types';
import { Button } from '@/components/ui/button';
import { useAutoConnect } from '@/hooks/useAutoConnect';
import { useConnection } from '@/hooks/useConnection';
import { useFileWatcher } from '@/hooks/useFileWatcher';
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
import { findContainingRoot, validateDroppedFiles } from '@/lib/drag-drop';
import {
	closeTabWithConfirm,
	languageFromPath,
	openFile,
	saveFile,
	saveFileAs,
} from '@/lib/file-io';
import { TauriFileWatcher } from '@/lib/file-watcher';
import { sidecarApi } from '@/lib/ipc';
import { formatLogTime, LEVEL_COLORS } from '@/lib/log-utils';
import { MENU_IDS, onMenuEvent } from '@/lib/menu';
import { resolveSchemaPath } from '@/lib/settings';
import { useAssertionStore } from '@/stores/assertion-store';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import type { LogEntry } from '@/stores/log-store';
import { useLogStore } from '@/stores/log-store';
import { useProjectStore } from '@/stores/project-store';
import { useResultsStore } from '@/stores/results-store';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';

const MAIN_LAYOUT_ID = 'dbsp-main-layout';
const RIGHT_LAYOUT_ID = 'dbsp-right-layout';
const SIDEBAR_PANEL_ID = 'dbsp-main-sidebar';
const MAIN_PANEL_ID = 'dbsp-main-content';
const EDITOR_PANEL_ID = 'dbsp-right-editor';
const RESULTS_PANEL_ID = 'dbsp-right-results';

// ── App Log Popover ──────────────────────────────────────────────

function AppLogPopover({
	entries,
	onClose,
	onExpand,
	onClear,
}: {
	entries: readonly LogEntry[];
	onClose: () => void;
	onExpand: () => void;
	onClear: () => void;
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
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onClear}
						className="text-muted-foreground hover:text-foreground"
						title="Clear all app logs"
					>
						<Trash2 className="h-3 w-3" />
					</button>
					<button
						type="button"
						onClick={onExpand}
						className="text-muted-foreground hover:text-foreground"
						title="Open in modal"
					>
						<Maximize2 className="h-3 w-3" />
					</button>
					<button
						type="button"
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground"
						title="Close"
					>
						<X className="h-3 w-3" />
					</button>
				</div>
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
	const autoConnect = useAutoConnect();
	useSchemaWatcher({
		onReload: () => {
			toast.success('Schema reloaded');
		},
		onError: (msg) => {
			toast.error('Schema reload failed', { description: msg });
		},
	});
	const fileWatcher = useMemo(() => new TauriFileWatcher(), []);
	const selfWriteFilter = useFileWatcher(fileWatcher);

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
	const [showAppLogModal, setShowAppLogModal] = useState(false);

	const mainLayoutPanelIds = useMemo(
		() =>
			sidebarVisible ? [SIDEBAR_PANEL_ID, MAIN_PANEL_ID] : [MAIN_PANEL_ID],
		[sidebarVisible],
	);
	const rightLayoutPanelIds = useMemo(
		() =>
			resultsVisible ? [EDITOR_PANEL_ID, RESULTS_PANEL_ID] : [EDITOR_PANEL_ID],
		[resultsVisible],
	);
	const mainLayout = useDefaultLayout({
		id: MAIN_LAYOUT_ID,
		panelIds: mainLayoutPanelIds,
	});
	const rightLayout = useDefaultLayout({
		id: RIGHT_LAYOUT_ID,
		panelIds: rightLayoutPanelIds,
	});

	const status = useConnectionStore((s) => s.status);
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

	// ── File drag & drop from OS ──────────────────────────────────
	useEffect(() => {
		if (projectMode !== 'project') return;

		let unlisten: (() => void) | undefined;

		listen<{ paths: string[] }>('tauri://drag-drop', async (event) => {
			const store = useProjectStore.getState();
			const roots = store.settings?.project?.roots ?? [];
			const allRoots =
				roots.length > 0
					? [...roots]
					: store.folderPath
						? [store.folderPath]
						: [];
			const existingFiles = store.settings?.project?.files ?? [];

			const result = validateDroppedFiles(
				event.payload.paths,
				allRoots,
				existingFiles,
			);

			for (const absPath of result.accepted) {
				await store.addFile(absPath);
			}

			if (result.outsideRoots.length > 0) {
				toast.error('File is outside project roots');
			}
		}).then((fn) => {
			unlisten = fn;
		});

		return () => {
			unlisten?.();
		};
	}, [projectMode]);

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

	// Guard: confirm unsaved changes before closing the window
	useEffect(() => {
		const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
			const dirtyTabs = useEditorStore.getState().getDirtyTabs();
			if (dirtyTabs.length === 0) return;

			// Prevent the window from closing immediately
			event.preventDefault();

			const actions = useEditorStore.getState();
			for (const tab of dirtyTabs) {
				const closed = await closeTabWithConfirm(tab, actions);
				if (!closed) return; // user cancelled — abort close
			}
			// All dirty tabs handled — close the window
			await getCurrentWindow().destroy();
		});
		return () => {
			unlisten.then((fn) => fn());
		};
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
				selfWriteFilter.markWritten(tab.filePath);
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
				selfWriteFilter.markWritten(path);
				const { setFilePath, markSaved, setOutOfRoot } =
					useEditorStore.getState();
				setFilePath(tab.id, path);
				markSaved(tab.id);

				// SC-16/SC-17: auto-add to project or warn if outside roots
				const store = useProjectStore.getState();
				if (store.mode === 'project') {
					const roots = store.settings?.project?.roots ?? [];
					const allRoots =
						roots.length > 0
							? [...roots]
							: store.folderPath
								? [store.folderPath]
								: [];
					const root = findContainingRoot(path, allRoots);
					if (root) {
						await store.addFile(path);
						setOutOfRoot(tab.id, false);
					} else {
						setOutOfRoot(tab.id, true);
					}
				}
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
			id: 'file.new_query_sql',
			label: 'New SQL Query',
			shortcut: '⌘N',
			category: 'file',
			menuId: MENU_IDS.FILE_NEW_QUERY_SQL,
			handler: () => {
				useEditorStore.getState().addTab('sql');
			},
		});
		commandRegistry.register({
			id: 'file.new_query_nql',
			label: 'New NQL Query',
			shortcut: '⇧⌘N',
			category: 'file',
			menuId: MENU_IDS.FILE_NEW_QUERY_NQL,
			handler: () => {
				useEditorStore.getState().addTab('nql');
			},
		});
		commandRegistry.register({
			id: 'file.close_tab',
			label: 'Close Tab',
			shortcut: '⌘W',
			category: 'file',
			menuId: MENU_IDS.FILE_CLOSE_TAB,
			when: () => !!useEditorStore.getState().activeTabId,
			handler: async () => {
				const state = useEditorStore.getState();
				const tab = getActiveTab(state);
				if (!tab) return;
				await closeTabWithConfirm(tab, state);
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
				if (tab?.language !== 'assert') return;
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
			// Auto-save profile on successful connect so it appears in the connection list
			const { profiles, addProfile } = useConnectionStore.getState();
			const exists = profiles.some((p) => p.name === data.name);
			if (!exists && data.name.trim()) {
				addProfile({
					id: crypto.randomUUID(),
					name: data.name,
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
					lastUsedAt: Date.now(),
				});
			}
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
		if (profile) {
			const cfg = profile.config as Record<string, unknown>;
			return {
				name: profile.name,
				type: profile.type,
				host: (cfg.host as string) ?? 'localhost',
				port: (cfg.port as number) ?? 5432,
				database: conn.database,
				user: (cfg.user as string) ?? '',
				password: '',
				schema: conn.schema,
				sslMode: (cfg.sslMode as ConnectionFormData['sslMode']) ?? 'disable',
			};
		}
		// No saved profile (standalone connect) — build from stored connect params
		if (!conn.connectParams) return undefined;
		return {
			name: '',
			type: 'postgresql',
			host: conn.connectParams.host,
			port: conn.connectParams.port,
			database: conn.database,
			user: conn.connectParams.user,
			password: '',
			schema: conn.schema,
			sslMode: conn.connectParams.sslMode,
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
				files: data.files,
				generateSchema: data.generateSchema,
			});

			// Auto-connect to the first database after project creation
			const firstConn = data.connections[0];
			if (firstConn) {
				const fd = firstConn.formData;
				const profiles = useConnectionStore.getState().profiles;
				const profileId = profiles[0]?.id;
				try {
					await connect(
						{
							host: fd.host,
							port: fd.port,
							database: fd.database,
							user: fd.user,
							password: fd.password,
							schema: fd.schema || undefined,
							sslMode: fd.sslMode,
						},
						profileId,
					);
				} catch {
					// Connection failure is non-fatal — project is created, user can reconnect
					toast.error('Project created but could not connect to database');
				}
			}

			setWizardOpen(false);
		} catch (err) {
			const msg =
				err instanceof Error
					? err.message
					: typeof err === 'string'
						? err
						: 'Failed to create project';
			toast.error(msg);
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
				<Group
					id={MAIN_LAYOUT_ID}
					defaultLayout={mainLayout.defaultLayout}
					onLayoutChanged={mainLayout.onLayoutChanged}
					orientation="horizontal"
				>
					{/* Left: Schema sidebar (toggleable via Cmd+B) */}
					{sidebarVisible && (
						<>
							<Panel
								id={SIDEBAR_PANEL_ID}
								defaultSize="20%"
								minSize="15%"
								maxSize="40%"
							>
								<Sidebar
									onConnect={() => setDialogOpen(true)}
									onFileSelect={handleFileSelect}
									schemaEditable={schemaEditable}
									onEditSchema={handleEditSchema}
								/>
							</Panel>
							<Separator />
						</>
					)}

					{/* Right: Editor + Results (vertical split) */}
					<Panel id={MAIN_PANEL_ID} defaultSize="80%" minSize="40%">
						<Group
							id={RIGHT_LAYOUT_ID}
							defaultLayout={rightLayout.defaultLayout}
							onLayoutChanged={rightLayout.onLayoutChanged}
							orientation="vertical"
						>
							{/* Top-right: Editor */}
							<Panel id={EDITOR_PANEL_ID} defaultSize="55%" minSize="20%">
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
									<Separator />
									<Panel id={RESULTS_PANEL_ID} defaultSize="45%" minSize="15%">
										<ResultsPanel />
									</Panel>
								</>
							)}
						</Group>
					</Panel>
				</Group>
			</div>

			{/* Status bar */}
			<div className="relative flex h-6 items-center justify-between border-t bg-background px-2">
				<ConnectionQuickPick onNewConnection={() => setDialogOpen(true)} />
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
						onExpand={() => {
							setShowAppLogs(false);
							setShowAppLogModal(true);
						}}
						onClear={() => useLogStore.getState().clearApp()}
					/>
				)}
			</div>

			{/* App log modal */}
			{showAppLogModal && (
				<AppLogModal
					entries={appEntries}
					onClose={() => setShowAppLogModal(false)}
					onClear={() => useLogStore.getState().clearApp()}
				/>
			)}

			{/* Auto-connect password prompt (fired on project open) */}
			<PasswordPrompt
				open={autoConnect.promptOpen}
				profileName={autoConnect.promptProfile?.name ?? ''}
				onSubmit={autoConnect.submitPassword}
				onCancel={autoConnect.cancelPassword}
				error={autoConnect.promptError}
				connecting={autoConnect.connecting}
			/>

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

			{/* New Project Wizard — conditional render so useState initializer runs fresh */}
			{wizardOpen && (
				<NewProjectWizard
					open
					onClose={() => setWizardOpen(false)}
					onCreate={handleCreateProject}
					initialConnection={getInitialConnection()}
					onDiscover={(params) => sidecarApi.listDatabases(params)}
					onListSchemas={(params) => sidecarApi.listSchemas(params)}
					onTestConnection={handleTest}
					testing={testing}
					testResult={testResult}
					creating={wizardCreating}
				/>
			)}
		</div>
	);
}
