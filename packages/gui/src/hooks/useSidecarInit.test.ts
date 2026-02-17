// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSidecarStore } from '@/stores/sidecar-store.js';

// Mock Tauri APIs
const mockInvoke = vi.fn();
const mockListen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
	listen: (event: string, handler: unknown) => mockListen(event, handler),
}));

// Mock ipcClient
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockOnStatusChange = vi.fn((_cb: unknown) => vi.fn());
const mockOnNotification = vi.fn((..._args: unknown[]) => vi.fn());

vi.mock('@/lib/ipc.js', () => ({
	ipcClient: {
		connect: (...args: unknown[]) => mockConnect(...args),
		disconnect: () => mockDisconnect(),
		onStatusChange: (cb: unknown) => mockOnStatusChange(cb),
		onNotification: (...args: unknown[]) => mockOnNotification(...args),
	},
}));

// Mock transport creation
const mockTransport = {
	send: vi.fn(),
	onMessage: vi.fn(),
	onClose: vi.fn(),
	close: vi.fn(),
};

vi.mock('@/lib/tauri-transport.js', () => ({
	createTauriTransport: () => mockTransport,
}));

// Mock log-db to prevent tauri-plugin-sql import
vi.mock('@/lib/log-db', () => ({
	initLogDb: vi.fn(async () => {}),
	closeLogDb: vi.fn(async () => {}),
	insertLog: vi.fn(async () => {}),
	queryLogs: vi.fn(async () => []),
	getLogStats: vi.fn(async () => ({ total: 0, byLevel: {} })),
	clearLogs: vi.fn(async () => {}),
	rotateOldLogs: vi.fn(async () => 0),
	exportLogs: vi.fn(async () => []),
	rowToEntry: vi.fn((r: unknown) => r),
}));

import { useSidecarInit } from './useSidecarInit.js';

describe('useSidecarInit', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		mockConnect.mockResolvedValue(undefined);
		mockListen.mockResolvedValue(vi.fn());

		// Reset store
		useSidecarStore.setState({
			status: 'stopped',
			error: null,
			lastHeartbeat: null,
		});
	});

	it('spawns sidecar and connects ipcClient on mount', async () => {
		renderHook(() => useSidecarInit());

		// Should invoke sidecar_spawn
		await vi.waitFor(() => {
			expect(mockInvoke).toHaveBeenCalledWith('sidecar_spawn');
		});

		// Should connect ipcClient with transport and version
		await vi.waitFor(() => {
			expect(mockConnect).toHaveBeenCalledWith(mockTransport, '1.0.0');
		});

		// Store should transition to ready
		await vi.waitFor(() => {
			expect(useSidecarStore.getState().status).toBe('ready');
		});
	});

	it('transitions through spawning → handshaking → ready', async () => {
		const statuses: string[] = [];
		useSidecarStore.subscribe((state) => {
			statuses.push(state.status);
		});

		renderHook(() => useSidecarInit());

		await vi.waitFor(() => {
			expect(useSidecarStore.getState().status).toBe('ready');
		});

		expect(statuses).toContain('spawning');
		expect(statuses).toContain('handshaking');
		expect(statuses).toContain('ready');
	});

	it('sets error and stopped status on spawn failure', async () => {
		mockInvoke.mockRejectedValue(new Error('spawn failed'));

		renderHook(() => useSidecarInit());

		await vi.waitFor(() => {
			expect(useSidecarStore.getState().status).toBe('stopped');
		});
		expect(useSidecarStore.getState().error).toBe('spawn failed');
	});

	it('sets error and stopped status on connect failure', async () => {
		mockConnect.mockRejectedValue(new Error('handshake failed'));

		renderHook(() => useSidecarInit());

		await vi.waitFor(() => {
			expect(useSidecarStore.getState().status).toBe('stopped');
		});
		expect(useSidecarStore.getState().error).toBe('handshake failed');
	});

	it('subscribes to ipcClient status changes', () => {
		renderHook(() => useSidecarInit());

		expect(mockOnStatusChange).toHaveBeenCalledWith(expect.any(Function));
	});

	it('subscribes to heartbeat notifications', () => {
		renderHook(() => useSidecarInit());

		expect(mockOnNotification).toHaveBeenCalledWith(
			'heartbeat',
			expect.any(Function),
		);
	});

	it('listens for sidecar-stderr events', () => {
		renderHook(() => useSidecarInit());

		expect(mockListen).toHaveBeenCalledWith(
			'sidecar-stderr',
			expect.any(Function),
		);
	});

	it('listens for sidecar-exit events', () => {
		renderHook(() => useSidecarInit());

		expect(mockListen).toHaveBeenCalledWith(
			'sidecar-exit',
			expect.any(Function),
		);
	});

	it('cleans up on unmount', async () => {
		const { unmount } = renderHook(() => useSidecarInit());

		await vi.waitFor(() => {
			expect(useSidecarStore.getState().status).toBe('ready');
		});

		unmount();

		expect(mockDisconnect).toHaveBeenCalled();
	});

	it('does not update store after unmount during connect', async () => {
		// Make connect slow so we can unmount during it
		mockConnect.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(resolve, 100);
				}),
		);

		const { unmount } = renderHook(() => useSidecarInit());

		// Unmount before connect resolves
		unmount();

		// Wait for connect to resolve
		await new Promise((resolve) => {
			setTimeout(resolve, 150);
		});

		// Should have disconnected since we unmounted during connect
		expect(mockDisconnect).toHaveBeenCalled();
	});

	describe('reconnection on unexpected exit', () => {
		it('attempts reconnection when sidecar exits unexpectedly while ready', async () => {
			let exitHandler: any = null;
			mockListen.mockImplementation((eventName: string, handler: unknown) => {
				if (eventName === 'sidecar-exit') {
					exitHandler = handler;
				}
				return Promise.resolve(vi.fn());
			});

			renderHook(() => useSidecarInit());

			// Wait for ready state
			await vi.waitFor(() => {
				expect(useSidecarStore.getState().status).toBe('ready');
			});

			// Clear invoke calls from initial boot
			mockInvoke.mockClear();
			mockConnect.mockClear();

			// Switch to fake timers BEFORE triggering exit handler
			// so setTimeout(2000) inside the handler uses the fake clock
			vi.useFakeTimers();

			// Simulate unexpected exit
			exitHandler?.({ payload: 1 });

			expect(useSidecarStore.getState().status).toBe('restarting');
			expect(useSidecarStore.getState().error).toContain(
				'Sidecar exited unexpectedly',
			);

			// Advance past reconnect delay (2000ms)
			await vi.advanceTimersByTimeAsync(2000);

			vi.useRealTimers();

			// Should attempt to re-spawn
			await vi.waitFor(() => {
				expect(mockInvoke).toHaveBeenCalledWith('sidecar_spawn');
			});
		});

		it('does not reconnect on clean exit (code 0)', async () => {
			let exitHandler: any = null;
			mockListen.mockImplementation((eventName: string, handler: unknown) => {
				if (eventName === 'sidecar-exit') {
					exitHandler = handler;
				}
				return Promise.resolve(vi.fn());
			});

			renderHook(() => useSidecarInit());

			await vi.waitFor(() => {
				expect(useSidecarStore.getState().status).toBe('ready');
			});

			mockInvoke.mockClear();

			// Simulate clean exit (code 0)
			exitHandler?.({ payload: 0 });

			// Status should NOT change to restarting
			expect(useSidecarStore.getState().status).toBe('ready');
		});
	});
});
