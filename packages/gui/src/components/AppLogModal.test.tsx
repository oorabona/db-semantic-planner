// @vitest-environment jsdom
/**
 * Tests for AppLogModal — level filter, text search, virtualized list, close behavior.
 * Covers AC-3 through AC-6 of GUI-024.
 */
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@/stores/log-store';

// Virtualizer needs real DOM measurements — mock it for jsdom
vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: (opts: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: opts.count }, (_, i) => ({
				index: i,
				start: i * 24,
				size: 24,
				key: i,
			})),
		getTotalSize: () => opts.count * 24,
		scrollToIndex: vi.fn(),
	}),
}));

// ── Fixtures ─────────────────────────────────────────────────

const ENTRIES: LogEntry[] = [
	{
		id: 1,
		timestamp: Date.now() - 3000,
		level: 'info',
		source: 'app',
		message: 'Application started',
	},
	{
		id: 2,
		timestamp: Date.now() - 2000,
		level: 'warn',
		source: 'app',
		message: 'Slow query detected',
	},
	{
		id: 3,
		timestamp: Date.now() - 1000,
		level: 'error',
		source: 'app',
		message: 'Connection refused',
	},
	{
		id: 4,
		timestamp: Date.now(),
		level: 'debug',
		source: 'app',
		message: 'Debug trace info',
	},
];

// ── Lazy import (after mocks) ────────────────────────────────

let AppLogModal: typeof import('./AppLogModal').AppLogModal;

beforeEach(async () => {
	const mod = await import('./AppLogModal');
	AppLogModal = mod.AppLogModal;
});

afterEach(cleanup);

// ── Tests ────────────────────────────────────────────────────

describe('AppLogModal', () => {
	it('renders entries with timestamps and level badges', () => {
		const onClose = vi.fn();
		render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

		expect(screen.getByText('Application started')).toBeDefined();
		expect(screen.getByText('Slow query detected')).toBeDefined();
		expect(screen.getByText('Connection refused')).toBeDefined();
		expect(screen.getByText('Debug trace info')).toBeDefined();
		expect(screen.getByText('[info]')).toBeDefined();
		expect(screen.getByText('[warn]')).toBeDefined();
		expect(screen.getByText('[error]')).toBeDefined();
		expect(screen.getByText('[debug]')).toBeDefined();
	});

	it('shows entry count', () => {
		const onClose = vi.fn();
		render(<AppLogModal entries={ENTRIES} onClose={onClose} />);
		expect(screen.getByText('4 entries')).toBeDefined();
	});

	it('shows empty state when no entries', () => {
		const onClose = vi.fn();
		render(<AppLogModal entries={[]} onClose={onClose} />);
		expect(screen.getByText('No app logs yet')).toBeDefined();
	});

	describe('level filter (AC-3)', () => {
		it('dropdown has all 4 levels plus "All levels"', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);
			const select = screen.getByTitle('Filter by level') as HTMLSelectElement;
			const options = Array.from(select.options).map((o) => o.value);
			expect(options).toEqual(['', 'debug', 'info', 'warn', 'error']);
		});

		it('selecting a level filters entries', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);
			const select = screen.getByTitle('Filter by level') as HTMLSelectElement;

			fireEvent.change(select, { target: { value: 'error' } });

			expect(screen.getByText('Connection refused')).toBeDefined();
			expect(screen.queryByText('Application started')).toBeNull();
			expect(screen.queryByText('Slow query detected')).toBeNull();
			expect(screen.queryByText('Debug trace info')).toBeNull();
		});

		it('shows filtered count vs total', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);
			const select = screen.getByTitle('Filter by level') as HTMLSelectElement;

			fireEvent.change(select, { target: { value: 'warn' } });
			expect(screen.getByText('1 / 4 entries')).toBeDefined();
		});

		it('reverting to "All levels" shows all entries', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);
			const select = screen.getByTitle('Filter by level') as HTMLSelectElement;

			fireEvent.change(select, { target: { value: 'error' } });
			fireEvent.change(select, { target: { value: '' } });

			expect(screen.getByText('Application started')).toBeDefined();
			expect(screen.getByText('Connection refused')).toBeDefined();
			expect(screen.getByText('4 entries')).toBeDefined();
		});
	});

	describe('text search (AC-4)', () => {
		it('filters entries after debounce', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			const input = screen.getByPlaceholderText('Search logs...');
			fireEvent.change(input, { target: { value: 'Connection' } });

			// Before debounce: all entries still visible
			expect(screen.getByText('Application started')).toBeDefined();

			// After debounce: only matching entry
			act(() => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('Connection refused')).toBeDefined();
			expect(screen.queryByText('Application started')).toBeNull();

			vi.useRealTimers();
		});

		it('clear button resets search', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			const input = screen.getByPlaceholderText('Search logs...');
			fireEvent.change(input, { target: { value: 'Connection' } });
			act(() => {
				vi.advanceTimersByTime(300);
			});

			// Click clear
			const clearBtn = screen.getByTitle('Clear search');
			fireEvent.click(clearBtn);

			// All entries restored
			expect(screen.getByText('Application started')).toBeDefined();
			expect(screen.getByText('Connection refused')).toBeDefined();

			vi.useRealTimers();
		});

		it('search is case-insensitive', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			const input = screen.getByPlaceholderText('Search logs...');
			fireEvent.change(input, { target: { value: 'connection' } });

			act(() => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('Connection refused')).toBeDefined();
			expect(screen.queryByText('Application started')).toBeNull();

			vi.useRealTimers();
		});

		it('shows "No matching entries" when search has no results', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			const input = screen.getByPlaceholderText('Search logs...');
			fireEvent.change(input, { target: { value: 'zzz_no_match' } });

			act(() => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('No matching entries')).toBeDefined();

			vi.useRealTimers();
		});
	});

	describe('close behavior (AC-6)', () => {
		it('X button calls onClose', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			const closeBtn = screen.getByTitle('Close (Escape)');
			fireEvent.click(closeBtn);

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('Escape key calls onClose', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('backdrop click calls onClose', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			// Click the backdrop (dialog overlay), not the inner content
			const backdrop = screen.getByRole('dialog');
			fireEvent.click(backdrop);

			expect(onClose).toHaveBeenCalledOnce();
		});

		it('clicking inner panel does NOT call onClose', () => {
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			// Click on the inner content (e.g. the "App Logs" header text)
			fireEvent.click(screen.getByText('App Logs'));

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('combined filters', () => {
		it('level + search filters combine', async () => {
			vi.useFakeTimers();
			const onClose = vi.fn();
			render(<AppLogModal entries={ENTRIES} onClose={onClose} />);

			// Filter by info level
			const select = screen.getByTitle('Filter by level') as HTMLSelectElement;
			fireEvent.change(select, { target: { value: 'info' } });

			// Then search for "started"
			const input = screen.getByPlaceholderText('Search logs...');
			fireEvent.change(input, { target: { value: 'started' } });
			act(() => {
				vi.advanceTimersByTime(300);
			});

			expect(screen.getByText('Application started')).toBeDefined();
			expect(screen.getByText('1 / 4 entries')).toBeDefined();

			vi.useRealTimers();
		});
	});
});
