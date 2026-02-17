/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	addRecentProject,
	closeAppDb,
	initAppDb,
	insertAppLog,
	listRecentProjects,
	queryAppLogs,
	removeRecentProject,
	touchRecentProject,
} from './app-db';
import { setDatabaseFactory } from './db-shared';

// ── In-memory mock DB ────────────────────────────────────────────

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

			// Parse column names from SQL
			const colMatch = sql.match(/\(([^)]+)\)\s*values/i);
			if (!colMatch || !params) return { lastInsertId: 0, rowsAffected: 0 };

			const cols = colMatch[1]!.split(',').map((c) => c.trim());
			const row: Row = {};
			for (let i = 0; i < cols.length; i++) {
				row[cols[i]!] = params[i];
			}

			if (s.includes('on conflict')) {
				// Upsert: remove existing by PK then insert
				const pkCol = cols[0]!;
				tables[tbl] = tables[tbl].filter((r) => r[pkCol] !== row[pkCol]);
			}

			if (s.includes('or ignore')) {
				const pkCol = cols[0]!;
				if (tables[tbl].some((r) => r[pkCol] === row[pkCol])) {
					return { lastInsertId: 0, rowsAffected: 0 };
				}
			}

			// Auto-increment for id columns
			if (cols.includes('id') && row.id === undefined) {
				row.id = tables[tbl].length + 1;
			}

			tables[tbl].push(row);
			return { lastInsertId: (row.id as number) ?? 0, rowsAffected: 1 };
		}

		if (s.startsWith('update')) {
			const tbl = sql.match(/update\s+(\w+)/i)?.[1] ?? '';
			if (!params) return { lastInsertId: 0, rowsAffected: 0 };

			// Simple: update WHERE path = $2 → set last_opened_at = $1
			let affected = 0;
			for (const row of tables[tbl] ?? []) {
				if (row.path === params[1]) {
					row.last_opened_at = params[0];
					affected++;
				}
			}
			return { lastInsertId: 0, rowsAffected: affected };
		}

		if (s.startsWith('delete')) {
			const tbl = sql.match(/from\s+(\w+)/i)?.[1] ?? '';
			const before = (tables[tbl] ?? []).length;
			if (params?.length) {
				tables[tbl] = (tables[tbl] ?? []).filter((r) => r.path !== params[0]);
			}
			return {
				lastInsertId: 0,
				rowsAffected: before - (tables[tbl]?.length ?? 0),
			};
		}

		return { lastInsertId: 0, rowsAffected: 0 };
	});

	const select = vi.fn(async (sql: string, params?: unknown[]) => {
		const s = sql.trim().toLowerCase();

		if (s.includes('from recent_projects')) {
			const rows = (tables.recent_projects ?? []).sort(
				(a, b) => (b.last_opened_at as number) - (a.last_opened_at as number),
			);
			const limit = params?.at(-1) as number | undefined;
			return limit ? rows.slice(0, limit) : rows;
		}

		if (s.includes('from app_logs')) {
			return (tables.app_logs ?? []).reverse();
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

beforeEach(async () => {
	mock = createMockDb();
	setDatabaseFactory(vi.fn().mockResolvedValue(mock.db));
	await initAppDb();
});

afterEach(async () => {
	await closeAppDb();
	setDatabaseFactory(null);
});

describe('initAppDb', () => {
	it('creates _meta, recent_projects, and app_logs tables', () => {
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS _meta'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS recent_projects'),
		);
		expect(mock.db.execute).toHaveBeenCalledWith(
			expect.stringContaining('CREATE TABLE IF NOT EXISTS app_logs'),
		);
	});

	it('is idempotent', async () => {
		const callsBefore = mock.db.execute.mock.calls.length;
		await initAppDb();
		// Should not run DDL again
		expect(mock.db.execute.mock.calls.length).toBe(callsBefore);
	});
});

describe('recent projects', () => {
	it('adds and lists projects', async () => {
		await addRecentProject('/home/user/p1', 'Project 1', 'project-1');
		// Ensure different timestamp for ordering
		await new Promise((r) => setTimeout(r, 10));
		await addRecentProject('/home/user/p2', 'Project 2', 'project-2');

		const projects = await listRecentProjects();
		expect(projects).toHaveLength(2);
		// Most recently added should be first
		expect(projects[0]!.name).toBe('Project 2');
		expect(projects[0]!.folderName).toBe('project-2');
	});

	it('updates existing project on re-add', async () => {
		await addRecentProject('/home/user/p1', 'Project 1', 'project-1');
		await addRecentProject('/home/user/p1', 'Project 1 Updated', 'project-1');

		const projects = await listRecentProjects();
		expect(projects).toHaveLength(1);
		expect(projects[0]!.name).toBe('Project 1 Updated');
	});

	it('removes a project', async () => {
		await addRecentProject('/home/user/p1', 'Project 1', 'project-1');
		await removeRecentProject('/home/user/p1');

		const projects = await listRecentProjects();
		expect(projects).toHaveLength(0);
	});

	it('touches last_opened_at', async () => {
		await addRecentProject('/home/user/p1', 'Project 1', 'project-1');
		const before =
			(mock.tables.recent_projects?.[0]?.last_opened_at as number) ?? 0;

		// Small delay so timestamp differs
		await new Promise((r) => setTimeout(r, 10));
		await touchRecentProject('/home/user/p1');

		const after = mock.tables.recent_projects?.[0]?.last_opened_at as number;
		expect(after).toBeGreaterThanOrEqual(before);
	});
});

describe('app logs', () => {
	it('inserts and queries logs', async () => {
		await insertAppLog('info', 'sidecar', 'Sidecar started');
		await insertAppLog('error', 'app', 'Something failed', 150);

		const logs = await queryAppLogs();
		expect(logs).toHaveLength(2);
	});
});

describe('closeAppDb', () => {
	it('closes the database connection', async () => {
		await closeAppDb();
		expect(mock.db.close).toHaveBeenCalled();
	});
});
