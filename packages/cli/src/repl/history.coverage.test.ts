// @ts-nocheck — coverage test
/**
 * Coverage tests for history.ts — targets uncovered branches.
 *
 * Branches covered:
 * - branch 4[0]: history.length > MAX_HISTORY_SIZE (trim)
 * - branch 6[0]: previous() on empty history
 * - branch 10[0]+10[1]: reverseSearch() both branches
 * - branch 12[0]+12[1]: getHistory() singleton
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ''),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/tmp/test-cov-home'),
}));

describe('CommandHistory coverage', () => {
	let CommandHistory: typeof import('./history.js').CommandHistory;

	beforeEach(async () => {
		vi.clearAllMocks();
		vi.resetModules();
		const mod = await import('./history.js');
		CommandHistory = mod.CommandHistory;
	});

	it('should trim history when exceeding MAX_HISTORY_SIZE', () => {
		const history = new CommandHistory();

		// Add > 1000 entries to trigger trim (MAX_HISTORY_SIZE = 1000)
		for (let i = 0; i < 1002; i++) {
			history.add(`command-${i}`);
		}

		// Should be trimmed to 1000
		expect(history.length).toBe(1000);
		// First two entries should have been trimmed
		expect(history.getAll()[0]).toBe('command-2');
	});

	it('should return undefined from previous() on empty history', () => {
		const history = new CommandHistory();
		const result = history.previous('current');
		expect(result).toBeUndefined();
	});

	it('should return matches from reverseSearch()', () => {
		const history = new CommandHistory();
		history.add('select * from users');
		history.add('insert into posts');
		history.add('select * from orders');

		const results = history.reverseSearch('select');
		expect(results).toHaveLength(2);
		// Most recent first
		expect(results[0]).toBe('select * from orders');
		expect(results[1]).toBe('select * from users');
	});

	it('should return empty array from reverseSearch() with empty query', () => {
		const history = new CommandHistory();
		history.add('select * from users');
		const results = history.reverseSearch('');
		expect(results).toEqual([]);
	});

	it('should return singleton from getHistory()', async () => {
		vi.resetModules();
		const mod = await import('./history.js');
		const a = mod.getHistory();
		const b = mod.getHistory();
		expect(a).toBe(b);
	});
});
