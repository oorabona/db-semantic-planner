// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoConnect } from './useAutoConnect';

// ── Mocks ────────────────────────────────────────────────────────

const mockQuickConnect = vi.fn();

vi.mock('@/hooks/useConnectFlow', () => ({
	useConnectFlow: () => ({
		quickConnect: mockQuickConnect,
		promptOpen: false,
		promptProfile: null,
		promptError: null,
		connecting: false,
		submitPassword: vi.fn(),
		cancelPassword: vi.fn(),
	}),
}));

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

const { toast } = await import('sonner');

// Store mocks — use getState pattern for non-reactive reads
const mockProjectState = {
	mode: 'project' as const,
	folderPath: '/my/project',
	settings: { version: 1 as const, defaultConnection: 'dev-local' } as {
		version: 1;
		defaultConnection?: string;
	},
};

const mockConnectionState = {
	profiles: [
		{
			id: 'p1',
			name: 'dev-local',
			type: 'postgresql' as const,
			config: {
				host: 'localhost',
				port: 5432,
				database: 'mydb',
				user: 'app',
				schema: 'public',
				sslMode: 'disable',
			},
			environment: 'dev',
			createdAt: Date.now(),
			lastUsedAt: null,
		},
	],
	active: null as null | { connectionId: string },
};

const mockSidecarState = {
	status: 'ready' as string,
};

vi.mock('@/stores/project-store', () => ({
	useProjectStore: (selector: (s: typeof mockProjectState) => unknown) =>
		selector(mockProjectState),
}));

vi.mock('@/stores/connection-store', () => ({
	useConnectionStore: (selector: (s: typeof mockConnectionState) => unknown) =>
		selector(mockConnectionState),
}));

vi.mock('@/stores/sidecar-store', () => ({
	useSidecarStore: (selector: (s: typeof mockSidecarState) => unknown) =>
		selector(mockSidecarState),
}));

// ── Tests ────────────────────────────────────────────────────────

describe('useAutoConnect', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset mock states
		mockProjectState.mode = 'project';
		mockProjectState.folderPath = '/my/project';
		mockProjectState.settings = { version: 1, defaultConnection: 'dev-local' };
		mockConnectionState.profiles = [
			{
				id: 'p1',
				name: 'dev-local',
				type: 'postgresql',
				config: {
					host: 'localhost',
					port: 5432,
					database: 'mydb',
					user: 'app',
					schema: 'public',
					sslMode: 'disable',
				},
				environment: 'dev',
				createdAt: Date.now(),
				lastUsedAt: null,
			},
		];
		mockConnectionState.active = null;
		mockSidecarState.status = 'ready';
	});

	it('auto-connects when all conditions met', () => {
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'dev-local' }),
		);
	});

	it('does not auto-connect when mode is standalone', () => {
		mockProjectState.mode = 'standalone' as 'project';
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
	});

	it('does not auto-connect when sidecar is not ready (PRE-04)', () => {
		mockSidecarState.status = 'spawning';
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
	});

	it('does not auto-connect when no defaultConnection (PRE-02)', () => {
		mockProjectState.settings = { version: 1 };
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
	});

	it('does not auto-connect when already connected', () => {
		mockConnectionState.active = { connectionId: 'existing' };
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
	});

	it('does not auto-connect when no profiles loaded (PRE-03)', () => {
		mockConnectionState.profiles = [];
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
	});

	it('shows toast warning when default profile not found (ERR-02)', () => {
		mockProjectState.settings = {
			version: 1,
			defaultConnection: 'nonexistent',
		};
		renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();
		expect(toast.warning).toHaveBeenCalledWith(
			"Default connection 'nonexistent' not found",
		);
	});

	it('only attempts auto-connect once', () => {
		const { rerender } = renderHook(() => useAutoConnect());
		rerender();
		rerender();
		expect(mockQuickConnect).toHaveBeenCalledTimes(1);
	});

	it('auto-connects when sidecar transitions from spawning to ready (SC-18)', () => {
		mockSidecarState.status = 'spawning';
		const { rerender } = renderHook(() => useAutoConnect());
		expect(mockQuickConnect).not.toHaveBeenCalled();

		// Sidecar transitions to ready
		mockSidecarState.status = 'ready';
		rerender();
		expect(mockQuickConnect).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'dev-local' }),
		);
	});
});
