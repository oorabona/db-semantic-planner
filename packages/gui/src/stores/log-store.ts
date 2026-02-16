/**
 * Zustand store for application logs (sidecar stderr, IPC, timing).
 * Ring buffer: max 500 entries, oldest evicted on overflow.
 */
import { create } from 'zustand';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
	readonly id: number;
	readonly timestamp: number;
	readonly level: LogLevel;
	readonly source: 'sidecar' | 'ipc' | 'app';
	readonly message: string;
	readonly durationMs?: number;
}

const MAX_ENTRIES = 500;

let nextId = 1;

export interface LogState {
	entries: readonly LogEntry[];

	addEntry: (
		level: LogLevel,
		source: LogEntry['source'],
		message: string,
		durationMs?: number,
	) => void;
	clear: () => void;
}

export const useLogStore = create<LogState>((set) => ({
	entries: [],

	addEntry: (level, source, message, durationMs) =>
		set((state) => {
			const entry: LogEntry = {
				id: nextId++,
				timestamp: Date.now(),
				level,
				source,
				message,
				...(durationMs != null ? { durationMs } : {}),
			};
			const next = [...state.entries, entry];
			// Ring buffer: evict oldest when over limit
			return {
				entries: next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next,
			};
		}),

	clear: () => set({ entries: [] }),
}));
