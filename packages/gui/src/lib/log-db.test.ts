/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearLogs,
	closeLogDb,
	exportLogs,
	getLogStats,
	initLogDb,
	insertLog,
	type LogRow,
	queryLogs,
	rotateOldLogs,
	rowToEntry,
	setDatabaseLoader,
} from './log-db';

// ── Mock Database ──────────────────────────────────────────────
// Simulates tauri-plugin-sql Database with in-memory storage.

interface MockRow {
	id: number;
	timestamp: number;
	level: string;
	source: string;
	message: string;
	duration_ms: number | null;
}

function createMockDb() {
	let rows: MockRow[] = [];
	let nextId = 1;

	const execute = vi.fn(async (sql: string, params?: unknown[]) => {
		const sqlLower = sql.trim().toLowerCase();

		if (
			sqlLower.startsWith('create table') ||
			sqlLower.startsWith('create index')
		) {
			return { lastInsertId: 0, rowsAffected: 0 };
		}

		if (sqlLower.startsWith('insert into logs')) {
			const [timestamp, level, source, message, duration_ms] = params as [
				number,
				string,
				string,
				string,
				number | null,
			];
			const id = nextId++;
			rows.push({ id, timestamp, level, source, message, duration_ms });
			return { lastInsertId: id, rowsAffected: 1 };
		}

		if (sqlLower.startsWith('delete from logs')) {
			if (params?.length) {
				// DELETE WHERE timestamp < $1
				const cutoff = params[0] as number;
				const before = rows.length;
				rows = rows.filter((r) => r.timestamp >= cutoff);
				return { lastInsertId: 0, rowsAffected: before - rows.length };
			}
			// DELETE all
			const count = rows.length;
			rows = [];
			return { lastInsertId: 0, rowsAffected: count };
		}

		return { lastInsertId: 0, rowsAffected: 0 };
	});

	const select = vi.fn(async (sql: string, params?: unknown[]) => {
		const sqlLower = sql.trim().toLowerCase();

		if (sqlLower.includes('group by level')) {
			// Stats query: respect WHERE clause filters
			const filtered = applyWhereFilters(rows, sql, params);
			const counts = new Map<string, number>();
			for (const r of filtered) {
				counts.set(r.level, (counts.get(r.level) ?? 0) + 1);
			}
			return Array.from(counts.entries()).map(([level, cnt]) => ({
				level,
				cnt,
			}));
		}

		// Regular SELECT with WHERE and LIMIT
		let filtered = applyWhereFilters(rows, sql, params);
		filtered.sort((a, b) => a.timestamp - b.timestamp);

		const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
		if (limitMatch?.[1]) {
			filtered = filtered.slice(0, Number.parseInt(limitMatch[1], 10));
		}

		return filtered;
	});

	const close = vi.fn(async () => {});

	return { execute, select, close, _getRows: () => rows };
}

function applyWhereFilters(
	rows: MockRow[],
	sql: string,
	params?: unknown[],
): MockRow[] {
	if (!params?.length) return [...rows];

	let result = [...rows];
	const sqlLower = sql.toLowerCase();
	let paramIdx = 0;

	// Parse level IN (...)
	const levelPlaceholders = sqlLower.match(/level in \(([$\d, ]+)\)/)?.[1];
	if (levelPlaceholders) {
		const placeholderCount = levelPlaceholders.split(',').length;
		const levels = params.slice(
			paramIdx,
			paramIdx + placeholderCount,
		) as string[];
		paramIdx += placeholderCount;
		result = result.filter((r) => levels.includes(r.level));
	}

	// Parse source IN (...)
	const sourcePlaceholders = sqlLower.match(/source in \(([$\d, ]+)\)/)?.[1];
	if (sourcePlaceholders) {
		const placeholderCount = sourcePlaceholders.split(',').length;
		const sources = params.slice(
			paramIdx,
			paramIdx + placeholderCount,
		) as string[];
		paramIdx += placeholderCount;
		result = result.filter((r) => sources.includes(r.source));
	}

	// Parse message LIKE
	if (sqlLower.includes('message like')) {
		const pattern = params[paramIdx] as string;
		paramIdx++;
		const search = pattern.replace(/%/g, '');
		result = result.filter((r) => r.message.includes(search));
	}

	// Parse timestamp >=
	if (sqlLower.includes('timestamp >=')) {
		const since = params[paramIdx] as number;
		paramIdx++;
		result = result.filter((r) => r.timestamp >= since);
	}

	return result;
}

// ── Tests ──────────────────────────────────────────────────────

describe('log-db', () => {
	let mockDb: ReturnType<typeof createMockDb>;

	beforeEach(async () => {
		mockDb = createMockDb();

		setDatabaseLoader(() =>
			Promise.resolve({
				default: {
					load: () => Promise.resolve(mockDb),
				},
			} as never),
		);

		await initLogDb();
	});

	afterEach(async () => {
		await closeLogDb();
		setDatabaseLoader(null);
	});

	describe('initLogDb', () => {
		it('should create table and indexes', () => {
			const calls = mockDb.execute.mock.calls.map((c) => c[0] as string);
			expect(
				calls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS logs')),
			).toBe(true);
			expect(calls.some((s) => s.includes('idx_logs_timestamp'))).toBe(true);
			expect(calls.some((s) => s.includes('idx_logs_level_ts'))).toBe(true);
			expect(calls.some((s) => s.includes('idx_logs_source_ts'))).toBe(true);
		});
	});

	describe('insertLog', () => {
		it('should insert a log entry with all fields', async () => {
			await insertLog('info', 'ipc', '← executeNQL', 142);
			const rows = await queryLogs();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				level: 'info',
				source: 'ipc',
				message: '← executeNQL',
				duration_ms: 142,
			});
		});

		it('should insert without durationMs', async () => {
			await insertLog('debug', 'sidecar', 'process started');
			const rows = await queryLogs();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.duration_ms).toBeNull();
		});
	});

	describe('queryLogs', () => {
		beforeEach(async () => {
			await insertLog('info', 'sidecar', 'msg1');
			await insertLog('warn', 'ipc', 'msg2');
			await insertLog('error', 'app', 'msg3');
			await insertLog('debug', 'sidecar', 'msg4');
			await insertLog('info', 'ipc', 'msg5 search-me');
		});

		it('should return all entries without filter', async () => {
			const rows = await queryLogs();
			expect(rows).toHaveLength(5);
		});

		it('should filter by level', async () => {
			const rows = await queryLogs({ levels: ['info'] });
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.level === 'info')).toBe(true);
		});

		it('should filter by multiple levels', async () => {
			const rows = await queryLogs({ levels: ['info', 'warn'] });
			expect(rows).toHaveLength(3);
		});

		it('should filter by source', async () => {
			const rows = await queryLogs({ sources: ['sidecar'] });
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.source === 'sidecar')).toBe(true);
		});

		it('should filter by search text', async () => {
			const rows = await queryLogs({ search: 'search-me' });
			expect(rows).toHaveLength(1);
			expect(rows[0]!.message).toBe('msg5 search-me');
		});

		it('should combine level + source filters', async () => {
			const rows = await queryLogs({ levels: ['info'], sources: ['ipc'] });
			expect(rows).toHaveLength(1);
			expect(rows[0]!.message).toBe('msg5 search-me');
		});
	});

	describe('getLogStats', () => {
		it('should return aggregate counts by level', async () => {
			await insertLog('info', 'sidecar', 'a');
			await insertLog('info', 'ipc', 'b');
			await insertLog('error', 'app', 'c');

			const stats = await getLogStats();
			expect(stats.total).toBe(3);
			expect(stats.byLevel.info).toBe(2);
			expect(stats.byLevel.error).toBe(1);
		});

		it('should return empty stats when no logs', async () => {
			const stats = await getLogStats();
			expect(stats.total).toBe(0);
			expect(stats.byLevel).toEqual({});
		});
	});

	describe('clearLogs', () => {
		it('should delete all logs', async () => {
			await insertLog('info', 'sidecar', 'a');
			await insertLog('warn', 'ipc', 'b');
			await clearLogs();

			const rows = await queryLogs();
			expect(rows).toHaveLength(0);
		});
	});

	describe('rotateOldLogs', () => {
		it('should delete logs older than specified days', async () => {
			// Insert with controlled timestamps via mock
			const now = Date.now();
			vi.spyOn(Date, 'now')
				.mockReturnValueOnce(now - 10 * 86400_000) // 10 days ago
				.mockReturnValueOnce(now - 3 * 86400_000) // 3 days ago
				.mockReturnValueOnce(now); // now

			await insertLog('info', 'sidecar', 'old');
			await insertLog('info', 'sidecar', 'recent');
			await insertLog('info', 'sidecar', 'now');

			vi.spyOn(Date, 'now').mockReturnValue(now);
			const deleted = await rotateOldLogs(7);
			expect(deleted).toBe(1);

			const rows = await queryLogs();
			expect(rows).toHaveLength(2);
		});
	});

	describe('exportLogs', () => {
		it('should return all matching logs without limit', async () => {
			for (let i = 0; i < 10; i++) {
				await insertLog('info', 'sidecar', `msg-${i}`);
			}

			const rows = await exportLogs();
			expect(rows).toHaveLength(10);
		});
	});

	describe('rowToEntry', () => {
		it('should convert snake_case LogRow to camelCase LogEntry', () => {
			const row: LogRow = {
				id: 42,
				timestamp: 1700000000000,
				level: 'warn',
				source: 'ipc',
				message: 'test message',
				duration_ms: 123,
			};

			const entry = rowToEntry(row);
			expect(entry).toEqual({
				id: 42,
				timestamp: 1700000000000,
				level: 'warn',
				source: 'ipc',
				message: 'test message',
				durationMs: 123,
			});
		});

		it('should omit durationMs when duration_ms is null', () => {
			const row: LogRow = {
				id: 1,
				timestamp: 1700000000000,
				level: 'info',
				source: 'sidecar',
				message: 'hello',
				duration_ms: null,
			};

			const entry = rowToEntry(row);
			expect(entry).not.toHaveProperty('durationMs');
		});
	});
});
