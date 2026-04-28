/**
 * Internal helpers for batch mode. Not part of the public API surface.
 *
 * Imported via relative path from batch.ts and from test files. NOT re-exported
 * from the package barrel — the package's public API does not include these
 * helpers, and they may be removed or refactored without notice.
 */

/**
 * Coalesce backslash-continuation lines into single logical query strings,
 * mirroring ReplEngine.submit() semantics:
 *   - Lines ending in '\' are joined with '\n' to the next non-continuation line
 *   - Blank lines and comment lines (starting with '#') flush the continuation
 *     buffer and are dropped from the output
 *   - Trailing pending text at EOF is emitted as a final entry (so malformed
 *     input ending on a continuation is still observable to validators)
 *
 * Used by batch mode to count distinct executable queries before passing them
 * to engine.submit() so that assertion validation counts match what the
 * engine actually executes.
 */
export function coalesceContinuations(lines: string[]): string[] {
	const result: string[] = [];
	let pending = '';
	for (const q of lines) {
		const trimmed = q.trim();

		// Blank or comment — flush continuation buffer (separator) and skip
		if (!trimmed || trimmed.startsWith('#')) {
			pending = '';
			continue;
		}

		// Backslash continuation — accumulate and wait for next line
		if (trimmed.endsWith('\\')) {
			pending += (pending ? '\n' : '') + trimmed.slice(0, -1).trimEnd();
			continue;
		}

		// Merge pending + current
		result.push(pending ? `${pending}\n${trimmed}` : trimmed);
		pending = '';
	}
	// EOF flush — only emit if there's accumulated text (matches engine: dangling
	// continuation buffer at end-of-input has nothing to merge with, but we keep
	// its content available so callers can detect malformed input.)
	if (pending) result.push(pending);
	return result;
}
