// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@/stores/history-store';

// ── Store mocks ──────────────────────────────────────────────────

const mockHistoryState = {
	search: '',
	entries: [] as HistoryEntry[],
	setSearch: vi.fn(),
	clearHistory: vi.fn(),
	getFiltered: () => mockHistoryState.entries,
};

vi.mock('@/stores/history-store', () => ({
	useHistoryStore: (selector: (s: typeof mockHistoryState) => unknown) =>
		selector(mockHistoryState),
}));

const mockConnectionState = {
	active: {
		connectionId: 'c1',
		profileId: 'p1',
		database: 'testdb',
		schema: 'public',
	},
};

vi.mock('@/stores/connection-store', () => ({
	useConnectionStore: (selector: (s: typeof mockConnectionState) => unknown) =>
		selector(mockConnectionState),
}));

const mockAddTab = vi.fn().mockReturnValue('tab-1');

vi.mock('@/stores/editor-store', () => ({
	useEditorStore: { getState: () => ({ addTab: mockAddTab }) },
}));

const mockSetActiveTab = vi.fn();

vi.mock('@/stores/results-store', () => ({
	useResultsStore: { getState: () => ({ setActiveTab: mockSetActiveTab }) },
}));

import { HistoryPanel } from './HistoryPanel';

afterEach(() => {
	cleanup();
	mockHistoryState.search = '';
	mockHistoryState.entries = [];
	mockHistoryState.setSearch.mockClear();
	mockHistoryState.clearHistory.mockClear();
	mockAddTab.mockClear();
	mockSetActiveTab.mockClear();
});

// ── Fixtures ────────────────────────────────────────────────────

const ENTRY_SUCCESS: HistoryEntry = {
	id: 'h1',
	query: 'SELECT * FROM users WHERE active = true',
	language: 'sql',
	database: 'testdb',
	timestamp: Date.now() - 120_000, // 2 min ago
	durationMs: 42,
	rowCount: 10,
	success: true,
};

const ENTRY_ERROR: HistoryEntry = {
	id: 'h2',
	query: 'SELECT * FROM nonexistent',
	language: 'nql',
	database: 'devdb',
	timestamp: Date.now() - 3_600_000, // 1h ago
	durationMs: 5,
	rowCount: null,
	success: false,
	error: 'relation "nonexistent" does not exist',
};

// ── Tests ────────────────────────────────────────────────────────

describe('HistoryPanel', () => {
	it('renders empty state when no entries', () => {
		render(<HistoryPanel />);
		expect(screen.getByText('No queries in history.')).toBeTruthy();
	});

	it('renders search-specific empty state', () => {
		mockHistoryState.search = 'missing';
		render(<HistoryPanel />);
		expect(screen.getByText('No matching queries.')).toBeTruthy();
	});

	it('renders entries with query text', () => {
		mockHistoryState.entries = [ENTRY_SUCCESS, ENTRY_ERROR];
		render(<HistoryPanel />);
		expect(screen.getByText(/SELECT \* FROM users/)).toBeTruthy();
		expect(screen.getByText(/SELECT \* FROM nonexistent/)).toBeTruthy();
	});

	it('shows duration and row count for successful entries', () => {
		mockHistoryState.entries = [ENTRY_SUCCESS];
		render(<HistoryPanel />);
		expect(screen.getByText('42ms')).toBeTruthy();
		expect(screen.getByText('10 rows')).toBeTruthy();
	});

	it('shows error message for failed entries', () => {
		mockHistoryState.entries = [ENTRY_ERROR];
		render(<HistoryPanel />);
		expect(
			screen.getByText('relation "nonexistent" does not exist'),
		).toBeTruthy();
	});

	it('shows language badge', () => {
		mockHistoryState.entries = [ENTRY_SUCCESS, ENTRY_ERROR];
		render(<HistoryPanel />);
		expect(screen.getByText('sql')).toBeTruthy();
		expect(screen.getByText('nql')).toBeTruthy();
	});

	it('opens query in new editor tab on click', () => {
		mockHistoryState.entries = [ENTRY_SUCCESS];
		render(<HistoryPanel />);
		fireEvent.click(screen.getByText(/SELECT \* FROM users/));
		expect(mockAddTab).toHaveBeenCalledWith('sql', ENTRY_SUCCESS.query);
		expect(mockSetActiveTab).toHaveBeenCalledWith('results');
	});

	it('shows Clear button when entries exist', () => {
		mockHistoryState.entries = [ENTRY_SUCCESS];
		render(<HistoryPanel />);
		const clearBtn = screen.getByText('Clear');
		expect(clearBtn).toBeTruthy();
		fireEvent.click(clearBtn);
		expect(mockHistoryState.clearHistory).toHaveBeenCalled();
	});

	it('hides Clear button when no entries', () => {
		render(<HistoryPanel />);
		expect(screen.queryByText('Clear')).toBeNull();
	});

	it('updates search on input change', () => {
		render(<HistoryPanel />);
		const input = screen.getByPlaceholderText('Search history...');
		fireEvent.change(input, { target: { value: 'users' } });
		expect(mockHistoryState.setSearch).toHaveBeenCalledWith('users');
	});
});
