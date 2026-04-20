/**
 * Path validator unit tests
 *
 * Covers the four public helpers extracted from schema-loader.ts:
 *   - hasParentSegment
 *   - realpathBestEffort
 *   - isPathContained
 *   - validateAllowedRoots
 *
 * Symlink tests use mkdtempSync + symlinkSync to create real fixtures in a temp dir.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';
import {
	_resetWarnFlagForTests,
	hasParentSegment,
	isPathContained,
	realpathBestEffort,
	validateAllowedRoots,
} from './path-validator.js';

// Minimal SchemaLoadError stub for validateAllowedRoots tests
class SchemaLoadError extends Error {
	constructor(
		message: string,
		public readonly code: 'PATH_TRAVERSAL',
	) {
		super(message);
		this.name = 'SchemaLoadError';
	}
}

// ─── hasParentSegment ───────────────────────────────────────────────────────

describe('hasParentSegment', () => {
	it('returns false for a path containing .. as substring but not segment (/var/..backup)', () => {
		// M-R3e: substring check would reject this legitimate POSIX directory name.
		expect(hasParentSegment(`${sep}var${sep}..backup`)).toBe(false);
	});

	it('returns true for /var/../etc (literal .. segment)', () => {
		expect(hasParentSegment(`${sep}var${sep}..${sep}etc`)).toBe(true);
	});

	it('returns false for a plain segment name (foo)', () => {
		expect(hasParentSegment('foo')).toBe(false);
	});

	it('returns true for bare .. (the whole path is a traversal)', () => {
		expect(hasParentSegment('..')).toBe(true);
	});

	it('returns true for foo/.. (trailing ..)', () => {
		expect(hasParentSegment(`foo${sep}..`)).toBe(true);
	});

	it('returns false for empty string', () => {
		expect(hasParentSegment('')).toBe(false);
	});

	it('returns false for a path with no .. at all', () => {
		expect(hasParentSegment(`${sep}usr${sep}local${sep}bin`)).toBe(false);
	});

	it('returns false for ..backup at root level', () => {
		// /..backup — the segment IS ..backup (not ..)
		expect(hasParentSegment(`${sep}..backup`)).toBe(false);
	});

	it('M1: detects Windows-style ..\\foo traversal on POSIX runtime (cross-platform)', () => {
		// On POSIX, path.sep === '/' so split('/') keeps '..\\foo' as one segment.
		// The regex /[\\/]/ splits on both separators, correctly finding '..' as a segment.
		expect(hasParentSegment('..\\foo')).toBe(true);
	});

	it('M1: detects Windows-style foo\\..\\bar traversal on POSIX runtime', () => {
		// Middle '..' segment must be detected regardless of separator style.
		expect(hasParentSegment('foo\\..\\bar')).toBe(true);
	});
});

// ─── realpathBestEffort ─────────────────────────────────────────────────────

describe('realpathBestEffort', () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'dbsp-pv-test-'));
	});

	afterAll(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns realpath for an existing file', () => {
		const filePath = join(tmpDir, 'real-file.ts');
		writeFileSync(filePath, '');
		// No symlinks involved — realpath equals the path itself (tmpDir is already real)
		expect(realpathBestEffort(filePath)).toBe(filePath);
	});

	it('returns realpath(parent) + basename for non-existent file in existing parent', () => {
		const nonExistent = join(tmpDir, 'ghost-schema.ts');
		const result = realpathBestEffort(nonExistent);
		// Parent (tmpDir) exists; result should be tmpDir/ghost-schema.ts
		expect(result).toBe(join(tmpDir, 'ghost-schema.ts'));
	});

	it('handles non-existent file with several non-existent ancestors', () => {
		// /tmpDir/deep/nested/ghost.ts — only tmpDir exists
		const deep = join(tmpDir, 'deep', 'nested', 'ghost.ts');
		const result = realpathBestEffort(deep);
		// Should resolve through tmpDir (first existing ancestor)
		expect(result).toContain(tmpDir);
		expect(result).toContain(join('deep', 'nested', 'ghost.ts'));
	});

	it('resolves symlink to its real target when file exists', () => {
		const realDir = join(tmpDir, 'real-target');
		mkdirSync(realDir, { recursive: true });
		const realFile = join(realDir, 'schema.ts');
		writeFileSync(realFile, '');

		const symlinkDir = join(tmpDir, 'symlink-dir');
		// Only create symlink if it doesn't already exist (guard against test reruns)
		if (!existsSync(symlinkDir)) {
			symlinkSync(realDir, symlinkDir);
		}
		const viaSymlink = join(symlinkDir, 'schema.ts');

		const result = realpathBestEffort(viaSymlink);
		// The result should be the real path, not the symlink path
		expect(result).toBe(realFile);
	});

	it('non-existent file inside symlinked dir resolves through the real dir', () => {
		// /tmp/symlink-dir2 → /tmp/real-target2/
		// File /tmp/symlink-dir2/new-file.ts does not exist.
		// realpathBestEffort should resolve to /tmp/real-target2/new-file.ts
		const realDir = join(tmpDir, 'real-target2');
		mkdirSync(realDir, { recursive: true });

		const symlinkDir = join(tmpDir, 'symlink-dir2');
		if (!existsSync(symlinkDir)) {
			symlinkSync(realDir, symlinkDir);
		}
		const nonExistent = join(symlinkDir, 'new-file.ts');

		const result = realpathBestEffort(nonExistent);
		// Ancestor is symlinkDir (exists); realpathSync(symlinkDir) = realDir
		// → result should be realDir + sep + 'new-file.ts'
		expect(result).toBe(join(realDir, 'new-file.ts'));
	});
});

// ─── isPathContained ────────────────────────────────────────────────────────

describe('isPathContained', () => {
	let tmpDir: string;

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), 'dbsp-ic-test-'));
	});

	afterAll(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	});

	it('returns false for /tmp against /etc/passwd', () => {
		expect(isPathContained([tmpDir], '/etc/passwd')).toBe(false);
	});

	it('returns false when path IS the root itself (not a file within)', () => {
		// isPathContained checks rel !== '' — root itself is not "contained in root"
		expect(isPathContained([tmpDir], tmpDir)).toBe(false);
	});

	it('returns true when path is a file within root', () => {
		const filePath = join(tmpDir, 'sub', 'schema.js');
		expect(isPathContained([tmpDir], filePath)).toBe(true);
	});

	it('returns true when any root in the list covers the path', () => {
		const outside = '/etc';
		const inside = join(tmpDir, 'foo.ts');
		expect(isPathContained([outside, tmpDir], inside)).toBe(true);
	});

	it('returns false when no root covers the path', () => {
		expect(isPathContained(['/etc', '/usr'], '/tmp/schema.ts')).toBe(false);
	});

	it('M-R3g: non-existent file within symlinked root is accepted (core fix)', () => {
		// /tmpDir/sym-root → /tmpDir/real-root
		// File /tmpDir/sym-root/data/schema.js does NOT exist.
		// isPathContained(['/tmpDir/sym-root'], '/tmpDir/sym-root/data/schema.js')
		// With the OLD code: realpathSync('/tmpDir/sym-root') = '/tmpDir/real-root'
		// but resolvedPath is lexical '/tmpDir/sym-root/data/schema.js'
		// → relative('/tmpDir/real-root', '/tmpDir/sym-root/data/schema.js') starts with '..'
		// → false PATH_TRAVERSAL. The fix: realpathBestEffort on the path too.
		const realRoot = join(tmpDir, 'real-root-mg');
		mkdirSync(realRoot, { recursive: true });

		const symRoot = join(tmpDir, 'sym-root-mg');
		if (!existsSync(symRoot)) {
			symlinkSync(realRoot, symRoot);
		}

		const nonExistentFile = join(symRoot, 'data', 'schema.js');

		// Must return true — the path IS within the symlinked root
		expect(isPathContained([symRoot], nonExistentFile)).toBe(true);
	});

	it('M-R3g: path outside symlinked root is correctly rejected', () => {
		const realRoot = join(tmpDir, 'real-root-reject');
		mkdirSync(realRoot, { recursive: true });

		const symRoot = join(tmpDir, 'sym-root-reject');
		if (!existsSync(symRoot)) {
			symlinkSync(realRoot, symRoot);
		}

		// This path is outside both symRoot and realRoot
		const outsideFile = join(tmpDir, 'other-dir', 'schema.js');
		expect(isPathContained([symRoot], outsideFile)).toBe(false);
	});
});

// ─── validateAllowedRoots ───────────────────────────────────────────────────

describe('validateAllowedRoots', () => {
	beforeEach(() => {
		_resetWarnFlagForTests();
	});
	afterEach(() => {
		_resetWarnFlagForTests();
	});

	it('M-R3e: accepts /var/..backup — substring .. is not a segment, not rejected', () => {
		// /var/..backup normalized is still /var/..backup on POSIX — no .. segment.
		// validateAllowedRoots must NOT throw for this root.
		expect(() =>
			validateAllowedRoots([`${sep}var${sep}..backup`], SchemaLoadError),
		).not.toThrow();
	});

	it('rejects /var/../etc — literal .. segment triggers PATH_TRAVERSAL', () => {
		expect(() =>
			validateAllowedRoots([`${sep}var${sep}..${sep}etc`], SchemaLoadError),
		).toThrow('Invalid allowedRoot contains path traversal');
	});

	it('returns [cwd] and emits a stderr warning when roots is undefined', () => {
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);

		const result = validateAllowedRoots(undefined, SchemaLoadError);

		expect(result).toEqual([process.cwd()]);
		const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
		expect(calls.some((s) => s.includes('no --allowed-root specified'))).toBe(
			true,
		);
		stderrSpy.mockRestore();
	});

	it('returns [cwd] when roots is an empty array', () => {
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		const result = validateAllowedRoots([], SchemaLoadError);
		expect(result).toEqual([process.cwd()]);
		stderrSpy.mockRestore();
	});

	it('warn-once: emits exactly one warning across multiple calls without roots', () => {
		const stderrSpy = vi
			.spyOn(process.stderr, 'write')
			.mockImplementation(() => true);
		for (let i = 0; i < 3; i++) {
			validateAllowedRoots(undefined, SchemaLoadError);
		}
		const warnCount = stderrSpy.mock.calls.filter((c) =>
			String(c[0]).includes('no --allowed-root specified'),
		).length;
		expect(warnCount).toBe(1);
		stderrSpy.mockRestore();
	});

	it('resolves relative paths against cwd', () => {
		const result = validateAllowedRoots(['relative/path'], SchemaLoadError);
		expect(result).toEqual([resolve(process.cwd(), 'relative/path')]);
	});

	it('preserves absolute paths as-is (no .. segment)', () => {
		const absPath = `${sep}usr${sep}local${sep}share`;
		const result = validateAllowedRoots([absPath], SchemaLoadError);
		expect(result).toEqual([absPath]);
	});

	it('throws for a root with a bare .. segment (..)', () => {
		expect(() => validateAllowedRoots(['..'], SchemaLoadError)).toThrow(
			'Invalid allowedRoot contains path traversal',
		);
	});
});
