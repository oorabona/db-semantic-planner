/**
 * Sidecar lifecycle management hook.
 * Spawns the sidecar process, creates TauriTransport, connects ipcClient.
 * Handles reconnection on unexpected close.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { ipcClient } from '@/lib/ipc';
import { createTauriTransport } from '@/lib/tauri-transport';
import { useSidecarStore } from '@/stores/sidecar-store';

/** Version sent during handshake — must match sidecar expectations */
const CLIENT_VERSION = '1.0.0';

/** Delay before attempting reconnection after unexpected close */
const RECONNECT_DELAY_MS = 2000;

export function useSidecarInit(): void {
	const mounted = useRef(true);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		mounted.current = true;
		const { setStatus, setError, setHeartbeat } = useSidecarStore.getState();

		async function boot(): Promise<void> {
			try {
				setStatus('spawning');

				// 1. Spawn the sidecar process
				await invoke('sidecar_spawn');
				if (!mounted.current) return;

				// 2. Create transport and connect
				const transport = createTauriTransport();
				setStatus('handshaking');

				await ipcClient.connect(transport, CLIENT_VERSION);
				if (!mounted.current) {
					ipcClient.disconnect();
					return;
				}

				setStatus('ready');
			} catch (err) {
				if (!mounted.current) return;
				const message =
					err instanceof Error ? err.message : 'Sidecar init failed';
				setStatus('stopped');
				setError(message);
			}
		}

		// Sync ipcClient status changes to the zustand store
		const unsubStatus = ipcClient.onStatusChange((status) => {
			if (mounted.current) {
				useSidecarStore.getState().setStatus(status);
			}
		});

		// Listen for heartbeat notifications from sidecar
		const unsubHeartbeat = ipcClient.onNotification('heartbeat', () => {
			if (mounted.current) {
				setHeartbeat();
			}
		});

		// Listen for sidecar stderr (log to console)
		let unlistenStderr: (() => void) | null = null;
		listen<string>('sidecar-stderr', (event) => {
			console.warn('[sidecar]', event.payload);
		}).then((unlisten) => {
			unlistenStderr = unlisten;
		});

		// Handle unexpected sidecar exit → reconnect
		let unlistenExit: (() => void) | null = null;
		listen<number | null>('sidecar-exit', (event) => {
			if (!mounted.current) return;

			const code = event.payload;
			const wasReady =
				useSidecarStore.getState().status === 'ready' ||
				useSidecarStore.getState().status === 'restarting';

			if (wasReady && code !== 0) {
				// Unexpected exit — attempt reconnection
				setStatus('restarting');
				setError(`Sidecar exited unexpectedly (code: ${code})`);
				reconnectTimer.current = setTimeout(() => {
					if (mounted.current) {
						boot();
					}
				}, RECONNECT_DELAY_MS);
			}
		}).then((unlisten) => {
			unlistenExit = unlisten;
		});

		// Boot
		boot();

		return () => {
			mounted.current = false;
			unsubStatus();
			unsubHeartbeat();
			unlistenStderr?.();
			unlistenExit?.();
			if (reconnectTimer.current) {
				clearTimeout(reconnectTimer.current);
			}
			ipcClient.disconnect();
		};
	}, []);
}
