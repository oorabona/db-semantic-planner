// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────

const mockUnwatch = vi.fn();
const mockWatch = vi.fn();

vi.mock('@tauri-apps/plugin-fs', () => ({
	watch: (...args: unknown[]) => mockWatch(...args),
}));

import { useEditorStore } from '@/stores/editor-store';
import { useEditorFileWatcher } from './useEditorFileWatcher.js';

describe('useEditorFileWatcher', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWatch.mockResolvedValue(mockUnwatch);
		useEditorStore.setState({ tabs: [], activeTabId: null });
	});

	it('does nothing when no tabs have file paths', () => {
		// Arrange — tab without filePath
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'Query 1.sql',
					language: 'sql',
					content: '',
					dirty: false,
				},
			],
		});

		renderHook(() => useEditorFileWatcher());

		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('sets up watcher for tab with filePath', async () => {
		// Arrange
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'schema.dbsp',
					language: 'nql',
					content: '',
					dirty: false,
					filePath: '/project/schema.dbsp',
				},
			],
		});

		renderHook(() => useEditorFileWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalledWith(
				'/project/schema.dbsp',
				expect.any(Function),
				{ delayMs: 500 },
			);
		});
	});

	it('marks tab as deleted on remove event', async () => {
		// Arrange
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'schema.dbsp',
					language: 'nql',
					content: 'SELECT 1',
					dirty: false,
					filePath: '/project/schema.dbsp',
				},
			],
		});

		// Capture the watch callback
		let watchCallback: (event: unknown) => void = () => {};
		mockWatch.mockImplementation(
			(_path: string, cb: (event: unknown) => void) => {
				watchCallback = cb;
				return Promise.resolve(mockUnwatch);
			},
		);

		renderHook(() => useEditorFileWatcher());

		// Wait for watcher to be set up
		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		// Act — simulate file removal
		watchCallback({ type: { remove: { kind: 'file' } } });

		// Assert — tab title updated with "(deleted)"
		const tab = useEditorStore.getState().tabs[0];
		expect(tab?.deleted).toBe(true);
		expect(tab?.title).toBe('schema.dbsp (deleted)');
	});

	it('does not mark already-deleted tab twice', async () => {
		// Arrange — tab already marked deleted
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'schema.dbsp (deleted)',
					language: 'nql',
					content: '',
					dirty: false,
					filePath: '/project/schema.dbsp',
					deleted: true,
				},
			],
		});

		renderHook(() => useEditorFileWatcher());

		// Assert — no watcher set up for deleted tabs
		expect(mockWatch).not.toHaveBeenCalled();
	});

	it('cleans up watchers on unmount', async () => {
		// Arrange
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'schema.dbsp',
					language: 'nql',
					content: '',
					dirty: false,
					filePath: '/project/schema.dbsp',
				},
			],
		});

		const { unmount } = renderHook(() => useEditorFileWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		// Act
		unmount();

		// Assert — cleanup called (either the unwatch or the cancelled wrapper)
		// The watcher's internal unwatch should have been invoked
		expect(mockUnwatch).toHaveBeenCalled();
	});

	it('ignores non-remove events', async () => {
		// Arrange
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'schema.dbsp',
					language: 'nql',
					content: '',
					dirty: false,
					filePath: '/project/schema.dbsp',
				},
			],
		});

		let watchCallback: (event: unknown) => void = () => {};
		mockWatch.mockImplementation(
			(_path: string, cb: (event: unknown) => void) => {
				watchCallback = cb;
				return Promise.resolve(mockUnwatch);
			},
		);

		renderHook(() => useEditorFileWatcher());

		await vi.waitFor(() => {
			expect(mockWatch).toHaveBeenCalled();
		});

		// Act — simulate a modify event (not remove)
		watchCallback({ type: { modify: { kind: 'data' } } });

		// Assert — tab not marked deleted
		const tab = useEditorStore.getState().tabs[0];
		expect(tab?.deleted).toBeUndefined();
		expect(tab?.title).toBe('schema.dbsp');
	});
});
