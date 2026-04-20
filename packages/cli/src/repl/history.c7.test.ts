/**
 * Regression tests for history.ts — Commit 7 fixes.
 *
 * SEC-5: History file written with mode 0600.
 * SEC-13: Batch queries skip history when persist=false.
 */

import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHistory } from './history.js';

// Mock fs operations (same pattern as history.test.ts)
vi.mock('node:fs', () => ({
	chmodSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ''),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/tmp/test-home'),
}));

describe('CommandHistory — Commit 7 security fixes', () => {
	let history: CommandHistory;

	beforeEach(() => {
		vi.clearAllMocks();
		history = new CommandHistory();
	});

	// -------------------------------------------------------------------------
	// SEC-5: History file written with mode 0600
	// -------------------------------------------------------------------------

	describe('SEC-5: file mode 0600', () => {
		it('writes history file with mode 0600', () => {
			history.add('SELECT 1');
			expect(fs.writeFileSync).toHaveBeenCalledWith(
				expect.stringContaining('.dbsp_history'),
				expect.any(String),
				expect.objectContaining({ mode: 0o600 }),
			);
		});

		it('calls chmodSync on load when file exists', () => {
			vi.mocked(fs.existsSync).mockReturnValueOnce(true);
			// Also return content for readFileSync on the second call (chmodSync path)
			vi.mocked(fs.readFileSync).mockReturnValueOnce('old-command\n');
			const h = new CommandHistory();
			// chmodSync should have been called during load
			expect(fs.chmodSync).toHaveBeenCalledWith(
				expect.stringContaining('.dbsp_history'),
				0o600,
			);
			expect(h.length).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// SEC-13: Batch queries skip history when persist=false
	// -------------------------------------------------------------------------

	describe('SEC-13: persist=false skips disk write', () => {
		it('does not call writeFileSync when persist=false', () => {
			history.add('SELECT * FROM users', false);
			expect(fs.writeFileSync).not.toHaveBeenCalled();
		});

		it('still records command in memory when persist=false', () => {
			history.add('SELECT * FROM users', false);
			expect(history.length).toBe(1);
			expect(history.getAll()).toContain('SELECT * FROM users');
		});

		it('calls writeFileSync when persist=true (default)', () => {
			history.add('SELECT 1');
			expect(fs.writeFileSync).toHaveBeenCalled();
		});

		it('persist=false does not affect subsequent persist=true writes', () => {
			history.add('batch-query', false);
			history.add('interactive-query', true);
			// writeFileSync called once (for interactive-query only)
			expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
		});
	});
});
