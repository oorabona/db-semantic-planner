/**
 * Tests for sidecar-store.ts — Zustand store for sidecar lifecycle state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidecarStatus } from '@/lib/ipc-transport';
import { useSidecarStore } from './sidecar-store';

describe('useSidecarStore', () => {
	beforeEach(() => {
		// Reset store to initial state before each test
		useSidecarStore.getState().reset();
		vi.clearAllMocks();
	});

	describe('initial state', () => {
		it('should have correct initial values', () => {
			const state = useSidecarStore.getState();

			expect(state.status).toBe('stopped');
			expect(state.lastHeartbeat).toBeNull();
			expect(state.error).toBeNull();
		});
	});

	describe('setStatus', () => {
		it('should update status', () => {
			const { setStatus } = useSidecarStore.getState();

			setStatus('spawning');
			expect(useSidecarStore.getState().status).toBe('spawning');

			setStatus('handshaking');
			expect(useSidecarStore.getState().status).toBe('handshaking');

			setStatus('ready');
			expect(useSidecarStore.getState().status).toBe('ready');

			setStatus('restarting');
			expect(useSidecarStore.getState().status).toBe('restarting');

			setStatus('stopped');
			expect(useSidecarStore.getState().status).toBe('stopped');
		});

		it('should clear error when status changes', () => {
			const { setError, setStatus } = useSidecarStore.getState();

			// Set an error first
			setError('Connection failed');
			expect(useSidecarStore.getState().error).toBe('Connection failed');

			// Change status — error should be cleared
			setStatus('ready');
			expect(useSidecarStore.getState().status).toBe('ready');
			expect(useSidecarStore.getState().error).toBeNull();
		});

		it('should handle all valid status values', () => {
			const { setStatus } = useSidecarStore.getState();
			const validStatuses: SidecarStatus[] = [
				'stopped',
				'spawning',
				'handshaking',
				'ready',
				'restarting',
			];

			for (const status of validStatuses) {
				setStatus(status);
				expect(useSidecarStore.getState().status).toBe(status);
			}
		});
	});

	describe('setHeartbeat', () => {
		it('should update lastHeartbeat to current timestamp', () => {
			const { setHeartbeat } = useSidecarStore.getState();
			const beforeTime = Date.now();

			setHeartbeat();

			const afterTime = Date.now();
			const heartbeat = useSidecarStore.getState().lastHeartbeat;

			expect(heartbeat).not.toBeNull();
			expect(heartbeat).toBeGreaterThanOrEqual(beforeTime);
			expect(heartbeat).toBeLessThanOrEqual(afterTime);
		});

		it('should update heartbeat multiple times', () => {
			const { setHeartbeat } = useSidecarStore.getState();

			setHeartbeat();
			const firstHeartbeat = useSidecarStore.getState().lastHeartbeat;
			expect(firstHeartbeat).not.toBeNull();

			// Wait a tiny bit to ensure different timestamp
			vi.useFakeTimers();
			vi.advanceTimersByTime(100);

			setHeartbeat();
			vi.useRealTimers();

			const secondHeartbeat = useSidecarStore.getState().lastHeartbeat;
			expect(secondHeartbeat).not.toBeNull();
			expect(secondHeartbeat).toBeGreaterThan(firstHeartbeat!);
		});

		it('should not affect status or error', () => {
			const { setStatus, setError, setHeartbeat } = useSidecarStore.getState();

			setStatus('ready');
			setError('Test error');

			setHeartbeat();

			expect(useSidecarStore.getState().status).toBe('ready');
			expect(useSidecarStore.getState().error).toBe('Test error');
		});
	});

	describe('setError', () => {
		it('should set error message', () => {
			const { setError } = useSidecarStore.getState();

			setError('Connection timeout');
			expect(useSidecarStore.getState().error).toBe('Connection timeout');
		});

		it('should clear error when set to null', () => {
			const { setError } = useSidecarStore.getState();

			setError('Some error');
			expect(useSidecarStore.getState().error).toBe('Some error');

			setError(null);
			expect(useSidecarStore.getState().error).toBeNull();
		});

		it('should overwrite previous error', () => {
			const { setError } = useSidecarStore.getState();

			setError('First error');
			expect(useSidecarStore.getState().error).toBe('First error');

			setError('Second error');
			expect(useSidecarStore.getState().error).toBe('Second error');
		});

		it('should not affect status or heartbeat', () => {
			const { setStatus, setHeartbeat, setError } = useSidecarStore.getState();

			setStatus('ready');
			setHeartbeat();
			const heartbeat = useSidecarStore.getState().lastHeartbeat;

			setError('Test error');

			expect(useSidecarStore.getState().status).toBe('ready');
			expect(useSidecarStore.getState().lastHeartbeat).toBe(heartbeat);
		});
	});

	describe('reset', () => {
		it('should reset all state to initial values', () => {
			const { setStatus, setHeartbeat, setError, reset } =
				useSidecarStore.getState();

			// Change all state
			setStatus('ready');
			setHeartbeat();
			setError('Some error');

			expect(useSidecarStore.getState().status).toBe('ready');
			expect(useSidecarStore.getState().lastHeartbeat).not.toBeNull();
			expect(useSidecarStore.getState().error).toBe('Some error');

			// Reset
			reset();

			expect(useSidecarStore.getState().status).toBe('stopped');
			expect(useSidecarStore.getState().lastHeartbeat).toBeNull();
			expect(useSidecarStore.getState().error).toBeNull();
		});

		it('should be idempotent', () => {
			const { reset } = useSidecarStore.getState();

			reset();
			const firstState = useSidecarStore.getState();

			reset();
			const secondState = useSidecarStore.getState();

			expect(secondState).toEqual(firstState);
		});
	});

	describe('state transitions', () => {
		it('should handle typical lifecycle: stopped → spawning → handshaking → ready', () => {
			const { setStatus } = useSidecarStore.getState();

			expect(useSidecarStore.getState().status).toBe('stopped');

			setStatus('spawning');
			expect(useSidecarStore.getState().status).toBe('spawning');

			setStatus('handshaking');
			expect(useSidecarStore.getState().status).toBe('handshaking');

			setStatus('ready');
			expect(useSidecarStore.getState().status).toBe('ready');
		});

		it('should handle restart: ready → restarting → spawning → ready', () => {
			const { setStatus } = useSidecarStore.getState();

			setStatus('ready');
			expect(useSidecarStore.getState().status).toBe('ready');

			setStatus('restarting');
			expect(useSidecarStore.getState().status).toBe('restarting');

			setStatus('spawning');
			expect(useSidecarStore.getState().status).toBe('spawning');

			setStatus('ready');
			expect(useSidecarStore.getState().status).toBe('ready');
		});

		it('should handle error scenario with heartbeat tracking', () => {
			const { setStatus, setHeartbeat, setError } = useSidecarStore.getState();

			setStatus('ready');
			setHeartbeat();

			expect(useSidecarStore.getState().status).toBe('ready');
			expect(useSidecarStore.getState().lastHeartbeat).not.toBeNull();
			expect(useSidecarStore.getState().error).toBeNull();

			// Heartbeat stops coming (simulated by not calling setHeartbeat)
			// Error detected
			setError('Heartbeat timeout');

			expect(useSidecarStore.getState().error).toBe('Heartbeat timeout');
			expect(useSidecarStore.getState().status).toBe('ready'); // Status unchanged until explicit change
		});
	});

	describe('concurrent updates', () => {
		it('should handle rapid status changes', () => {
			const { setStatus } = useSidecarStore.getState();

			setStatus('spawning');
			setStatus('handshaking');
			setStatus('ready');

			expect(useSidecarStore.getState().status).toBe('ready');
		});

		it('should handle rapid heartbeat updates', () => {
			const { setHeartbeat } = useSidecarStore.getState();

			setHeartbeat();
			const first = useSidecarStore.getState().lastHeartbeat;

			vi.useFakeTimers();
			vi.advanceTimersByTime(10);
			setHeartbeat();
			vi.advanceTimersByTime(10);
			setHeartbeat();
			vi.useRealTimers();

			const last = useSidecarStore.getState().lastHeartbeat;
			expect(last).toBeGreaterThan(first!);
		});
	});
});
