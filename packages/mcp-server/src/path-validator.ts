/**
 * Path validation helpers for MCP server schema loading.
 *
 * Extracted from schema-loader.ts to give each concern a focused, testable unit:
 *   - hasParentSegment  — segment-based `..` detection (avoids false positives on `..backup`)
 *   - realpathBestEffort — symlink-aware resolution that works for non-existent paths
 *   - isPathContained   — unified containment check (existing or not, symlink-aware)
 *   - validateAllowedRoots — canonicalization + default-to-cwd warn-once
 *
 * These helpers fix three Copilot R3 M-findings:
 *   M-R3e/f: substring `.includes('..')` rejected legitimate dir names like `/var/..backup`
 *   M-R3g:   non-existent path containment check failed when root was a symlink
 *   (warn-once flag moved here so tests can reset it without importing schema-loader)
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// ─── warn-once flag (moved from schema-loader.ts) ──────────────────────────

let _cwdWarnEmitted = false;

/** @internal Test-only: reset the warn-once flag between test runs. */
export function _resetWarnFlagForTests(): void {
	_cwdWarnEmitted = false;
}

// ─── hasParentSegment ───────────────────────────────────────────────────────

/**
 * Returns true if the path contains a `..` path segment (exact segment, not substring).
 *
 * Splits on both POSIX (/) and Windows (\\) separators so traversal detection
 * works regardless of runtime OS — important for paths supplied by external callers.
 *
 * Examples:
 *   hasParentSegment('/var/..backup') → false  (`..backup` is not `..`)
 *   hasParentSegment('/var/../etc')   → true   (literal `..` segment)
 *   hasParentSegment('..')            → true
 *   hasParentSegment('..\\foo')       → true   (Windows-style, detected on POSIX)
 */
export function hasParentSegment(p: string): boolean {
	if (p === '') return false;
	return p.split(/[\\/]/).some((seg) => seg === '..');
}

// ─── realpathBestEffort ─────────────────────────────────────────────────────

/**
 * Symlink-aware path resolution that works even when the target doesn't exist.
 *
 * For existing paths: delegates to `realpathSync` (resolves all symlinks).
 * For non-existent paths: walks up the directory tree to find the deepest existing
 * ancestor, calls `realpathSync` on it, then re-attaches the relative descent.
 *
 * This prevents the M-R3g false-positive: when root is a symlink (`/srv/data → /mnt/storage`)
 * and the file doesn't exist, `resolvedPath` is lexical `/srv/data/foo/schema.js` but
 * `realpathSync(root)` returns `/mnt/storage`. Without this helper, `relative` between
 * them starts with `..` → false PATH_TRAVERSAL throw.
 */
export function realpathBestEffort(absPath: string): string {
	if (existsSync(absPath)) return realpathSync(absPath);

	// Walk up to find the deepest existing ancestor.
	let ancestor = dirname(absPath);
	while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) {
		ancestor = dirname(ancestor);
	}

	// If even the filesystem root doesn't exist (impossible in practice), bail.
	if (!existsSync(ancestor)) return absPath;

	const realAncestor = realpathSync(ancestor);
	const relDescent = relative(ancestor, absPath);
	return relDescent ? `${realAncestor}${sep}${relDescent}` : realAncestor;
}

// ─── isPathContained ────────────────────────────────────────────────────────

/**
 * Returns true if `absPath` is contained within any of `roots`.
 *
 * Symlink-aware for both roots and the target path — uses `realpathBestEffort`
 * so non-existent paths inside symlinked roots are accepted correctly (M-R3g).
 *
 * A path is considered contained if:
 *   - `relative(realRoot, realPath)` does not start with `..` (no escape)
 *   - `relative(realRoot, realPath)` is not empty (the path is not the root itself)
 *   - `relative(realRoot, realPath)` is not absolute (no drive-letter escape on Windows)
 */
export function isPathContained(roots: string[], absPath: string): boolean {
	const realPath = realpathBestEffort(absPath);
	return roots.some((root) => {
		const realRoot = realpathBestEffort(root);
		const rel = relative(realRoot, realPath);
		return (
			rel !== '' &&
			rel !== '..' &&
			!rel.startsWith(`..${sep}`) &&
			!isAbsolute(rel)
		);
	});
}

// ─── validateAllowedRoots ───────────────────────────────────────────────────

/**
 * Canonicalize and validate `allowedRoots`.
 *
 * - Relative paths are resolved against `process.cwd()`.
 * - Roots containing a `..` path segment (exact segment, not substring) are rejected
 *   with `PATH_TRAVERSAL` — e.g. `/var/../etc` is rejected but `/var/..backup` is not.
 * - When `roots` is undefined or empty, defaults to `[process.cwd()]` and emits a
 *   one-time warning to stderr (warn-once to avoid spamming stdio-MCP transport).
 *
 * @throws SchemaLoadError (PATH_TRAVERSAL) if any root contains a `..` segment
 */
export function validateAllowedRoots(
	roots: string[] | undefined,
	SchemaLoadError: new (message: string, code: 'PATH_TRAVERSAL') => Error,
): string[] {
	const canonical: string[] = (roots ?? []).map((root) => {
		// Segment-based check on the raw input: reject only if a segment IS exactly '..'
		// (not mere substring — /var/..backup is a valid POSIX name).
		// We check the raw input BEFORE resolving because resolve('..') → '/parent/dir'
		// which strips the traversal indicator — we'd miss it post-resolution.
		if (hasParentSegment(root)) {
			throw new SchemaLoadError(
				`Invalid allowedRoot contains path traversal: ${root}`,
				'PATH_TRAVERSAL',
			);
		}
		return isAbsolute(root) ? root : resolve(process.cwd(), root);
	});

	if (canonical.length === 0) {
		if (!_cwdWarnEmitted) {
			process.stderr.write(
				'[dbsp-mcp] Warning: no --allowed-root specified, defaulting to cwd\n',
			);
			_cwdWarnEmitted = true;
		}
		return [process.cwd()];
	}

	return canonical;
}
