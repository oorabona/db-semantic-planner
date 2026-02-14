import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ────────────────────────────────────────────────────────

export interface HistoryEntry {
	readonly id: string;
	/** SQL or NQL text */
	readonly query: string;
	readonly language: 'sql' | 'nql';
	/** Connection database name */
	readonly database: string;
	/** Date.now() */
	readonly timestamp: number;
	/** Execution time in ms */
	readonly durationMs: number;
	/** rows.length or null on error */
	readonly rowCount: number | null;
	readonly success: boolean;
	/** Error message if failed */
	readonly error?: string | undefined;
}

const MAX_ENTRIES = 500;

// ── Store ────────────────────────────────────────────────────────

interface HistoryState {
	readonly entries: readonly HistoryEntry[];
	readonly search: string;

	addEntry: (entry: Omit<HistoryEntry, 'id'>) => void;
	setSearch: (search: string) => void;
	clearHistory: () => void;
	removeEntry: (id: string) => void;
	getFiltered: () => readonly HistoryEntry[];
}

export const useHistoryStore = create<HistoryState>()(
	persist(
		(set, get) => ({
			entries: [],
			search: '',

			addEntry: (entry) =>
				set((state) => {
					const newEntry: HistoryEntry = {
						...entry,
						id: crypto.randomUUID(),
					};
					const updated = [newEntry, ...state.entries];
					return {
						entries:
							updated.length > MAX_ENTRIES
								? updated.slice(0, MAX_ENTRIES)
								: updated,
					};
				}),

			setSearch: (search) => set({ search }),

			clearHistory: () => set({ entries: [] }),

			removeEntry: (id) =>
				set((state) => ({
					entries: state.entries.filter((e) => e.id !== id),
				})),

			getFiltered: () => {
				const { entries, search } = get();
				if (!search) return entries;
				const lower = search.toLowerCase();
				return entries.filter(
					(e) =>
						e.query.toLowerCase().includes(lower) ||
						e.database.toLowerCase().includes(lower),
				);
			},
		}),
		{
			name: 'dbsp-history',
			// Only persist entries, not runtime search state
			partialize: (state) => ({ entries: state.entries }),
		},
	),
);
