import {
	AlertTriangle,
	Globe,
	Monitor,
	Palette,
	Settings,
	X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SETTINGS_FILENAME } from '@/lib/settings';
import { useEditorStore } from '@/stores/editor-store';
import {
	type PreferencesSection,
	useUserSettingsStore,
} from '@/stores/user-settings-store';

// ── Section navigation ──────────────────────────────────────────

const SECTIONS: {
	id: PreferencesSection;
	label: string;
	icon: typeof Settings;
}[] = [
	{ id: 'general', label: 'General', icon: Globe },
	{ id: 'editor', label: 'Editor', icon: Palette },
	{ id: 'databases', label: 'Databases', icon: Monitor },
	{ id: 'advanced', label: 'Advanced', icon: Settings },
];

// ── General Section ─────────────────────────────────────────────

function GeneralSection() {
	const { language, theme, autoUpdates, updateSetting } =
		useUserSettingsStore();

	return (
		<div className="space-y-4">
			<h3 className="text-sm font-medium">General</h3>

			<div className="space-y-2">
				<Label htmlFor="pref-language">Language</Label>
				<select
					id="pref-language"
					className="w-full rounded border bg-background px-2 py-1 text-sm"
					value={language}
					onChange={(e) =>
						updateSetting('language', e.target.value as 'en' | 'fr')
					}
				>
					<option value="en">English</option>
					<option value="fr">Français</option>
				</select>
			</div>

			<div className="space-y-2">
				<Label htmlFor="pref-theme">Theme</Label>
				<select
					id="pref-theme"
					className="w-full rounded border bg-background px-2 py-1 text-sm"
					value={theme}
					onChange={(e) =>
						updateSetting(
							'theme',
							e.target.value as 'system' | 'light' | 'dark',
						)
					}
				>
					<option value="system">System</option>
					<option value="light">Light</option>
					<option value="dark">Dark</option>
				</select>
			</div>

			<div className="flex items-center gap-2">
				<input
					type="checkbox"
					id="pref-auto-updates"
					checked={autoUpdates}
					onChange={(e) => updateSetting('autoUpdates', e.target.checked)}
				/>
				<Label htmlFor="pref-auto-updates">
					Automatically check for updates
				</Label>
			</div>
		</div>
	);
}

// ── Editor Section ──────────────────────────────────────────────

function EditorSection() {
	const { tabSize, formatOnSave, maxResults, updateSetting } =
		useUserSettingsStore();

	return (
		<div className="space-y-4">
			<h3 className="text-sm font-medium">Editor</h3>

			<div className="space-y-2">
				<Label htmlFor="pref-tab-size">Tab Size</Label>
				<Input
					id="pref-tab-size"
					type="number"
					min={1}
					max={8}
					value={tabSize}
					onChange={(e) =>
						updateSetting('tabSize', Number(e.target.value) || 2)
					}
				/>
			</div>

			<div className="flex items-center gap-2">
				<input
					type="checkbox"
					id="pref-format-on-save"
					checked={formatOnSave}
					onChange={(e) => updateSetting('formatOnSave', e.target.checked)}
				/>
				<Label htmlFor="pref-format-on-save">Format on save</Label>
			</div>

			<div className="space-y-2">
				<Label htmlFor="pref-max-results">Max Results</Label>
				<Input
					id="pref-max-results"
					type="number"
					min={10}
					max={100000}
					value={maxResults}
					onChange={(e) =>
						updateSetting('maxResults', Number(e.target.value) || 1000)
					}
				/>
			</div>
		</div>
	);
}

// ── Databases Section ───────────────────────────────────────────

function DatabasesSection() {
	return (
		<div className="space-y-4">
			<h3 className="text-sm font-medium">Databases</h3>
			<p className="text-xs text-[var(--muted-foreground)]">
				Connection profiles are managed via the Connection dialog or
				dbsp.settings.json.
			</p>
			<p className="text-xs text-[var(--muted-foreground)]">
				Use File &gt; New Connection (⌘N) to add profiles, or edit
				dbsp.settings.json directly for URI-based profiles (file://, env://,
				store://).
			</p>
		</div>
	);
}

// ── Advanced Section ────────────────────────────────────────────

function AdvancedSection() {
	const resetToDefaults = useUserSettingsStore((s) => s.resetToDefaults);

	return (
		<div className="space-y-4">
			<h3 className="text-sm font-medium">Advanced</h3>
			<p className="text-xs text-[var(--muted-foreground)]">
				Advanced settings will be available in future releases.
			</p>
			<Button variant="outline" size="sm" onClick={resetToDefaults}>
				Reset All to Defaults
			</Button>
		</div>
	);
}

// ── Section Router ──────────────────────────────────────────────

function SectionContent({ section }: { section: PreferencesSection }) {
	switch (section) {
		case 'general':
			return <GeneralSection />;
		case 'editor':
			return <EditorSection />;
		case 'databases':
			return <DatabasesSection />;
		case 'advanced':
			return <AdvancedSection />;
	}
}

// ── Preferences Dialog ──────────────────────────────────────────

// ── Concurrent-edit warning (D02) ──────────────────────────────

/**
 * Returns true when the user has dbsp.settings.json open as a dirty
 * (unsaved) editor tab — meaning a concurrent edit could overwrite
 * programmatic changes from the Preferences dialog.
 */
function useSettingsFileDirty(): boolean {
	return useEditorStore((s) =>
		s.tabs.some((t) => t.dirty && t.filePath?.endsWith(SETTINGS_FILENAME)),
	);
}

function ConcurrentEditBanner() {
	const dirty = useSettingsFileDirty();
	if (!dirty) return null;

	return (
		<div
			role="alert"
			className="mb-3 flex items-start gap-2 rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs text-[var(--foreground)]"
		>
			<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
			<span>
				<strong>{SETTINGS_FILENAME}</strong> is open with unsaved changes in the
				editor. Saving from the editor will overwrite any changes made here.
			</span>
		</div>
	);
}

// ── Preferences Dialog ──────────────────────────────────────────

export function PreferencesDialog() {
	const { dialogOpen, activeSection, closePreferences, setActiveSection } =
		useUserSettingsStore();

	if (!dialogOpen) return null;

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center">
			{/* Backdrop */}
			<div
				className="absolute inset-0 bg-black/50"
				onClick={closePreferences}
				onKeyDown={(e) => e.key === 'Escape' && closePreferences()}
			/>

			{/* Dialog */}
			<div className="relative flex h-[480px] w-[640px] overflow-hidden rounded-lg border bg-background shadow-xl">
				{/* Sidebar */}
				<div className="flex w-48 flex-col border-r bg-[var(--sidebar)]">
					<div className="flex items-center justify-between border-b px-3 py-2">
						<span className="text-sm font-medium">Preferences</span>
						<button
							type="button"
							className="rounded p-0.5 hover:bg-[var(--accent)]"
							onClick={closePreferences}
						>
							<X className="h-4 w-4" />
						</button>
					</div>
					<nav className="flex flex-col gap-0.5 p-1">
						{SECTIONS.map(({ id, label, icon: Icon }) => (
							<button
								key={id}
								type="button"
								className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm ${
									activeSection === id
										? 'bg-[var(--accent)] font-medium'
										: 'hover:bg-[var(--accent)]/50'
								}`}
								onClick={() => setActiveSection(id)}
							>
								<Icon className="h-4 w-4" />
								{label}
							</button>
						))}
					</nav>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto p-4">
					<ConcurrentEditBanner />
					<SectionContent section={activeSection} />
				</div>
			</div>
		</div>
	);
}
