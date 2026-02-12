// @ts-nocheck — coverage test: runtime assertions
import { describe, expect, it } from 'vitest';
import {
	parseAssertionFile,
	resolveQueryIndex,
	validateAssertionBlocks,
} from './assertion-parser.js';

/**
 * Coverage test for assertion-parser.ts — targets UNCOVERED branches only.
 * The existing assertion-parser.test.ts covers most standard paths.
 * This file focuses on edge cases:
 *  - Empty match pattern in block header
 *  - Assertion line without colon separator
 *  - params.type with non-array JSON
 *  - params.value pass-through
 *  - db.value.equals JSON parsing success/fallback
 *  - db.output marker value (empty string)
 *  - Unhandled assertion type (default branch)
 *  - Table block: only separator rows (no header/data)
 *  - parseBlockHeader error fallback when parsed.error is null but no block
 *  - intent.* type parsing branches
 *  - resolveQueryIndex with neither queryIndex nor queryMatch
 */

describe('assertion-parser coverage', () => {
	describe('block header edge cases', () => {
		it('handles --- with no header text at all', () => {
			const content = `---\noutput.contains: test\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			// Empty string is invalid block header
			expect(result.errors[0]!.message).toContain('Invalid block header');
		});

		it('handles --- match: with only trailing spaces (no content after trim)', () => {
			// After line.trim(), "--- match:   " becomes "--- match:", regex won't match .+
			const content = `--- match:   \noutput.contains: test\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			// Falls through to "Invalid block header" since regex requires at least one char
			expect(result.errors[0]!.message).toContain('Invalid block header');
		});

		it('handles --- query: without number', () => {
			const content = `--- query: abc\noutput.contains: test\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('Invalid block header');
		});

		it('handles block header with extra text after query number', () => {
			const content = `--- query: 0 extra stuff\noutput.contains: test\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe('assertion line syntax edge cases', () => {
		it('reports error for line without colon separator', () => {
			const content = `--- query: 0\nno-colon-here\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('Invalid assertion syntax');
		});
	});

	describe('params.type parsing', () => {
		it('parses valid JSON array for params.type', () => {
			const content = `--- query: 0\nparams.type: ["string", "number"]\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toEqual([
				'string',
				'number',
			]);
		});

		it('reports error for non-array JSON in params.type', () => {
			const content = `--- query: 0\nparams.type: {"key": "val"}\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('expected JSON array');
		});

		it('reports error for invalid JSON in params.type', () => {
			const content = `--- query: 0\nparams.type: not-json\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('Invalid JSON');
		});
	});

	describe('params.value parsing', () => {
		it('passes through string value as-is', () => {
			const content = `--- query: 0\nparams.value: some_value\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe('some_value');
		});
	});

	describe('db.value.equals parsing', () => {
		it('parses valid JSON', () => {
			const content = `--- query: 0\ndb.value.equals: {"row": 0, "column": "name", "value": "Alice"}\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toEqual({
				row: 0,
				column: 'name',
				value: 'Alice',
			});
		});

		it('falls back to string when JSON parsing fails', () => {
			const content = `--- query: 0\ndb.value.equals: not-valid-json\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe('not-valid-json');
		});
	});

	describe('db.output marker parsing', () => {
		it('returns empty string marker for db.output (table follows)', () => {
			const content = `--- query: 0\ndb.output:\n| id |\n| 1 |\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			// The empty marker is replaced by parsed table data
			expect(result.blocks[0]!.assertions[0]!.type).toBe('db.output');
			expect(result.blocks[0]!.assertions[0]!.value).toEqual({
				columns: ['id'],
				rows: [['1']],
			});
		});
	});

	describe('boolean assertion types', () => {
		it('parses db.success as boolean', () => {
			const content = `--- query: 0\ndb.success: true\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(true);
		});

		it('parses intent.hasWhere as boolean', () => {
			const content = `--- query: 0\nintent.hasWhere: true\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(true);
		});

		it('parses intent.hasGroupBy as boolean', () => {
			const content = `--- query: 0\nintent.hasGroupBy: false\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(false);
		});

		it('parses intent.hasOrderBy as boolean', () => {
			const content = `--- query: 0\nintent.hasOrderBy: true\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(true);
		});

		it('reports error for invalid boolean in intent.hasWhere', () => {
			const content = `--- query: 0\nintent.hasWhere: yes\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('Invalid boolean');
		});
	});

	describe('numeric assertion types', () => {
		it('parses db.rows.equals as number', () => {
			const content = `--- query: 0\ndb.rows.equals: 5\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(5);
		});

		it('parses db.rows.min as number', () => {
			const content = `--- query: 0\ndb.rows.min: 1\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(1);
		});

		it('parses db.rows.max as number', () => {
			const content = `--- query: 0\ndb.rows.max: 100\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe(100);
		});

		it('reports error for negative number', () => {
			const content = `--- query: 0\ndb.rows.equals: -1\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('Invalid number');
		});
	});

	describe('string assertion types', () => {
		it('parses sql.table as string', () => {
			const content = `--- query: 0\nsql.table: users\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.value).toBe('users');
		});

		it('parses sql.column as string', () => {
			const content = `--- query: 0\nsql.column: createdAt\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('parses sql.join as string', () => {
			const content = `--- query: 0\nsql.join: users\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('parses db.column.exists as string', () => {
			const content = `--- query: 0\ndb.column.exists: name\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('parses db.output.contains as string', () => {
			const content = `--- query: 0\ndb.output.contains: Alice\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.type).toBe('db.output.contains');
		});

		it('parses intent.type as string', () => {
			const content = `--- query: 0\nintent.type: query\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('parses intent.table as string', () => {
			const content = `--- query: 0\nintent.table: users\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('parses intent.with as string', () => {
			const content = `--- query: 0\nintent.with: comments\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe('table block edge cases', () => {
		it('reports error when table has only separator rows', () => {
			const content = `--- query: 0\ndb.output:\n|---|---|\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('only separator rows');
		});

		it('handles table block terminated by non-pipe line', () => {
			const content = `--- query: 0\ndb.output:\n| id |\n| 1  |\nsuccess: true\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions).toHaveLength(2);
			expect(result.blocks[0]!.assertions[0]!.type).toBe('db.output');
			expect(result.blocks[0]!.assertions[1]!.type).toBe('success');
		});

		it('handles table block terminated by block header', () => {
			const content = `--- query: 0\ndb.output:\n| id |\n| 1  |\n--- query: 1\nsuccess: true\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(2);
		});

		it('handles blank lines within table block', () => {
			const content = `--- query: 0\ndb.output:\n| id |\n\n| 1  |\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['id'],
				rows: [['1']],
			});
		});

		it('handles escaped pipes in table cells', () => {
			const content = `--- query: 0\ndb.output:\n| col |\n| a\\|b |\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['col'],
				rows: [['a|b']],
			});
		});
	});

	describe('params.equals non-array JSON', () => {
		it('reports error for non-array JSON in params.equals', () => {
			const content = `--- query: 0\nparams.equals: "not an array"\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('expected JSON array');
		});

		it('reports error for object JSON in params.equals', () => {
			const content = `--- query: 0\nparams.equals: {"key": 1}\n`;
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]!.message).toContain('expected JSON array');
		});
	});

	describe('resolveQueryIndex edge cases', () => {
		it('returns -1 when neither queryIndex nor queryMatch is set', () => {
			const block = { startLine: 1, assertions: [] };
			expect(resolveQueryIndex(block, ['a', 'b'])).toBe(-1);
		});

		it('returns queryIndex when set to 0', () => {
			const block = { queryIndex: 0, startLine: 1, assertions: [] };
			expect(resolveQueryIndex(block, ['a'])).toBe(0);
		});
	});

	describe('validateAssertionBlocks edge cases', () => {
		it('validates negative query index', () => {
			const blocks = [
				{
					queryIndex: -1,
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, ['a', 'b', 'c']);
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]!.message).toContain('out of bounds');
		});

		it('accepts valid match with single occurrence', () => {
			const blocks = [
				{
					queryMatch: 'users',
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, [
				'posts',
				'users',
				'comments',
			]);
			expect(errors).toHaveLength(0);
		});
	});

	describe('multiple blocks and assertions in one file', () => {
		it('parses file with mixed assertion types across blocks', () => {
			const content = `--- query: 0
sql.table: users
sql.column: name
params.length: 1
success: true

--- query: 1
intent.type: query
intent.table: posts
intent.hasWhere: true

--- match: comments
db.rows.equals: 5
db.column.exists: id
`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(3);
			expect(result.blocks[0]!.assertions).toHaveLength(4);
			expect(result.blocks[1]!.assertions).toHaveLength(3);
			expect(result.blocks[2]!.assertions).toHaveLength(2);
		});
	});

	describe('regex validation in sql.matches', () => {
		it('passes valid regex for sql.matches', () => {
			const content = `--- query: 0\nsql.matches: SELECT.*FROM\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});

		it('passes valid regex for output.matches', () => {
			const content = `--- query: 0\noutput.matches: \\d+\n`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
		});
	});

	describe('last block finalization', () => {
		it('finalizes the last block when file does not end with newline', () => {
			const content = `--- query: 0\nsuccess: true`;
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]!.assertions).toHaveLength(1);
		});
	});
});
