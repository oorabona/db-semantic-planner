// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUserSettingsStore } from '@/stores/user-settings-store';
import { useThemeEffect } from './useThemeEffect';

// ── Helpers ──────────────────────────────────────────────────

let mediaListeners: Array<(e: { matches: boolean }) => void> = [];
let mediaDark = false;

function mockMatchMedia() {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: mediaDark,
			media: query,
			addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
				mediaListeners.push(cb);
			},
			removeEventListener: (
				_: string,
				cb: (e: { matches: boolean }) => void,
			) => {
				mediaListeners = mediaListeners.filter((l) => l !== cb);
			},
		})),
	});
}

// ── Tests ────────────────────────────────────────────────────

describe('useThemeEffect', () => {
	beforeEach(() => {
		mediaDark = false;
		mediaListeners = [];
		mockMatchMedia();
		document.documentElement.classList.remove('dark');
		useUserSettingsStore.setState({ theme: 'system' });
	});

	afterEach(() => {
		document.documentElement.classList.remove('dark');
	});

	it('adds .dark class when theme is "dark"', () => {
		useUserSettingsStore.setState({ theme: 'dark' });
		renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	it('does not add .dark class when theme is "light"', () => {
		useUserSettingsStore.setState({ theme: 'light' });
		renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	it('respects system preference when theme is "system"', () => {
		mediaDark = true;
		mockMatchMedia(); // re-mock with dark = true
		useUserSettingsStore.setState({ theme: 'system' });
		renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});

	it('defaults to light when system is light and theme is "system"', () => {
		mediaDark = false;
		useUserSettingsStore.setState({ theme: 'system' });
		renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	it('removes .dark class when switching from dark to light', () => {
		useUserSettingsStore.setState({ theme: 'dark' });
		const { rerender } = renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(true);

		useUserSettingsStore.setState({ theme: 'light' });
		rerender();
		expect(document.documentElement.classList.contains('dark')).toBe(false);
	});

	it('reacts to system preference change (for theme="system")', () => {
		mediaDark = false;
		mockMatchMedia();
		useUserSettingsStore.setState({ theme: 'system' });
		renderHook(() => useThemeEffect());
		expect(document.documentElement.classList.contains('dark')).toBe(false);

		// Simulate OS switching to dark
		act(() => {
			mediaDark = true;
			for (const cb of mediaListeners) cb({ matches: true });
		});
		expect(document.documentElement.classList.contains('dark')).toBe(true);
	});
});
