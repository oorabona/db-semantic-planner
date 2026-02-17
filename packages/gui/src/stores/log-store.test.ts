/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock log-db module before importing the store
vi.mock('@/lib/log-db', () => {
	let rows: Array<{
		id: number;
		timestamp: number;
		level: string;
		source: string;
		message: string;
		duration_ms: number | null;
	}> = [];
	let nextId = 1;

	return {
		initLogDb: vi.fn(async () => {}),
		closeLogDb: vi.fn(async () => {}),
		insertLog: vi.fn(
			async (
				level: string,
				source: string,
				message: string,
				durationMs?: number,
			) => {
				rows.push({
					id: nextId++,
					timestamp: Date.now(),
					level,
					source,
					message,
					duration_ms: durationMs ?? null,
				});
			},
		),
		queryLogs: vi.fn(async () => [...rows]),
		getLogStats: vi.fn(async () => {
			const byLevel: Record<string, number> = {};
			for (const r of rows) {
				byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
			}
			return { total: rows.length, byLevel };
		}),
		clearLogs: vi.fn(async () => {
			rows = [];
		}),
		rotateOldLogs: vi.fn(async () => 0),
		exportLogs: vi.fn(async () => [...rows]),
		rowToEntry: vi.fn(
			(row: {
				id: number;
				timestamp: number;
				level: string;
				source: string;
				message: string;
				duration_ms: number | null;
			}) => ({
				id: row.id,
				timestamp: row.timestamp,
				level: row.level,
				source: row.source,
				message: row.message,
				...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
			}),
		),
	};
});

import { useLogStore } from './log-store';

describe('useLogStore', () => {
	beforeEach(async () => {
		await useLogStore.getState().initDb();
	});

	afterEach(async () => {
		await useLogStore.getState().clear();
		await useLogStore.getState().closeDb();
	});

	it('should start with empty entries after init', () => {
		// After initDb + refresh, entries is whatever queryLogs returns
		// The mock starts empty, so entries should be empty
		expect(useLogStore.getState().entries).toEqual([]);
	});

	it('should add an entry and refresh display', async () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'hello');
		// addEntry is fire-and-forget; wait for the internal refresh
		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(1);
		});
		const entry = useLogStore.getState().entries[0]!;
		expect(entry).toMatchObject({
			level: 'info',
			source: 'sidecar',
			message: 'hello',
		});
		expect(entry.id).toBeGreaterThan(0);
		expect(entry.timestamp).toBeGreaterThan(0);
	});

	it('should preserve insertion order', async () => {
		const { addEntry } = useLogStore.getState();
		addEntry('info', 'sidecar', 'first');
		addEntry('warn', 'ipc', 'second');
		addEntry('error', 'app', 'third');

		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(3);
		});
		const messages = useLogStore.getState().entries.map((e) => e.message);
		expect(messages).toEqual(['first', 'second', 'third']);
	});

	it('should store durationMs when provided', async () => {
		useLogStore.getState().addEntry('info', 'ipc', '← executeNQL', 142);
		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(1);
		});
		const entry = useLogStore.getState().entries[0]!;
		expect(entry.durationMs).toBe(142);
	});

	it('should omit durationMs when not provided', async () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'hello');
		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(1);
		});
		expect(useLogStore.getState().entries[0]).not.toHaveProperty('durationMs');
	});

	it('should clear all entries', async () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'hello');
		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(1);
		});

		await useLogStore.getState().clear();
		expect(useLogStore.getState().entries).toEqual([]);
	});

	it('should track stats', async () => {
		useLogStore.getState().addEntry('info', 'sidecar', 'a');
		useLogStore.getState().addEntry('error', 'ipc', 'b');
		await vi.waitFor(() => {
			expect(useLogStore.getState().entries).toHaveLength(2);
		});
		const stats = useLogStore.getState().stats;
		expect(stats.total).toBe(2);
		expect(stats.byLevel).toEqual({ info: 1, error: 1 });
	});

	it('should have dbReady=true after initDb', () => {
		expect(useLogStore.getState().dbReady).toBe(true);
	});
});
