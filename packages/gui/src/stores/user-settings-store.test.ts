import { beforeEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_USER_SETTINGS,
	useUserSettingsStore,
} from './user-settings-store';

// ── Reset store between tests ───────────────────────────────────

beforeEach(() => {
	useUserSettingsStore.setState({
		...DEFAULT_USER_SETTINGS,
		activeSection: 'general',
		dialogOpen: false,
	});
});

// ── Initial state ───────────────────────────────────────────────

describe('initial state', () => {
	it('has default settings', () => {
		const state = useUserSettingsStore.getState();
		expect(state.language).toBe('en');
		expect(state.theme).toBe('system');
		expect(state.autoUpdates).toBe(true);
		expect(state.tabSize).toBe(2);
		expect(state.formatOnSave).toBe(false);
		expect(state.maxResults).toBe(1000);
	});

	it('dialog is closed by default', () => {
		expect(useUserSettingsStore.getState().dialogOpen).toBe(false);
	});
});

// ── openPreferences / closePreferences ──────────────────────────

describe('openPreferences', () => {
	it('opens dialog with default section', () => {
		useUserSettingsStore.getState().openPreferences();
		const state = useUserSettingsStore.getState();
		expect(state.dialogOpen).toBe(true);
		expect(state.activeSection).toBe('general');
	});

	it('opens dialog with specific section', () => {
		useUserSettingsStore.getState().openPreferences('databases');
		const state = useUserSettingsStore.getState();
		expect(state.dialogOpen).toBe(true);
		expect(state.activeSection).toBe('databases');
	});
});

describe('closePreferences', () => {
	it('closes dialog', () => {
		useUserSettingsStore.getState().openPreferences();
		useUserSettingsStore.getState().closePreferences();
		expect(useUserSettingsStore.getState().dialogOpen).toBe(false);
	});
});

// ── setActiveSection ────────────────────────────────────────────

describe('setActiveSection', () => {
	it('changes the active section', () => {
		useUserSettingsStore.getState().setActiveSection('editor');
		expect(useUserSettingsStore.getState().activeSection).toBe('editor');
	});
});

// ── updateSetting ───────────────────────────────────────────────

describe('updateSetting', () => {
	it('updates language', () => {
		useUserSettingsStore.getState().updateSetting('language', 'fr');
		expect(useUserSettingsStore.getState().language).toBe('fr');
	});

	it('updates theme', () => {
		useUserSettingsStore.getState().updateSetting('theme', 'dark');
		expect(useUserSettingsStore.getState().theme).toBe('dark');
	});

	it('updates tabSize', () => {
		useUserSettingsStore.getState().updateSetting('tabSize', 4);
		expect(useUserSettingsStore.getState().tabSize).toBe(4);
	});

	it('updates formatOnSave', () => {
		useUserSettingsStore.getState().updateSetting('formatOnSave', true);
		expect(useUserSettingsStore.getState().formatOnSave).toBe(true);
	});

	it('updates maxResults', () => {
		useUserSettingsStore.getState().updateSetting('maxResults', 500);
		expect(useUserSettingsStore.getState().maxResults).toBe(500);
	});

	it('updates autoUpdates', () => {
		useUserSettingsStore.getState().updateSetting('autoUpdates', false);
		expect(useUserSettingsStore.getState().autoUpdates).toBe(false);
	});
});

// ── resetToDefaults ─────────────────────────────────────────────

describe('resetToDefaults', () => {
	it('resets all settings to defaults', () => {
		// Arrange — change several settings
		const { updateSetting } = useUserSettingsStore.getState();
		updateSetting('language', 'fr');
		updateSetting('theme', 'dark');
		updateSetting('tabSize', 4);
		updateSetting('maxResults', 100);

		// Act
		useUserSettingsStore.getState().resetToDefaults();

		// Assert
		const state = useUserSettingsStore.getState();
		expect(state.language).toBe('en');
		expect(state.theme).toBe('system');
		expect(state.tabSize).toBe(2);
		expect(state.maxResults).toBe(1000);
	});
});
