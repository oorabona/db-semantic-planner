/**
 * DEMO-E2E: Assertion Parser Tests
 */

import { describe, expect, it } from 'vitest';
import {
	ASSERTION_TYPES,
	parseAssertionFile,
	requiresDatabase,
	resolveQueryIndex,
	validateAssertionBlocks,
} from './assertion-parser.js';

describe('assertion-parser', () => {
	describe('parseAssertionFile', () => {
		it('parses a simple assertion block with query index', () => {
			const content = `--- query: 0
output.contains: Tables (5)
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]!.queryIndex).toBe(0);
			expect(result.blocks[0]!.assertions).toHaveLength(1);
			expect(result.blocks[0]!.assertions[0]!.type).toBe('output.contains');
			expect(result.blocks[0]!.assertions[0]!.value).toBe('Tables (5)');
		});

		it('parses a block with match pattern', () => {
			const content = `--- match: posts where id = 1
params.equals: [1]
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]!.queryMatch).toBe('posts where id = 1');
			expect(result.blocks[0]!.assertions[0]!.type).toBe('params.equals');
			expect(result.blocks[0]!.assertions[0]!.value).toEqual([1]);
		});

		it('parses multiple assertion blocks', () => {
			const content = `--- query: 0
output.contains: Tables

--- query: 1
sql.contains: SELECT
params.length: 0

--- query: 2
success: true
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(3);
			expect(result.blocks[0]!.queryIndex).toBe(0);
			expect(result.blocks[1]!.queryIndex).toBe(1);
			expect(result.blocks[1]!.assertions).toHaveLength(2);
			expect(result.blocks[2]!.queryIndex).toBe(2);
		});

		it('skips comments and empty lines', () => {
			const content = `# This is a comment
--- query: 0
# Another comment
output.contains: test

`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]!.assertions).toHaveLength(1);
		});

		it('reports error for assertion outside block', () => {
			const content = `output.contains: orphan assertion
--- query: 0
output.contains: valid
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].line).toBe(1);
			expect(result.errors[0].message).toContain('outside of any block');
		});

		it('reports error for invalid block header', () => {
			const content = `--- invalid header
output.contains: test
`;
			const result = parseAssertionFile(content);

			// Two errors: invalid header + orphan assertion (block not started)
			expect(result.errors).toHaveLength(2);
			expect(result.errors[0].line).toBe(1);
			expect(result.errors[0].message).toContain('Invalid block header');
			expect(result.errors[1].line).toBe(2);
			expect(result.errors[1].message).toContain('outside of any block');
		});

		it('reports error for unknown assertion type', () => {
			const content = `--- query: 0
unknown.type: value
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].line).toBe(2);
			expect(result.errors[0].message).toContain('Unknown assertion type');
			expect(result.errors[0].message).toContain('unknown.type');
		});

		it('reports error for invalid boolean value', () => {
			const content = `--- query: 0
success: maybe
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('Invalid boolean');
		});

		it('reports error for invalid params.length value', () => {
			const content = `--- query: 0
params.length: abc
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('Invalid number');
		});

		it('reports error for invalid JSON in params.equals', () => {
			const content = `--- query: 0
params.equals: not json
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('Invalid JSON');
		});

		it('reports error for invalid regex pattern', () => {
			const content = `--- query: 0
sql.matches: [invalid(regex
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].message).toContain('Invalid regex');
		});

		it('includes line numbers in all errors', () => {
			const content = `--- query: 0
valid.output: ok
--- invalid
success: maybe
`;
			const result = parseAssertionFile(content);

			// Should have errors with line numbers
			for (const error of result.errors) {
				expect(error.line).toBeGreaterThan(0);
			}
		});
	});

	describe('all assertion types', () => {
		it.each([
			['output.contains', 'text value', 'text value'],
			['output.equals', 'exact text', 'exact text'],
			['output.matches', '\\d+', '\\d+'],
			['sql.contains', 'SELECT', 'SELECT'],
			['sql.equals', 'SELECT * FROM users', 'SELECT * FROM users'],
			['sql.matches', 'SELECT.*FROM', 'SELECT.*FROM'],
			['params.equals', '[1, "test", true]', [1, 'test', true]],
			['params.length', '3', 3],
			['plan.contains', 'strategy: join', 'strategy: join'],
			['success', 'true', true],
			['success', 'false', false],
			['error.contains', 'not found', 'not found'],
		])('parses %s: %s', (type, input, expected) => {
			const content = `--- query: 0
${type}: ${input}
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.type).toBe(type);
			expect(result.blocks[0]!.assertions[0]!.value).toEqual(expected);
		});
	});

	describe('validateAssertionBlocks', () => {
		it('validates query index bounds', () => {
			const blocks = [
				{
					queryIndex: 10,
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, ['a', 'b', 'c']);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('out of bounds');
			expect(errors[0].message).toContain('0-2');
		});

		it('validates query match exists', () => {
			const blocks = [
				{
					queryMatch: 'nonexistent',
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, [
				'posts',
				'users',
				'comments',
			]);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('No query matches');
		});

		it('detects ambiguous match (ERR-06)', () => {
			const blocks = [
				{
					queryMatch: 'posts',
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, [
				'posts',
				'users',
				'posts',
			]);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('Ambiguous match');
			expect(errors[0].message).toContain('0, 2');
			expect(errors[0].message).toContain('Use query index instead');
		});

		it('warns about empty blocks', () => {
			const blocks = [{ queryIndex: 0, startLine: 1, assertions: [] }];
			const errors = validateAssertionBlocks(blocks, 3, ['a', 'b', 'c']);

			expect(errors).toHaveLength(1);
			expect(errors[0].message).toContain('no assertions');
		});

		it('passes valid blocks', () => {
			const blocks = [
				{
					queryIndex: 0,
					startLine: 1,
					assertions: [{ type: 'success' as const, value: true, line: 2 }],
				},
				{
					queryIndex: 2,
					startLine: 3,
					assertions: [{ type: 'success' as const, value: true, line: 4 }],
				},
			];
			const errors = validateAssertionBlocks(blocks, 3, ['a', 'b', 'c']);

			expect(errors).toHaveLength(0);
		});
	});

	describe('resolveQueryIndex', () => {
		const queries = ['posts', 'users where id = 1', 'comments'];

		it('returns queryIndex directly if set', () => {
			const block = { queryIndex: 1, startLine: 1, assertions: [] };
			expect(resolveQueryIndex(block, queries)).toBe(1);
		});

		it('finds index by match', () => {
			const block = {
				queryMatch: 'users where id = 1',
				startLine: 1,
				assertions: [],
			};
			expect(resolveQueryIndex(block, queries)).toBe(1);
		});

		it('returns -1 if match not found', () => {
			const block = { queryMatch: 'nonexistent', startLine: 1, assertions: [] };
			expect(resolveQueryIndex(block, queries)).toBe(-1);
		});

		it('handles whitespace in match', () => {
			const block = {
				queryMatch: '  users where id = 1  ',
				startLine: 1,
				assertions: [],
			};
			expect(resolveQueryIndex(block, queries)).toBe(1);
		});
	});

	describe('ASSERTION_TYPES constant', () => {
		it('includes all documented assertion types', () => {
			const expected = [
				'output.contains',
				'output.equals',
				'output.matches',
				'sql.contains',
				'sql.equals',
				'sql.matches',
				'params.equals',
				'params.length',
				'plan.contains',
				'success',
				'error.contains',
			];

			for (const type of expected) {
				expect(ASSERTION_TYPES).toContain(type);
			}
		});

		it('includes new typed SQL assertions', () => {
			expect(ASSERTION_TYPES).toContain('sql.table');
			expect(ASSERTION_TYPES).toContain('sql.column');
			expect(ASSERTION_TYPES).toContain('sql.join');
		});

		it('includes new typed params assertions', () => {
			expect(ASSERTION_TYPES).toContain('params.type');
			expect(ASSERTION_TYPES).toContain('params.value');
		});

		it('includes new DB-only assertions', () => {
			expect(ASSERTION_TYPES).toContain('db.rows.equals');
			expect(ASSERTION_TYPES).toContain('db.rows.min');
			expect(ASSERTION_TYPES).toContain('db.rows.max');
			expect(ASSERTION_TYPES).toContain('db.column.exists');
			expect(ASSERTION_TYPES).toContain('db.value.equals');
		});
	});

	describe('requiresDatabase', () => {
		it('returns true for db.* assertions', () => {
			expect(requiresDatabase('db.rows.equals')).toBe(true);
			expect(requiresDatabase('db.rows.min')).toBe(true);
			expect(requiresDatabase('db.rows.max')).toBe(true);
			expect(requiresDatabase('db.column.exists')).toBe(true);
			expect(requiresDatabase('db.value.equals')).toBe(true);
		});

		it('returns false for sql.* assertions', () => {
			expect(requiresDatabase('sql.contains')).toBe(false);
			expect(requiresDatabase('sql.equals')).toBe(false);
			expect(requiresDatabase('sql.matches')).toBe(false);
			expect(requiresDatabase('sql.table')).toBe(false);
			expect(requiresDatabase('sql.column')).toBe(false);
			expect(requiresDatabase('sql.join')).toBe(false);
		});

		it('returns false for other assertions', () => {
			expect(requiresDatabase('output.contains')).toBe(false);
			expect(requiresDatabase('params.equals')).toBe(false);
			expect(requiresDatabase('success')).toBe(false);
			expect(requiresDatabase('error.contains')).toBe(false);
		});
	});

	describe('db.output table block parsing', () => {
		it('parses a table block with header and data rows', () => {
			const content = `--- query: 0
db.output:
| id | name  |
| 1  | Alice |
| 2  | Bob   |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(1);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.type).toBe('db.output');
			expect(assertion.value).toEqual({
				columns: ['id', 'name'],
				rows: [
					['1', 'Alice'],
					['2', 'Bob'],
				],
			});
		});

		it('ignores separator rows', () => {
			const content = `--- query: 0
db.output:
| id | name  |
|----|----- |
| 1  | Alice |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['id', 'name'],
				rows: [['1', 'Alice']],
			});
		});

		it('handles escaped pipes in values', () => {
			const content = `--- query: 0
db.output:
| col |
| foo\\|bar |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['col'],
				rows: [['foo|bar']],
			});
		});

		it('ignores blank lines within table block', () => {
			const content = `--- query: 0
db.output:
| id | name  |

| 1  | Alice |

| 2  | Bob   |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['id', 'name'],
				rows: [
					['1', 'Alice'],
					['2', 'Bob'],
				],
			});
		});

		it('terminates table block at next --- header', () => {
			const content = `--- query: 0
db.output:
| id |
| 1  |
--- query: 1
success: true
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks).toHaveLength(2);
			expect(result.blocks[0]!.assertions[0]!.value).toEqual({
				columns: ['id'],
				rows: [['1']],
			});
			expect(result.blocks[1]!.assertions[0]!.type).toBe('success');
		});

		it('terminates table block at non-pipe assertion line', () => {
			const content = `--- query: 0
db.output:
| id |
| 1  |
success: true
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const block = result.blocks[0]!;
			expect(block.assertions).toHaveLength(2);
			expect(block.assertions[0]!.type).toBe('db.output');
			expect(block.assertions[1]!.type).toBe('success');
		});

		it('reports error when no table rows follow db.output:', () => {
			const content = `--- query: 0
db.output:
success: true
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.message).toContain('expected table rows');
		});

		it('handles header-only table (no data rows)', () => {
			const content = `--- query: 0
db.output:
| id | name |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['id', 'name'],
				rows: [],
			});
		});

		it('trims whitespace from cell values', () => {
			const content = `--- query: 0
db.output:
|  id  |  name  |
|  1   |  Alice Johnson  |
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			const assertion = result.blocks[0]!.assertions[0]!;
			expect(assertion.value).toEqual({
				columns: ['id', 'name'],
				rows: [['1', 'Alice Johnson']],
			});
		});

		it('coexists with db.output.contains (different type)', () => {
			const content = `--- query: 0
db.output.contains: Alice
`;
			const result = parseAssertionFile(content);

			expect(result.errors).toHaveLength(0);
			expect(result.blocks[0]!.assertions[0]!.type).toBe('db.output.contains');
			expect(result.blocks[0]!.assertions[0]!.value).toBe('Alice');
		});
	});
});
