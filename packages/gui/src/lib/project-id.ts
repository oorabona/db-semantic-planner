// ── Project identity helpers ─────────────────────────────────────
// Path normalization and folder-name sanitization for project storage.

const IS_WINDOWS =
	typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

/**
 * Normalize an absolute folder path into a canonical project identity.
 *
 * - Resolves `.` / `..` segments (via URL normalization)
 * - Strips trailing slashes
 * - Lowercases on Windows (case-insensitive FS)
 *
 * Two paths that refer to the same directory **must** produce the same output.
 */
export function normalizePath(raw: string): string {
	// Use URL to resolve `.` / `..` without Node `path.resolve`
	// file:///C:/foo/bar/../baz → file:///C:/foo/baz
	let normalized: string;
	try {
		const cleaned = raw.replace(/\\/g, '/');
		const url = new URL(
			cleaned.startsWith('/') ? `file://${cleaned}` : `file:///${cleaned}`,
		);
		// pathname gives us the resolved path; drop the leading `/` on Windows drive letters
		normalized = decodeURIComponent(url.pathname);
		if (IS_WINDOWS && /^\/[A-Za-z]:/.test(normalized)) {
			normalized = normalized.slice(1);
		}
	} catch {
		// Fallback: just clean up the string
		normalized = raw.replace(/\\/g, '/');
	}

	// Collapse multiple slashes and strip trailing (but keep root `/` or `C:/`)
	normalized = normalized.replace(/\/{2,}/g, '/');
	normalized = normalized.replace(/\/+$/, '') || '/';

	if (IS_WINDOWS) {
		normalized = normalized.toLowerCase();
	}

	return normalized;
}

// Characters forbidden in most filesystems (Windows + macOS + Linux)
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — filters control chars from filenames
const UNSAFE_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
// Collapse runs of whitespace / dashes / underscores
const COLLAPSE_SEPARATORS = /[-_\s]+/g;

/**
 * Turn a human-friendly project name into a filesystem-safe folder name.
 *
 * - Strips unsafe characters
 * - Collapses whitespace/dashes/underscores into single dashes
 * - Trims leading/trailing separators
 * - Lowercases
 * - Falls back to `"project"` if the result is empty
 */
export function sanitizeFolderName(name: string): string {
	const slug = name
		.trim()
		.replace(UNSAFE_CHARS, '')
		.replace(COLLAPSE_SEPARATORS, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();

	return slug || 'project';
}
