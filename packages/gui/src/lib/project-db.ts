// ── Project-level SQLite database ────────────────────────────────
// Manages per-project data.sqlite: query history, IPC logs, connections, meta.
// Also handles the "default" standalone database at $APPCONFIG/default/data.sqlite.

import type { Database } from './db-shared';
import { openDatabaseSafe } from './db-shared';

// ── Types ────────────────────────────────────────────────────────

export interface QueryHistoryRow {
	readonly id: string;
	readonly query: string;
	readonly language: string;
	readonly database: string | null;
	readonly connection_id: string | null;
	readonly timestamp: number;
	readonly duration_ms: number | null;
	readonly row_count: number | null;
	readonly success: number;
	readonly error: string | null;
}

export interface IpcLogRow {
	readonly id: number;
	readonly timestamp: number;
	readonly level: string;
	readonly source: string;
	readonly message: string;
	readonly duration_ms: number | null;
	readonly method: string | null;
	readonly connection_id: string | null;
}

export interface ConnectionProfileRow {
	readonly id: string;
	readonly name: string;
	readonly environment: string | null;
	readonly type: string;
	readonly config: string; // JSON blob
	readonly color: string | null;
	readonly created_at: number;
	readonly last_used_at: number | null;
}

// ── State ────────────────────────────────────────────────────────

let db: Database | null = null;
let currentUri: string | null = null;

// ── DDL ──────────────────────────────────────────────────────────

const DDL_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS _meta (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS query_history (
		id TEXT PRIMARY KEY,
		query TEXT NOT NULL,
		language TEXT NOT NULL,
		database TEXT,
		connection_id TEXT,
		timestamp INTEGER NOT NULL,
		duration_ms INTEGER,
		row_count INTEGER,
		success INTEGER NOT NULL DEFAULT 1,
		error TEXT
	)`,
	'CREATE INDEX IF NOT EXISTS idx_history_ts ON query_history(timestamp)',
	'CREATE INDEX IF NOT EXISTS idx_history_lang ON query_history(language, timestamp)',

	`CREATE TABLE IF NOT EXISTS ipc_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp INTEGER NOT NULL,
		level TEXT NOT NULL,
		source TEXT NOT NULL,
		message TEXT NOT NULL,
		duration_ms INTEGER,
		method TEXT,
		connection_id TEXT
	)`,
	'CREATE INDEX IF NOT EXISTS idx_ipc_ts ON ipc_logs(timestamp)',

	`CREATE TABLE IF NOT EXISTS connection_profiles (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		environment TEXT,
		type TEXT NOT NULL DEFAULT 'postgresql',
		config TEXT NOT NULL,
		color TEXT,
		created_at INTEGER NOT NULL,
		last_used_at INTEGER
	)`,
] as const;

// ── Lifecycle ────────────────────────────────────────────────────

async function openAndInit(
	uri: string,
	onCorrupt?: (uri: string) => void,
): Promise<void> {
	// Close existing connection if switching databases
	if (db && currentUri !== uri) {
		await db.close();
		db = null;
		currentUri = null;
	}
	if (db) return; // Already open for this URI

	db = await openDatabaseSafe(uri, onCorrupt);
	currentUri = uri;

	for (const ddl of DDL_STATEMENTS) {
		await db.execute(ddl);
	}

	// Set schema version
	await db.execute(
		`INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1')`,
	);
}

/**
 * Open a project-specific database.
 * Creates `$APPCONFIG/projects/<folderName>/data.sqlite` if missing.
 */
export async function openProjectDb(
	folderName: string,
	onCorrupt?: (uri: string) => void,
): Promise<void> {
	await openAndInit(`sqlite:projects/${folderName}/data.sqlite`, onCorrupt);
}

/** Open the standalone/default database at `$APPCONFIG/default/data.sqlite`. */
export async function openDefaultDb(
	onCorrupt?: (uri: string) => void,
): Promise<void> {
	await openAndInit('sqlite:default/data.sqlite', onCorrupt);
}

/** Close the project database. */
export async function closeProjectDb(): Promise<void> {
	if (!db) return;
	await db.close();
	db = null;
	currentUri = null;
}

/** Get the raw Database handle (for testing / advanced use). */
export function getProjectDb(): Database | null {
	return db;
}

/** Get the current database URI (for diagnostics). */
export function getProjectDbUri(): string | null {
	return currentUri;
}

// ── Meta ─────────────────────────────────────────────────────────

/** Get a meta value by key. */
export async function getProjectMeta(key: string): Promise<string | null> {
	if (!db) return null;
	const rows = await db.select<Array<{ value: string }>>(
		'SELECT value FROM _meta WHERE key = $1',
		[key],
	);
	return rows[0]?.value ?? null;
}

/** Set a meta key-value pair (upsert). */
export async function setProjectMeta(
	key: string,
	value: string,
): Promise<void> {
	if (!db) return;
	await db.execute(
		`INSERT INTO _meta (key, value) VALUES ($1, $2)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		[key, value],
	);
}

// ── IPC Log Redaction ────────────────────────────────────────────

/** Redact sensitive fields from an IPC log message string. */
export function redactSensitiveFields(message: string): string {
	// Match JSON-like key:value patterns with sensitive keys
	return message.replace(
		/("(?:password|secret|token|credential|auth)[^"]*")\s*:\s*("[^"]*"|'[^']*'|[^,}\]\s]+)/gi,
		'$1: "[REDACTED]"',
	);
}

// ── IPC Logs ─────────────────────────────────────────────────────

/** Insert an IPC log entry with automatic redaction. */
export async function insertIpcLog(
	level: string,
	message: string,
	opts?: {
		durationMs?: number;
		method?: string;
		connectionId?: string;
	},
): Promise<void> {
	if (!db) return;
	const redacted = redactSensitiveFields(message);
	await db.execute(
		`INSERT INTO ipc_logs (timestamp, level, source, message, duration_ms, method, connection_id)
		 VALUES ($1, $2, 'ipc', $3, $4, $5, $6)`,
		[
			Date.now(),
			level,
			redacted,
			opts?.durationMs ?? null,
			opts?.method ?? null,
			opts?.connectionId ?? null,
		],
	);
}

/** Query IPC logs with optional filters. */
export async function queryIpcLogs(opts?: {
	since?: number;
	limit?: number;
	method?: string;
}): Promise<IpcLogRow[]> {
	if (!db) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	let idx = 1;

	if (opts?.since) {
		where.push(`timestamp >= $${idx++}`);
		params.push(opts.since);
	}
	if (opts?.method) {
		where.push(`method = $${idx++}`);
		params.push(opts.method);
	}

	const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
	const limit = opts?.limit ?? 5000;

	return db.select<IpcLogRow[]>(
		`SELECT id, timestamp, level, source, message, duration_ms, method, connection_id
		 FROM ipc_logs ${whereClause} ORDER BY timestamp ASC LIMIT $${idx}`,
		[...params, limit],
	);
}

/** Get IPC log stats. */
export async function getIpcLogStats(): Promise<{
	total: number;
	byLevel: Record<string, number>;
}> {
	if (!db) return { total: 0, byLevel: {} };
	const rows = await db.select<Array<{ level: string; cnt: number }>>(
		'SELECT level, COUNT(*) as cnt FROM ipc_logs GROUP BY level',
	);
	const total = rows.reduce((sum, r) => sum + r.cnt, 0);
	const byLevel: Record<string, number> = {};
	for (const row of rows) {
		byLevel[row.level] = row.cnt;
	}
	return { total, byLevel };
}

/** Clear all IPC logs. */
export async function clearIpcLogs(): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM ipc_logs');
}

/** Rotate IPC logs older than maxAgeDays. */
export async function rotateIpcLogs(maxAgeDays = 7): Promise<number> {
	if (!db) return 0;
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const result = await db.execute('DELETE FROM ipc_logs WHERE timestamp < $1', [
		cutoff,
	]);
	return result.rowsAffected;
}

/** Rotate query history entries older than maxAgeDays. */
export async function rotateOldHistory(maxAgeDays = 90): Promise<number> {
	if (!db) return 0;
	const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
	const result = await db.execute(
		'DELETE FROM query_history WHERE timestamp < $1',
		[cutoff],
	);
	return result.rowsAffected;
}

// ── Connection Profiles ──────────────────────────────────────────

/** Insert or replace a connection profile. */
export async function upsertConnectionProfile(
	profile: ConnectionProfileRow,
): Promise<void> {
	if (!db) return;
	await db.execute(
		`INSERT OR REPLACE INTO connection_profiles
		 (id, name, environment, type, config, color, created_at, last_used_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		[
			profile.id,
			profile.name,
			profile.environment,
			profile.type,
			profile.config,
			profile.color ?? null,
			profile.created_at,
			profile.last_used_at ?? null,
		],
	);
}

/** List all connection profiles ordered by last used. */
export async function listConnectionProfiles(): Promise<
	ConnectionProfileRow[]
> {
	if (!db) return [];
	return db.select<ConnectionProfileRow[]>(
		`SELECT id, name, environment, type, config, color, created_at, last_used_at
		 FROM connection_profiles
		 ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
	);
}

/** Delete a connection profile by ID. */
export async function deleteConnectionProfile(id: string): Promise<void> {
	if (!db) return;
	await db.execute('DELETE FROM connection_profiles WHERE id = $1', [id]);
}

/** Update last_used_at timestamp for a connection profile. */
export async function touchConnectionProfile(id: string): Promise<void> {
	if (!db) return;
	await db.execute(
		'UPDATE connection_profiles SET last_used_at = $1 WHERE id = $2',
		[Date.now(), id],
	);
}
