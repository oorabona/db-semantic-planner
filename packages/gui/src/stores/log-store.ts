/**
 * Zustand store for application logs backed by SQLite.
 *
 * SQLite (via tauri-plugin-sql) is the source of truth.
 * Zustand holds the current display page (filtered, limited).
 * Callers write via addEntry(); the store persists to SQLite
 * and refreshes the display cache.
 */
import { create } from 'zustand';
import type { LogFilter, LogStats } from '@/lib/log-db';
import {
	clearLogs,
	closeLogDb,
	exportLogs,
	getLogStats,
	initLogDb,
	insertLog,
	queryLogs,
	rotateOldLogs,
	rowToEntry,
} from '@/lib/log-db';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
	readonly id: number;
	readonly timestamp: number;
	readonly level: LogLevel;
	readonly source: 'sidecar' | 'ipc' | 'app';
	readonly message: string;
	readonly durationMs?: number;
}

export interface LogState {
	/** Current display entries (filtered subset from SQLite). */
	entries: readonly LogEntry[];
	/** Active filter criteria. */
	filter: LogFilter;
	/** Aggregate stats (total + per-level). */
	stats: LogStats;
	/** Whether the SQLite backend is initialized. */
	dbReady: boolean;

	/** Initialize SQLite backend + load initial data. */
	initDb: () => Promise<void>;
	/** Close the SQLite connection. */
	closeDb: () => Promise<void>;
	/** Add a log entry (writes to SQLite + refreshes display). */
	addEntry: (
		level: LogLevel,
		source: LogEntry['source'],
		message: string,
		durationMs?: number,
	) => void;
	/** Update filter criteria and refresh display. */
	setFilter: (filter: Partial<LogFilter>) => void;
	/** Reload entries from SQLite using current filter. */
	refresh: () => Promise<void>;
	/** Clear all logs (SQLite + display). */
	clear: () => Promise<void>;
	/** Export filtered logs as array (for save-to-file). */
	exportLogs: (filter?: LogFilter) => Promise<LogEntry[]>;
}

const EMPTY_STATS: LogStats = { total: 0, byLevel: {} };

export const useLogStore = create<LogState>((set, get) => ({
	entries: [],
	filter: {},
	stats: EMPTY_STATS,
	dbReady: false,

	initDb: async () => {
		await initLogDb();
		// Rotate logs older than 30 days on startup
		await rotateOldLogs(30);
		set({ dbReady: true });
		await get().refresh();
	},

	closeDb: async () => {
		await closeLogDb();
		set({ dbReady: false });
	},

	addEntry: (level, source, message, durationMs) => {
		// Fire-and-forget write to SQLite
		insertLog(level, source, message, durationMs)
			.then(() => {
				// Refresh display + stats after DB write
				get().refresh();
			})
			.catch((err) => {
				console.error('[log-store] Failed to persist log entry:', err);
			});
	},

	setFilter: (partial) => {
		set((state) => ({
			filter: { ...state.filter, ...partial },
		}));
		get().refresh();
	},

	refresh: async () => {
		if (!get().dbReady) return;
		const filter = get().filter;
		const [rows, stats] = await Promise.all([
			queryLogs(filter),
			getLogStats(filter),
		]);
		set({
			entries: rows.map(rowToEntry),
			stats,
		});
	},

	clear: async () => {
		await clearLogs();
		set({ entries: [], stats: EMPTY_STATS });
	},

	exportLogs: async (filter) => {
		const rows = await exportLogs(filter ?? get().filter);
		return rows.map(rowToEntry);
	},
}));
