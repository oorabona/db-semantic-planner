/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from './db-shared';
import { migrateFromLocalStorage } from './migration';

// ── Mock DB ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function createMockDb() {
	const meta: Record<string, string> = {};
	const history: Row[] = [];
	const connections: Row[] = [];

	const db: Database = {
		execute: vi.fn(async (sql: string, params?: unknown[]) => {
			const s = sql.trim().toLowerCase();

			if (s.includes('insert') && s.includes('_meta')) {
				const key = params?.[0] as string;
				const value = params?.[1] as string;
				if (key) meta[key] = value;
				return { lastInsertId: 0, rowsAffected: 1 };
			}

			if (s.includes('insert') && s.includes('query_history')) {
				const id = params?.[0] as string;
				// Remove existing with same id (INSERT OR REPLACE)
				const idx = history.findIndex((r) => r.id === id);
				if (idx >= 0) history.splice(idx, 1);
				history.push({ id, query: params?.[1] });
				return { lastInsertId: 0, rowsAffected: 1 };
			}

			if (s.includes('insert') && s.includes('connection_profiles')) {
				const id = params?.[0] as string;
				const idx = connections.findIndex((r) => r.id === id);
				if (idx >= 0) connections.splice(idx, 1);
				connections.push({ id, name: params?.[1] });
				return { lastInsertId: 0, rowsAffected: 1 };
			}

			return { lastInsertId: 0, rowsAffected: 0 };
		}),

		select: vi.fn(async (sql: string, _params?: unknown[]) => {
			if (sql.includes('migration_complete')) {
				const val = meta.migration_complete;
				return val ? [{ value: val }] : [];
			}
			return [];
		}) as Database['select'],

		close: vi.fn().mockResolvedValue(undefined),
	};

	return { db, meta, history, connections };
}

// ── Helpers ──────────────────────────────────────────────────────

function setLocalStorage(key: string, value: unknown): void {
	localStorage.setItem(key, JSON.stringify(value));
}

// ── Tests ────────────────────────────────────────────────────────

let mock: ReturnType<typeof createMockDb>;

beforeEach(() => {
	mock = createMockDb();
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

describe('migrateFromLocalStorage', () => {
	it('migrates history entries', async () => {
		setLocalStorage('dbsp-history', {
			state: {
				entries: [
					{
						id: 'h1',
						query: 'SELECT 1',
						language: 'sql',
						database: 'testdb',
						timestamp: 1700000000000,
						durationMs: 42,
						rowCount: 1,
						success: true,
					},
					{
						id: 'h2',
						query: 'SELECT 2',
						language: 'nql',
						database: 'proddb',
						timestamp: 1700000001000,
						durationMs: 10,
						rowCount: 5,
						success: true,
					},
				],
			},
		});

		const result = await migrateFromLocalStorage(mock.db);

		expect(result.historyMigrated).toBe(2);
		expect(result.historySkipped).toBe(0);
		expect(result.alreadyDone).toBe(false);
		expect(mock.history).toHaveLength(2);
	});

	it('migrates connection profiles with JSON config', async () => {
		setLocalStorage('dbsp-connections', {
			state: {
				profiles: [
					{
						id: 'c1',
						name: 'Local Dev',
						type: 'postgresql',
						host: 'localhost',
						port: 5432,
						database: 'mydb',
						user: 'postgres',
						schema: 'public',
						sslMode: 'prefer',
					},
				],
			},
		});

		const result = await migrateFromLocalStorage(mock.db);

		expect(result.connectionsMigrated).toBe(1);
		expect(result.connectionsSkipped).toBe(0);
		expect(mock.connections).toHaveLength(1);

		// Verify config JSON was built from flat fields
		const configParam = (
			mock.db.execute as ReturnType<typeof vi.fn>
		).mock.calls.find((c: unknown[]) =>
			(c[0] as string).includes('connection_profiles'),
		)?.[1]?.[4] as string;
		const parsed = JSON.parse(configParam);
		expect(parsed.host).toBe('localhost');
		expect(parsed.port).toBe(5432);
	});

	it('skips migration if already complete', async () => {
		mock.meta.migration_complete = 'true';

		const result = await migrateFromLocalStorage(mock.db);

		expect(result.alreadyDone).toBe(true);
		expect(result.historyMigrated).toBe(0);
	});

	it('is idempotent — re-running replaces existing entries', async () => {
		setLocalStorage('dbsp-history', {
			state: {
				entries: [
					{
						id: 'h1',
						query: 'SELECT 1',
						language: 'sql',
						database: 'db',
						timestamp: 1,
						durationMs: 1,
						rowCount: 1,
						success: true,
					},
				],
			},
		});

		// First run
		await migrateFromLocalStorage(mock.db);
		expect(mock.history).toHaveLength(1);

		// Reset migration flag to simulate partial failure
		delete (mock.meta as Record<string, string>).migration_complete;

		// Second run — should INSERT OR REPLACE
		const result = await migrateFromLocalStorage(mock.db);
		expect(result.historyMigrated).toBe(1);
		expect(mock.history).toHaveLength(1); // Same entry, not duplicated
	});

	it('skips malformed entries with warning count', async () => {
		setLocalStorage('dbsp-history', {
			state: {
				entries: [
					{
						id: 'h1',
						query: 'SELECT 1',
						language: 'sql',
						database: 'db',
						timestamp: 1,
						durationMs: 1,
						rowCount: 1,
						success: true,
					},
					{ noId: true }, // Malformed — missing id and query
					{
						id: 'h3',
						query: 'SELECT 3',
						language: 'sql',
						database: 'db',
						timestamp: 3,
						durationMs: 1,
						rowCount: 1,
						success: true,
					},
				],
			},
		});

		const result = await migrateFromLocalStorage(mock.db);

		expect(result.historyMigrated).toBe(2);
		expect(result.historySkipped).toBe(1);
	});

	it('handles malformed JSON gracefully', async () => {
		localStorage.setItem('dbsp-history', '{invalid json');

		const result = await migrateFromLocalStorage(mock.db);

		expect(result.historyMigrated).toBe(0);
		expect(result.historySkipped).toBe(1);
	});

	it('handles missing localStorage keys', async () => {
		const result = await migrateFromLocalStorage(mock.db);

		expect(result.historyMigrated).toBe(0);
		expect(result.historySkipped).toBe(0);
		expect(result.connectionsMigrated).toBe(0);
		expect(result.connectionsSkipped).toBe(0);
		expect(result.alreadyDone).toBe(false);
	});

	it('sets migration_complete flag', async () => {
		setLocalStorage('dbsp-history', { state: { entries: [] } });

		await migrateFromLocalStorage(mock.db);

		expect(mock.meta.migration_complete).toBe('true');
	});

	it('preserves localStorage data (does not delete)', async () => {
		setLocalStorage('dbsp-history', {
			state: {
				entries: [
					{
						id: 'h1',
						query: 'SELECT 1',
						language: 'sql',
						database: 'db',
						timestamp: 1,
						durationMs: 1,
						rowCount: 1,
						success: true,
					},
				],
			},
		});

		await migrateFromLocalStorage(mock.db);

		// localStorage should still have the data
		expect(localStorage.getItem('dbsp-history')).not.toBeNull();
	});
});
