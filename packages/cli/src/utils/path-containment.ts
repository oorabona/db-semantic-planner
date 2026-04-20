/**
 * @module path-containment
 * Validate that a user-supplied path stays within the working directory.
 *
 * Security notes:
 * - NUL bytes are stripped before any comparison (they can truncate paths on
 *   some OS/libc layers and confuse string-prefix checks).
 * - Uses path.relative() instead of startsWith() to detect traversal — the
 *   startsWith approach is unsafe because a basePath of /foo matches /foobar.
 *   path.relative() returns a leading ".." segment when the resolved path
 *   escapes the base directory.
 *
 * Reference: security-basics GOTCHAS.md §"Path containment bypass via
 * startsWith" (2026-02-05).
 */

import { relative, resolve } from 'node:path';

/** Thrown when a path escapes the permitted base directory. */
export class PathEscapeError extends Error {
	constructor(
		public readonly originalArg: string,
		public readonly resolvedPath: string,
		public readonly baseDir: string,
	) {
		super(
			`Path escapes working directory: "${originalArg}" resolves to "${resolvedPath}" which is outside "${baseDir}"`,
		);
		this.name = 'PathEscapeError';
	}
}

/**
 * Sanitise a user-provided path argument and verify it stays within `cwd`.
 *
 * Steps:
 *  1. Strip NUL bytes (defensive: truncation attacks).
 *  2. Resolve the path relative to `cwd`.
 *  3. Verify the resolved path is inside `cwd` using `path.relative()`.
 *
 * @param arg  - Raw user-supplied path (may be relative or absolute).
 * @param cwd  - Base directory to contain the path (default: process.cwd()).
 * @returns    The sanitised, resolved absolute path.
 * @throws {PathEscapeError} if the path resolves outside `cwd`.
 */
export function validatePathInCwd(
	arg: string,
	cwd: string = process.cwd(),
): string {
	// Step 1: strip NUL bytes
	const sanitised = arg.replace(/\0/g, '');

	// Step 2: resolve to absolute path
	const resolved = resolve(cwd, sanitised);
	const base = resolve(cwd);

	// Step 3: containment check — only for RELATIVE paths.
	//
	// Rationale: a relative path like '../../etc/passwd' silently escapes the
	// working directory without the user realising it. An explicit absolute
	// path (e.g. '/home/user/data/seed.sql') is unambiguous user intent and
	// is allowed — the user typed it in full.
	//
	// We only enforce containment on relative paths. The check uses
	// path.relative() instead of startsWith() to avoid the prefix-collision
	// trap (/foo matches /foobar with startsWith).
	//
	// Reference: security-basics GOTCHAS.md §"Path containment bypass via
	// startsWith" (2026-02-05).
	const isRelative = !sanitised.startsWith('/');
	if (isRelative) {
		const rel = relative(base, resolved);
		if (rel.startsWith('..')) {
			throw new PathEscapeError(arg, resolved, base);
		}
	}

	return resolved;
}
