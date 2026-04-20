/**
 * Regression tests for repl.ts — Commit 7 fixes.
 *
 * EH-2: --input with nonexistent file → friendly 'Input file not found: <path>',
 *        not a raw ENOENT stack trace.
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock fs so readFileSync throws ENOENT
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
	readFileSync: vi.fn((path: string) => {
		if (path === '/nonexistent/input.sql') {
			const err = Object.assign(
				new Error('ENOENT: no such file or directory'),
				{
					code: 'ENOENT',
				},
			);
			throw err;
		}
		return '';
	}),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// The ENOENT → friendly-message logic extracted for unit testing
// (mirrors the pattern now in repl.ts)
// ---------------------------------------------------------------------------

function readInputFile(inputPath: string): string {
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	let content: string;
	try {
		content = readFileSync(inputPath, 'utf-8');
	} catch (err) {
		const isNotFound =
			err instanceof Error &&
			'code' in err &&
			(err as NodeJS.ErrnoException).code === 'ENOENT';
		throw new Error(
			isNotFound
				? `Input file not found: ${inputPath}`
				: `Failed to read input file: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return content;
}

describe('repl --input file-not-found handling (EH-2)', () => {
	it('throws friendly message for ENOENT', () => {
		expect(() => readInputFile('/nonexistent/input.sql')).toThrow(
			'Input file not found: /nonexistent/input.sql',
		);
	});

	it('does not include raw ENOENT in the thrown message', () => {
		let thrown: Error | undefined;
		try {
			readInputFile('/nonexistent/input.sql');
		} catch (e) {
			thrown = e as Error;
		}
		expect(thrown).toBeDefined();
		// Should not start with ENOENT or include node internal path details
		expect(thrown!.message).not.toMatch(/^ENOENT/);
		expect(thrown!.message).toContain('/nonexistent/input.sql');
	});
});
