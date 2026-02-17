import { create } from 'zustand';
import type { Database } from '@/lib/db-shared';

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

// ── DB accessor ──────────────────────────────────────────────────
// Injected at init time so the store doesn't depend on the project-db module.

let getDb: (() => Database | null) | null = null;

/**
 * Set the function that provides the current project database handle.
 * Called once at app startup (or in tests).
 */
export function setHistoryDbAccessor(
	accessor: (() => Database | null) | null,
): void {
	getDb = accessor;
}

// ── Store ────────────────────────────────────────────────────────

interface HistoryState {
	readonly entries: readonly HistoryEntry[];
	readonly search: string;
	readonly loaded: boolean;

	addEntry: (entry: Omit<HistoryEntry, 'id'>) => void;
	setSearch: (search: string) => void;
	clearHistory: () => void;
	removeEntry: (id: string) => void;
	getFiltered: () => readonly HistoryEntry[];
	loadHistory: () => Promise<void>;
}

/** Convert a SQLite row (snake_case) to a HistoryEntry (camelCase). */
function rowToEntry(row: Record<string, unknown>): HistoryEntry {
	return {
		id: row.id as string,
		query: row.query as string,
		language: row.language as 'sql' | 'nql',
		database: (row.database as string) ?? '',
		timestamp: row.timestamp as number,
		durationMs: (row.duration_ms as number) ?? 0,
		rowCount: row.row_count as number | null,
		success: (row.success as number) === 1,
		error: (row.error as string) ?? undefined,
	};
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
	entries: [],
	search: '',
	loaded: false,

	loadHistory: async () => {
		const db = getDb?.();
		if (!db) return;

		const rows = await db.select<Array<Record<string, unknown>>>(
			'SELECT id, query, language, database, timestamp, duration_ms, row_count, success, error FROM query_history ORDER BY timestamp DESC LIMIT $1',
			[MAX_ENTRIES],
		);
		set({ entries: rows.map(rowToEntry), loaded: true });
	},

	addEntry: (entry) => {
		const newEntry: HistoryEntry = {
			...entry,
			id: crypto.randomUUID(),
		};

		set((state) => {
			const updated = [newEntry, ...state.entries];
			return {
				entries:
					updated.length > MAX_ENTRIES
						? updated.slice(0, MAX_ENTRIES)
						: updated,
			};
		});

		// Persist to SQLite (fire-and-forget)
		const db = getDb?.();
		if (db) {
			db.execute(
				`INSERT OR REPLACE INTO query_history
				 (id, query, language, database, timestamp, duration_ms, row_count, success, error)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				[
					newEntry.id,
					newEntry.query,
					newEntry.language,
					newEntry.database,
					newEntry.timestamp,
					newEntry.durationMs,
					newEntry.rowCount,
					newEntry.success ? 1 : 0,
					newEntry.error ?? null,
				],
			).catch(() => {
				/* best-effort persistence */
			});
		}
	},

	setSearch: (search) => set({ search }),

	clearHistory: () => {
		set({ entries: [] });

		const db = getDb?.();
		if (db) {
			db.execute('DELETE FROM query_history').catch(() => {});
		}
	},

	removeEntry: (id) => {
		set((state) => ({
			entries: state.entries.filter((e) => e.id !== id),
		}));

		const db = getDb?.();
		if (db) {
			db.execute('DELETE FROM query_history WHERE id = $1', [id]).catch(
				() => {},
			);
		}
	},

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
}));
