/**
 * Tauri-specific IPC transport implementation.
 * Bridges the IpcTransport interface to Tauri's sidecar commands + events.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { IpcTransport } from './ipc-transport';

/**
 * Creates an IpcTransport backed by Tauri sidecar commands.
 *
 * - `send` → `invoke('sidecar_send', { message })`
 * - `onMessage` → `listen('sidecar-stdout')`
 * - `onClose` → `listen('sidecar-exit')`
 */
export function createTauriTransport(): IpcTransport {
	const unlisteners: UnlistenFn[] = [];
	const pending: Promise<void>[] = [];

	return {
		send(message: string): void {
			// Fire-and-forget; errors surface via transport close
			invoke('sidecar_send', { message }).catch((err) => {
				console.error('[TauriTransport] send error:', err);
			});
		},

		onMessage(callback: (message: string) => void): void {
			const p = listen<string>('sidecar-stdout', (event) => {
				callback(event.payload);
			}).then((unlisten) => {
				unlisteners.push(unlisten);
			});
			pending.push(p);
		},

		onClose(callback: (code: number | null) => void): void {
			const p = listen<number | null>('sidecar-exit', (event) => {
				callback(event.payload);
			}).then((unlisten) => {
				unlisteners.push(unlisten);
			});
			pending.push(p);
		},

		close(): void {
			// Cleanup already-resolved listeners
			for (const unlisten of unlisteners) {
				unlisten();
			}
			unlisteners.length = 0;
			// Drain pending listen() registrations that resolved after close
			void Promise.allSettled(pending).then(() => {
				for (const unlisten of unlisteners) {
					unlisten();
				}
				unlisteners.length = 0;
			});
			pending.length = 0;
			// NOTE: Don't call sidecar_kill here. On webview reload, the cleanup's
			// fire-and-forget kill races with the new mount's sidecar_spawn, often
			// killing the freshly spawned sidecar. sidecar_spawn already handles
			// killing the old process atomically within its mutex lock.
			// On app exit, the sidecar detects stdin EOF and exits cleanly.
		},
	};
}
