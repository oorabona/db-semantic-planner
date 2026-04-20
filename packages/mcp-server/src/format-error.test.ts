/**
 * Unit tests for format-error.ts — path sanitization helpers.
 *
 * These helpers are the canonical sanitization layer for ALL mcp-server
 * error messages and log lines that touch file-system paths.
 */

import { describe, expect, it } from 'vitest';
import {
	formatLogPath,
	sanitizeErrorMessage,
	sanitizePath,
} from './format-error.js';

describe('sanitizePath', () => {
	describe("mode='placeholder' (default not used here — explicit)", () => {
		it("returns '<schema-file>' for any absolute path", () => {
			expect(sanitizePath('/home/user/project/schema.ts', 'placeholder')).toBe(
				'<schema-file>',
			);
		});

		it("returns '<schema-file>' for any relative path", () => {
			expect(sanitizePath('./schema.ts', 'placeholder')).toBe('<schema-file>');
		});
	});

	describe("mode='basename' (default)", () => {
		it('returns only the filename for an absolute path', () => {
			expect(sanitizePath('/home/user/project/schema.ts', 'basename')).toBe(
				'schema.ts',
			);
		});

		it('returns only the filename for a deep absolute path', () => {
			expect(
				sanitizePath('/home/alice/workspace/my-app/db/schema.ts', 'basename'),
			).toBe('schema.ts');
		});

		it('default mode is basename', () => {
			expect(sanitizePath('/home/user/project/schema.ts')).toBe('schema.ts');
		});
	});

	describe("mode='redacted'", () => {
		it("returns '<dir>/<filename>' hiding the full directory tree", () => {
			const result = sanitizePath('/home/user/project/schema.ts', 'redacted');
			expect(result).not.toContain('/home/user/project');
			expect(result).toContain('schema.ts');
			// Should start with the redacted dir marker
			expect(result).toMatch(/^<dir>[/\\]schema\.ts$/);
		});
	});

	describe('edge cases', () => {
		it('returns empty string for empty input', () => {
			expect(sanitizePath('')).toBe('');
		});

		it('does not crash on single-segment paths', () => {
			expect(sanitizePath('schema.ts', 'basename')).toBe('schema.ts');
		});
	});
});

describe('formatLogPath', () => {
	it('returns the full path when verbose=true', () => {
		expect(formatLogPath('/home/user/project/schema.ts', true)).toBe(
			'/home/user/project/schema.ts',
		);
	});

	it('returns basename when verbose=false', () => {
		expect(formatLogPath('/home/user/project/schema.ts', false)).toBe(
			'schema.ts',
		);
	});

	it('returns empty string for empty input', () => {
		expect(formatLogPath('', false)).toBe('');
		expect(formatLogPath('', true)).toBe('');
	});

	it('returns the full path verbatim including any special characters', () => {
		const p = '/home/alice/my project/schema.ts';
		expect(formatLogPath(p, true)).toBe(p);
	});
});

describe('sanitizeErrorMessage', () => {
	it('replaces a single occurrence of the resolved path', () => {
		const result = sanitizeErrorMessage('Cannot read /home/user/x.ts', {
			resolved: '/home/user/x.ts',
		});
		expect(result).not.toContain('/home/user/x.ts');
		expect(result).toContain('<schema-file>');
	});

	it('replaces multiple occurrences (ERR_MODULE_NOT_FOUND pattern)', () => {
		const result = sanitizeErrorMessage('Cannot find /a/b imported from /a/b', {
			resolved: '/a/b',
		});
		// No occurrence of /a/b should remain
		expect(result).not.toContain('/a/b');
		expect(result).toContain('<schema-file>');
	});

	it('replaces the parent directory separately', () => {
		const result = sanitizeErrorMessage('Failed at /home/user/proj/x.ts', {
			resolved: '/home/user/proj/x.ts',
			parent: '/home/user/proj',
		});
		// Neither the full path nor the parent dir should be present
		expect(result).not.toContain('/home/user/proj');
		expect(result).not.toContain('/home/user/proj/x.ts');
	});

	it('replaces parent directory when it appears without the full path', () => {
		const result = sanitizeErrorMessage(
			'Cannot load from /home/user/proj — check permissions',
			{ resolved: '/home/user/proj/x.ts', parent: '/home/user/proj' },
		);
		expect(result).not.toContain('/home/user/proj');
		expect(result).toContain('<schema-dir>');
	});

	it('caps message at 500 characters by default', () => {
		const long = 'x'.repeat(1000);
		const result = sanitizeErrorMessage(long, {});
		expect(result.length).toBeLessThanOrEqual(500);
	});

	it('ends with truncation marker when capped', () => {
		const long = 'x'.repeat(1000);
		const result = sanitizeErrorMessage(long, {});
		expect(result.endsWith('…')).toBe(true);
	});

	it('respects custom maxLength', () => {
		const msg = 'a'.repeat(200);
		const result = sanitizeErrorMessage(msg, {}, 100);
		expect(result.length).toBeLessThanOrEqual(100);
		expect(result.endsWith('…')).toBe(true);
	});

	it('does not truncate messages that are within the limit', () => {
		const msg = 'short message';
		const result = sanitizeErrorMessage(msg, {});
		expect(result).toBe('short message');
		expect(result.endsWith('…')).toBe(false);
	});

	it('returns empty string for empty message', () => {
		expect(sanitizeErrorMessage('', {})).toBe('');
	});

	it('handles empty paths object gracefully', () => {
		const result = sanitizeErrorMessage('some error occurred', {});
		expect(result).toBe('some error occurred');
	});

	it('replaces resolved before parent (prefix order correctness)', () => {
		// Resolved is replaced first, then parent. Parent is a prefix of resolved,
		// so replacing parent first would turn /proj/x.ts into <schema-dir>/x.ts,
		// causing the resolved replacement to miss. Replacing resolved first avoids
		// this and then remaining standalone /proj occurrences are caught by the parent pass.
		const msg = 'Error in /proj/x.ts and also /proj was searched';
		const result = sanitizeErrorMessage(msg, {
			resolved: '/proj/x.ts',
			parent: '/proj',
		});
		// Both /proj/x.ts (now <schema-file>) and standalone /proj (now <schema-dir>) must be gone
		expect(result).not.toContain('/proj');
		expect(result).toContain('<schema-file>');
		expect(result).toContain('<schema-dir>');
	});
});
