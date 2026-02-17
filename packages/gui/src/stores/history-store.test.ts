import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type HistoryEntry,
	setHistoryDbAccessor,
	useHistoryStore,
} from './history-store.js';

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

// ── Mock DB ──────────────────────────────────────────────────────

function createMockDb() {
	return {
		execute: vi.fn().mockResolvedValue({ lastInsertId: 0, rowsAffected: 0 }),
		select: vi.fn().mockResolvedValue([]),
		close: vi.fn().mockResolvedValue(undefined),
	};
}

let mockDb: ReturnType<typeof createMockDb>;

beforeEach(() => {
	mockDb = createMockDb();
	setHistoryDbAccessor(() => mockDb);
	useHistoryStore.setState({ entries: [], search: '', loaded: false });
});

afterEach(() => {
	setHistoryDbAccessor(null);
});

describe('useHistoryStore', () => {
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

		it('persists to SQLite', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			expect(mockDb.execute).toHaveBeenCalledWith(
				expect.stringContaining('INSERT OR REPLACE INTO query_history'),
				expect.arrayContaining(['SELECT * FROM users']),
			);
		});
	});

	describe('FIFO pruning', () => {
		it('caps entries at 500, dropping oldest', () => {
			const bulk: HistoryEntry[] = Array.from({ length: 500 }, (_, i) => ({
				...ENTRY,
				id: `old-${i}`,
				query: `query-${i}`,
			}));
			useHistoryStore.setState({ entries: bulk });

			useHistoryStore.getState().addEntry(makeEntry({ query: 'newest' }));
			const { entries } = useHistoryStore.getState();
			expect(entries).toHaveLength(500);
			expect(entries[0]!.query).toBe('newest');
			expect(entries.some((e) => e.id === 'old-499')).toBe(false);
		});
	});

	describe('clearHistory', () => {
		it('removes all entries and clears SQLite', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().clearHistory();
			expect(useHistoryStore.getState().entries).toHaveLength(0);
			expect(mockDb.execute).toHaveBeenCalledWith('DELETE FROM query_history');
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

		it('deletes from SQLite', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			const id = useHistoryStore.getState().entries[0]!.id;
			useHistoryStore.getState().removeEntry(id);
			expect(mockDb.execute).toHaveBeenCalledWith(
				'DELETE FROM query_history WHERE id = $1',
				[id],
			);
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

	describe('loadHistory', () => {
		it('loads entries from SQLite', async () => {
			mockDb.select.mockResolvedValueOnce([
				{
					id: 'abc',
					query: 'SELECT 1',
					language: 'sql',
					database: 'testdb',
					timestamp: 1700000000000,
					duration_ms: 10,
					row_count: 1,
					success: 1,
					error: null,
				},
			]);

			await useHistoryStore.getState().loadHistory();
			const { entries, loaded } = useHistoryStore.getState();
			expect(entries).toHaveLength(1);
			expect(entries[0]!.id).toBe('abc');
			expect(entries[0]!.durationMs).toBe(10);
			expect(entries[0]!.success).toBe(true);
			expect(loaded).toBe(true);
		});

		it('handles empty database', async () => {
			await useHistoryStore.getState().loadHistory();
			expect(useHistoryStore.getState().entries).toHaveLength(0);
			expect(useHistoryStore.getState().loaded).toBe(true);
		});
	});

	describe('search state is transient', () => {
		it('does not affect entries when set', () => {
			useHistoryStore.getState().addEntry(ENTRY);
			useHistoryStore.getState().setSearch('test');
			expect(useHistoryStore.getState().entries).toHaveLength(1);
			expect(useHistoryStore.getState().search).toBe('test');
		});
	});
});
