// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_FILENAME } from '@/lib/settings';
import { useEditorStore } from '@/stores/editor-store';
import { useUserSettingsStore } from '@/stores/user-settings-store';
import { PreferencesDialog } from './PreferencesDialog';

// Mock Tauri APIs (required by stores that use persist)
vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
	LazyStore: vi.fn().mockImplementation(() => ({
		get: vi.fn(),
		set: vi.fn(),
		save: vi.fn(),
	})),
}));

beforeEach(() => {
	// Reset stores between tests
	useEditorStore.setState({ tabs: [], activeTabId: null });
	useUserSettingsStore.setState({ dialogOpen: true, activeSection: 'general' });
});

afterEach(() => {
	cleanup();
});

// ── Concurrent Edit Banner (D02) ────────────────────────────────

describe('ConcurrentEditBanner', () => {
	it('does not show banner when no settings file is open', () => {
		// Arrange — no tabs
		render(<PreferencesDialog />);

		// Assert
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('does not show banner when settings file is open but clean', () => {
		// Arrange — settings file open, not dirty
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: SETTINGS_FILENAME,
					language: 'sql',
					content: '{}',
					dirty: false,
					filePath: `/project/${SETTINGS_FILENAME}`,
				},
			],
			activeTabId: 'tab-1',
		});

		render(<PreferencesDialog />);

		// Assert
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('shows warning when settings file is dirty', () => {
		// Arrange — settings file open and dirty
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: SETTINGS_FILENAME,
					language: 'sql',
					content: '{ "changed": true }',
					dirty: true,
					filePath: `/project/${SETTINGS_FILENAME}`,
				},
			],
			activeTabId: 'tab-1',
		});

		render(<PreferencesDialog />);

		// Assert
		const alert = screen.getByRole('alert');
		expect(alert).toBeDefined();
		expect(alert.textContent).toContain(SETTINGS_FILENAME);
		expect(alert.textContent).toContain('unsaved changes');
	});

	it('does not show banner for other dirty files', () => {
		// Arrange — unrelated file is dirty
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: 'query.sql',
					language: 'sql',
					content: 'SELECT 1',
					dirty: true,
					filePath: '/project/query.sql',
				},
			],
			activeTabId: 'tab-1',
		});

		render(<PreferencesDialog />);

		// Assert
		expect(screen.queryByRole('alert')).toBeNull();
	});

	it('detects settings file via endsWith (nested path)', () => {
		// Arrange — filePath is a nested path ending with SETTINGS_FILENAME
		useEditorStore.setState({
			tabs: [
				{
					id: 'tab-1',
					title: SETTINGS_FILENAME,
					language: 'sql',
					content: '{}',
					dirty: true,
					filePath: `/home/user/project/subdir/${SETTINGS_FILENAME}`,
				},
			],
			activeTabId: 'tab-1',
		});

		render(<PreferencesDialog />);

		// Assert
		expect(screen.getByRole('alert')).toBeDefined();
	});

	it('does not render dialog when dialogOpen is false', () => {
		// Arrange
		useUserSettingsStore.setState({ dialogOpen: false });

		const { container } = render(<PreferencesDialog />);

		// Assert — nothing rendered
		expect(container.innerHTML).toBe('');
	});
});
