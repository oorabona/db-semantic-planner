import { describe, expect, it } from 'vitest';
import {
	findContainingRoot,
	isSupportedFile,
	relativeTo,
	SUPPORTED_EXTENSIONS,
	validateDroppedFiles,
} from './drag-drop';

// ── Constants ────────────────────────────────────────────────────

describe('SUPPORTED_EXTENSIONS', () => {
	it('includes .dbsp and .sql', () => {
		expect(SUPPORTED_EXTENSIONS).toContain('.dbsp');
		expect(SUPPORTED_EXTENSIONS).toContain('.sql');
	});
});

// ── isSupportedFile ──────────────────────────────────────────────

describe('isSupportedFile', () => {
	it('accepts .dbsp files', () => {
		expect(isSupportedFile('main.dbsp')).toBe(true);
	});

	it('accepts .assert.dbsp files (ends with .dbsp)', () => {
		expect(isSupportedFile('main.assert.dbsp')).toBe(true);
	});

	it('accepts .sql files', () => {
		expect(isSupportedFile('query.sql')).toBe(true);
	});

	it('rejects unsupported extensions', () => {
		expect(isSupportedFile('image.png')).toBe(false);
		expect(isSupportedFile('readme.md')).toBe(false);
		expect(isSupportedFile('data.json')).toBe(false);
	});

	it('rejects files with no extension', () => {
		expect(isSupportedFile('Makefile')).toBe(false);
	});
});

// ── findContainingRoot ───────────────────────────────────────────

describe('findContainingRoot', () => {
	it('finds root that contains the file', () => {
		expect(
			findContainingRoot('/home/user/project/src/main.dbsp', [
				'/home/user/project',
			]),
		).toBe('/home/user/project');
	});

	it('returns first matching root when multiple match', () => {
		expect(findContainingRoot('/a/b/c/file.dbsp', ['/a/b', '/a/b/c'])).toBe(
			'/a/b',
		);
	});

	it('returns null when file is outside all roots', () => {
		expect(
			findContainingRoot('/tmp/file.dbsp', ['/home/user/project']),
		).toBeNull();
	});

	it('handles root with trailing slash', () => {
		expect(findContainingRoot('/project/file.dbsp', ['/project/'])).toBe(
			'/project/',
		);
	});

	it('does not match partial directory names', () => {
		// /project-extra/file.dbsp should NOT match root /project
		expect(
			findContainingRoot('/project-extra/file.dbsp', ['/project']),
		).toBeNull();
	});
});

// ── relativeTo ───────────────────────────────────────────────────

describe('relativeTo', () => {
	it('computes relative path', () => {
		expect(
			relativeTo('/home/user/project/src/main.dbsp', '/home/user/project'),
		).toBe('src/main.dbsp');
	});

	it('handles root with trailing slash', () => {
		expect(relativeTo('/project/file.dbsp', '/project/')).toBe('file.dbsp');
	});
});

// ── validateDroppedFiles ─────────────────────────────────────────

describe('validateDroppedFiles', () => {
	const roots = ['/home/user/project'];

	it('SC-09: accepts supported files within root', () => {
		const result = validateDroppedFiles(
			['/home/user/project/new.dbsp'],
			roots,
			[],
		);

		expect(result.accepted).toEqual(['new.dbsp']);
		expect(result.outsideRoots).toEqual([]);
	});

	it('SC-09: accepts .assert.dbsp files', () => {
		const result = validateDroppedFiles(
			['/home/user/project/test.assert.dbsp'],
			roots,
			[],
		);

		expect(result.accepted).toEqual(['test.assert.dbsp']);
	});

	it('SC-10: silently ignores unsupported extensions', () => {
		const result = validateDroppedFiles(
			[
				'/home/user/project/image.png',
				'/home/user/project/readme.md',
				'/home/user/project/valid.dbsp',
			],
			roots,
			[],
		);

		expect(result.accepted).toEqual(['valid.dbsp']);
		expect(result.outsideRoots).toEqual([]);
	});

	it('SC-11: rejects files outside project roots', () => {
		const result = validateDroppedFiles(['/tmp/external.dbsp'], roots, []);

		expect(result.accepted).toEqual([]);
		expect(result.outsideRoots).toEqual(['/tmp/external.dbsp']);
	});

	it('SC-12: deduplicates against existing files', () => {
		const result = validateDroppedFiles(['/home/user/project/a.dbsp'], roots, [
			'a.dbsp',
		]);

		expect(result.accepted).toEqual([]);
		expect(result.outsideRoots).toEqual([]);
	});

	it('SC-12: deduplicates within same drop batch', () => {
		const result = validateDroppedFiles(
			['/home/user/project/a.dbsp', '/home/user/project/a.dbsp'],
			roots,
			[],
		);

		expect(result.accepted).toEqual(['a.dbsp']);
	});

	it('handles mixed valid, invalid, outside, and duplicate', () => {
		const result = validateDroppedFiles(
			[
				'/home/user/project/new.dbsp', // accepted
				'/home/user/project/image.png', // unsupported → ignored
				'/tmp/external.sql', // outside root
				'/home/user/project/existing.dbsp', // duplicate
				'/home/user/project/new.dbsp', // batch duplicate
				'/home/user/project/another.sql', // accepted
			],
			roots,
			['existing.dbsp'],
		);

		expect(result.accepted).toEqual(['new.dbsp', 'another.sql']);
		expect(result.outsideRoots).toEqual(['/tmp/external.sql']);
	});

	it('handles empty drop', () => {
		const result = validateDroppedFiles([], roots, []);

		expect(result.accepted).toEqual([]);
		expect(result.outsideRoots).toEqual([]);
	});

	it('handles empty roots (no root = all outside)', () => {
		const result = validateDroppedFiles(['/any/path/file.dbsp'], [], []);

		expect(result.accepted).toEqual([]);
		expect(result.outsideRoots).toEqual(['/any/path/file.dbsp']);
	});

	it('works with multiple roots', () => {
		const multiRoots = ['/workspace/a', '/workspace/b'];
		const result = validateDroppedFiles(
			[
				'/workspace/a/file1.dbsp',
				'/workspace/b/file2.sql',
				'/workspace/c/file3.dbsp',
			],
			multiRoots,
			[],
		);

		expect(result.accepted).toEqual(['file1.dbsp', 'file2.sql']);
		expect(result.outsideRoots).toEqual(['/workspace/c/file3.dbsp']);
	});

	it('dedup uses relative path (same filename in different roots)', () => {
		const multiRoots = ['/a', '/b'];
		const result = validateDroppedFiles(
			['/a/main.dbsp', '/b/main.dbsp'],
			multiRoots,
			[],
		);

		// Both have relative path "main.dbsp" — second is deduped
		expect(result.accepted).toEqual(['main.dbsp']);
	});
});
