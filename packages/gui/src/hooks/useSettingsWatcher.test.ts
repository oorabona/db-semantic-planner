// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────

const mockUnwatch = vi.fn();
const mockWatch = vi.fn();
const mockJoin = vi.fn();

vi.mock('@tauri-apps/api/path', () => ({
	join: (...args: string[]) => mockJoin(...args),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
	watch: (...args: unknown[]) => mockWatch(...args),
}));

vi.mock('@/stores/project-store', () => ({
	useProjectStore: vi.fn(),
}));

import { useProjectStore } from '@/stores/project-store';
import { useSettingsWatcher } from './useSettingsWatcher.js';

describe('useSettingsWatcher', () => {
	const mockOnSettingsChanged = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		mockJoin.mockImplementation((...parts: string[]) =>
			Promise.resolve(parts.join('/')),
		);
		mockWatch.mockResolvedValue(mockUnwatch);
	});

	function setupStore(folderPath: string | null) {
		vi.mocked(useProjectStore).mockImplementation((selector: any) => {
			const state = { folderPath, onSettingsChanged: mockOnSettingsChanged };
			return selector(state);
		});
	}

	it('does nothing when folderPath is null', () => {
		setupStore(null);

		renderHook(() => useSettingsWatcher());

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('watches settings file when folderPath is set', async () => {
		setupStore('/project');

		renderHook(() => useSettingsWatcher());

		await vi.waitFor(() => {
			expect(mockJoin).toHaveBeenCalledWith('/project', 'dbsp.settings.json');
		});

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalledWith(
				'/project/dbsp.settings.json',
				expect.any(Function),
				{ delayMs: 500 },
			);
		});
	});

	it('calls unwatch on cleanup', async () => {
		setupStore('/project');

		const { unmount } = renderHook(() => useSettingsWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		unmount();

		expect(mockUnwatch).toHaveBeenCalled();
	});

	it('calls onSettingsChanged(true) on create event', async () => {
		setupStore('/project');

		renderHook(() => useSettingsWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		// Extract the callback passed to watch
		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { create: { kind: 'file' } } });

		expect(mockOnSettingsChanged).toHaveBeenCalledWith(true);
	});

	it('calls onSettingsChanged(false) on remove event', async () => {
		setupStore('/project');

		renderHook(() => useSettingsWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: { remove: { kind: 'file' } } });

		expect(mockOnSettingsChanged).toHaveBeenCalledWith(false);
	});

	it('ignores non-object event types', async () => {
		setupStore('/project');

		renderHook(() => useSettingsWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		const watchCallback = mockWatch.mock.calls[0]![1] as (event: {
			type: unknown;
		}) => void;

		watchCallback({ type: 'other' });

		expect(mockOnSettingsChanged).not.toHaveBeenCalled();
	});

	it('cancels setup if unmounted before watch resolves', async () => {
		setupStore('/project');

		// Make watch resolve slowly
		let resolveWatch: (fn: typeof mockUnwatch) => void;
		mockWatch.mockReturnValue(
			new Promise((resolve) => {
				resolveWatch = resolve;
			}),
		);

		const { unmount } = renderHook(() => useSettingsWatcher());

		// Unmount before watch resolves
		unmount();

		// Now resolve watch
		resolveWatch!(mockUnwatch);

		// Should NOT have set unwatchFn because cancelled=true
		// unwatchFn is null, so cleanup doesn't call it
		expect(mockUnwatch).not.toHaveBeenCalled();
	});
});
