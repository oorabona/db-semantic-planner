// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogFilter, LogStats } from '@/lib/log-db';
import type { LogEntry } from '@/stores/log-store';

// ── Mock Tauri plugins ───────────────────────────────────────

vi.mock('@tauri-apps/plugin-dialog', () => ({
	save: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
	writeTextFile: vi.fn(async () => {}),
}));

// ── Mock log store ───────────────────────────────────────────

const EMPTY_STATS: LogStats = { total: 0, byLevel: {} };

const mockState: {
	entries: LogEntry[];
	filter: LogFilter;
	stats: LogStats;
	dbReady: boolean;
	setFilter: ReturnType<typeof vi.fn>;
	clear: ReturnType<typeof vi.fn>;
	exportLogs: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
	initDb: ReturnType<typeof vi.fn>;
	closeDb: ReturnType<typeof vi.fn>;
	addEntry: ReturnType<typeof vi.fn>;
} = {
	entries: [],
	filter: {},
	stats: EMPTY_STATS,
	dbReady: true,
	setFilter: vi.fn(),
	clear: vi.fn(async () => {}),
	exportLogs: vi.fn(async () => []),
	refresh: vi.fn(async () => {}),
	initDb: vi.fn(async () => {}),
	closeDb: vi.fn(async () => {}),
	addEntry: vi.fn(),
};

vi.mock('@/stores/log-store', () => ({
	useLogStore: (selector: (s: typeof mockState) => unknown) =>
		selector(mockState),
}));

import { LogPanel } from './LogPanel';

// ── Helpers ──────────────────────────────────────────────────

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: 1,
		timestamp: new Date('2026-02-17T10:30:45.000Z').getTime(),
		level: 'info',
		source: 'ipc',
		message: 'test message',
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────

afterEach(() => {
	cleanup();
	mockState.entries = [];
	mockState.filter = {};
	mockState.stats = EMPTY_STATS;
	vi.clearAllMocks();
});

describe('LogPanel', () => {
	it('should show empty state when no entries', () => {
		render(<LogPanel />);
		expect(screen.getByText('No log entries yet')).toBeTruthy();
	});

	it('should display entry count', () => {
		mockState.entries = [makeEntry()];
		mockState.stats = { total: 5, byLevel: { info: 5 } };
		render(<LogPanel />);
		expect(screen.getByText('1 / 5 entries')).toBeTruthy();
	});

	it('should show total without fraction when unfiltered', () => {
		mockState.entries = [makeEntry(), makeEntry({ id: 2 })];
		mockState.stats = { total: 2, byLevel: { info: 2 } };
		render(<LogPanel />);
		expect(screen.getByText('2 entries')).toBeTruthy();
	});

	it('should render log entries with HH:MM:SS timestamps', () => {
		mockState.entries = [makeEntry({ message: 'hello world' })];
		mockState.stats = { total: 1, byLevel: { info: 1 } };
		render(<LogPanel />);
		expect(screen.getByText('hello world')).toBeTruthy();
		// Timestamp should be formatted as HH:MM:SS (local time)
		const timeEl = screen.getByText(/^\d{2}:\d{2}:\d{2}$/);
		expect(timeEl).toBeTruthy();
	});

	it('should display duration badge when durationMs is present', () => {
		mockState.entries = [makeEntry({ durationMs: 142 })];
		mockState.stats = { total: 1, byLevel: { info: 1 } };
		render(<LogPanel />);
		expect(screen.getByText('142ms')).toBeTruthy();
	});

	it('should render level filter dropdown', () => {
		render(<LogPanel />);
		const select = screen.getByTitle('Filter by level');
		expect(select).toBeTruthy();
		expect(select.tagName).toBe('SELECT');
	});

	it('should render source filter dropdown', () => {
		render(<LogPanel />);
		const select = screen.getByTitle('Filter by source');
		expect(select).toBeTruthy();
		expect(select.tagName).toBe('SELECT');
	});

	it('should render search input', () => {
		render(<LogPanel />);
		const input = screen.getByPlaceholderText('Search...');
		expect(input).toBeTruthy();
	});

	it('should call setFilter when level changes', () => {
		render(<LogPanel />);
		const select = screen.getByTitle('Filter by level') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'error' } });
		expect(mockState.setFilter).toHaveBeenCalledWith({
			levels: ['error'],
		});
	});

	it('should call setFilter when source changes', () => {
		render(<LogPanel />);
		const select = screen.getByTitle('Filter by source') as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'sidecar' } });
		expect(mockState.setFilter).toHaveBeenCalledWith({
			sources: ['sidecar'],
		});
	});

	it('should call clear when Clear button clicked', () => {
		render(<LogPanel />);
		const clearBtn = screen.getByTitle('Clear logs');
		fireEvent.click(clearBtn);
		expect(mockState.clear).toHaveBeenCalled();
	});

	it('should have an Export button', () => {
		render(<LogPanel />);
		const exportBtn = screen.getByTitle('Export logs');
		expect(exportBtn).toBeTruthy();
	});

	it('should display correct level colors', () => {
		mockState.entries = [
			makeEntry({ id: 1, level: 'error', message: 'err msg' }),
			makeEntry({ id: 2, level: 'warn', message: 'warn msg' }),
		];
		mockState.stats = { total: 2, byLevel: { error: 1, warn: 1 } };
		render(<LogPanel />);
		expect(screen.getByText('[error]')).toBeTruthy();
		expect(screen.getByText('[warn]')).toBeTruthy();
	});
});
