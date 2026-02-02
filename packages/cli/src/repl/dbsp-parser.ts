/**
 * Parser for .dbsp files.
 *
 * Handles: blank lines, # comments, \ line continuations.
 * Shared between batch mode (commands/repl.ts) and any future consumer.
 */

/**
 * Parse .dbsp file content into executable input lines.
 *
 * Rules:
 * - Blank lines and `#`-prefixed lines are treated as separators/comments
 * - A trailing `\` joins the current line with the next (continuation)
 * - Consecutive non-blank, non-comment lines without `\` are individual queries
 */
export function parseDbspLines(content: string): string[] {
	const rawLines = content.split('\n');
	const queries: string[] = [];
	let buffer = '';

	for (const line of rawLines) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith('#')) {
			if (buffer) {
				queries.push(buffer);
				buffer = '';
			}
			continue;
		}

		if (trimmed.endsWith('\\')) {
			buffer += (buffer ? '\n' : '') + trimmed.slice(0, -1);
		} else {
			buffer += (buffer ? '\n' : '') + trimmed;
			queries.push(buffer);
			buffer = '';
		}
	}

	if (buffer) queries.push(buffer);
	return queries;
}
