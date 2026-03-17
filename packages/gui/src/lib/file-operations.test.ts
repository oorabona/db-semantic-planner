import { describe, expect, it } from 'vitest';
import {
	computeRenamedPath,
	extractFilename,
	validateRename,
} from './file-operations';

// ── validateRename ──────────────────────────────────────────────

describe('validateRename', () => {
	it('accepts valid rename with .dbsp extension', () => {
		expect(validateRename('old.dbsp', 'new.dbsp')).toEqual({ valid: true });
	});

	it('accepts valid rename with .sql extension', () => {
		expect(validateRename('old.sql', 'new.sql')).toEqual({ valid: true });
	});

	it('rejects empty name', () => {
		const result = validateRename('old.dbsp', '');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/empty/i);
	});

	it('rejects whitespace-only name', () => {
		const result = validateRename('old.dbsp', '   ');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/empty/i);
	});

	it('rejects path separators (forward slash)', () => {
		const result = validateRename('old.dbsp', 'sub/new.dbsp');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/separator/i);
	});

	it('rejects path separators (backslash)', () => {
		const result = validateRename('old.dbsp', 'sub\\new.dbsp');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/separator/i);
	});

	it('rejects unsupported extension', () => {
		const result = validateRename('old.dbsp', 'new.txt');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/\.dbsp|\.sql/);
	});

	it('rejects unchanged name', () => {
		const result = validateRename('file.dbsp', 'file.dbsp');
		expect(result.valid).toBe(false);
		expect(result.error).toMatch(/unchanged/i);
	});

	it('trims whitespace before validation', () => {
		expect(validateRename('old.dbsp', '  new.dbsp  ')).toEqual({
			valid: true,
		});
	});

	it('accepts .assert.dbsp extension', () => {
		expect(validateRename('old.assert.dbsp', 'new.assert.dbsp')).toEqual({
			valid: true,
		});
	});
});

// ── computeRenamedPath ──────────────────────────────────────────

describe('computeRenamedPath', () => {
	it('replaces filename in nested path', () => {
		expect(computeRenamedPath('src/models/users.dbsp', 'accounts.dbsp')).toBe(
			'src/models/accounts.dbsp',
		);
	});

	it('handles root-level file', () => {
		expect(computeRenamedPath('query.sql', 'report.sql')).toBe('report.sql');
	});

	it('handles deeply nested path', () => {
		expect(computeRenamedPath('a/b/c/d.dbsp', 'e.dbsp')).toBe('a/b/c/e.dbsp');
	});
});

// ── extractFilename ─────────────────────────────────────────────

describe('extractFilename', () => {
	it('extracts filename from path', () => {
		expect(extractFilename('src/models/users.dbsp')).toBe('users.dbsp');
	});

	it('returns path if no directory', () => {
		expect(extractFilename('query.sql')).toBe('query.sql');
	});
});
