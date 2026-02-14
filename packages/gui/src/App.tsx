import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import {
	open as openDialog,
	message as showMessage,
} from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
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
import { Button } from '@/components/ui/button';
import { useConnection } from '@/hooks/useConnection';
import { useMonacoSetup } from '@/hooks/useMonacoSetup';
import { useSettingsWatcher } from '@/hooks/useSettingsWatcher';
import { useSidecarInit } from '@/hooks/useSidecarInit';
import { useThemeEffect } from '@/hooks/useThemeEffect';
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
import { useAssertionStore } from '@/stores/assertion-store';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useResultsStore } from '@/stores/results-store';
import { useSchemaDiffStore } from '@/stores/schema-diff-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';

export default function App() {
	useMonacoSetup();
	useSettingsWatcher();
	useSidecarInit();
	useThemeEffect();

	// ── State declarations (must come before effects that reference them) ──
	const [dialogOpen, setDialogOpen] = useState(false);
	const [sidebarVisible, setSidebarVisible] = useState(true);
	const [resultsVisible, setResultsVisible] = useState(true);
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);

	const { status, active, error } = useConnectionStore();
	const { connect, testConnection, testResult, disconnect } = useConnection();

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
			id: 'file.open_folder',
			label: 'Open Folder',
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

				// Derive paired .dbsp file path from .assert.dbsp path
				const assertContent = tab.content;
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
							useAssertionStore
								.getState()
								.setError(
									`No query file found: expected ${dbspPath.split('/').pop()}`,
								);
							return;
						}
					}
				}

				const { setRunning, setResult, setError } =
					useAssertionStore.getState();
				setRunning(tab.id, tab.id);
				useResultsStore.getState().setActiveTab('assertions');

				try {
					const result = await sidecarApi.runAssertions({
						connectionId: activeConn.connectionId,
						dbspContent,
						assertContent,
					});
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
			host: data.host,
			port: data.port,
			database: data.database,
			user: data.user,
			schema: data.schema,
			sslMode: data.sslMode,
		});
	};

	return (
		<div className="flex h-screen w-screen flex-col">
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
								<EditorPanel onConnect={() => setDialogOpen(true)} />
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
			<div className="flex h-6 items-center justify-between border-t bg-background px-2">
				<ConnectionStatus
					status={status}
					database={active?.database}
					schema={active?.schema}
					error={error}
					onReconnect={() => setDialogOpen(true)}
				/>
				<Button
					variant="ghost"
					size="icon"
					className="h-5 w-5"
					onClick={() =>
						status === 'connected' ? disconnect() : setDialogOpen(true)
					}
					title={status === 'connected' ? 'Disconnect' : 'New connection'}
				>
					<Plus className="h-3.5 w-3.5" />
				</Button>
			</div>

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
		</div>
	);
}
