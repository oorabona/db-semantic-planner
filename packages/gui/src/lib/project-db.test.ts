/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDatabaseFactory } from './db-shared';
import {
	closeProjectDb,
	getProjectDb,
	getProjectDbUri,
	getProjectMeta,
	openDefaultDb,
	openProjectDb,
	rotateOldHistory,
	setProjectMeta,
} from './project-db';

// ── Mock DB ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function createMockDb() {
	const tables: Record<string, Row[]> = {};

	const execute = vi.fn(async (sql: string, params?: unknown[]) => {
		const s = sql.trim().toLowerCase();

		if (s.startsWith('create table') || s.startsWith('create index')) {
			const match = sql.match(
				/(?:create table|create index)\s+(?:if not exists\s+)?(\w+)/i,
			);
			if (match && s.startsWith('create table')) {
				tables[match[1]!] ??= [];
			}
			return { lastInsertId: 0, rowsAffected: 0 };
		}

		if (s.startsWith('insert')) {
			const tbl = sql.match(/into\s+(\w+)/i)?.[1] ?? '';
			tables[tbl] ??= [];

			const colMatch = sql.match(/\(([^)]+)\)\s*values/i);
			if (!colMatch || !params) return { lastInsertId: 0, rowsAffected: 0 };

			const cols = colMatch[1]!.split(',').map((c) => c.trim());
			const row: Row = {};
			for (let i = 0; i < cols.length; i++) {
				row[cols[i]!] = params[i];
			}

			if (s.includes('on conflict')) {
				const pkCol = cols[0]!;
				tables[tbl] = tables[tbl].filter((r) => r[pkCol] !== row[pkCol]);
			}

			if (s.includes('or ignore')) {
				const pkCol = cols[0]!;
				if (tables[tbl].some((r) => r[pkCol] === row[pkCol])) {
					return { lastInsertId: 0, rowsAffected: 0 };
				}
			}

			tables[tbl].push(row);
			return { lastInsertId: 0, rowsAffected: 1 };
		}

		if (s.startsWith('select')) {
			return { lastInsertId: 0, rowsAffected: 0 };
		}

		return { lastInsertId: 0, rowsAffected: 0 };
	});

	const select = vi.fn(async (sql: string, params?: unknown[]) => {
		const s = sql.trim().toLowerCase();

		if (s.includes('from _meta')) {
			const key = params?.[0] as string;
			const row = (tables._meta ?? []).find((r) => r.key === key);
			return row ? [{ value: row.value }] : [];
		}

		return [];
	});

	return {
		db: {
			execute,
			select,
			close: vi.fn().mockResolvedValue(undefined),
		},
		tables,
	};
}

// ── Tests ────────────────────────────────────────────────────────

let mock: ReturnType<typeof createMockDb>;

beforeEach(() => {
	mock = createMockDb();
	setDatabaseFactory(vi.fn().mockResolvedValue(mock.db));
});

afterEach(async () => {
	await closeProjectDb();
	setDatabaseFactory(null);
});

describe('openProjectDb', () => {
	it('opens with correct URI', async () => {
		await openProjectDb('my-app');
		expect(getProjectDbUri()).toBe('sqlite:projects/my-app/data.sqlite');
		expect(getProjectDb()).toBe(mock.db);
	});

	it('creates all required tables', async () => {
		await openProjectDb('my-app');
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS _meta'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS query_history'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS ipc_logs'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS connection_profiles'),
		);
	});

	it('creates indexes', async () => {
		await openProjectDb('my-app');
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_history_ts'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE INDEX IF NOT EXISTS idx_ipc_ts'),
		);
	});

	it('is idempotent for same URI', async () => {
		await openProjectDb('my-app');
		const calls = mock.db.execute.mock.calls.length;
		await openProjectDb('my-app');
		expect(mock.db.execute.mock.calls.length).toBe(calls);
	});
});

describe('openDefaultDb', () => {
	it('opens with default URI', async () => {
		await openDefaultDb();
		expect(getProjectDbUri()).toBe('sqlite:default/data.sqlite');
	});
});

describe('switching databases', () => {
	it('closes previous DB when switching', async () => {
		await openProjectDb('project-a');
		await openProjectDb('project-b');
		expect(mock.db.close).toHaveBeenCalled();
		expect(getProjectDbUri()).toBe('sqlite:projects/project-b/data.sqlite');
	});
});

describe('meta operations', () => {
	it('sets and gets meta values', async () => {
		await openProjectDb('my-app');
		await setProjectMeta('project_name', 'My App');

		const value = await getProjectMeta('project_name');
		expect(value).toBe('My App');
	});

	it('returns null for missing keys', async () => {
		await openProjectDb('my-app');
		const value = await getProjectMeta('nonexistent');
		expect(value).toBeNull();
	});

	it('upserts existing keys', async () => {
		await openProjectDb('my-app');
		await setProjectMeta('version', '1');
		await setProjectMeta('version', '2');

		const value = await getProjectMeta('version');
		expect(value).toBe('2');
	});
});

describe('closeProjectDb', () => {
	it('closes and resets state', async () => {
		await openProjectDb('my-app');
		await closeProjectDb();

		expect(mock.db.close).toHaveBeenCalled();
		expect(getProjectDb()).toBeNull();
		expect(getProjectDbUri()).toBeNull();
	});
});

describe('rotateOldHistory', () => {
	it('should delete history entries older than maxAgeDays', async () => {
		await openProjectDb('my-app');

		const now = 1700000000000;
		vi.spyOn(Date, 'now').mockReturnValue(now);

		const deleted = await rotateOldHistory(90);
		expect(deleted).toBe(0); // mock returns 0 rowsAffected

		const call = mock.db.execute.mock.calls.find(
			([sql]) =>
				typeof sql === 'string' &&
				sql.includes('DELETE') &&
				sql.includes('query_history'),
		);
		expect(call).toBeDefined();
		expect(call![0]).toContain(
			'DELETE FROM query_history WHERE timestamp < $1',
		);
		// cutoff = now - 90 * 24 * 60 * 60 * 1000
		expect(call![1]).toEqual([now - 90 * 24 * 60 * 60 * 1000]);

		vi.restoreAllMocks();
	});

	it('should return 0 when no DB is open', async () => {
		const deleted = await rotateOldHistory(30);
		expect(deleted).toBe(0);
	});
});
