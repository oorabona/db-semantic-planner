import { join } from '@tauri-apps/api/path';
import { type UnwatchFn, watch } from '@tauri-apps/plugin-fs';
import { useCallback, useEffect, useRef } from 'react';
import { sidecarApi } from '@/lib/ipc';
import { resolveSchemaPath } from '@/lib/settings';
import { useProjectStore } from '@/stores/project-store';

export interface SchemaWatcherCallbacks {
	/** Called when schema reload succeeds (table names refreshed) */
	onReload?: (tableNames: readonly string[]) => void;
	/** Called when schema reload fails (parse error etc.) */
	onError?: (message: string) => void;
}

/**
 * Watch a project's schema.ts file for changes.
 *
 * When the file changes (debounced 500ms), calls sidecar schema.reload
 * to re-parse the schema. On success → calls onReload. On parse error →
 * calls onError (toast) but keeps last valid schema (no tree clear).
 */
export function useSchemaWatcher(callbacks?: SchemaWatcherCallbacks) {
	const folderPath = useProjectStore((s) => s.folderPath);
	const settings = useProjectStore((s) => s.settings);
	const mode = useProjectStore((s) => s.mode);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;

	const reload = useCallback(async () => {
		if (!folderPath) return;
		try {
			const result = await sidecarApi.schemaReload(folderPath);
			callbacksRef.current?.onReload?.(result.tableNames);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : 'Schema reload failed';
			callbacksRef.current?.onError?.(message);
		}
	}, [folderPath]);

	useEffect(() => {
		if (mode !== 'project' || !folderPath || !settings?.project?.schemaPath)
			return;

		let unwatchFn: UnwatchFn | null = null;
		let cancelled = false;

		const setup = async () => {
			const schemaRelPath = await resolveSchemaPath(
				folderPath,
				settings.project?.schemaPath,
			);
			if (cancelled || !schemaRelPath) return;

			const fullPath = await join(folderPath, schemaRelPath);
			if (cancelled) return;

			unwatchFn = await watch(
				fullPath,
				(event) => {
					// Trigger reload on any modify event
					if (typeof event.type === 'object' && 'modify' in event.type) {
						reload();
					}
				},
				{ delayMs: 500 },
			);
		};

		setup();

		return () => {
			cancelled = true;
			unwatchFn?.();
		};
	}, [folderPath, mode, settings?.project?.schemaPath, reload]);

	return { reload };
}
