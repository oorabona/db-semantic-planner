/**
 * CLI-020: Mode Escape Logic
 *
 * Handles the symmetric mode escape behavior with ! prefix:
 * - Natural mode (default): input is natural query, ! escapes to raw SQL
 * - SQL mode (.sql): input is raw SQL, ! escapes to natural query
 */

import type { QueryMode } from './types.js';

export interface ModeEscapeResult {
	/** The query content without the escape prefix */
	content: string;
	/** Whether the input should be treated as raw SQL */
	isRawSql: boolean;
	/** Whether the ! escape prefix was used */
	escaped: boolean;
}

/**
 * Parse input and determine query type based on mode and escape prefix.
 *
 * @param input - The raw user input
 * @param mode - Current query mode ('natural' or 'sql')
 * @returns Parsed result with content and query type
 */
export function parseInputMode(
	input: string,
	mode: QueryMode,
): ModeEscapeResult {
	const trimmed = input.trim();
	const escaped = trimmed.startsWith('!');
	const content = escaped ? trimmed.slice(1).trim() : trimmed;

	// Mode escape logic:
	// - Natural mode + no escape = natural query
	// - Natural mode + escape (!) = raw SQL
	// - SQL mode + no escape = raw SQL
	// - SQL mode + escape (!) = natural query
	const isRawSql =
		(mode === 'natural' && escaped) || (mode === 'sql' && !escaped);

	return { content, isRawSql, escaped };
}

/**
 * Get the warning message for the current mode and escape state.
 */
export function getModeWarning(mode: QueryMode, escaped: boolean): string {
	if (mode === 'sql' && !escaped) {
		return 'SQL mode: direct SQL';
	}
	if (mode === 'natural' && escaped) {
		return 'Escaped to raw SQL with !';
	}
	if (mode === 'sql' && escaped) {
		return 'Escaped to natural query with !';
	}
	return 'Natural query mode';
}
