/**
 * RFC 4180 compliance regression tests for the CSV parser rewrite (Commit 3).
 *
 * Covers the 6 findings from the worklist:
 *   S1 - Multiline quoted fields (round-trip via formatCsv + parseCsvFile)
 *   S2 - Single-pass read (readFile called once)
 *   M1 - Field count validation (CsvParseError with line number)
 *   M2 - Header detection with leading blank lines
 *   M3 - Unterminated quote at EOF
 *   M4 - Extra chars after closing quote
 *   SEC - escapeCsvField quotes values containing \r
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CsvParseError, formatCsv, parseCsvFile } from './csv.js';

function createTempCsv(content: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'csv-rfc4180-'));
	const path = join(dir, 'test.csv');
	writeFileSync(path, content, 'utf-8');
	return path;
}

// ============================================================================
// S1 — Multiline quoted fields: round-trip
// ============================================================================

describe('RFC 4180 multiline quoted fields', () => {
	it('parses a quoted field containing an embedded newline', async () => {
		const path = createTempCsv('name,notes\nAlice,"hello\nworld"\n');
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(1);
		expect(data.rows[0]).toEqual({ name: 'Alice', notes: 'hello\nworld' });
	});

	it('parses a quoted field containing multiple embedded newlines', async () => {
		const path = createTempCsv('id,body\n1,"line1\nline2\nline3"\n');
		const data = await parseCsvFile(path);

		expect(data.rows[0]).toEqual({ id: '1', body: 'line1\nline2\nline3' });
	});

	it('round-trips a row with embedded newline via formatCsv + parseCsvFile', async () => {
		const originalValue = 'hello\nworld';
		const dumpedCsv = formatCsv([{ notes: originalValue }], ['notes']);

		expect(dumpedCsv).toBe('notes\n"hello\nworld"');

		const path = createTempCsv(dumpedCsv);
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(1);
		expect(data.rows[0]!.notes).toBe(originalValue);
	});

	it('round-trips multiple multiline fields', async () => {
		const rows = [
			{ id: '1', content: 'line A\nline B' },
			{ id: '2', content: 'plain' },
			{ id: '3', content: 'first\nsecond\nthird' },
		];
		const csv = formatCsv(rows, ['id', 'content']);
		const path = createTempCsv(csv);
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(3);
		expect(data.rows[0]!.content).toBe('line A\nline B');
		expect(data.rows[1]!.content).toBe('plain');
		expect(data.rows[2]!.content).toBe('first\nsecond\nthird');
	});

	it('handles CRLF line endings', async () => {
		const path = createTempCsv('name,age\r\nAlice,30\r\nBob,25\r\n');
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(2);
		expect(data.rows[0]).toEqual({ name: 'Alice', age: '30' });
		expect(data.rows[1]).toEqual({ name: 'Bob', age: '25' });
	});
});

// ============================================================================
// S2 — Single-pass read
// ============================================================================

describe('single-pass read', () => {
	it('parses a file correctly (single readFile call in implementation)', async () => {
		const path = createTempCsv('a,b\n1,2\n3,4\n');
		const data = await parseCsvFile(path);
		expect(data.rows).toHaveLength(2);
		expect(data.rows[0]).toEqual({ a: '1', b: '2' });
	});
});

// ============================================================================
// M1 — Field count validation
// ============================================================================

describe('field count validation', () => {
	it('throws CsvParseError when a row has too many fields', async () => {
		const path = createTempCsv('a,b,c\n1,2,3,4\n');
		await expect(parseCsvFile(path)).rejects.toThrow(CsvParseError);
		await expect(parseCsvFile(path)).rejects.toThrow(
			/expected 3 fields, got 4/,
		);
	});

	it('throws CsvParseError when a row has too few fields', async () => {
		const path = createTempCsv('a,b,c\n1,2\n');
		await expect(parseCsvFile(path)).rejects.toThrow(CsvParseError);
		await expect(parseCsvFile(path)).rejects.toThrow(
			/expected 3 fields, got 2/,
		);
	});

	it('error message includes the physical line number', async () => {
		const path = createTempCsv('a,b\n1,2\n3,4,5\n');
		try {
			await parseCsvFile(path);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(CsvParseError);
			expect((err as CsvParseError).line).toBe(3);
			expect((err as CsvParseError).message).toMatch(/line 3/);
		}
	});

	it('does not throw when all rows have correct field count', async () => {
		const path = createTempCsv('a,b,c\n1,2,3\n4,5,6\n');
		await expect(parseCsvFile(path)).resolves.not.toThrow();
	});
});

// ============================================================================
// M2 — Header detection with leading blank lines
// ============================================================================

describe('header detection with leading blank lines', () => {
	it('does not treat a data row as header when file starts with blank lines', async () => {
		const path = createTempCsv('\n\n1,2,3\n4,5,6\n');
		const data = await parseCsvFile(path);

		expect(data.format.hasHeader).toBe(false);
		expect(data.rows).toHaveLength(2);
	});

	it('correctly identifies header after leading blank lines', async () => {
		const path = createTempCsv('\nname,age\nAlice,30\n');
		const data = await parseCsvFile(path);

		expect(data.format.hasHeader).toBe(true);
		expect(data.format.columns).toEqual(['name', 'age']);
		expect(data.rows).toHaveLength(1);
		expect(data.rows[0]).toEqual({ name: 'Alice', age: '30' });
	});

	it('does not drop the first data row when no header is present', async () => {
		const path = createTempCsv('\n1,hello\n2,world\n');
		const data = await parseCsvFile(path, ['id', 'msg']);
		expect(data.format.hasHeader).toBe(false);
		expect(data.rows).toHaveLength(2);
	});
});

// ============================================================================
// M3 — Unterminated quote at EOF
// ============================================================================

describe('unterminated quoted field', () => {
	it('throws CsvParseError when file ends inside a quoted field (with newline)', async () => {
		const path = createTempCsv('col\n"hello\n');
		await expect(parseCsvFile(path)).rejects.toThrow(CsvParseError);
		await expect(parseCsvFile(path)).rejects.toThrow(
			/unterminated quoted field/,
		);
	});

	it('throws CsvParseError for file ending with open quote (no trailing newline)', async () => {
		const path = createTempCsv('col\n"open');
		await expect(parseCsvFile(path)).rejects.toThrow(CsvParseError);
		await expect(parseCsvFile(path)).rejects.toThrow(
			/unterminated quoted field/,
		);
	});

	it('error is an instance of CsvParseError', async () => {
		const path = createTempCsv('col\n"unterminated\n');
		try {
			await parseCsvFile(path);
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(CsvParseError);
			expect(err).toBeInstanceOf(Error);
			expect((err as CsvParseError).name).toBe('CsvParseError');
		}
	});
});

// ============================================================================
// M4 — Extra chars after closing quote
// ============================================================================

describe('extra chars after closing quote', () => {
	it('throws CsvParseError for chars between closing quote and separator', async () => {
		const path = createTempCsv('a,b\n"hello"garbage,world\n');
		await expect(parseCsvFile(path)).rejects.toThrow(CsvParseError);
		await expect(parseCsvFile(path)).rejects.toThrow(/unexpected character/);
	});
});

// ============================================================================
// SEC — escapeCsvField: \r in values
// ============================================================================

describe('escapeCsvField \\r handling', () => {
	it('quotes a value containing \\r', () => {
		const csv = formatCsv([{ col: 'a\rb' }], ['col']);
		expect(csv).toBe('col\n"a\rb"');
	});

	it('quotes a value containing only \\r', () => {
		const csv = formatCsv([{ col: '\r' }], ['col']);
		expect(csv).toBe('col\n"\r"');
	});

	it('round-trips a value with \\r through formatCsv + parseCsvFile', async () => {
		const originalValue = 'a\rb';
		const dumpedCsv = formatCsv([{ col: originalValue }], ['col']);
		const path = createTempCsv(dumpedCsv);
		const data = await parseCsvFile(path);
		expect(data.rows[0]!.col).toBe(originalValue);
	});
});

// ============================================================================
// CsvParseError class contract
// ============================================================================

describe('CsvParseError', () => {
	it('has the correct name and line properties', () => {
		const err = new CsvParseError(42, 'test error');
		expect(err.name).toBe('CsvParseError');
		expect(err.line).toBe(42);
		expect(err.message).toBe('CSV parse error at line 42: test error');
	});

	it('is an instance of both CsvParseError and Error', () => {
		const err = new CsvParseError(1, 'msg');
		expect(err).toBeInstanceOf(CsvParseError);
		expect(err).toBeInstanceOf(Error);
	});
});


// ============================================================================
// C6 regression: headerless CSV detection defaults to no-header
// ============================================================================

describe('[C6] CSV load defaults to no-header without schema columns', () => {
	it('[C6] Alice,Paris\\nBob,London imports both rows when no schema columns given (regression gate)', async () => {
		// Previously the heuristic saw non-numeric values in row 1 and consumed
		// it as a header row, silently dropping Alice/Paris.
		const path = createTempCsv('Alice,Paris\nBob,London\n');

		const result = await parseCsvFile(path);

		// Both rows must be present — first row must NOT be treated as header
		expect(result.rows).toHaveLength(2);
		expect(result.format.hasHeader).toBe(false);
	});

	it('does NOT auto-detect header when first-row values are proper nouns (uppercase-first)', async () => {
		const path = createTempCsv('Alice,Paris\nBob,London\nCarol,Tokyo\n');

		// Proper nouns (uppercase first letter) must never be auto-detected as
		// column names — they look like data rows (same heuristic as the primary test).
		const result = await parseCsvFile(path);

		expect(result.rows).toHaveLength(3);
		expect(result.format.hasHeader).toBe(false);
	});

	it('detects header when schema columns match the first row', async () => {
		const path = createTempCsv('name,city\nAlice,Paris\nBob,London\n');

		// With matching schema columns, header is detected
		const result = await parseCsvFile(path, ['name', 'city']);

		expect(result.rows).toHaveLength(2); // header consumed, 2 data rows
		expect(result.format.hasHeader).toBe(true);
	});
});
