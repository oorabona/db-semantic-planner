/**
 * Adapter-agnostic SQL utilities.
 *
 * Pure string helpers that work with any SQL dialect.
 * Placed in core so every package can use them without
 * pulling in a specific adapter dependency.
 */

/**
 * Normalize SQL for comparison: collapse whitespace, lowercase, trim.
 * Useful for golden-file tests and assertion systems.
 */
export function normalizeSQL(sql: string): string {
	return sql
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/\s*,\s*/g, ', ')
		.replace(/\(\s+/g, '(')
		.replace(/\s+\)/g, ')')
		.replace(/;\s*$/, '')
		.trim();
}
