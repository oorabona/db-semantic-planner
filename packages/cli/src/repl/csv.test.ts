/**
 * E16/E16e: CSV parsing and format detection tests
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	formatCsv,
	parseCsvFile,
	parseCsvLine,
	sniffCsvFormat,
} from './csv.js';

// ============================================================================
// parseCsvLine
// ============================================================================

describe('parseCsvLine', () => {
	it('should parse simple comma-separated values', () => {
		expect(parseCsvLine('a,b,c', ',', '"')).toEqual(['a', 'b', 'c']);
	});

	it('should handle quoted fields', () => {
		expect(parseCsvLine('"hello, world",b,c', ',', '"')).toEqual([
			'hello, world',
			'b',
			'c',
		]);
	});

	it('should handle escaped quotes (doubled)', () => {
		expect(parseCsvLine('"he said ""hi""",b', ',', '"')).toEqual([
			'he said "hi"',
			'b',
		]);
	});

	it('should handle tab separator', () => {
		expect(parseCsvLine('a\tb\tc', '\t', '"')).toEqual(['a', 'b', 'c']);
	});

	it('should handle semicolon separator', () => {
		expect(parseCsvLine('a;b;c', ';', '"')).toEqual(['a', 'b', 'c']);
	});

	it('should handle pipe separator', () => {
		expect(parseCsvLine('a|b|c', '|', '"')).toEqual(['a', 'b', 'c']);
	});

	it('should handle empty fields', () => {
		expect(parseCsvLine('a,,c', ',', '"')).toEqual(['a', '', 'c']);
	});

	it('should handle single-quoted fields', () => {
		expect(parseCsvLine("'hello, world',b", ',', "'")).toEqual([
			'hello, world',
			'b',
		]);
	});
});

// ============================================================================
// sniffCsvFormat
// ============================================================================

describe('sniffCsvFormat', () => {
	it('should detect comma separator', () => {
		const lines = ['name,age,city', 'Alice,30,Paris', 'Bob,25,London'];
		const format = sniffCsvFormat(lines);
		expect(format.separator).toBe(',');
		expect(format.hasHeader).toBe(true);
		expect(format.columns).toEqual(['name', 'age', 'city']);
	});

	it('should detect semicolon separator', () => {
		const lines = ['name;age;city', 'Alice;30;Paris', 'Bob;25;London'];
		const format = sniffCsvFormat(lines);
		expect(format.separator).toBe(';');
		expect(format.hasHeader).toBe(true);
	});

	it('should detect tab separator', () => {
		const lines = ['name\tage\tcity', 'Alice\t30\tParis'];
		const format = sniffCsvFormat(lines);
		expect(format.separator).toBe('\t');
		expect(format.hasHeader).toBe(true);
	});

	it('should detect pipe separator', () => {
		const lines = ['name|age|city', 'Alice|30|Paris'];
		const format = sniffCsvFormat(lines);
		expect(format.separator).toBe('|');
	});

	it('should detect no header (all numeric first row)', () => {
		const lines = ['1,30,100', '2,25,200', '3,35,150'];
		const format = sniffCsvFormat(lines);
		expect(format.hasHeader).toBe(false);
		expect(format.columns).toEqual(['col_0', 'col_1', 'col_2']);
	});

	it('should match header against schema columns', () => {
		const lines = ['id,name,email', '1,Alice,alice@test.com'];
		const format = sniffCsvFormat(lines, ['id', 'name', 'email', 'active']);
		expect(format.hasHeader).toBe(true);
		expect(format.columns).toEqual(['id', 'name', 'email']);
	});

	it('should handle empty input', () => {
		const format = sniffCsvFormat([]);
		expect(format.separator).toBe(',');
		expect(format.columns).toEqual([]);
	});

	it('should detect double-quote char', () => {
		const lines = ['"name","age"', '"Alice","30"'];
		const format = sniffCsvFormat(lines);
		expect(format.quote).toBe('"');
	});
});

// ============================================================================
// parseCsvFile
// ============================================================================

describe('parseCsvFile', () => {
	function createTempCsv(content: string): string {
		const dir = mkdtempSync(join(tmpdir(), 'csv-test-'));
		const path = join(dir, 'test.csv');
		writeFileSync(path, content, 'utf-8');
		return path;
	}

	it('should parse a simple CSV file with header', async () => {
		const path = createTempCsv('name,age\nAlice,30\nBob,25\n');
		const data = await parseCsvFile(path);

		expect(data.format.hasHeader).toBe(true);
		expect(data.format.columns).toEqual(['name', 'age']);
		expect(data.rows).toEqual([
			{ name: 'Alice', age: '30' },
			{ name: 'Bob', age: '25' },
		]);
	});

	it('should parse CSV without header using schema columns', async () => {
		const path = createTempCsv('1,30\n2,25\n');
		const data = await parseCsvFile(path, ['id', 'age']);

		// Without matching schema columns, first row looks numeric = no header
		expect(data.format.hasHeader).toBe(false);
		expect(data.rows).toHaveLength(2);
	});

	it('should handle empty file', async () => {
		const path = createTempCsv('');
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(0);
	});

	it('should skip empty lines', async () => {
		const path = createTempCsv('name,age\n\nAlice,30\n\nBob,25\n');
		const data = await parseCsvFile(path);

		expect(data.rows).toHaveLength(2);
	});

	it('should handle quoted values with commas', async () => {
		const path = createTempCsv(
			'name,address\nAlice,"123 Main St, Apt 4"\nBob,"456 Oak Ave"\n',
		);
		const data = await parseCsvFile(path);

		expect(data.rows[0]).toEqual({
			name: 'Alice',
			address: '123 Main St, Apt 4',
		});
	});
});

// ============================================================================
// formatCsv
// ============================================================================

describe('formatCsv', () => {
	it('should format rows with header', () => {
		const rows = [
			{ name: 'Alice', age: 30 },
			{ name: 'Bob', age: 25 },
		];
		const csv = formatCsv(rows, ['name', 'age']);
		expect(csv).toBe('name,age\nAlice,30\nBob,25');
	});

	it('should escape values with commas', () => {
		const rows = [{ name: 'Smith, John', age: 30 }];
		const csv = formatCsv(rows, ['name', 'age']);
		expect(csv).toBe('name,age\n"Smith, John",30');
	});

	it('should escape values with quotes', () => {
		const rows = [{ name: 'He said "hi"', age: 30 }];
		const csv = formatCsv(rows, ['name', 'age']);
		expect(csv).toBe('name,age\n"He said ""hi""",30');
	});

	it('should handle null/undefined as empty string', () => {
		const rows = [{ name: null, age: undefined }];
		const csv = formatCsv(rows, ['name', 'age']);
		expect(csv).toBe('name,age\n,');
	});

	it('should handle objects as JSON', () => {
		const rows = [{ data: { x: 1 } }];
		const csv = formatCsv(rows, ['data']);
		expect(csv).toBe('data\n"{""x"":1}"');
	});

	it('should return empty string for no columns', () => {
		expect(formatCsv([], [])).toBe('');
	});
});
