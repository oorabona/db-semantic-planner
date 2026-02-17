/**
 * SQLite log database abstraction layer.
 * Uses tauri-plugin-sql for persistent, queryable log storage.
 *
 * DB path: $APPCONFIG/logs.db (resolved by Tauri per OS)
 * Schema: logs(id, timestamp, level, source, message, duration_ms)
 */
import type { LogEntry, LogLevel } from '@/stores/log-store';

/** Raw row shape from SQLite (snake_case columns). */
export interface LogRow {
	id: number;
	timestamp: number;
	level: string;
	source: string;
	message: string;
	duration_ms: number | null;
}

/** Filter criteria for querying logs. */
export interface LogFilter {
	levels?: LogLevel[];
	sources?: LogEntry['source'][];
	search?: string;
	since?: number;
	limit?: number;
}

/** Stats returned by getLogStats. */
export interface LogStats {
	total: number;
	byLevel: Partial<Record<LogLevel, number>>;
}

// Dynamic import to avoid breaking unit tests (no Tauri runtime in jsdom).
// Resolved lazily on first initLogDb() call.
type Database = {
	execute: (
		sql: string,
		params?: unknown[],
	) => Promise<{ lastInsertId: number; rowsAffected: number }>;
	select: <T>(sql: string, params?: unknown[]) => Promise<T>;
	close: () => Promise<void>;
};

let db: Database | null = null;
let loadDatabase:
	| (() => Promise<{ load: (uri: string) => Promise<Database> }>)
	| null = null;

/**
 * Allow injection of the Database loader for testing.
 * In production, this is set to dynamic import('@tauri-apps/plugin-sql').
 */
export function setDatabaseLoader(
	loader: (() => Promise<{ load: (uri: string) => Promise<Database> }>) | null,
): void {
	loadDatabase = loader;
}

// Default loader (production): dynamic import
if (typeof loadDatabase !== 'function') {
	loadDatabase = () =>
		import('@tauri-apps/plugin-sql') as unknown as Promise<{
			load: (uri: string) => Promise<Database>;
		}>;
}

/** Initialize the log database (create table + indexes if missing). */
export async function initLogDb(): Promise<void> {
	if (db) return;
	if (!loadDatabase) throw new Error('No database loader configured');

	const mod = await loadDatabase();
	// The module default export IS the Database class with a static .load()
	const Database =
		(
			mod as unknown as {
				default: { load: (uri: string) => Promise<Database> };
			}
		).default ?? mod;
	db = await Database.load('sqlite:logs.db');

	await db.execute(`
		CREATE TABLE IF NOT EXISTS logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			level TEXT NOT NULL,
			source TEXT NOT NULL,
			message TEXT NOT NULL,
			duration_ms INTEGER
		)
	`);
	await db.execute(
		'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)',
	);
	await db.execute(
		'CREATE INDEX IF NOT EXISTS idx_logs_level_ts ON logs(level, timestamp)',
	);
	await db.execute(
		'CREATE INDEX IF NOT EXISTS idx_logs_source_ts ON logs(source, timestamp)',
	);
}

/** Insert a single log entry. */
export async function insertLog(
	level: LogLevel,
	source: LogEntry['source'],
	message: string,
	durationMs?: number,
): Promise<void> {
	if (!db) return;
	await db.execute(
		'INSERT INTO logs (timestamp, level, source, message, duration_ms) VALUES ($1, $2, $3, $4, $5)',
		[Date.now(), level, source, message, durationMs ?? null],
	);
}

/** Build a parameterized WHERE clause from filter criteria. */
function buildWhereClause(filter: LogFilter): {
	where: string;
	params: unknown[];
} {
	const conditions: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (filter.levels?.length) {
		const placeholders = filter.levels.map(() => `$${idx++}`).join(', ');
		conditions.push(`level IN (${placeholders})`);
		params.push(...filter.levels);
	}

	if (filter.sources?.length) {
		const placeholders = filter.sources.map(() => `$${idx++}`).join(', ');
		conditions.push(`source IN (${placeholders})`);
		params.push(...filter.sources);
	}

	if (filter.search) {
		conditions.push(`message LIKE $${idx++}`);
		params.push(`%${filter.search}%`);
	}

	if (filter.since) {
		conditions.push(`timestamp >= $${idx++}`);
		params.push(filter.since);
	}

	return {
		where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
		params,
	};
}

/** Query logs with optional filters. Default limit: 5000. */
export async function queryLogs(filter: LogFilter = {}): Promise<LogRow[]> {
	if (!db) return [];

	const { where, params } = buildWhereClause(filter);
	const limitClause = filter.limit === 0 ? '' : `LIMIT ${filter.limit ?? 5000}`;

	return db.select<LogRow[]>(
		`SELECT id, timestamp, level, source, message, duration_ms FROM logs ${where} ORDER BY timestamp ASC ${limitClause}`,
		params,
	);
}

/** Get aggregate stats (total count, count per level). */
export async function getLogStats(filter: LogFilter = {}): Promise<LogStats> {
	if (!db) return { total: 0, byLevel: {} };

	const { where, params } = buildWhereClause(filter);
	const rows = await db.select<Array<{ level: string; cnt: number }>>(
		`SELECT level, COUNT(*) as cnt FROM logs ${where} GROUP BY level`,
		params,
	);

	const total = rows.reduce((sum, r) => sum + r.cnt, 0);
	const byLevel: Partial<Record<LogLevel, number>> = {};
	for (const row of rows) {
		byLevel[row.level as LogLevel] = row.cnt;
	}

	return { total, byLevel };
}

/** Delete all logs. */
export async function clearLogs(): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM logs');
}

/** Delete logs older than maxAgeDays. Returns rows deleted. */
export async function rotateOldLogs(maxAgeDays = 7): Promise<number> {
	if (!db) return 0;
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const result = await db.execute('DELETE FROM logs WHERE timestamp < $1', [
		cutoff,
	]);
	return result.rowsAffected;
}

/** Export all logs matching filter (no limit). */
export async function exportLogs(filter: LogFilter = {}): Promise<LogRow[]> {
	return queryLogs({ ...filter, limit: 0 });
}

/** Convert a LogRow (snake_case DB) to a LogEntry (camelCase app). */
export function rowToEntry(row: LogRow): LogEntry {
	return {
		id: row.id,
		timestamp: row.timestamp,
		level: row.level as LogLevel,
		source: row.source as LogEntry['source'],
		message: row.message,
		...(row.duration_ms != null ? { durationMs: row.duration_ms } : {}),
	};
}

/** Close the database connection. */
export async function closeLogDb(): Promise<void> {
	if (!db) return;
	await db.close();
	db = null;
}
