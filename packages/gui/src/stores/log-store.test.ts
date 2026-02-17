/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock app-db (sidecar + app logs) ────────────────────────────

let appRows: Array<{
	id: number;
	timestamp: number;
	level: string;
	source: string;
	message: string;
	duration_ms: number | null;
}> = [];
let appNextId = 1;

vi.mock('@/lib/app-db', () => ({
	initAppDb: vi.fn(async () => {}),
	closeAppDb: vi.fn(async () => {}),
	insertAppLog: vi.fn(
		async (
			level: string,
			source: string,
			message: string,
			durationMs?: number,
		) => {
			appRows.push({
				id: appNextId++,
				timestamp: Date.now(),
				level,
				source,
				message,
				duration_ms: durationMs ?? null,
			});
		},
	),
	queryAppLogs: vi.fn(async () => [...appRows].reverse()),
}));

// ── Mock project-db (IPC logs) ──────────────────────────────────

let ipcRows: Array<{
	id: number;
	timestamp: number;
	level: string;
	source: string;
	message: string;
	duration_ms: number | null;
	method: string | null;
	connection_id: string | null;
}> = [];
let ipcNextId = 1;

vi.mock('@/lib/project-db', () => ({
	insertIpcLog: vi.fn(
		async (
			level: string,
			message: string,
			opts?: {
				durationMs?: number;
				method?: string;
				connectionId?: string;
			},
		) => {
			ipcRows.push({
				id: ipcNextId++,
				timestamp: Date.now(),
				level,
				source: 'ipc',
				message,
				duration_ms: opts?.durationMs ?? null,
				method: opts?.method ?? null,
				connection_id: opts?.connectionId ?? null,
			});
		},
	),
	queryIpcLogs: vi.fn(async () => [...ipcRows]),
	getIpcLogStats: vi.fn(async () => {
		const byLevel: Record<string, number> = {};
		for (const r of ipcRows) {
			byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
		}
		return { total: ipcRows.length, byLevel };
	}),
	clearIpcLogs: vi.fn(async () => {
		ipcRows = [];
	}),
	rotateIpcLogs: vi.fn(async () => 0),
}));

// ── Mock user-settings-store (imported lazily by initDb) ────────

vi.mock('./user-settings-store', () => ({
	useUserSettingsStore: {
		getState: () => ({ logRetentionDays: 7 }),
	},
}));

import { useLogStore } from './log-store';

describe('useLogStore (dual-backend)', () => {
	beforeEach(async () => {
		appRows = [];
		appNextId = 1;
		ipcRows = [];
		ipcNextId = 1;
		useLogStore.setState({
			entries: [],
			filter: {},
			stats: { total: 0, byLevel: {} },
			appEntries: [],
			dbReady: false,
		});
		await useLogStore.getState().initDb();
	});

	afterEach(async () => {
		await useLogStore.getState().closeDb();
	});

	it('starts with empty entries after init', () => {
		expect(useLogStore.getState().entries).toEqual([]);
		expect(useLogStore.getState().appEntries).toEqual([]);
		expect(useLogStore.getState().dbReady).toBe(true);
	});

	// ── Routing ─────────────────────────────────────────────────

	describe('routing', () => {
		it('routes IPC logs to project-db entries', async () => {
			useLogStore.getState().addEntry('info', 'ipc', '← executeNQL');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});

			const entry = useLogStore.getState().entries[0]!;
			expect(entry).toMatchObject({
				level: 'info',
				source: 'ipc',
				message: '← executeNQL',
			});
			// Should NOT appear in appEntries
			expect(useLogStore.getState().appEntries).toHaveLength(0);
		});

		it('routes sidecar logs to app-db appEntries', async () => {
			useLogStore.getState().addEntry('info', 'sidecar', 'boot ok');

			await vi.waitFor(() => {
				expect(useLogStore.getState().appEntries).toHaveLength(1);
			});

			const entry = useLogStore.getState().appEntries[0]!;
			expect(entry).toMatchObject({
				level: 'info',
				source: 'sidecar',
				message: 'boot ok',
			});
			// Should NOT appear in entries (IPC)
			expect(useLogStore.getState().entries).toHaveLength(0);
		});

		it('routes app logs to app-db appEntries', async () => {
			useLogStore.getState().addEntry('warn', 'app', 'low memory');

			await vi.waitFor(() => {
				expect(useLogStore.getState().appEntries).toHaveLength(1);
			});

			expect(useLogStore.getState().appEntries[0]!.source).toBe('app');
			expect(useLogStore.getState().entries).toHaveLength(0);
		});
	});

	// ── IPC log features ────────────────────────────────────────

	describe('IPC logs', () => {
		it('stores durationMs when provided', async () => {
			useLogStore.getState().addEntry('info', 'ipc', '← query', 42);

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			expect(useLogStore.getState().entries[0]!.durationMs).toBe(42);
		});

		it('stores method and connectionId', async () => {
			useLogStore.getState().addEntry('info', 'ipc', '← query', 10, {
				method: 'schema.introspect',
				connectionId: 'conn-1',
			});

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			const entry = useLogStore.getState().entries[0]!;
			expect(entry.method).toBe('schema.introspect');
			expect(entry.connectionId).toBe('conn-1');
		});

		it('omits durationMs when not provided', async () => {
			useLogStore.getState().addEntry('info', 'ipc', 'hello');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			expect(useLogStore.getState().entries[0]).not.toHaveProperty(
				'durationMs',
			);
		});

		it('clears IPC logs only', async () => {
			useLogStore.getState().addEntry('info', 'ipc', 'ipc msg');
			useLogStore.getState().addEntry('info', 'sidecar', 'sidecar msg');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			await vi.waitFor(() => {
				expect(useLogStore.getState().appEntries).toHaveLength(1);
			});

			await useLogStore.getState().clear();
			expect(useLogStore.getState().entries).toEqual([]);
			// App entries are NOT cleared
			expect(useLogStore.getState().appEntries).toHaveLength(1);
		});

		it('tracks IPC stats', async () => {
			useLogStore.getState().addEntry('info', 'ipc', 'a');
			useLogStore.getState().addEntry('error', 'ipc', 'b');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(2);
			});
			const stats = useLogStore.getState().stats;
			expect(stats.total).toBe(2);
			expect(stats.byLevel).toEqual({ info: 1, error: 1 });
		});
	});

	// ── App log features ────────────────────────────────────────

	describe('app logs', () => {
		it('stores durationMs for sidecar logs', async () => {
			useLogStore.getState().addEntry('info', 'sidecar', 'boot', 500);

			await vi.waitFor(() => {
				expect(useLogStore.getState().appEntries).toHaveLength(1);
			});
			expect(useLogStore.getState().appEntries[0]!.durationMs).toBe(500);
		});

		it('refreshAppLogs reloads from app-db', async () => {
			useLogStore.getState().addEntry('info', 'sidecar', 'msg1');

			await vi.waitFor(() => {
				expect(useLogStore.getState().appEntries).toHaveLength(1);
			});

			// Add another outside store (simulate external write)
			appRows.push({
				id: 999,
				timestamp: Date.now(),
				level: 'warn',
				source: 'app',
				message: 'external',
				duration_ms: null,
			});

			await useLogStore.getState().refreshAppLogs();
			expect(useLogStore.getState().appEntries).toHaveLength(2);
		});
	});

	// ── Filter ──────────────────────────────────────────────────

	describe('setFilter', () => {
		it('filters IPC entries by level (client-side)', async () => {
			useLogStore.getState().addEntry('info', 'ipc', 'a');
			useLogStore.getState().addEntry('error', 'ipc', 'b');
			useLogStore.getState().addEntry('warn', 'ipc', 'c');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(3);
			});

			useLogStore.getState().setFilter({ levels: ['error'] });

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			expect(useLogStore.getState().entries[0]!.level).toBe('error');
		});

		it('filters IPC entries by search text', async () => {
			useLogStore.getState().addEntry('info', 'ipc', 'executeNQL');
			useLogStore.getState().addEntry('info', 'ipc', 'schema.introspect');

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(2);
			});

			useLogStore.getState().setFilter({ search: 'nql' });

			await vi.waitFor(() => {
				expect(useLogStore.getState().entries).toHaveLength(1);
			});
			expect(useLogStore.getState().entries[0]!.message).toBe('executeNQL');
		});
	});
});
