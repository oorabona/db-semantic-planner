/**
 * Cursor streaming tests
 *
 * Tests for cursor statement builders (DECLARE, FETCH, CLOSE).
 */

import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it } from 'vitest';

import { buildFetch, type FetchDirection } from './cursor.js';

describe('buildFetch', () => {
	function deparse(direction: FetchDirection, count?: number): string {
		const ast = buildFetch({
			cursorName: 'test_cursor',
			direction,
			...(count !== undefined && { count }),
		});
		return deparseSync(ast);
	}

	it('generates FETCH NEXT (default)', () => {
		const sql = deparse('next');
		// Deparser outputs: FETCH FORWARD 1 test_cursor
		expect(sql).toBe('FETCH FORWARD 1 test_cursor');
	});

	it('generates FETCH FORWARD with count', () => {
		const sql = deparse('forward', 100);
		expect(sql).toBe('FETCH FORWARD 100 test_cursor');
	});

	it('generates FETCH BACKWARD with count', () => {
		const sql = deparse('backward', 50);
		expect(sql).toBe('FETCH BACKWARD 50 test_cursor');
	});

	it('generates FETCH FIRST (row 1)', () => {
		const sql = deparse('first');
		// FETCH FIRST is deparsed as FETCH ABSOLUTE 1
		expect(sql).toBe('FETCH ABSOLUTE 1 test_cursor');
	});

	it('generates FETCH LAST (last row)', () => {
		const sql = deparse('last');
		// FETCH LAST is deparsed as FETCH ABSOLUTE -1
		expect(sql).toBe('FETCH ABSOLUTE -1 test_cursor');
	});

	it('FIRST and LAST produce different SQL (E02 regression)', () => {
		const firstSql = deparse('first');
		const lastSql = deparse('last');

		expect(firstSql).not.toBe(lastSql);
		// First is ABSOLUTE 1, Last is ABSOLUTE -1
		expect(firstSql).toContain('ABSOLUTE 1');
		expect(lastSql).toContain('ABSOLUTE -1');
	});

	it('generates FETCH ABSOLUTE with position', () => {
		const sql = deparse('absolute', 42);
		expect(sql).toBe('FETCH ABSOLUTE 42 test_cursor');
	});

	it('generates FETCH RELATIVE with offset', () => {
		const sql = deparse('relative', -5);
		expect(sql).toBe('FETCH RELATIVE -5 test_cursor');
	});

	it('generates FETCH FORWARD ALL', () => {
		const sql = deparse('forward_all');
		// pgsql-deparser emits FETCH FORWARD ALL when howMany === 9223372036854776000 (Number, float64 ≈ INT64_MAX)
		expect(sql).toBe('FETCH FORWARD ALL test_cursor');
	});

	it('generates FETCH BACKWARD ALL', () => {
		const sql = deparse('backward_all');
		// pgsql-deparser emits FETCH BACKWARD ALL when howMany === 9223372036854776000 (Number, float64 ≈ INT64_MAX)
		expect(sql).toBe('FETCH BACKWARD ALL test_cursor');
	});
});
