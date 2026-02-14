// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionStore } from '@/stores/connection-store.js';
import { useSchemaStore } from '@/stores/schema-store.js';
import { useSchema } from './useSchema.js';

// Mock the IPC module
vi.mock('@/lib/ipc.js', () => ({
	sidecarApi: {
		introspect: vi.fn(),
	},
}));

import { sidecarApi } from '@/lib/ipc.js';

const MOCK_SCHEMA = {
	tables: [
		{
			name: 'users',
			columns: [
				{ name: 'id', type: 'integer', nullable: false },
				{ name: 'name', type: 'text', nullable: false },
			],
			foreignKeys: [],
			indexes: [],
		},
	],
	relations: [],
	hierarchies: [],
	warnings: [],
	introspectedAt: '2026-01-01T00:00:00Z',
};

describe('useSchema', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		// Reset stores
		useConnectionStore.setState({
			active: null,
			status: 'disconnected',
			error: null,
			profiles: [],
		});
		useSchemaStore.setState({
			schema: null,
			loading: false,
			error: null,
		});
	});

	describe('loadSchema (via auto-load)', () => {
		it('auto-loads schema when connection becomes connected', async () => {
			vi.mocked(sidecarApi.introspect).mockResolvedValue(MOCK_SCHEMA);

			renderHook(() => useSchema());

			// Simulate connection becoming active
			act(() => {
				useConnectionStore.setState({
					active: {
						connectionId: 'conn-1',
						profileId: 'p1',
						database: 'testdb',
						schema: 'public',
					},
					status: 'connected',
				});
			});

			await waitFor(() => {
				expect(sidecarApi.introspect).toHaveBeenCalledWith('conn-1', 'public');
			});

			await waitFor(() => {
				const state = useSchemaStore.getState();
				expect(state.schema).toEqual(MOCK_SCHEMA);
				expect(state.loading).toBe(false);
			});
		});

		it('clears schema when status becomes disconnected', () => {
			// Start with a schema loaded
			useSchemaStore.setState({
				schema: MOCK_SCHEMA,
				loading: false,
				error: null,
			});
			useConnectionStore.setState({
				active: {
					connectionId: 'conn-1',
					profileId: 'p1',
					database: 'testdb',
					schema: 'public',
				},
				status: 'connected',
			});

			renderHook(() => useSchema());

			// Simulate disconnection
			act(() => {
				useConnectionStore.setState({
					active: null,
					status: 'disconnected',
				});
			});

			const state = useSchemaStore.getState();
			expect(state.schema).toBeNull();
		});

		it('sets error on introspection failure', async () => {
			vi.mocked(sidecarApi.introspect).mockRejectedValue(
				new Error('Permission denied'),
			);

			renderHook(() => useSchema());

			act(() => {
				useConnectionStore.setState({
					active: {
						connectionId: 'conn-1',
						profileId: 'p1',
						database: 'testdb',
						schema: 'public',
					},
					status: 'connected',
				});
			});

			await waitFor(() => {
				const state = useSchemaStore.getState();
				expect(state.error).toBe('Permission denied');
				expect(state.loading).toBe(false);
			});
		});

		it('uses fallback message for non-Error exceptions', async () => {
			vi.mocked(sidecarApi.introspect).mockRejectedValue('timeout');

			renderHook(() => useSchema());

			act(() => {
				useConnectionStore.setState({
					active: {
						connectionId: 'conn-1',
						profileId: 'p1',
						database: 'testdb',
						schema: 'public',
					},
					status: 'connected',
				});
			});

			await waitFor(() => {
				const state = useSchemaStore.getState();
				expect(state.error).toBe('Introspection failed');
			});
		});

		it('sets loading true during introspection', async () => {
			let loadingDuringCall = false;
			vi.mocked(sidecarApi.introspect).mockImplementation(async () => {
				loadingDuringCall = useSchemaStore.getState().loading;
				return MOCK_SCHEMA;
			});

			renderHook(() => useSchema());

			act(() => {
				useConnectionStore.setState({
					active: {
						connectionId: 'conn-1',
						profileId: 'p1',
						database: 'testdb',
						schema: 'public',
					},
					status: 'connected',
				});
			});

			await waitFor(() => {
				expect(sidecarApi.introspect).toHaveBeenCalled();
			});
			expect(loadingDuringCall).toBe(true);
		});
	});

	describe('refresh', () => {
		it('re-introspects when active connection exists', async () => {
			vi.mocked(sidecarApi.introspect).mockResolvedValue(MOCK_SCHEMA);

			useConnectionStore.setState({
				active: {
					connectionId: 'conn-1',
					profileId: 'p1',
					database: 'testdb',
					schema: 'public',
				},
				status: 'connected',
			});

			const { result } = renderHook(() => useSchema());

			// Wait for auto-load to complete
			await waitFor(() => {
				expect(sidecarApi.introspect).toHaveBeenCalled();
			});

			const callCountBefore = vi.mocked(sidecarApi.introspect).mock.calls
				.length;

			// Call refresh
			act(() => {
				result.current.refresh();
			});

			await waitFor(() => {
				expect(
					vi.mocked(sidecarApi.introspect).mock.calls.length,
				).toBeGreaterThan(callCountBefore);
			});

			// Last call should be with the active connection
			const lastCall = vi.mocked(sidecarApi.introspect).mock.calls.at(-1);
			expect(lastCall).toEqual(['conn-1', 'public']);
		});

		it('does nothing when no active connection', () => {
			const { result } = renderHook(() => useSchema());

			act(() => {
				result.current.refresh();
			});

			expect(sidecarApi.introspect).not.toHaveBeenCalled();
		});
	});

	describe('return values', () => {
		it('returns schema, loading, error, and refresh', () => {
			const { result } = renderHook(() => useSchema());

			expect(result.current).toHaveProperty('schema');
			expect(result.current).toHaveProperty('loading');
			expect(result.current).toHaveProperty('error');
			expect(result.current).toHaveProperty('refresh');
			expect(typeof result.current.refresh).toBe('function');
		});
	});
});
