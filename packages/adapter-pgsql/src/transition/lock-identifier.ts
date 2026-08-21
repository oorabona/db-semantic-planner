/**
 * Renders identifiers obtained from catalogue-backed ledger addresses for
 * relation locks. Unlike generated DDL identifiers, adopted names may contain
 * any PostgreSQL-legal character except NUL.
 */
export function renderPgLockIdentifier(value: unknown): string {
	if (typeof value !== 'string')
		throw new Error('PostgreSQL lock identifier must be a string');
	if (value.includes('\0'))
		throw new Error('PostgreSQL lock identifier must not contain NUL');
	return `"${value.replaceAll('"', '""')}"`;
}
