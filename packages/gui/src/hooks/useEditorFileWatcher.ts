import { type UnwatchFn, watch } from '@tauri-apps/plugin-fs';
import { useEffect, useRef } from 'react';
import { useEditorStore } from '@/stores/editor-store';

const FILE_WATCH_DEBOUNCE_MS = 500;

/**
 * Watch open editor tabs' file paths for deletion.
 * D05: When the OS deletes a file that is open in a tab,
 * the tab title is updated to show "(deleted)".
 */
export function useEditorFileWatcher() {
	const tabs = useEditorStore((s) => s.tabs);
	const markFileDeleted = useEditorStore((s) => s.markFileDeleted);

	// Track active watchers so we can clean up per-file
	const watchersRef = useRef<Map<string, UnwatchFn>>(new Map());

	useEffect(() => {
		const currentPaths = new Set<string>();
		const toWatch: Array<{ id: string; filePath: string }> = [];

		for (const tab of tabs) {
			if (tab.filePath && !tab.deleted) {
				currentPaths.add(tab.filePath);
				// Only set up watcher for paths we're not already watching
				if (!watchersRef.current.has(tab.filePath)) {
					toWatch.push({ id: tab.id, filePath: tab.filePath });
				}
			}
		}

		// Remove watchers for files no longer open
		for (const [path, unwatch] of watchersRef.current) {
			if (!currentPaths.has(path)) {
				unwatch();
				watchersRef.current.delete(path);
			}
		}

		// Set up new watchers
		for (const { id, filePath } of toWatch) {
			let cancelled = false;

			const setup = async () => {
				try {
					const unwatchFn = await watch(
						filePath,
						(event) => {
							if (cancelled) return;
							if (typeof event.type === 'object' && 'remove' in event.type) {
								markFileDeleted(id);
								// Clean up this watcher — file is gone
								const stored = watchersRef.current.get(filePath);
								if (stored) {
									stored();
									watchersRef.current.delete(filePath);
								}
							}
						},
						{ delayMs: FILE_WATCH_DEBOUNCE_MS },
					);

					if (cancelled) {
						unwatchFn();
					} else {
						watchersRef.current.set(filePath, () => {
							cancelled = true;
							unwatchFn();
						});
					}
				} catch {
					// File may not exist yet — ignore watch setup failures
				}
			};

			setup();
		}

		// Cleanup on unmount
		return () => {
			for (const unwatch of watchersRef.current.values()) {
				unwatch();
			}
			watchersRef.current.clear();
		};
	}, [tabs, markFileDeleted]);
}
