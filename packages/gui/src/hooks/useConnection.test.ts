// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '@/stores/connection-store.js';
import { useConnection } from './useConnection.js';

// Mock the IPC module
vi.mock('@/lib/ipc.js', () => ({
	sidecarApi: {
		connect: vi.fn(),
		disconnect: vi.fn(),
	},
}));

// Import after mock to get the mocked version
import { sidecarApi } from '@/lib/ipc.js';

describe('useConnection', () => {
	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks();

		// Reset zustand store state
		useConnectionStore.setState({
			active: null,
			status: 'disconnected',
			error: null,
			profiles: [],
		});
	});

	describe('connect', () => {
		it('calls sidecarApi.connect, sets active connection, and returns result', async () => {
			const mockResult = {
				connectionId: 'conn-123',
				database: 'testdb',
				schema: 'public',
			};
			vi.mocked(sidecarApi.connect).mockResolvedValue(mockResult);

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			const returnValue = await result.current.connect(
				connectParams,
				'profile-1',
			);

			expect(sidecarApi.connect).toHaveBeenCalledWith(connectParams);
			expect(returnValue).toEqual(mockResult);

			const state = useConnectionStore.getState();
			expect(state.active).toEqual({
				connectionId: 'conn-123',
				profileId: 'profile-1',
				database: 'testdb',
				schema: 'public',
			});
		});

		it("sets status to 'connecting' before API call", async () => {
			const mockResult = {
				connectionId: 'conn-123',
				database: 'testdb',
				schema: 'public',
			};

			let capturedStatus = '';
			vi.mocked(sidecarApi.connect).mockImplementation(async () => {
				capturedStatus = useConnectionStore.getState().status;
				return mockResult;
			});

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await result.current.connect(connectParams);

			expect(capturedStatus).toBe('connecting');
		});

		it('defaults profileId to empty string when not provided', async () => {
			const mockResult = {
				connectionId: 'conn-123',
				database: 'testdb',
				schema: 'public',
			};
			vi.mocked(sidecarApi.connect).mockResolvedValue(mockResult);

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await result.current.connect(connectParams);

			const state = useConnectionStore.getState();
			expect(state.active?.profileId).toBe('');
		});

		it("sets status to 'error' with message and re-throws error on failure", async () => {
			const error = new Error('Database not found');
			vi.mocked(sidecarApi.connect).mockRejectedValue(error);

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await expect(result.current.connect(connectParams)).rejects.toThrow(
				'Database not found',
			);

			const state = useConnectionStore.getState();
			expect(state.status).toBe('error');
			expect(state.error).toBe('Database not found');
		});

		it("uses fallback 'Connection failed' message for non-Error exceptions", async () => {
			vi.mocked(sidecarApi.connect).mockRejectedValue('string error');

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await expect(result.current.connect(connectParams)).rejects.toEqual(
				'string error',
			);

			const state = useConnectionStore.getState();
			expect(state.status).toBe('error');
			expect(state.error).toBe('Connection failed');
		});
	});

	describe('disconnect', () => {
		it('calls sidecarApi.disconnect with active connectionId, then clearActive', async () => {
			// Set up an active connection
			useConnectionStore.setState({
				active: {
					connectionId: 'conn-123',
					profileId: 'profile-1',
					database: 'testdb',
					schema: 'public',
				},
				status: 'connected',
				error: null,
				profiles: [],
			});

			vi.mocked(sidecarApi.disconnect).mockResolvedValue({ ok: true });

			const { result } = renderHook(() => useConnection());

			await result.current.disconnect();

			expect(sidecarApi.disconnect).toHaveBeenCalledWith({
				connectionId: 'conn-123',
			});

			const state = useConnectionStore.getState();
			expect(state.active).toBeNull();
		});

		it('just calls clearActive without API call when no active connection', async () => {
			// Ensure no active connection
			useConnectionStore.setState({
				active: null,
				status: 'disconnected',
				error: null,
				profiles: [],
			});

			const { result } = renderHook(() => useConnection());

			await result.current.disconnect();

			expect(sidecarApi.disconnect).not.toHaveBeenCalled();

			const state = useConnectionStore.getState();
			expect(state.active).toBeNull();
		});

		it('swallows sidecar disconnect error and still calls clearActive', async () => {
			// Set up an active connection
			useConnectionStore.setState({
				active: {
					connectionId: 'conn-123',
					profileId: 'profile-1',
					database: 'testdb',
					schema: 'public',
				},
				status: 'connected',
				error: null,
				profiles: [],
			});

			vi.mocked(sidecarApi.disconnect).mockRejectedValue(
				new Error('Sidecar is down'),
			);

			const { result } = renderHook(() => useConnection());

			// Should not throw
			await expect(result.current.disconnect()).resolves.toBeUndefined();

			const state = useConnectionStore.getState();
			expect(state.active).toBeNull();
		});
	});

	describe('testConnection', () => {
		it('connects then immediately disconnects, sets testResult ok', async () => {
			const mockResult = {
				connectionId: 'test-conn-123',
				database: 'testdb',
				schema: 'public',
			};
			vi.mocked(sidecarApi.connect).mockResolvedValue(mockResult);
			vi.mocked(sidecarApi.disconnect).mockResolvedValue({ ok: true });

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await result.current.testConnection(connectParams);

			expect(sidecarApi.connect).toHaveBeenCalledWith(connectParams);
			expect(sidecarApi.disconnect).toHaveBeenCalledWith({
				connectionId: 'test-conn-123',
			});

			await waitFor(() => {
				expect(result.current.testResult).toEqual({
					ok: true,
					message: 'Connection successful!',
				});
			});
		});

		it('sets testResult not ok with error message on failure', async () => {
			const error = new Error('Authentication failed');
			vi.mocked(sidecarApi.connect).mockRejectedValue(error);

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'wrongpass',
			};

			await result.current.testConnection(connectParams);

			await waitFor(() => {
				expect(result.current.testResult).toEqual({
					ok: false,
					message: 'Authentication failed',
				});
			});
		});

		it("uses 'Connection failed' fallback for non-Error exceptions", async () => {
			vi.mocked(sidecarApi.connect).mockRejectedValue({ code: 'ECONNREFUSED' });

			const { result } = renderHook(() => useConnection());

			const connectParams = {
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'testpass',
			};

			await result.current.testConnection(connectParams);

			await waitFor(() => {
				expect(result.current.testResult).toEqual({
					ok: false,
					message: 'Connection failed',
				});
			});
		});
	});

	describe('saveProfile', () => {
		it('delegates to store addProfile', () => {
			const { result } = renderHook(() => useConnection());

			const profile = {
				id: 'profile-1',
				name: 'Test Profile',
				type: 'postgresql' as const,
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				schema: 'public',
				sslMode: 'prefer' as const,
			};

			result.current.saveProfile(profile);

			const state = useConnectionStore.getState();
			expect(state.profiles).toContainEqual(profile);
		});
	});

	describe('deleteProfile', () => {
		it('delegates to store removeProfile', () => {
			// Set up a profile
			useConnectionStore.setState({
				active: null,
				status: 'disconnected',
				error: null,
				profiles: [
					{
						id: 'profile-1',
						name: 'Test Profile',
						type: 'postgresql' as const,
						host: 'localhost',
						port: 5432,
						database: 'testdb',
						user: 'testuser',
						schema: 'public',
						sslMode: 'prefer',
					},
				],
			});

			const { result } = renderHook(() => useConnection());

			result.current.deleteProfile('profile-1');

			const state = useConnectionStore.getState();
			expect(state.profiles).toHaveLength(0);
		});
	});

	describe('connectFromProfile', () => {
		it('builds params from profile + password, calls connect with profileId', async () => {
			const mockResult = {
				connectionId: 'conn-123',
				database: 'testdb',
				schema: 'public',
			};
			vi.mocked(sidecarApi.connect).mockResolvedValue(mockResult);

			const { result } = renderHook(() => useConnection());

			const profile = {
				id: 'profile-1',
				name: 'Test Profile',
				type: 'postgresql' as const,
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				schema: 'public',
				sslMode: 'prefer' as const,
			};

			const returnValue = await result.current.connectFromProfile(
				profile,
				'mypassword',
			);

			expect(sidecarApi.connect).toHaveBeenCalledWith({
				host: 'localhost',
				port: 5432,
				database: 'testdb',
				user: 'testuser',
				password: 'mypassword',
				schema: 'public',
				sslMode: 'prefer',
			});

			expect(returnValue).toEqual(mockResult);

			const state = useConnectionStore.getState();
			expect(state.active?.profileId).toBe('profile-1');
		});
	});
});
