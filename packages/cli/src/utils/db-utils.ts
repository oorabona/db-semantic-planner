/**
 * Shared database utilities for CLI commands.
 *
 * E09: Extracted from verify.ts and introspect.ts to DRY up code.
 * E09b: Shared URL redaction for secure logging.
 */

/**
 * Create a database connection pool.
 * pg is an optional peer dependency.
 *
 * @param connectionUrl - PostgreSQL connection URL
 * @returns Pool instance
 * @throws Error if pg is not installed
 */
export async function createDbConnection(connectionUrl: string) {
	let pg: typeof import('pg').default;
	try {
		const mod = await import('pg');
		pg = mod.default;
	} catch {
		throw new Error(
			'pg is required for this command. Install it with: pnpm add pg',
		);
	}

	const pool = new pg.Pool({
		connectionString: connectionUrl,
	});
	return { pool };
}

/**
 * Redact password from a database connection URL for safe logging.
 *
 * @param url - Database connection URL (e.g., postgres://user:pass@host/db)
 * @returns URL with password replaced by ***
 *
 * @example
 * redactDbUrl('postgres://user:secret@localhost/mydb')
 * // => 'postgres://user:***@localhost/mydb'
 */
export function redactDbUrl(url: string): string {
	try {
		const u = new URL(url);
		if (u.password) {
			u.password = '***';
		}
		return u.toString();
	} catch {
		// Fall back to regex for non-standard or malformed URLs
		return url.replace(/:[^:@]+@/, ':***@');
	}
}
