// ── App-level SQLite database ────────────────────────────────────
// Manages $APPCONFIG/app.sqlite: recent projects + app-level logs.

import type { Database } from './db-shared';
import { openDatabaseSafe } from './db-shared';

// ── Types ────────────────────────────────────────────────────────

export interface RecentProject {
	readonly path: string;
	readonly name: string;
	readonly folderName: string;
	readonly lastOpenedAt: number;
	readonly createdAt: number;
}

export interface AppLogRow {
	readonly id: number;
	readonly timestamp: number;
	readonly level: string;
	readonly source: string;
	readonly message: string;
	readonly duration_ms: number | null;
}

// ── State ────────────────────────────────────────────────────────

let db: Database | null = null;

// ── Lifecycle ────────────────────────────────────────────────────

/** Initialize app.sqlite — creates tables if missing. */
export async function initAppDb(
	onCorrupt?: (uri: string) => void,
): Promise<void> {
	if (db) return;

	db = await openDatabaseSafe('sqlite:app.sqlite', onCorrupt);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS _meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS recent_projects (
			path TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			folder_name TEXT NOT NULL,
			last_opened_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS app_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			timestamp INTEGER NOT NULL,
			level TEXT NOT NULL,
			source TEXT NOT NULL,
			message TEXT NOT NULL,
			duration_ms INTEGER
		)
	`);
	await db.execute(
		'CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(timestamp)',
	);

	// Set schema version
	await db.execute(
		`INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1')`,
	);
}

/** Close the app database. */
export async function closeAppDb(): Promise<void> {
	if (!db) return;
	await db.close();
	db = null;
}

/** Get the raw Database handle (for testing). */
export function getAppDb(): Database | null {
	return db;
}

// ── Recent Projects ──────────────────────────────────────────────

/** Add or update a recent project entry. */
export async function addRecentProject(
	path: string,
	name: string,
	folderName: string,
): Promise<void> {
	if (!db) return;
	const now = Date.now();
	await db.execute(
		`INSERT INTO recent_projects (path, name, folder_name, last_opened_at, created_at)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT(path) DO UPDATE SET
			name = excluded.name,
			last_opened_at = excluded.last_opened_at`,
		[path, name, folderName, now, now],
	);
}

/** Update last_opened_at for an existing project. */
export async function touchRecentProject(path: string): Promise<void> {
	if (!db) return;
	await db.execute(
		'UPDATE recent_projects SET last_opened_at = $1 WHERE path = $2',
		[Date.now(), path],
	);
}

/** List recent projects, newest first. */
export async function listRecentProjects(limit = 10): Promise<RecentProject[]> {
	if (!db) return [];
	const rows = await db.select<
		Array<{
			path: string;
			name: string;
			folder_name: string;
			last_opened_at: number;
			created_at: number;
		}>
	>(
		'SELECT path, name, folder_name, last_opened_at, created_at FROM recent_projects ORDER BY last_opened_at DESC LIMIT $1',
		[limit],
	);
	return rows.map((r) => ({
		path: r.path,
		name: r.name,
		folderName: r.folder_name,
		lastOpenedAt: r.last_opened_at,
		createdAt: r.created_at,
	}));
}

/** Remove a project from the recent list. */
export async function removeRecentProject(path: string): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM recent_projects WHERE path = $1', [path]);
}

// ── App Logs ─────────────────────────────────────────────────────

/** Insert a global app-level log entry. */
export async function insertAppLog(
	level: string,
	source: string,
	message: string,
	durationMs?: number,
): Promise<void> {
	if (!db) return;
	await db.execute(
		'INSERT INTO app_logs (timestamp, level, source, message, duration_ms) VALUES ($1, $2, $3, $4, $5)',
		[Date.now(), level, source, message, durationMs ?? null],
	);
}

/** Query app logs with optional filters. */
export async function queryAppLogs(opts?: {
	since?: number;
	limit?: number;
	source?: string;
}): Promise<AppLogRow[]> {
	if (!db) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (opts?.since) {
		where.push(`timestamp >= $${idx++}`);
		params.push(opts.since);
	}
	if (opts?.source) {
		where.push(`source = $${idx++}`);
		params.push(opts.source);
	}

	const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const limit = opts?.limit ?? 500;

	return db.select<AppLogRow[]>(
		`SELECT id, timestamp, level, source, message, duration_ms FROM app_logs ${whereClause} ORDER BY timestamp DESC LIMIT $${idx}`,
		[...params, limit],
	);
}

/** Delete all app-level log entries. */
export async function clearAppLogs(): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM app_logs');
}
