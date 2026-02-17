// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────

const mockUnwatch = vi.fn();
const mockWatch = vi.fn();
const mockJoin = vi.fn();
const mockSchemaReload = vi.fn();
const mockResolveSchemaPath = vi.fn();

vi.mock('@tauri-apps/api/path', () => ({
	join: (...args: string[]) => mockJoin(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	watch: (...args: unknown[]) => mockWatch(...args),
}));

vi.mock('@/stores/project-store', () => ({
	useProjectStore: vi.fn(),
}));

vi.mock('@/lib/ipc.js', () => ({
	sidecarApi: {
		schemaReload: (...args: unknown[]) => mockSchemaReload(...args),
	},
}));

vi.mock('@/lib/settings', () => ({
	resolveSchemaPath: (...args: unknown[]) => mockResolveSchemaPath(...args),
}));

import { useProjectStore } from '@/stores/project-store';
import { useSchemaWatcher } from './useSchemaWatcher.js';

describe('useSchemaWatcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockJoin.mockImplementation((...parts: string[]) =>
			Promise.resolve(parts.join('/')),
		);
		mockWatch.mockResolvedValue(mockUnwatch);
		mockResolveSchemaPath.mockResolvedValue('schema.ts');
	});

	function setupStore(opts: {
		folderPath: string | null;
		mode: 'standalone' | 'project';
		schemaPath?: string | undefined;
	}) {
		vi.mocked(useProjectStore).mockImplementation((selector: any) => {
			const state = {
				folderPath: opts.folderPath,
				mode: opts.mode,
				settings: opts.schemaPath
					? { project: { schemaPath: opts.schemaPath } }
					: null,
			};
			return selector(state);
		});
	}

	it('does nothing in standalone mode', () => {
		setupStore({ folderPath: '/project', mode: 'standalone' });

		renderHook(() => useSchemaWatcher());

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('does nothing when folderPath is null', () => {
		setupStore({
			folderPath: null,
			mode: 'project',
			schemaPath: 'schema.ts',
		});

		renderHook(() => useSchemaWatcher());

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('does nothing when no schemaPath in settings', () => {
		setupStore({ folderPath: '/project', mode: 'project' });

		renderHook(() => useSchemaWatcher());

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('watches schema file in project mode with schemaPath', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		renderHook(() => useSchemaWatcher());

		await vi.waitFor(() => {
			expect(mockResolveSchemaPath).toHaveBeenCalledWith('/project', 'auto');
		});

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalledWith(
				'/project/schema.ts',
				expect.any(Function),
				{ delayMs: 500 },
			);
		});
	});

	it('calls unwatch on cleanup', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		const { unmount } = renderHook(() => useSchemaWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		unmount();

		expect(mockUnwatch).toHaveBeenCalled();
	});

	it('calls sidecarApi.schemaReload on modify event', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		mockSchemaReload.mockResolvedValue({
			tableNames: ['users', 'posts'],
			tableCount: 2,
			relationCount: 1,
			schemaPath: '/project/schema.ts',
		});

		const onReload = vi.fn();
		renderHook(() => useSchemaWatcher({ onReload }));

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		// Extract the callback passed to watch
		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { modify: { kind: 'data' } } });

		await vi.waitFor(() => {
			expect(mockSchemaReload).toHaveBeenCalledWith('/project');
		});

		await vi.waitFor(() => {
			expect(onReload).toHaveBeenCalledWith(['users', 'posts']);
		});
	});

	it('calls onError when schemaReload fails', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		mockSchemaReload.mockRejectedValue(new Error('Parse error in schema.ts'));

		const onError = vi.fn();
		renderHook(() => useSchemaWatcher({ onError }));

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { modify: { kind: 'data' } } });

		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith('Parse error in schema.ts');
		});
	});

	it('handles non-Error rejections gracefully', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		mockSchemaReload.mockRejectedValue('string error');

		const onError = vi.fn();
		renderHook(() => useSchemaWatcher({ onError }));

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { modify: { kind: 'data' } } });

		await vi.waitFor(() => {
			expect(onError).toHaveBeenCalledWith('Schema reload failed');
		});
	});

	it('ignores non-modify events', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		renderHook(() => useSchemaWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { create: { kind: 'file' } } });
		watchCallback({ type: 'other' });

		expect(mockSchemaReload).not.toHaveBeenCalled();
	});

	it('does not set up watcher if resolveSchemaPath returns null', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		mockResolveSchemaPath.mockResolvedValue(null);

		renderHook(() => useSchemaWatcher());

		await vi.waitFor(() => {
			expect(mockResolveSchemaPath).toHaveBeenCalled();
		});

		// Give time for async setup to complete
		await new Promise((r) => setTimeout(r, 50));

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('cancels setup if unmounted before watch resolves', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		// Make watch resolve slowly
		let resolveWatch: (fn: typeof mockUnwatch) => void;
		mockWatch.mockReturnValue(
			new Promise((resolve) => {
				resolveWatch = resolve;
			}),
		);

		const { unmount } = renderHook(() => useSchemaWatcher());

		// Unmount before watch resolves
		unmount();

		// Now resolve watch
		resolveWatch!(mockUnwatch);

		// unwatchFn is null because cancelled=true during setup
		expect(mockUnwatch).not.toHaveBeenCalled();
	});

	it('exposes reload function', async () => {
		setupStore({
			folderPath: '/project',
			mode: 'project',
			schemaPath: 'auto',
		});

		mockSchemaReload.mockResolvedValue({
			tableNames: ['users'],
			tableCount: 1,
			relationCount: 0,
			schemaPath: '/project/schema.ts',
		});

		const onReload = vi.fn();
		const { result } = renderHook(() => useSchemaWatcher({ onReload }));

		// Call reload directly
		await result.current.reload();

		expect(mockSchemaReload).toHaveBeenCalledWith('/project');
		expect(onReload).toHaveBeenCalledWith(['users']);
	});
});
