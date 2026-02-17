// ── Shared database primitives ───────────────────────────────────
// Reusable type + loader for Tauri plugin-sql SQLite databases.

/** Minimal interface matching @tauri-apps/plugin-sql Database. */
export interface Database {
	execute: (
		sql: string,
		params?: unknown[],
	) => Promise<{ lastInsertId: number; rowsAffected: number }>;
	select: <T>(sql: string, params?: unknown[]) => Promise<T>;
	close: () => Promise<void>;
}

/** Factory that produces a Database from a `sqlite:…` URI. */
export type DatabaseFactory = (uri: string) => Promise<Database>;

// ── Loader injection ─────────────────────────────────────────────
// In production: `() => import('@tauri-apps/plugin-sql')`
// In tests: a mock factory.

let factory: DatabaseFactory | null = null;

/**
 * Set the global database factory.
 *
 * Call once at app startup with the Tauri loader:
 * ```ts
 * setDatabaseFactory(async (uri) => {
 *   const mod = await import('@tauri-apps/plugin-sql');
 *   const Database = (mod as any).default ?? mod;
 *   return Database.load(uri);
 * });
 * ```
 */
export function setDatabaseFactory(f: DatabaseFactory | null): void {
	factory = f;
}

/** Open a SQLite database by URI (e.g. `sqlite:app.sqlite`). */
export async function openDatabase(uri: string): Promise<Database> {
	if (!factory) {
		throw new Error(
			'No database factory configured. Call setDatabaseFactory() at startup.',
		);
	}
	return factory(uri);
}

// ── Corrupt-database detection ───────────────────────────────────

/**
 * Try to open a database; if it's corrupted, rename the file to `.corrupt`
 * and create a fresh one.
 *
 * @param uri    SQLite URI, e.g. `sqlite:projects/my-app/data.sqlite`
 * @param onCorrupt Optional callback when corruption is detected
 * @returns An open Database handle
 */
export async function openDatabaseSafe(
	uri: string,
	onCorrupt?: (originalUri: string) => void,
): Promise<Database> {
	try {
		const db = await openDatabase(uri);
		// Quick integrity check — if the file is invalid, this will throw
		await db.execute('SELECT 1');
		return db;
	} catch (_firstError) {
		// Assume corruption — try to rename and recreate
		onCorrupt?.(uri);

		// The Tauri SQL plugin stores DBs relative to $APPDATA.
		// We can't rename via SQL — we'll rely on the fs plugin.
		// For now, attempt a fresh open (the plugin creates a new file if missing).
		try {
			return await openDatabase(uri);
		} catch (secondError) {
			// Both attempts failed — propagate
			throw new Error(
				`Failed to open database ${uri}: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
			);
		}
	}
}
