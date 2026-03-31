import { describe, expect, it } from 'vitest';
import type { AssertionBlock } from '../assertion-parser.js';
import {
	parseAssertionFile,
	requiresDatabase,
	resolveQueryIndex,
	validateAssertionBlocks,
} from '../assertion-parser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBlock(overrides: Partial<AssertionBlock> = {}): AssertionBlock {
	return {
		queryIndex: 0,
		startLine: 1,
		assertions: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// parseAssertionFile — basic structure
// ---------------------------------------------------------------------------

describe('parseAssertionFile', () => {
	describe('empty / whitespace / comments', () => {
		it('should return empty blocks and no errors for empty string', () => {
			const result = parseAssertionFile('');
			expect(result.blocks).toEqual([]);
			expect(result.errors).toEqual([]);
		});

		it('should skip lines that are only whitespace', () => {
			const result = parseAssertionFile('   \n\t\n   ');
			expect(result.blocks).toEqual([]);
			expect(result.errors).toEqual([]);
		});

		it('should skip comment lines starting with #', () => {
			const result = parseAssertionFile('# this is a comment\n# another comment');
			expect(result.blocks).toEqual([]);
			expect(result.errors).toEqual([]);
		});

		it('should skip inline comments mixed with blank lines', () => {
			const content = '# header\n\n# another comment\n\n';
			const result = parseAssertionFile(content);
			expect(result.blocks).toEqual([]);
			expect(result.errors).toEqual([]);
		});
	});

	describe('block headers — query: N', () => {
		it('should parse a query-indexed block', () => {
			const content = `--- query: 0\nsql.equals: SELECT 1`;
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]?.queryIndex).toBe(0);
			expect(result.blocks[0]?.assertions).toHaveLength(1);
		});

		it('should parse multiple query blocks', () => {
			const content = `--- query: 0\nsuccess: true\n--- query: 1\nsuccess: false`;
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			expect(result.blocks).toHaveLength(2);
			expect(result.blocks[0]?.queryIndex).toBe(0);
			expect(result.blocks[1]?.queryIndex).toBe(1);
		});

		it('should parse query index > 1', () => {
			const result = parseAssertionFile('--- query: 5\nsuccess: true');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.queryIndex).toBe(5);
		});

		it('should track the start line for a block', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: true');
			expect(result.blocks[0]?.startLine).toBe(1);
		});
	});

	describe('block headers — match: text', () => {
		it('should parse a match-text block', () => {
			const content = `--- match: SELECT * FROM users\nsuccess: true`;
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			expect(result.blocks).toHaveLength(1);
			expect(result.blocks[0]?.queryMatch).toBe('SELECT * FROM users');
		});

		it('should error on match header with no text', () => {
			// '--- match:' with no text after colon — regex /^match:\s*(.+)$/ requires >=1 char
			// falls through to "Invalid block header"
			const result = parseAssertionFile('--- match:');
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors[0]?.message).toMatch(/Invalid block header/);
		});
	});

	describe('block headers — invalid', () => {
		it('should error on unrecognized block header', () => {
			// After a header error, currentBlock is null, so 'success: true' also
			// triggers "assertion outside any block" — at least 1 error, first is header error
			const result = parseAssertionFile('--- unknown: something\nsuccess: true');
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors[0]?.message).toMatch(/Invalid block header/);
		});

		it('should error on --- with no content', () => {
			// After a header error, currentBlock is null, so 'success: true' also
			// triggers "assertion outside any block" — at least 1 error, first is header error
			const result = parseAssertionFile('---\nsuccess: true');
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors[0]?.message).toMatch(/Invalid block header/);
		});

		it('should set error line number correctly', () => {
			const result = parseAssertionFile('\n--- invalid: header\nsuccess: true');
			expect(result.errors[0]?.line).toBe(2);
		});

		it('should not create a block after a header parse error', () => {
			const result = parseAssertionFile('--- bad\nsuccess: true');
			expect(result.blocks).toHaveLength(0);
		});
	});

	describe('assertion outside any block', () => {
		it('should error when assertion appears before any block header', () => {
			const result = parseAssertionFile('success: true');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/outside of any block/);
		});
	});

	describe('assertion parsing', () => {
		it('should error on assertion line with no colon separator', () => {
			const result = parseAssertionFile('--- query: 0\nno_colon_here');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid assertion syntax/);
		});

		it('should error on unknown assertion type', () => {
			const result = parseAssertionFile('--- query: 0\nunknown.type: value');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Unknown assertion type/);
		});

		it('should parse success: true as boolean true', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: true');
			expect(result.errors).toEqual([]);
			const assertion = result.blocks[0]?.assertions[0];
			expect(assertion?.type).toBe('success');
			expect(assertion?.value).toBe(true);
		});

		it('should parse success: false as boolean false', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: false');
			const assertion = result.blocks[0]?.assertions[0];
			expect(assertion?.value).toBe(false);
		});

		it('should error on non-boolean value for success', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: yes');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid boolean value/);
		});

		it('should parse params.length: 3 as number 3', () => {
			const result = parseAssertionFile('--- query: 0\nparams.length: 3');
			const assertion = result.blocks[0]?.assertions[0];
			expect(assertion?.value).toBe(3);
		});

		it('should error on negative number for params.length', () => {
			const result = parseAssertionFile('--- query: 0\nparams.length: -1');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid number/);
		});

		it('should error on non-numeric value for params.length', () => {
			const result = parseAssertionFile('--- query: 0\nparams.length: abc');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid number/);
		});

		it('should parse params.equals with JSON array', () => {
			const result = parseAssertionFile('--- query: 0\nparams.equals: [1, "foo"]');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toEqual([1, 'foo']);
		});

		it('should error when params.equals value is not a JSON array (object)', () => {
			const result = parseAssertionFile('--- query: 0\nparams.equals: {"a":1}');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/expected JSON array/);
		});

		it('should error when params.equals value is invalid JSON', () => {
			const result = parseAssertionFile('--- query: 0\nparams.equals: not json');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid JSON/);
		});

		it('should error when params.type value is not a JSON array', () => {
			const result = parseAssertionFile('--- query: 0\nparams.type: "string"');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/expected JSON array/);
		});

		it('should error when params.type value is invalid JSON', () => {
			const result = parseAssertionFile('--- query: 0\nparams.type: bad json');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid JSON/);
		});

		it('should parse params.value as raw string', () => {
			const result = parseAssertionFile('--- query: 0\nparams.value: 0:hello');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe('0:hello');
		});

		it('should parse db.value.equals as parsed JSON when valid', () => {
			const result = parseAssertionFile('--- query: 0\ndb.value.equals: 42');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe(42);
		});

		it('should parse db.value.equals as string when invalid JSON', () => {
			const result = parseAssertionFile('--- query: 0\ndb.value.equals: some text');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe('some text');
		});

		it('should error on invalid regex for sql.matches', () => {
			const result = parseAssertionFile('--- query: 0\nsql.matches: [invalid(');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid regex pattern/);
		});

		it('should error on invalid regex for output.matches', () => {
			const result = parseAssertionFile('--- query: 0\noutput.matches: [invalid(');
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/Invalid regex pattern/);
		});

		it('should parse sql.equals as string value', () => {
			const result = parseAssertionFile('--- query: 0\nsql.equals: SELECT 1');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe('SELECT 1');
		});

		it('should parse intent.type as string value', () => {
			const result = parseAssertionFile('--- query: 0\nintent.type: select');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe('select');
		});

		it('should parse db.rows.equals: 0 as number zero', () => {
			const result = parseAssertionFile('--- query: 0\ndb.rows.equals: 0');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe(0);
		});

		it('should parse boolean assertions for all intent.has* types', () => {
			for (const type of ['intent.hasWhere', 'intent.hasGroupBy', 'intent.hasOrderBy'] as const) {
				const result = parseAssertionFile(`--- query: 0\n${type}: true`);
				expect(result.errors).toEqual([]);
				expect(result.blocks[0]?.assertions[0]?.value).toBe(true);
			}
		});

		it('should parse db.success: false as boolean', () => {
			const result = parseAssertionFile('--- query: 0\ndb.success: false');
			expect(result.errors).toEqual([]);
			expect(result.blocks[0]?.assertions[0]?.value).toBe(false);
		});

		it('should record assertion line number', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: true');
			expect(result.blocks[0]?.assertions[0]?.line).toBe(2);
		});
	});

	describe('db.output table block', () => {
		it('should parse a db.output block with header and data rows', () => {
			const content = ['--- query: 0', 'db.output:', '| id | name |', '|----|----- |', '| 1  | Alice |'].join('\n');
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			const assertion = result.blocks[0]?.assertions[0];
			expect(assertion?.type).toBe('db.output');
			const tableData = assertion?.value as { columns: string[]; rows: string[][] };
			expect(tableData.columns).toEqual(['id', 'name']);
			expect(tableData.rows).toHaveLength(1);
			expect(tableData.rows[0]).toEqual(['1', 'Alice']);
		});

		it('should error when db.output has no following pipe rows', () => {
			// The db.output error is pushed, then the parser resumes inside the block
			// and tries to parse 'next assertion: value' — which fails with "Unknown assertion type"
			const content = '--- query: 0\ndb.output:\nnext assertion: value';
			const result = parseAssertionFile(content);
			expect(result.errors.length).toBeGreaterThanOrEqual(1);
			expect(result.errors[0]?.message).toMatch(/expected table rows/);
		});

		it('should error when db.output table has only separator rows', () => {
			const content = '--- query: 0\ndb.output:\n|---|----|';
			const result = parseAssertionFile(content);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]?.message).toMatch(/only separator rows/);
		});

		it('should stop collecting table rows at a non-pipe line', () => {
			const content = ['--- query: 0', 'db.output:', '| id |', '| 1  |', '--- query: 1', 'success: true'].join('\n');
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			expect(result.blocks).toHaveLength(2);
		});

		it('should skip blank lines within a table block', () => {
			const content = ['--- query: 0', 'db.output:', '| id |', '', '| 1  |'].join('\n');
			const result = parseAssertionFile(content);
			expect(result.errors).toEqual([]);
			const tableData = result.blocks[0]?.assertions[0]?.value as { columns: string[]; rows: string[][] };
			expect(tableData.rows).toHaveLength(1);
		});
	});

	describe('last block without trailing separator', () => {
		it('should include the last block even without a trailing ---', () => {
			const result = parseAssertionFile('--- query: 0\nsuccess: true\n--- query: 1\nparams.length: 0');
			expect(result.blocks).toHaveLength(2);
		});
	});
});

// ---------------------------------------------------------------------------
// requiresDatabase
// ---------------------------------------------------------------------------

describe('requiresDatabase', () => {
	it('should return true for db.success', () => {
		expect(requiresDatabase('db.success')).toBe(true);
	});

	it('should return true for db.rows.equals', () => {
		expect(requiresDatabase('db.rows.equals')).toBe(true);
	});

	it('should return true for db.output', () => {
		expect(requiresDatabase('db.output')).toBe(true);
	});

	it('should return false for sql.equals', () => {
		expect(requiresDatabase('sql.equals')).toBe(false);
	});

	it('should return false for success', () => {
		expect(requiresDatabase('success')).toBe(false);
	});

	it('should return false for intent.type', () => {
		expect(requiresDatabase('intent.type')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// validateAssertionBlocks
// ---------------------------------------------------------------------------

describe('validateAssertionBlocks', () => {
	it('should return no errors when query index is in range', () => {
		const block = makeBlock({ queryIndex: 0, assertions: [{ type: 'success', value: true, line: 1 }] });
		const errors = validateAssertionBlocks([block], 2, ['SELECT 1', 'SELECT 2']);
		expect(errors).toEqual([]);
	});

	it('should error when query index is out of bounds (too high)', () => {
		const block = makeBlock({ queryIndex: 5, assertions: [{ type: 'success', value: true, line: 1 }] });
		const errors = validateAssertionBlocks([block], 2, ['SELECT 1', 'SELECT 2']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/out of bounds/);
	});

	it('should error when query index is negative', () => {
		const block = makeBlock({ queryIndex: -1, assertions: [{ type: 'success', value: true, line: 1 }] });
		const errors = validateAssertionBlocks([block], 2, ['SELECT 1', 'SELECT 2']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/out of bounds/);
	});

	it('should error when match text does not match any query', () => {
		const block = makeBlock({
			queryIndex: undefined,
			queryMatch: 'SELECT nonexistent',
			startLine: 5,
			assertions: [{ type: 'success', value: true, line: 6 }],
		});
		const errors = validateAssertionBlocks([block], 1, ['SELECT 1']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/No query matches/);
	});

	it('should error when match text is ambiguous (matches multiple queries)', () => {
		const block = makeBlock({
			queryIndex: undefined,
			queryMatch: 'SELECT 1',
			startLine: 1,
			assertions: [{ type: 'success', value: true, line: 2 }],
		});
		const errors = validateAssertionBlocks([block], 2, ['SELECT 1', 'SELECT 1']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/Ambiguous match/);
	});

	it('should error when block has no assertions', () => {
		const block = makeBlock({ queryIndex: 0, assertions: [] });
		const errors = validateAssertionBlocks([block], 1, ['SELECT 1']);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe('Block has no assertions');
	});

	it('should match query with leading/trailing whitespace (trimmed)', () => {
		const block = makeBlock({
			queryIndex: undefined,
			queryMatch: 'SELECT 1',
			assertions: [{ type: 'success', value: true, line: 2 }],
		});
		const errors = validateAssertionBlocks([block], 1, ['  SELECT 1  ']);
		expect(errors).toEqual([]);
	});

	it('should return no errors for empty blocks array', () => {
		const errors = validateAssertionBlocks([], 5, ['q1', 'q2']);
		expect(errors).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveQueryIndex
// ---------------------------------------------------------------------------

describe('resolveQueryIndex', () => {
	it('should return queryIndex when set', () => {
		const block = makeBlock({ queryIndex: 2 });
		expect(resolveQueryIndex(block, ['a', 'b', 'c'])).toBe(2);
	});

	it('should return -1 when queryIndex is undefined and queryMatch is undefined', () => {
		const block = makeBlock({ queryIndex: undefined, queryMatch: undefined });
		expect(resolveQueryIndex(block, ['a', 'b'])).toBe(-1);
	});

	it('should find matching query by queryMatch text', () => {
		const block = makeBlock({ queryIndex: undefined, queryMatch: 'SELECT 1' });
		expect(resolveQueryIndex(block, ['SELECT 1', 'SELECT 2'])).toBe(0);
	});

	it('should return -1 when queryMatch does not match any query', () => {
		const block = makeBlock({ queryIndex: undefined, queryMatch: 'SELECT 99' });
		expect(resolveQueryIndex(block, ['SELECT 1'])).toBe(-1);
	});

	it('should match using trimmed comparison', () => {
		const block = makeBlock({ queryIndex: undefined, queryMatch: 'SELECT 1' });
		expect(resolveQueryIndex(block, ['  SELECT 1  '])).toBe(0);
	});

	it('should return index of first match when multiple queries match', () => {
		const block = makeBlock({ queryIndex: undefined, queryMatch: 'SELECT 1' });
		// First match is at index 0
		expect(resolveQueryIndex(block, ['SELECT 1', 'SELECT 1'])).toBe(0);
	});
});
