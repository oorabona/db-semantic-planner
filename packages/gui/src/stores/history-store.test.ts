import { beforeEach, describe, expect, it } from 'vitest';
import { type HistoryEntry, useHistoryStore } from './history-store.js';

const ENTRY: Omit<HistoryEntry, 'id'> = {
	query: 'SELECT * FROM users',
	language: 'sql',
	database: 'testdb',
	timestamp: 1700000000000,
	durationMs: 42,
	rowCount: 10,
	success: true,
};

function makeEntry(
	overrides?: Partial<Omit<HistoryEntry, 'id'>>,
): Omit<HistoryEntry, 'id'> {
	return { ...ENTRY, ...overrides };
}

describe('useHistoryStore', () => {
	beforeEach(() => {
		useHistoryStore.setState({ entries: [], search: '' });
	});

	describe('addEntry', () => {
		it('adds an entry with generated id', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(1);
			expect(entries[0]!.query).toBe('SELECT * FROM users');
			expect(entries[0]!.id).toBeTruthy();
		});

		it('prepends new entries (newest first)', () => {
			useHistoryStore.getState().addEntry(makeEntry({ query: 'first' }));
			useHistoryStore.getState().addEntry(makeEntry({ query: 'second' }));
			const { entries } = useHistoryStore.getState();
			expect(entries[0]!.query).toBe('second');
			expect(entries[1]!.query).toBe('first');
		});

		it('preserves error field on failed entries', () => {
			useHistoryStore.getState().addEntry(
				makeEntry({
					success: false,
					rowCount: null,
					error: 'relation "foo" does not exist',
				}),
			);
			const entry = useHistoryStore.getState().entries[0]!;
			expect(entry.success).toBe(false);
			expect(entry.error).toBe('relation "foo" does not exist');
		});
	});

	describe('FIFO pruning', () => {
		it('caps entries at 500, dropping oldest', () => {
			// Pre-fill with 500 entries
			const bulk: HistoryEntry[] = Array.from({ length: 500 }, (_, i) => ({
				...ENTRY,
				id: `old-${i}`,
				query: `query-${i}`,
			}));
			useHistoryStore.setState({ entries: bulk });

			// Add one more — should evict the oldest
			useHistoryStore.getState().addEntry(makeEntry({ query: 'newest' }));
			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(500);
			expect(entries[0]!.query).toBe('newest');
			// The very last old entry (index 499) should be gone
			expect(entries.some((e) => e.id === 'old-499')).toBe(false);
		});
	});

	describe('clearHistory', () => {
		it('removes all entries', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().clearHistory();
			expect(useHistoryStore.getState().entries).toHaveLength(0);
		});
	});

	describe('removeEntry', () => {
		it('removes a specific entry by id', () => {
			useHistoryStore.getState().addEntry(makeEntry({ query: 'keep' }));
			useHistoryStore.getState().addEntry(makeEntry({ query: 'remove' }));
			const toRemove = useHistoryStore.getState().entries[0]!;
			useHistoryStore.getState().removeEntry(toRemove.id);
			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(1);
			expect(entries[0]!.query).toBe('keep');
		});

		it('is a no-op for non-existent id', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().removeEntry('nonexistent');
			expect(useHistoryStore.getState().entries).toHaveLength(1);
		});
	});

	describe('getFiltered', () => {
		it('returns all entries when search is empty', () => {
			useHistoryStore.getState().addEntry(makeEntry({ query: 'a' }));
			useHistoryStore.getState().addEntry(makeEntry({ query: 'b' }));
			expect(useHistoryStore.getState().getFiltered()).toHaveLength(2);
		});

		it('filters by query text (case-insensitive)', () => {
			useHistoryStore
				.getState()
				.addEntry(makeEntry({ query: 'SELECT * FROM users' }));
			useHistoryStore
				.getState()
				.addEntry(makeEntry({ query: 'INSERT INTO orders' }));
			useHistoryStore.getState().setSearch('users');
			expect(useHistoryStore.getState().getFiltered()).toHaveLength(1);
			expect(useHistoryStore.getState().getFiltered()[0]!.query).toContain(
				'users',
			);
		});

		it('filters by database name', () => {
			useHistoryStore.getState().addEntry(makeEntry({ database: 'proddb' }));
			useHistoryStore.getState().addEntry(makeEntry({ database: 'devdb' }));
			useHistoryStore.getState().setSearch('prod');
			const filtered = useHistoryStore.getState().getFiltered();
			expect(filtered).toHaveLength(1);
			expect(filtered[0]!.database).toBe('proddb');
		});
	});

	describe('search state is transient', () => {
		it('does not affect entries when set', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().setSearch('test');
			// Search is runtime-only, entries remain unchanged
			expect(useHistoryStore.getState().entries).toHaveLength(1);
			expect(useHistoryStore.getState().search).toBe('test');
		});
	});
});
