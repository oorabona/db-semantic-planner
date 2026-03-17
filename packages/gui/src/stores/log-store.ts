/**
 * Zustand store for application logs — dual-backend routing.
 *
 * Write path:
 *   - source='sidecar'|'app' → app-db.ts (app.sqlite/app_logs)
 *   - source='ipc'           → project-db.ts (data.sqlite/ipc_logs)
 *
 * Read paths:
 *   - Bottom panel "Logs" tab → IPC logs from project-db
 *   - StatusBar "+" popover   → App logs from app-db
 */
import { toast } from 'sonner';
import { create } from 'zustand';
import type { AppLogRow } from '@/lib/app-db';
import {
	clearAppLogs,
	closeAppDb,
	initAppDb,
	insertAppLog,
	queryAppLogs,
} from '@/lib/app-db';
import type { IpcLogRow } from '@/lib/project-db';
import {
	clearIpcLogs,
	getIpcLogStats,
	insertIpcLog,
	queryIpcLogs,
	rotateIpcLogs,
} from '@/lib/project-db';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
	readonly id: number;
	readonly timestamp: number;
	readonly level: LogLevel;
	readonly source: 'sidecar' | 'ipc' | 'app';
	readonly message: string;
	readonly durationMs?: number;
	readonly method?: string;
	readonly connectionId?: string;
}

/** Filter criteria for the IPC logs panel. */
export interface LogFilter {
	levels?: LogLevel[];
	sources?: LogEntry['source'][];
	search?: string;
	since?: number;
	limit?: number;
	method?: string;
}

/** Aggregate stats for IPC logs. */
export interface LogStats {
	total: number;
	byLevel: Partial<Record<LogLevel, number>>;
}

export interface LogState {
	/** IPC log entries for the bottom panel "Logs" tab. */
	entries: readonly LogEntry[];
	/** Active filter criteria for IPC logs. */
	filter: LogFilter;
	/** Aggregate stats for IPC logs (total + per-level). */
	stats: LogStats;
	/** App-level log entries for StatusBar "+" popover. */
	appEntries: readonly LogEntry[];
	/** Whether the backends are initialized. */
	dbReady: boolean;

	/** Initialize backends + load initial data. */
	initDb: () => Promise<void>;
	/** Close backends. */
	closeDb: () => Promise<void>;
	/** Add a log entry — routes to correct backend by source. */
	addEntry: (
		level: LogLevel,
		source: LogEntry['source'],
		message: string,
		durationMs?: number,
		opts?: { method?: string; connectionId?: string },
	) => void;
	/** Update IPC log filter criteria and refresh. */
	setFilter: (filter: Partial<LogFilter>) => void;
	/** Reload IPC log entries from project-db. */
	refresh: () => Promise<void>;
	/** Reload app-level log entries from app-db. */
	refreshAppLogs: () => Promise<void>;
	/** Clear all IPC logs (project-db). */
	clear: () => Promise<void>;
	/** Clear all app-level logs (app-db). */
	clearApp: () => Promise<void>;
	/** Export IPC logs as array (for save-to-file). */
	exportLogs: (filter?: LogFilter) => Promise<LogEntry[]>;
}

const EMPTY_STATS: LogStats = { total: 0, byLevel: {} };

// ── Row → Entry converters ──────────────────────────────────────

function ipcRowToEntry(row: IpcLogRow): LogEntry {
	return {
		id: row.id,
		timestamp: row.timestamp,
		level: row.level as LogLevel,
		source: 'ipc',
		message: row.message,
		...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
		...(row.method != null ? { method: row.method } : {}),
		...(row.connection_id != null ? { connectionId: row.connection_id } : {}),
	};
}

function appRowToEntry(row: AppLogRow): LogEntry {
	return {
		id: row.id,
		timestamp: row.timestamp,
		level: row.level as LogLevel,
		source: row.source as LogEntry['source'],
		message: row.message,
		...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
	};
}

// ── Store ────────────────────────────────────────────────────────

export const useLogStore = create<LogState>((set, get) => ({
	entries: [],
	filter: {},
	stats: EMPTY_STATS,
	appEntries: [],
	dbReady: false,

	initDb: async () => {
		// App-db is always initialized (app.sqlite)
		await initAppDb();

		// Rotate old IPC logs on startup (retention from user settings)
		try {
			const { useUserSettingsStore } = await import('./user-settings-store');
			const days = useUserSettingsStore.getState().logRetentionDays;
			await rotateIpcLogs(days);
		} catch {
			// No user settings store or no project-db yet — OK
		}

		set({ dbReady: true });
		await Promise.all([get().refresh(), get().refreshAppLogs()]);
	},

	closeDb: async () => {
		await closeAppDb();
		// project-db lifecycle managed by project-store
		set({ dbReady: false });
	},

	addEntry: (level, source, message, durationMs, opts) => {
		// Surface warnings/errors as toast notifications
		if (level === 'error') toast.error(message, { duration: 6000 });
		else if (level === 'warn') toast.warning(message, { duration: 4000 });

		if (source === 'ipc') {
			// IPC logs → project-db (data.sqlite) with redaction
			insertIpcLog(level, message, {
				durationMs,
				method: opts?.method,
				connectionId: opts?.connectionId,
			})
				.then(() => get().refresh())
				.catch((err: unknown) =>
					console.error('[log-store] Failed to persist IPC log:', err),
				);
		} else {
			// sidecar / app → app-db (app.sqlite)
			insertAppLog(level, source, message, durationMs)
				.then(() => get().refreshAppLogs())
				.catch((err: unknown) =>
					console.error('[log-store] Failed to persist app log:', err),
				);
		}
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

		const [rows, statsResult] = await Promise.all([
			queryIpcLogs({
				since: filter.since,
				limit: filter.limit ?? 5000,
				method: filter.method,
			}),
			getIpcLogStats(),
		]);

		// Client-side filtering for levels/search (IPC table doesn't have these indexed)
		let entries = rows.map(ipcRowToEntry);

		if (filter.levels?.length) {
			const allowed = new Set(filter.levels);
			entries = entries.filter((e) => allowed.has(e.level));
		}
		if (filter.search) {
			const q = filter.search.toLowerCase();
			entries = entries.filter((e) => e.message.toLowerCase().includes(q));
		}

		set({ entries, stats: statsResult });
	},

	refreshAppLogs: async () => {
		if (!get().dbReady) return;
		const rows = await queryAppLogs({ limit: 500 });
		// queryAppLogs returns DESC order — reverse for chronological
		set({ appEntries: rows.map(appRowToEntry).reverse() });
	},

	clear: async () => {
		await clearIpcLogs();
		set({ entries: [], stats: EMPTY_STATS });
	},

	clearApp: async () => {
		await clearAppLogs();
		set({ appEntries: [] });
	},

	exportLogs: async (filter) => {
		const f = filter ?? get().filter;
		const rows = await queryIpcLogs({
			since: f.since,
			limit: 0, // no limit for export
			method: f.method,
		});
		return rows.map(ipcRowToEntry);
	},
}));
