// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────

const mockRegister = vi.fn();
const mockSetMonarchTokensProvider = vi.fn();
const mockSetLanguageConfiguration = vi.fn();
const mockRegisterCompletionItemProvider = vi.fn();
const mockDefineTheme = vi.fn();

const mockMonaco = {
	languages: {
		register: mockRegister,
		setMonarchTokensProvider: mockSetMonarchTokensProvider,
		setLanguageConfiguration: mockSetLanguageConfiguration,
		registerCompletionItemProvider: mockRegisterCompletionItemProvider,
	},
	editor: {
		defineTheme: mockDefineTheme,
	},
};

// ── Module mocks ────────────────────────────────────────────────

vi.mock('@monaco-editor/react', () => ({
	loader: {
		init: vi.fn(() => Promise.resolve(mockMonaco)),
	},
}));

vi.mock('@/lib/nql-completions.js', () => ({
	createNqlCompletionProvider: vi.fn(() => ({
		provideCompletionItems: vi.fn(),
	})),
}));

vi.mock('@/lib/nql-monarch.js', () => ({
	NQL_LANGUAGE_ID: 'nql',
	nqlLanguageConfiguration: { brackets: [] },
	nqlMonarchTokensProvider: { tokenizer: {} },
}));

vi.mock('@/lib/sql-completions.js', () => ({
	createSqlCompletionProvider: vi.fn(() => ({
		provideCompletionItems: vi.fn(),
	})),
}));

// ── Import AFTER mocks ─────────────────────────────────────────

import { loader } from '@monaco-editor/react';
import { useMonacoSetup } from './useMonacoSetup.js';

describe('useMonacoSetup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset the init mock to return our mock monaco
		vi.mocked(loader.init).mockReturnValue(Promise.resolve(mockMonaco) as any);
	});

	it('calls loader.init() on first render', async () => {
		renderHook(() => useMonacoSetup());

		// Let the promise resolve
		await vi.waitFor(() => {
			expect(loader.init).toHaveBeenCalledTimes(1);
		});
	});

	it('defines the dbsp-light theme', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockDefineTheme).toHaveBeenCalledWith(
				'dbsp-light',
				expect.objectContaining({
					base: 'vs',
					inherit: true,
					colors: expect.objectContaining({
						'editor.background': '#fafafa',
					}),
				}),
			);
		});
	});

	it('registers NQL language with extensions', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockRegister).toHaveBeenCalledWith({
				id: 'nql',
				extensions: ['.dbsp'],
			});
		});
	});

	it('sets Monarch token provider for NQL', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockSetMonarchTokensProvider).toHaveBeenCalledWith(
				'nql',
				expect.objectContaining({ tokenizer: {} }),
			);
		});
	});

	it('sets language configuration for NQL', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockSetLanguageConfiguration).toHaveBeenCalledWith(
				'nql',
				expect.objectContaining({ brackets: [] }),
			);
		});
	});

	it('registers SQL completion provider', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockRegisterCompletionItemProvider).toHaveBeenCalledWith(
				'sql',
				expect.objectContaining({
					provideCompletionItems: expect.any(Function),
				}),
			);
		});
	});

	it('registers NQL completion provider', async () => {
		renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(mockRegisterCompletionItemProvider).toHaveBeenCalledWith(
				'nql',
				expect.objectContaining({
					provideCompletionItems: expect.any(Function),
				}),
			);
		});
	});

	it('only initializes once across multiple renders', async () => {
		const { rerender } = renderHook(() => useMonacoSetup());

		await vi.waitFor(() => {
			expect(loader.init).toHaveBeenCalledTimes(1);
		});

		// Re-render multiple times
		rerender();
		rerender();
		rerender();

		// Still only called once
		expect(loader.init).toHaveBeenCalledTimes(1);
	});
});
