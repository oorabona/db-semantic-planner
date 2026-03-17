/**
 * React hook for file watching in project mode.
 *
 * - Watches project roots for file changes (create/modify/remove)
 * - 300ms debounce via batcher
 * - Self-write filter to ignore our own saves
 * - Respects user preference (auto-reload vs prompt)
 */
import { readTextFile } from '@tauri-apps/plugin-fs';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { isSupportedFile } from '@/lib/drag-drop';
import {
	createSelfWriteFilter,
	type FileWatcher,
	type WatchEvent,
} from '@/lib/file-watcher';
import { useEditorStore } from '@/stores/editor-store';
import { useProjectStore } from '@/stores/project-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';

/**
 * Convert an absolute watcher path to a path relative to the project root.
 * Returns null if absPath does not start with root (orphan path — skip it).
 */
function toRelative(absPath: string, root: string): string | null {
	const prefix = root.endsWith('/') ? root : `${root}/`;
	if (!absPath.startsWith(prefix)) return null;
	return absPath.slice(prefix.length);
}

export function useFileWatcher(watcher: FileWatcher | null) {
	const mode = useProjectStore((s) => s.mode);
	const folderPath = useProjectStore((s) => s.folderPath);
	const roots = useProjectStore((s) => s.settings?.project?.roots);
	const fileWatcherMode = useUserSettingsStore((s) => s.fileWatcherMode);

	const selfWriteFilter = useRef(createSelfWriteFilter());

	useEffect(() => {
		if (!watcher || mode !== 'project' || !folderPath) return;

		const watchPaths = roots && roots.length > 0 ? [...roots] : [folderPath];

		const handleEvents = async (events: readonly WatchEvent[]) => {
			const filter = selfWriteFilter.current;

			for (const event of events) {
				for (const path of event.paths) {
					if (filter.isSelfWrite(path)) continue;

					// F-001/F-002: convert absolute watcher path to relative
					// before passing to addFile/removeFile (which expect relative)
					const { folderPath: root } = useProjectStore.getState();
					if (!root) continue;
					const relPath = toRelative(path, root);
					if (!relPath) continue;

					switch (event.type) {
						case 'create':
							if (isSupportedFile(relPath)) {
								await useProjectStore.getState().addFile(relPath);
							}
							break;

						case 'remove': {
							await useProjectStore.getState().removeFile(relPath);
							// Mark open tabs for this file as deleted
							const tab = useEditorStore.getState().findTabByFilePath(path);
							if (tab) {
								useEditorStore.getState().markFileDeleted(tab.id);
							}
							break;
						}

						case 'modify': {
							const openTab = useEditorStore.getState().findTabByFilePath(path);
							if (!openTab) break;

							if (fileWatcherMode === 'auto') {
								try {
									const content = await readTextFile(path);
									useEditorStore.getState().updateContent(openTab.id, content);
									useEditorStore.getState().markSaved(openTab.id);
								} catch {
									// File might be temporarily unavailable
								}
							} else {
								toast.info(`File "${openTab.title}" changed on disk`, {
									action: {
										label: 'Reload',
										onClick: async () => {
											try {
												const content = await readTextFile(path);
												useEditorStore
													.getState()
													.updateContent(openTab.id, content);
												useEditorStore.getState().markSaved(openTab.id);
											} catch {
												toast.error('Failed to reload file');
											}
										},
									},
								});
							}
							break;
						}
					}
				}
			}
		};

		watcher.start(watchPaths, handleEvents).catch((err) => {
			console.warn('[useFileWatcher] Failed to start:', err);
		});

		return () => {
			watcher.stop().catch((err) => {
				console.warn('[useFileWatcher] Failed to stop:', err);
			});
		};
	}, [watcher, mode, folderPath, roots, fileWatcherMode]);

	return selfWriteFilter.current;
}
