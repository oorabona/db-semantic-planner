import { useSyncExternalStore } from 'react';
import { useUserSettingsStore } from '@/stores/user-settings-store';

// ── System dark preference ───────────────────────────────────

const DARK_MQ = '(prefers-color-scheme: dark)';

function subscribe(cb: () => void) {
	if (typeof window === 'undefined') return () => {};
	const mq = window.matchMedia(DARK_MQ);
	mq.addEventListener('change', cb);
	return () => mq.removeEventListener('change', cb);
}

function getSnapshot() {
	if (typeof window === 'undefined') return false;
	return window.matchMedia(DARK_MQ).matches;
}

function useSystemDark(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}

// ── Effective theme ──────────────────────────────────────────

export type EffectiveTheme = 'light' | 'dark';

/**
 * Returns the effective theme ('light' | 'dark') by combining the
 * user preference with the OS color scheme.
 */
export function useEffectiveTheme(): EffectiveTheme {
	const theme = useUserSettingsStore((s) => s.theme);
	const systemDark = useSystemDark();

	if (theme === 'dark') return 'dark';
	if (theme === 'light') return 'light';
	return systemDark ? 'dark' : 'light';
}

/**
 * Returns the Monaco theme name matching the current effective theme.
 */
export function useMonacoTheme(): string {
	return useEffectiveTheme() === 'dark' ? 'dbsp-dark' : 'dbsp-light';
}
