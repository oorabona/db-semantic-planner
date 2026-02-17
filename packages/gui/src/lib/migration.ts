// ── localStorage → SQLite migration ──────────────────────────────
// Migrates dbsp-history and dbsp-connections from localStorage to SQLite.
// Idempotent: re-running after partial failure is safe (INSERT OR REPLACE).

import type { Database } from './db-shared';

export interface MigrationResult {
	readonly historyMigrated: number;
	readonly historySkipped: number;
	readonly connectionsMigrated: number;
	readonly connectionsSkipped: number;
	readonly alreadyDone: boolean;
}

/**
 * Migrate localStorage data to the given project/default database.
 *
 * - Reads `dbsp-history` and `dbsp-connections` from localStorage
 * - Writes entries to `query_history` and `connection_profiles` tables
 * - Sets `_meta.migration_complete = 'true'` on success
 * - Idempotent: INSERT OR REPLACE by primary key (UUID)
 * - Skips malformed entries with warning count
 * - Does NOT delete localStorage data (preserved as fallback)
 */
export async function migrateFromLocalStorage(
	db: Database,
): Promise<MigrationResult> {
	// Check if migration was already completed
	const rows = await db.select<Array<{ value: string }>>(
		"SELECT value FROM _meta WHERE key = 'migration_complete'",
	);
	if (rows[0]?.value === 'true') {
		return {
			historyMigrated: 0,
			historySkipped: 0,
			connectionsMigrated: 0,
			connectionsSkipped: 0,
			alreadyDone: true,
		};
	}

	let historyMigrated = 0;
	let historySkipped = 0;
	let connectionsMigrated = 0;
	let connectionsSkipped = 0;

	// ── Migrate history ──────────────────────────────────────────
	const rawHistory = localStorage.getItem('dbsp-history');
	if (rawHistory) {
		try {
			const parsed = JSON.parse(rawHistory);
			// Zustand persist wraps in { state: { entries: [...] } }
			const entries: unknown[] =
				parsed?.state?.entries ?? parsed?.entries ?? [];

			for (const entry of entries) {
				try {
					const e = entry as Record<string, unknown>;
					if (!e.id || !e.query) {
						historySkipped++;
						continue;
					}
					await db.execute(
						`INSERT OR REPLACE INTO query_history
						 (id, query, language, database, timestamp, duration_ms, row_count, success, error)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
						[
							e.id,
							e.query,
							e.language ?? 'sql',
							e.database ?? '',
							e.timestamp ?? Date.now(),
							e.durationMs ?? null,
							e.rowCount ?? null,
							e.success === false ? 0 : 1,
							e.error ?? null,
						],
					);
					historyMigrated++;
				} catch {
					historySkipped++;
				}
			}
		} catch {
			// Entire JSON is malformed — skip all
			historySkipped = 1;
		}
	}

	// ── Migrate connection profiles ──────────────────────────────
	const rawConnections = localStorage.getItem('dbsp-connections');
	if (rawConnections) {
		try {
			const parsed = JSON.parse(rawConnections);
			const profiles: unknown[] =
				parsed?.state?.profiles ?? parsed?.profiles ?? [];

			for (const profile of profiles) {
				try {
					const p = profile as Record<string, unknown>;
					if (!p.id || !p.name) {
						connectionsSkipped++;
						continue;
					}

					// Old format has flat PG fields; convert to type+config JSON
					const config = JSON.stringify({
						host: p.host ?? 'localhost',
						port: p.port ?? 5432,
						database: p.database ?? '',
						username: p.user ?? '',
						schema: p.schema ?? 'public',
						sslMode: p.sslMode ?? 'prefer',
					});

					await db.execute(
						`INSERT OR REPLACE INTO connection_profiles
						 (id, name, environment, type, config, color, created_at, last_used_at)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
						[
							p.id,
							p.name,
							(p.name as string) ?? null, // environment defaults to name
							(p.type as string) ?? 'postgresql',
							config,
							p.color ?? null,
							Date.now(),
							null,
						],
					);
					connectionsMigrated++;
				} catch {
					connectionsSkipped++;
				}
			}
		} catch {
			connectionsSkipped = 1;
		}
	}

	// ── Mark as complete ─────────────────────────────────────────
	await db.execute(
		'INSERT OR REPLACE INTO _meta (key, value) VALUES ($1, $2)',
		['migration_complete', 'true'],
	);

	return {
		historyMigrated,
		historySkipped,
		connectionsMigrated,
		connectionsSkipped,
		alreadyDone: false,
	};
}
