/**
 * Path sanitization helpers for mcp-server error messages and log lines.
 *
 * ALL error messages and log lines that touch file-system paths MUST go through
 * one of these helpers to prevent leaking absolute paths (which often contain
 * user identity via /home/<user>/ or /Users/<user>/ prefixes).
 *
 * Design rationale:
 * - A single canonical module breaks the "each new code path re-introduces a leak"
 *   cycle that occurred across Copilot R1/R3/R5 reviews.
 * - Three helpers cover the three distinct use-cases: log lines (formatLogPath),
 *   error messages with multiple occurrences (sanitizeErrorMessage), and ad-hoc
 *   path display in any context (sanitizePath).
 */

import { basename, sep } from 'node:path';

/** Default max length for sanitized error messages. */
const DEFAULT_MAX_LENGTH = 500;

/**
 * Sanitize an absolute path by replacing it with a placeholder, stripping
 * the parent directory (which often contains user identity like /home/<user>/).
 *
 * @param p - Path to sanitize (absolute or relative)
 * @param mode - 'placeholder' returns '<schema-file>'; 'basename' returns just
 *   the filename; 'redacted' returns '<dir>/<filename>' to show the name but
 *   hide the full directory tree.
 * @returns Sanitized path string, or empty string for empty input.
 */
export function sanitizePath(
	p: string,
	mode: 'placeholder' | 'basename' | 'redacted' = 'basename',
): string {
	if (!p) return '';

	switch (mode) {
		case 'placeholder':
			return '<schema-file>';
		case 'basename':
			return basename(p);
		case 'redacted':
			return `<dir>${sep}${basename(p)}`;
	}
}

/**
 * Format a path for log output based on a verbosity setting.
 *
 * Use this for ALL console.error() / log lines that display a path after
 * successful validation (post-load logs). Pre-validation logs MUST always
 * use basename regardless of verbose, since the path has not been security-checked.
 *
 * @param p - The path to format (may be absolute)
 * @param verbose - When true, returns the full path; when false, returns basename
 * @returns Full path or basename depending on verbosity
 */
export function formatLogPath(p: string, verbose: boolean): string {
	if (!p) return '';
	return verbose ? p : basename(p);
}

/**
 * Sanitize an error message by replacing all occurrences of given paths with
 * safe placeholders, then cap the message to avoid oversized error strings.
 *
 * Handles the case where a path appears multiple times (Node ERR_MODULE_NOT_FOUND
 * repeats the path twice in the same message). Both the resolved file path and
 * its parent directory are replaced to prevent user-identity leaks via directory
 * names (e.g. /home/alice/project → <schema-dir>).
 *
 * @param message - Original error message (potentially containing absolute paths)
 * @param paths - Paths to redact: `resolved` for the schema file path,
 *   `parent` for its parent directory
 * @param maxLength - Cap message at this many characters (default 500).
 *   Truncated messages end with '…' to indicate truncation.
 * @returns Sanitized, length-capped message string
 */
export function sanitizeErrorMessage(
	message: string,
	paths: { resolved?: string; parent?: string },
	maxLength = DEFAULT_MAX_LENGTH,
): string {
	if (!message) return '';

	let sanitized = message;

	// Replace the resolved file path FIRST (may appear multiple times in a single
	// Node.js error, e.g. ERR_MODULE_NOT_FOUND: 'Cannot find … <path> … <path>').
	// Must come before parent replacement: parent is a prefix of resolved, so if
	// we replaced parent first, the full path would become '<schema-dir>/file.ts'
	// and the resolved replacement would no longer match.
	if (paths.resolved) {
		sanitized = sanitized.replaceAll(paths.resolved, '<schema-file>');
	}

	// Replace parent directory AFTER resolved — catches occurrences of the directory
	// alone (without the filename) that still contain user identity information
	// (e.g. /home/alice/proj appears standalone in some Node.js error messages).
	if (paths.parent) {
		sanitized = sanitized.replaceAll(paths.parent, '<schema-dir>');
	}

	// Cap length to prevent oversized error strings.
	if (sanitized.length > maxLength) {
		// Leave room for the truncation marker (1 char).
		return `${sanitized.slice(0, maxLength - 1)}…`;
	}

	return sanitized;
}
