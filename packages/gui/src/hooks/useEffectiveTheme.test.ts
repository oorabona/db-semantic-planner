// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUserSettingsStore } from '@/stores/user-settings-store';
import { useEffectiveTheme, useMonacoTheme } from './useEffectiveTheme';

// ── Helpers ──────────────────────────────────────────────────

let mediaDark = false;

function mockMatchMedia() {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: mediaDark,
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	});
}

// ── Tests ────────────────────────────────────────────────────

describe('useEffectiveTheme', () => {
	beforeEach(() => {
		mediaDark = false;
		mockMatchMedia();
		useUserSettingsStore.setState({ theme: 'system' });
	});

	it('returns "dark" when user selects dark', () => {
		useUserSettingsStore.setState({ theme: 'dark' });
		const { result } = renderHook(() => useEffectiveTheme());
		expect(result.current).toBe('dark');
	});

	it('returns "light" when user selects light', () => {
		useUserSettingsStore.setState({ theme: 'light' });
		const { result } = renderHook(() => useEffectiveTheme());
		expect(result.current).toBe('light');
	});

	it('returns "dark" when system prefers dark and theme is "system"', () => {
		mediaDark = true;
		mockMatchMedia();
		useUserSettingsStore.setState({ theme: 'system' });
		const { result } = renderHook(() => useEffectiveTheme());
		expect(result.current).toBe('dark');
	});

	it('returns "light" when system prefers light and theme is "system"', () => {
		mediaDark = false;
		mockMatchMedia();
		useUserSettingsStore.setState({ theme: 'system' });
		const { result } = renderHook(() => useEffectiveTheme());
		expect(result.current).toBe('light');
	});
});

describe('useMonacoTheme', () => {
	beforeEach(() => {
		mediaDark = false;
		mockMatchMedia();
		useUserSettingsStore.setState({ theme: 'system' });
	});

	it('returns "dbsp-dark" for dark theme', () => {
		useUserSettingsStore.setState({ theme: 'dark' });
		const { result } = renderHook(() => useMonacoTheme());
		expect(result.current).toBe('dbsp-dark');
	});

	it('returns "dbsp-light" for light theme', () => {
		useUserSettingsStore.setState({ theme: 'light' });
		const { result } = renderHook(() => useMonacoTheme());
		expect(result.current).toBe('dbsp-light');
	});
});
