/**
 * Tests for path-containment utility.
 */
import { describe, expect, it } from 'vitest';
import { PathEscapeError, validatePathInCwd } from './path-containment.js';

const CWD = '/app/workspace';

describe('validatePathInCwd', () => {
	describe('accepted paths', () => {
		it('accepts a simple filename in cwd', () => {
			const result = validatePathInCwd('seed.sql', CWD);
			expect(result).toBe('/app/workspace/seed.sql');
		});

		it('accepts a subdirectory path', () => {
			const result = validatePathInCwd('data/import.csv', CWD);
			expect(result).toBe('/app/workspace/data/import.csv');
		});

		it('accepts a nested subdirectory path', () => {
			const result = validatePathInCwd('fixtures/db/seed.sql', CWD);
			expect(result).toBe('/app/workspace/fixtures/db/seed.sql');
		});

		it('accepts an absolute path inside cwd', () => {
			const result = validatePathInCwd('/app/workspace/exports/out.csv', CWD);
			expect(result).toBe('/app/workspace/exports/out.csv');
		});

		it('accepts a path with redundant ./ prefix', () => {
			const result = validatePathInCwd('./data/file.csv', CWD);
			expect(result).toBe('/app/workspace/data/file.csv');
		});
	});

	describe('path traversal rejection (relative paths)', () => {
		it('rejects ../escape from cwd', () => {
			expect(() => validatePathInCwd('../etc/passwd', CWD)).toThrow(
				PathEscapeError,
			);
			expect(() => validatePathInCwd('../etc/passwd', CWD)).toThrow(
				'Path escapes working directory',
			);
		});

		it('rejects ../../deep escape', () => {
			expect(() => validatePathInCwd('../../etc/shadow', CWD)).toThrow(
				PathEscapeError,
			);
		});

		it('rejects dot-dot in the middle of a relative path', () => {
			expect(() => validatePathInCwd('data/../../../etc/passwd', CWD)).toThrow(
				PathEscapeError,
			);
		});

		// Absolute paths are user-explicit intent — allowed even outside cwd.
		it('allows absolute path outside cwd (explicit user intent)', () => {
			expect(() => validatePathInCwd('/etc/passwd', CWD)).not.toThrow();
		});

		it('allows adjacent-directory absolute path (explicit user intent)', () => {
			// /app/workspace-sibling is clearly outside /app/workspace, but the
			// user typed it explicitly — allow it (not a relative traversal).
			expect(() =>
				validatePathInCwd('/app/workspace-sibling/file.csv', CWD),
			).not.toThrow();
		});
	});

	describe('NUL byte stripping', () => {
		it('strips NUL bytes before path comparison', () => {
			// NUL in the middle: 'seed.sql\0' → 'seed.sql' after strip → inside cwd
			const result = validatePathInCwd('seed.sql\x00', CWD);
			expect(result).toBe('/app/workspace/seed.sql');
		});

		it('strips NUL bytes in traversal attempt (cannot bypass via NUL)', () => {
			// Attempt: '../etc\x00/passwd' — after NUL strip → '../etc/passwd'
			// This still escapes cwd, so should still throw
			expect(() => validatePathInCwd('../etc\x00/passwd', CWD)).toThrow(
				PathEscapeError,
			);
		});
	});

	describe('error payload', () => {
		it('PathEscapeError includes originalArg, resolvedPath, baseDir', () => {
			let err: unknown;
			try {
				validatePathInCwd('../escape.csv', CWD);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(PathEscapeError);
			const pe = err as PathEscapeError;
			expect(pe.originalArg).toBe('../escape.csv');
			expect(pe.baseDir).toBe(CWD);
			expect(pe.resolvedPath).not.toContain('..');
		});
	});
});
