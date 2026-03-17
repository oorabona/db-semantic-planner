import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ────────────────────────────────────────────────────────

export type PreferencesSection =
	| 'general'
	| 'editor'
	| 'databases'
	| 'advanced';

export interface UserSettings {
	/** UI language */
	language: 'en' | 'fr';
	/** Color theme */
	theme: 'system' | 'light' | 'dark';
	/** Auto-check for updates */
	autoUpdates: boolean;
	/** Editor tab size (project settings override this) */
	tabSize: number;
	/** Format on save (project settings override this) */
	formatOnSave: boolean;
	/** Maximum result rows (project settings override this) */
	maxResults: number;
	/** Log retention in days (logs older than this are deleted on startup) */
	logRetentionDays: number;
	/** Query history retention in days (entries older than this are deleted on load) */
	historyRetentionDays: number;
	/** File watcher behavior: auto-reload open files or prompt user */
	fileWatcherMode: 'auto' | 'prompt';
}

// ── Defaults ─────────────────────────────────────────────────────

export const DEFAULT_USER_SETTINGS: UserSettings = {
	language: 'en',
	theme: 'system',
	autoUpdates: true,
	tabSize: 2,
	formatOnSave: false,
	maxResults: 1000,
	logRetentionDays: 30,
	historyRetentionDays: 90,
	fileWatcherMode: 'auto',
};

// ── Store ────────────────────────────────────────────────────────

interface UserSettingsState extends UserSettings {
	/** Currently active section in preferences dialog */
	activeSection: PreferencesSection;
	/** Whether preferences dialog is open */
	dialogOpen: boolean;

	// ── Actions ──
	openPreferences: (section?: PreferencesSection) => void;
	closePreferences: () => void;
	setActiveSection: (section: PreferencesSection) => void;
	updateSetting: <K extends keyof UserSettings>(
		key: K,
		value: UserSettings[K],
	) => void;
	resetToDefaults: () => void;
}

export const useUserSettingsStore = create<UserSettingsState>()(
	persist(
		(set) => ({
			// Settings
			...DEFAULT_USER_SETTINGS,
			// UI state (not persisted — see partialize below)
			activeSection: 'general',
			dialogOpen: false,

			openPreferences: (section = 'general') => {
				set({ dialogOpen: true, activeSection: section });
			},

			closePreferences: () => {
				set({ dialogOpen: false });
			},

			setActiveSection: (section) => {
				set({ activeSection: section });
			},

			updateSetting: (key, value) => {
				set({ [key]: value });
			},

			resetToDefaults: () => {
				set({ ...DEFAULT_USER_SETTINGS });
			},
		}),
		{
			name: 'dbsp-user-settings',
			// Only persist actual settings, not UI state
			partialize: (state) => ({
				language: state.language,
				theme: state.theme,
				autoUpdates: state.autoUpdates,
				tabSize: state.tabSize,
				formatOnSave: state.formatOnSave,
				maxResults: state.maxResults,
				logRetentionDays: state.logRetentionDays,
				historyRetentionDays: state.historyRetentionDays,
				fileWatcherMode: state.fileWatcherMode,
			}),
		},
	),
);
