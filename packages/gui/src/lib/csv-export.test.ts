import { describe, expect, it } from 'vitest';
import { toCsv } from './csv-export.js';

describe('toCsv', () => {
	it('produces header + rows', () => {
		const csv = toCsv(
			['id', 'name'],
			[
				{ id: 1, name: 'Alice' },
				{ id: 2, name: 'Bob' },
			],
		);
		expect(csv).toBe('id,name\n1,Alice\n2,Bob');
	});

	it('handles null and undefined values as empty strings', () => {
		const csv = toCsv(['a', 'b'], [{ a: null, b: undefined }]);
		expect(csv).toBe('a,b\n,');
	});

	it('escapes commas in fields', () => {
		const csv = toCsv(['name'], [{ name: 'Doe, John' }]);
		expect(csv).toBe('name\n"Doe, John"');
	});

	it('escapes double quotes in fields', () => {
		const csv = toCsv(['val'], [{ val: 'say "hello"' }]);
		expect(csv).toBe('val\n"say ""hello"""');
	});

	it('escapes newlines in fields', () => {
		const csv = toCsv(['note'], [{ note: 'line1\nline2' }]);
		expect(csv).toBe('note\n"line1\nline2"');
	});

	it('handles empty rows', () => {
		const csv = toCsv(['id'], []);
		expect(csv).toBe('id');
	});

	it('handles boolean and number values', () => {
		const csv = toCsv(['active', 'count'], [{ active: true, count: 42 }]);
		expect(csv).toBe('active,count\ntrue,42');
	});

	it('handles bigint-like string values', () => {
		const csv = toCsv(['big'], [{ big: '9007199254740993' }]);
		expect(csv).toBe('big\n9007199254740993');
	});
});
