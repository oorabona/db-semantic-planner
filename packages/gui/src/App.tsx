import { join } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
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
import { useThemeEffect } from '@/hooks/useThemeEffect';
import { commandRegistry } from '@/lib/commands';
import {
	languageFromPath,
	openFile,
	saveFile,
	saveFileAs,
} from '@/lib/file-io';
import { sidecarApi } from '@/lib/ipc';
import { MENU_IDS, onMenuEvent } from '@/lib/menu';
import { useConnectionStore } from '@/stores/connection-store';
import { getActiveTab, useEditorStore } from '@/stores/editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';

export default function App() {
	useMonacoSetup();
	useSettingsWatcher();
	useThemeEffect();

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

	const [dialogOpen, setDialogOpen] = useState(false);
	const { status, active, error } = useConnectionStore();
	const { connect, testConnection, testResult, disconnect } = useConnection();
	const [connecting, setConnecting] = useState(false);
	const [testing, setTesting] = useState(false);

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
					{/* Left: Schema sidebar */}
					<Panel defaultSize={20} minSize={15} maxSize={40}>
						<Sidebar
							onConnect={() => setDialogOpen(true)}
							onFileSelect={handleFileSelect}
						/>
					</Panel>

					<PanelResizeHandle />

					{/* Right: Editor + Results (vertical split) */}
					<Panel defaultSize={80} minSize={40}>
						<PanelGroup autoSaveId="dbsp-right-layout" direction="vertical">
							{/* Top-right: Editor */}
							<Panel defaultSize={55} minSize={20}>
								<EditorPanel onConnect={() => setDialogOpen(true)} />
							</Panel>

							<PanelResizeHandle />

							{/* Bottom-right: Results */}
							<Panel defaultSize={45} minSize={15}>
								<ResultsPanel />
							</Panel>
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
