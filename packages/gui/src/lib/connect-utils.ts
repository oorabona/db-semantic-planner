import type { ConnectionProfile } from '@/stores/connection-store';

/**
 * Classify connection errors as auth vs non-auth (ERR-07).
 *
 * Auth failures: PostgreSQL SQLSTATE 28000/28P01 or "password authentication failed".
 * Everything else (DNS, refused, TLS, bad DB name) is non-auth.
 */
export function isAuthError(error: unknown): boolean {
	const msg = String(error).toLowerCase();
	return (
		msg.includes('password authentication failed') ||
		msg.includes('28000') ||
		msg.includes('28p01') ||
		msg.includes('no password supplied')
	);
}

/** Sort: default first, then lastUsedAt desc (null last), then name asc */
export function sortProfiles(
	profiles: readonly ConnectionProfile[],
	defaultName?: string,
): ConnectionProfile[] {
	return [...profiles].sort((a, b) => {
		if (a.name === defaultName && b.name !== defaultName) return -1;
		if (b.name === defaultName && a.name !== defaultName) return 1;
		if (a.lastUsedAt !== null && b.lastUsedAt === null) return -1;
		if (a.lastUsedAt === null && b.lastUsedAt !== null) return 1;
		if (a.lastUsedAt !== null && b.lastUsedAt !== null)
			return b.lastUsedAt - a.lastUsedAt;
		return a.name.localeCompare(b.name);
	});
}
