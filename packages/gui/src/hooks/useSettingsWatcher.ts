import { join } from '@tauri-apps/api/path';
import { type UnwatchFn, watch } from '@tauri-apps/plugin-fs';
import { useEffect } from 'react';
import { SETTINGS_FILENAME } from '@/lib/settings';
import { useProjectStore } from '@/stores/project-store';

/**
 * Watch for external creation/deletion of dbsp.settings.json.
 * SC-27: settings created → transition to project mode.
 * SC-28: settings deleted → transition to standalone.
 */
export function useSettingsWatcher() {
	const folderPath = useProjectStore((s) => s.folderPath);
	const onSettingsChanged = useProjectStore((s) => s.onSettingsChanged);

	useEffect(() => {
		if (!folderPath) return;

		let unwatchFn: UnwatchFn | null = null;
		let cancelled = false;

		const setup = async () => {
			const settingsPath = await join(folderPath, SETTINGS_FILENAME);
			if (cancelled) return;
			unwatchFn = await watch(
				settingsPath,
				(event) => {
					if (typeof event.type === 'object') {
						if ('create' in event.type) {
							onSettingsChanged(true);
						} else if ('remove' in event.type) {
							onSettingsChanged(false);
						}
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
	}, [folderPath, onSettingsChanged]);
}
