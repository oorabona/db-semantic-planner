/**
 * DX-030 Block 5: Command History Tests
 */

import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandHistory } from './history.js';

// Mock fs operations
vi.mock('node:fs', () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ''),
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	chmodSync: vi.fn(),
}));

vi.mock('node:os', () => ({
	homedir: vi.fn(() => '/tmp/test-home'),
}));

describe('CommandHistory', () => {
	let history: CommandHistory;

	beforeEach(() => {
		vi.clearAllMocks();
		// Create fresh instance for each test
		history = new CommandHistory();
	});

	describe('add()', () => {
		it('should add a command to history', () => {
			history.add('select * from users');
			expect(history.length).toBe(1);
			expect(history.getAll()).toContain('select * from users');
		});

		it('should trim whitespace from commands', () => {
			history.add('  select * from users  ');
			expect(history.getAll()).toContain('select * from users');
		});

		it('should not add empty commands', () => {
			history.add('');
			history.add('   ');
			expect(history.length).toBe(0);
		});

		it('should not add duplicate consecutive commands', () => {
			history.add('users');
			history.add('users');
			history.add('users');
			expect(history.length).toBe(1);
		});

		it('should add same command if not consecutive', () => {
			history.add('users');
			history.add('posts');
			history.add('users');
			expect(history.length).toBe(3);
		});
	});

	describe('previous() / next() navigation', () => {
		beforeEach(() => {
			history.add('command1');
			history.add('command2');
			history.add('command3');
		});

		it('should return previous command on previous()', () => {
			const prev = history.previous('current');
			expect(prev).toBe('command3');
		});

		it('should navigate backwards through history', () => {
			expect(history.previous('current')).toBe('command3');
			expect(history.previous('current')).toBe('command2');
			expect(history.previous('current')).toBe('command1');
		});

		it('should stay at oldest command when at start', () => {
			history.previous('current');
			history.previous('current');
			history.previous('current');
			expect(history.previous('current')).toBe('command1');
		});

		it('should return to newer commands with next()', () => {
			history.previous('current');
			history.previous('current');
			expect(history.next()).toBe('command3');
		});

		it('should return saved input when navigating past newest', () => {
			history.previous('my input');
			expect(history.next()).toBe('my input');
		});

		it('should save current input when starting navigation', () => {
			const result = history.previous('my current input');
			expect(result).toBe('command3');
			// Navigate back to current
			expect(history.next()).toBe('my current input');
		});
	});

	describe('resetIndex()', () => {
		it('should reset navigation state', () => {
			history.add('cmd1');
			history.add('cmd2');
			history.previous('input');
			history.resetIndex();
			// After reset, previous should start fresh
			expect(history.previous('new input')).toBe('cmd2');
		});
	});

	describe('search()', () => {
		beforeEach(() => {
			history.add('users where active = true');
			history.add('posts limit 10');
			history.add('users include posts');
		});

		it('should find commands containing query', () => {
			const results = history.search('users');
			expect(results.length).toBe(2);
		});

		it('should be case-insensitive', () => {
			const results = history.search('USERS');
			expect(results.length).toBe(2);
		});

		it('should return recent history when query is empty', () => {
			const results = history.search('');
			expect(results.length).toBe(3);
		});
	});

	describe('getRecent()', () => {
		it('should return last N commands', () => {
			history.add('cmd1');
			history.add('cmd2');
			history.add('cmd3');
			history.add('cmd4');
			history.add('cmd5');

			const recent = history.getRecent(3);
			expect(recent).toEqual(['cmd3', 'cmd4', 'cmd5']);
		});

		it('should return all if fewer than N commands', () => {
			history.add('cmd1');
			history.add('cmd2');

			const recent = history.getRecent(10);
			expect(recent).toEqual(['cmd1', 'cmd2']);
		});
	});

	describe('clear()', () => {
		it('should clear all history', () => {
			history.add('cmd1');
			history.add('cmd2');
			history.clear();
			expect(history.length).toBe(0);
		});
	});

	describe('persistence', () => {
		it('should attempt to save on add()', () => {
			history.add('test command');
			expect(fs.writeFileSync).toHaveBeenCalled();
		});

		it('calls chmodSync after writeFileSync on save (L-3)', () => {
			// chmodSync must be called after each write so a pre-existing file with
			// broad permissions (e.g., 0644 created by another tool) is tightened to
			// 0o600 on the same write operation, not only on next REPL startup.
			history.add('secure command');
			expect(fs.chmodSync).toHaveBeenCalled();
		});

		it('should load from file if exists', () => {
			vi.mocked(fs.existsSync).mockReturnValueOnce(true);
			vi.mocked(fs.readFileSync).mockReturnValueOnce('cmd1\ncmd2\ncmd3');

			const loadedHistory = new CommandHistory();
			expect(loadedHistory.length).toBe(3);
		});

		it('should handle missing file gracefully', () => {
			vi.mocked(fs.existsSync).mockReturnValueOnce(false);
			const loadedHistory = new CommandHistory();
			expect(loadedHistory.length).toBe(0);
		});

		it('should handle read errors gracefully', () => {
			vi.mocked(fs.existsSync).mockReturnValueOnce(true);
			vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
				throw new Error('Read error');
			});

			const loadedHistory = new CommandHistory();
			expect(loadedHistory.length).toBe(0);
		});
	});
});
