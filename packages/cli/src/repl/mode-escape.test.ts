/**
 * CLI-020: Mode Escape Tests
 */

import { describe, expect, it } from 'vitest';
import { getModeWarning, parseInputMode } from './mode-escape.js';

describe('parseInputMode', () => {
	describe('natural mode (default)', () => {
		it('should treat plain input as natural query', () => {
			const result = parseInputMode('users where active = true', 'natural');

			expect(result.content).toBe('users where active = true');
			expect(result.isRawSql).toBe(false);
			expect(result.escaped).toBe(false);
		});

		it('should escape to raw SQL with ! prefix', () => {
			const result = parseInputMode('!SELECT * FROM users', 'natural');

			expect(result.content).toBe('SELECT * FROM users');
			expect(result.isRawSql).toBe(true);
			expect(result.escaped).toBe(true);
		});

		it('should handle ! with whitespace after', () => {
			const result = parseInputMode('!  SELECT * FROM users  ', 'natural');

			expect(result.content).toBe('SELECT * FROM users');
			expect(result.isRawSql).toBe(true);
		});

		it('should handle empty content after !', () => {
			const result = parseInputMode('!', 'natural');

			expect(result.content).toBe('');
			expect(result.isRawSql).toBe(true);
			expect(result.escaped).toBe(true);
		});

		it('should not escape if ! is not at start', () => {
			const result = parseInputMode('users where name = "test!"', 'natural');

			expect(result.content).toBe('users where name = "test!"');
			expect(result.isRawSql).toBe(false);
			expect(result.escaped).toBe(false);
		});
	});

	describe('sql mode', () => {
		it('should treat plain input as raw SQL', () => {
			const result = parseInputMode('SELECT * FROM users', 'sql');

			expect(result.content).toBe('SELECT * FROM users');
			expect(result.isRawSql).toBe(true);
			expect(result.escaped).toBe(false);
		});

		it('should escape to natural query with ! prefix', () => {
			const result = parseInputMode('!users where active = true', 'sql');

			expect(result.content).toBe('users where active = true');
			expect(result.isRawSql).toBe(false);
			expect(result.escaped).toBe(true);
		});

		it('should handle ! with complex natural query', () => {
			const result = parseInputMode(
				'!posts include author where published = true limit 10',
				'sql',
			);

			expect(result.content).toBe(
				'posts include author where published = true limit 10',
			);
			expect(result.isRawSql).toBe(false);
			expect(result.escaped).toBe(true);
		});

		it('should handle plain SQL with special characters', () => {
			const result = parseInputMode(
				"SELECT * FROM users WHERE name LIKE '%test%'",
				'sql',
			);

			expect(result.content).toBe(
				"SELECT * FROM users WHERE name LIKE '%test%'",
			);
			expect(result.isRawSql).toBe(true);
			expect(result.escaped).toBe(false);
		});
	});

	describe('edge cases', () => {
		it('should trim whitespace from input', () => {
			const result = parseInputMode('  users  ', 'natural');

			expect(result.content).toBe('users');
			expect(result.isRawSql).toBe(false);
		});

		it('should handle multiple ! at start (only first matters)', () => {
			const result = parseInputMode('!!SELECT', 'natural');

			expect(result.content).toBe('!SELECT');
			expect(result.isRawSql).toBe(true);
			expect(result.escaped).toBe(true);
		});

		it('should handle empty input', () => {
			const result = parseInputMode('', 'natural');

			expect(result.content).toBe('');
			expect(result.isRawSql).toBe(false);
			expect(result.escaped).toBe(false);
		});

		it('should handle whitespace-only input', () => {
			const result = parseInputMode('   ', 'natural');

			expect(result.content).toBe('');
			expect(result.isRawSql).toBe(false);
		});
	});
});

describe('getModeWarning', () => {
	it('should return SQL mode message in sql mode without escape', () => {
		expect(getModeWarning('sql', false)).toBe('SQL mode: direct SQL');
	});

	it('should return escape message in natural mode with escape', () => {
		expect(getModeWarning('natural', true)).toBe('Escaped to raw SQL with !');
	});

	it('should return escape message in sql mode with escape', () => {
		expect(getModeWarning('sql', true)).toBe('Escaped to natural query with !');
	});

	it('should return natural mode message in natural mode without escape', () => {
		expect(getModeWarning('natural', false)).toBe('Natural query mode');
	});
});
