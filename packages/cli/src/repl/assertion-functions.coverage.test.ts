// @ts-nocheck — coverage test: runtime assertions
import { describe, expect, it } from 'vitest';
import {
	assertContains,
	assertDbColumnExists,
	assertDbOutput,
	assertDbRowsEquals,
	assertDbRowsMax,
	assertDbRowsMin,
	assertDbValueEquals,
	assertEquals,
	assertIntentHasGroupBy,
	assertIntentHasOrderBy,
	assertIntentHasWhere,
	assertIntentTable,
	assertIntentType,
	assertIntentWith,
	assertMatches,
	assertParamsEquals,
	assertParamsLength,
	assertParamsType,
	assertParamsValue,
	assertSQLColumn,
	assertSQLEquals,
	assertSQLJoin,
	assertSQLTable,
	assertSuccess,
} from './assertion-functions.js';

// ============================================================
// GENERAL ASSERTIONS
// ============================================================

describe('assertContains', () => {
	it('passes when substring found', () => {
		const r = assertContains('output', 'hello world', 'world');
		expect(r.passed).toBe(true);
		expect(r.actual).toBeUndefined();
		expect(r.message).toBeUndefined();
	});

	it('fails when substring not found', () => {
		const r = assertContains('output', 'hello world', 'xyz');
		expect(r.passed).toBe(false);
		expect(r.actual).toBe('hello world');
		expect(r.message).toContain('contain');
		expect(r.message).toContain('xyz');
	});

	it('uses default type when originalType not provided', () => {
		const r = assertContains('sql', 'SELECT 1', 'SELECT');
		expect(r.type).toBe('sql.contains');
	});

	it('uses originalType when provided', () => {
		const r = assertContains('output', 'text', 'text', 'db.output.contains');
		expect(r.type).toBe('db.output.contains');
	});

	it('handles empty actual string', () => {
		const r = assertContains('output', '', 'something');
		expect(r.passed).toBe(false);
	});

	it('handles empty expected string', () => {
		const r = assertContains('output', 'anything', '');
		expect(r.passed).toBe(true);
	});
});

describe('assertEquals', () => {
	it('passes on exact match', () => {
		const r = assertEquals('output', 'hello', 'hello');
		expect(r.passed).toBe(true);
		expect(r.actual).toBeUndefined();
		expect(r.message).toBeUndefined();
	});

	it('passes with whitespace trimming', () => {
		const r = assertEquals('output', '  hello  ', '  hello  ');
		expect(r.passed).toBe(true);
	});

	it('fails on mismatch', () => {
		const r = assertEquals('output', 'hello', 'world');
		expect(r.passed).toBe(false);
		expect(r.actual).toBe('hello');
		expect(r.message).toContain('equal');
	});

	it('trims both sides for comparison', () => {
		const r = assertEquals('output', '  x  ', 'x');
		expect(r.passed).toBe(true);
	});

	it('type includes field name', () => {
		const r = assertEquals('sql', 'a', 'a');
		expect(r.type).toBe('sql.equals');
	});
});

describe('assertMatches', () => {
	it('passes when regex matches', () => {
		const r = assertMatches('output', 'Tables (5)', 'Tables \\(\\d+\\)');
		expect(r.passed).toBe(true);
		expect(r.actual).toBeUndefined();
	});

	it('fails when regex does not match', () => {
		const r = assertMatches('output', 'no match', '^\\d+$');
		expect(r.passed).toBe(false);
		expect(r.actual).toBe('no match');
		expect(r.message).toContain('match');
	});

	it('type includes field name', () => {
		const r = assertMatches('sql', 'SELECT', '.*');
		expect(r.type).toBe('sql.matches');
	});
});

describe('assertSuccess', () => {
	it('passes when actual=true and expected=true', () => {
		const r = assertSuccess(true, true);
		expect(r.passed).toBe(true);
		expect(r.type).toBe('success');
	});

	it('passes when actual=false and expected=false', () => {
		const r = assertSuccess(false, false);
		expect(r.passed).toBe(true);
	});

	it('fails when actual=true but expected=false', () => {
		const r = assertSuccess(true, false);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('fail');
		expect(r.message).toContain('succeeded');
	});

	it('fails when actual=false but expected=true', () => {
		const r = assertSuccess(false, true);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('succeed');
		expect(r.message).toContain('failed');
	});
});

// ============================================================
// SQL ASSERTIONS
// ============================================================

describe('assertSQLEquals', () => {
	it('passes with normalized comparison', () => {
		const r = assertSQLEquals('SELECT  *  FROM  users', 'select * from users');
		expect(r.passed).toBe(true);
		expect(r.type).toBe('sql.equals');
	});

	it('fails on actual mismatch', () => {
		const r = assertSQLEquals('SELECT * FROM users', 'SELECT * FROM posts');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('SQL mismatch');
	});
});

describe('assertSQLTable', () => {
	it('matches logical name (case-insensitive)', () => {
		const r = assertSQLTable('SELECT * FROM users', 'Users');
		expect(r.passed).toBe(true);
	});

	it('matches snake_case from camelCase', () => {
		const r = assertSQLTable('SELECT * FROM "product_images"', 'productImages');
		expect(r.passed).toBe(true);
	});

	it('matches quoted logical name', () => {
		const r = assertSQLTable('SELECT * FROM "users"', 'users');
		expect(r.passed).toBe(true);
	});

	it('matches quoted snake_case', () => {
		const r = assertSQLTable('SELECT * FROM "product_images"', 'productImages');
		expect(r.passed).toBe(true);
	});

	it('fails when table not found in SQL', () => {
		const r = assertSQLTable('SELECT * FROM orders', 'users');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('table');
		expect(r.message).toContain('users');
	});

	it('message includes snake_case hint when different from logical', () => {
		const r = assertSQLTable('SELECT * FROM orders', 'productImages');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('product_images');
	});

	it('message omits snake_case hint when same as logical', () => {
		const r = assertSQLTable('SELECT * FROM orders', 'users');
		expect(r.passed).toBe(false);
		// "users" has no camelCase → snake_case is same as logical
		expect(r.message).not.toContain('(or');
	});
});

describe('assertSQLColumn', () => {
	it('matches logical column name', () => {
		const r = assertSQLColumn('SELECT name FROM users', 'name');
		expect(r.passed).toBe(true);
	});

	it('matches snake_case column from camelCase', () => {
		const r = assertSQLColumn('SELECT created_at FROM users', 'createdAt');
		expect(r.passed).toBe(true);
	});

	it('matches quoted column name', () => {
		const r = assertSQLColumn('SELECT "created_at" FROM users', 'createdAt');
		expect(r.passed).toBe(true);
	});

	it('fails when column not found', () => {
		const r = assertSQLColumn('SELECT id FROM users', 'email');
		expect(r.passed).toBe(false);
		expect(r.type).toBe('sql.column');
	});
});

describe('assertSQLJoin', () => {
	it('detects INNER JOIN', () => {
		const r = assertSQLJoin(
			'SELECT * FROM posts INNER JOIN "users" ON posts.user_id = users.id',
			'users',
		);
		expect(r.passed).toBe(true);
	});

	it('detects LEFT JOIN', () => {
		const r = assertSQLJoin(
			'SELECT * FROM posts LEFT JOIN "comments" ON p.id = c.post_id',
			'comments',
		);
		expect(r.passed).toBe(true);
	});

	it('detects RIGHT JOIN', () => {
		const r = assertSQLJoin(
			'SELECT * FROM a RIGHT JOIN "b" ON a.id = b.a_id',
			'b',
		);
		expect(r.passed).toBe(true);
	});

	it('detects FULL JOIN', () => {
		const r = assertSQLJoin(
			'SELECT * FROM a FULL JOIN "b" ON a.id = b.a_id',
			'b',
		);
		expect(r.passed).toBe(true);
	});

	it('detects CROSS JOIN', () => {
		const r = assertSQLJoin('SELECT * FROM a CROSS JOIN "b"', 'b');
		expect(r.passed).toBe(true);
	});

	it('detects plain JOIN (without qualifier)', () => {
		const r = assertSQLJoin(
			'SELECT * FROM posts JOIN "users" ON p.uid = u.id',
			'users',
		);
		expect(r.passed).toBe(true);
	});

	it('detects CTE with table name', () => {
		const r = assertSQLJoin(
			'WITH filtered_users AS (SELECT * FROM users) SELECT * FROM filtered_users',
			'filtered_users',
		);
		expect(r.passed).toBe(true);
	});

	it('detects CTE with snake_case name from camelCase', () => {
		const r = assertSQLJoin(
			'WITH filtered_users AS (SELECT * FROM users) SELECT * FROM filtered_users',
			'filteredUsers',
		);
		expect(r.passed).toBe(true);
	});

	it('fails when no JOIN or CTE found', () => {
		const r = assertSQLJoin('SELECT * FROM posts WHERE id = 1', 'users');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('JOIN or CTE');
	});

	it('fails when JOIN exists but table name missing', () => {
		const r = assertSQLJoin(
			'SELECT * FROM posts INNER JOIN "comments" ON p.id = c.post_id',
			'users',
		);
		expect(r.passed).toBe(false);
	});

	it('matches schema-qualified table after dot', () => {
		const r = assertSQLJoin(
			'SELECT * FROM a LEFT JOIN "schema"."users" ON a.id = u.a_id',
			'users',
		);
		expect(r.passed).toBe(true);
	});

	it('matches unquoted table with spaces', () => {
		const r = assertSQLJoin(
			'SELECT * FROM a JOIN users ON a.id = users.a_id',
			'users',
		);
		expect(r.passed).toBe(true);
	});
});

// ============================================================
// PARAMS ASSERTIONS
// ============================================================

describe('assertParamsEquals', () => {
	it('passes when arrays match', () => {
		const r = assertParamsEquals([1, 'test', true], [1, 'test', true]);
		expect(r.passed).toBe(true);
		expect(r.actual).toBeUndefined();
	});

	it('fails when arrays differ', () => {
		const r = assertParamsEquals([1, 'a'], [1, 'b']);
		expect(r.passed).toBe(false);
		expect(r.actual).toEqual([1, 'a']);
		expect(r.message).toContain('Params mismatch');
	});

	it('passes with empty arrays', () => {
		const r = assertParamsEquals([], []);
		expect(r.passed).toBe(true);
	});

	it('fails on length mismatch', () => {
		const r = assertParamsEquals([1], [1, 2]);
		expect(r.passed).toBe(false);
	});
});

describe('assertParamsLength', () => {
	it('passes when length matches', () => {
		const r = assertParamsLength([1, 2, 3], 3);
		expect(r.passed).toBe(true);
	});

	it('fails when length differs', () => {
		const r = assertParamsLength([1], 3);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Expected 3 params, got 1');
	});

	it('passes with zero-length', () => {
		const r = assertParamsLength([], 0);
		expect(r.passed).toBe(true);
	});
});

describe('assertParamsType', () => {
	it('passes with matching types', () => {
		const r = assertParamsType(
			['hello', 42, true],
			['string', 'number', 'boolean'],
		);
		expect(r.passed).toBe(true);
	});

	it('fails on length mismatch', () => {
		const r = assertParamsType([1], ['number', 'string']);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Expected 2 params, got 1');
		expect(r.actual).toEqual(['number']);
	});

	it('detects null type', () => {
		const r = assertParamsType([null], ['null']);
		expect(r.passed).toBe(true);
	});

	it('detects array type', () => {
		const r = assertParamsType([[1, 2]], ['array']);
		expect(r.passed).toBe(true);
	});

	it('detects object type (non-null, non-array)', () => {
		const r = assertParamsType([{ key: 'val' }], ['object']);
		expect(r.passed).toBe(true);
	});

	it('reports mismatches with index info', () => {
		const r = assertParamsType([42, 'str'], ['string', 'number']);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Index 0');
		expect(r.message).toContain('Index 1');
	});

	it('handles mixed types correctly', () => {
		const r = assertParamsType(
			[null, [1], { a: 1 }, 'hello'],
			['null', 'array', 'object', 'string'],
		);
		expect(r.passed).toBe(true);
		expect(r.actual).toBeUndefined();
	});

	it('fails when object given but string expected', () => {
		const r = assertParamsType([{ $ref: 'x' }], ['string']);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('object');
	});

	it('fails when null given but number expected', () => {
		const r = assertParamsType([null], ['number']);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('null');
	});

	it('fails when array given but object expected', () => {
		const r = assertParamsType([[1, 2]], ['object']);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('array');
	});
});

describe('assertParamsValue', () => {
	it('passes when spec object matches', () => {
		const r = assertParamsValue([10, 20, 30], { index: 1, value: 20 });
		expect(r.passed).toBe(true);
	});

	it('fails when spec object value mismatches', () => {
		const r = assertParamsValue([10, 20, 30], { index: 1, value: 99 });
		expect(r.passed).toBe(false);
		expect(r.message).toContain('index 1');
	});

	it('handles primitive spec (non-object) — defaults to index 0', () => {
		const r = assertParamsValue([42], 42);
		expect(r.passed).toBe(true);
	});

	it('fails primitive spec when value mismatches at index 0', () => {
		const r = assertParamsValue([42], 99);
		expect(r.passed).toBe(false);
	});

	it('fails when index is out of bounds', () => {
		const r = assertParamsValue([1], { index: 5, value: 1 });
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No param at index 5');
		expect(r.message).toContain('only 1 params');
	});

	it('handles null spec as primitive', () => {
		const r = assertParamsValue([null], null);
		expect(r.passed).toBe(true);
	});

	it('handles string values', () => {
		const r = assertParamsValue(['hello'], { index: 0, value: 'hello' });
		expect(r.passed).toBe(true);
	});

	it('handles nested object values via JSON comparison', () => {
		const r = assertParamsValue([{ a: 1 }], {
			index: 0,
			value: { a: 1 },
		});
		expect(r.passed).toBe(true);
	});
});

// ============================================================
// DB ASSERTIONS
// ============================================================

describe('assertDbRowsEquals', () => {
	it('passes when rowCount matches', () => {
		const r = assertDbRowsEquals({ rowCount: 5 }, 5);
		expect(r.passed).toBe(true);
	});

	it('fails when rowCount mismatches', () => {
		const r = assertDbRowsEquals({ rowCount: 3 }, 5);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Expected 5 rows, got 3');
	});

	it('defaults rowCount to 0 when undefined', () => {
		const r = assertDbRowsEquals({}, 0);
		expect(r.passed).toBe(true);
	});

	it('fails when rowCount undefined and expected > 0', () => {
		const r = assertDbRowsEquals({}, 1);
		expect(r.passed).toBe(false);
		expect(r.actual).toBe(0);
	});
});

describe('assertDbRowsMin', () => {
	it('passes when rowCount >= expected', () => {
		const r = assertDbRowsMin({ rowCount: 5 }, 3);
		expect(r.passed).toBe(true);
	});

	it('passes when rowCount == expected', () => {
		const r = assertDbRowsMin({ rowCount: 3 }, 3);
		expect(r.passed).toBe(true);
	});

	it('fails when rowCount < expected', () => {
		const r = assertDbRowsMin({ rowCount: 1 }, 3);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('at least 3');
	});
});

describe('assertDbRowsMax', () => {
	it('passes when rowCount <= expected', () => {
		const r = assertDbRowsMax({ rowCount: 2 }, 5);
		expect(r.passed).toBe(true);
	});

	it('passes when rowCount == expected', () => {
		const r = assertDbRowsMax({ rowCount: 5 }, 5);
		expect(r.passed).toBe(true);
	});

	it('fails when rowCount > expected', () => {
		const r = assertDbRowsMax({ rowCount: 10 }, 5);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('at most 5');
	});
});

describe('assertDbColumnExists', () => {
	it('passes when column found (exact)', () => {
		const r = assertDbColumnExists(
			{ columns: ['id', 'name', 'email'] },
			'name',
		);
		expect(r.passed).toBe(true);
	});

	it('passes with case-insensitive match', () => {
		const r = assertDbColumnExists({ columns: ['Name', 'Email'] }, 'name');
		expect(r.passed).toBe(true);
	});

	it('passes with snake_case match from camelCase', () => {
		const r = assertDbColumnExists({ columns: ['created_at'] }, 'createdAt');
		expect(r.passed).toBe(true);
	});

	it('fails when column not found', () => {
		const r = assertDbColumnExists({ columns: ['id', 'name'] }, 'email');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('email');
		expect(r.message).toContain('Available');
	});

	it('handles empty columns array', () => {
		const r = assertDbColumnExists({ columns: [] }, 'name');
		expect(r.passed).toBe(false);
	});

	it('handles undefined columns (defaults to empty)', () => {
		const r = assertDbColumnExists({}, 'name');
		expect(r.passed).toBe(false);
	});
});

describe('assertDbValueEquals', () => {
	it('passes when cell value matches', () => {
		const r = assertDbValueEquals(
			{ rows: [{ id: 1, name: 'Alice' }] },
			{ row: 0, column: 'name', value: 'Alice' },
		);
		expect(r.passed).toBe(true);
	});

	it('fails when cell value mismatches', () => {
		const r = assertDbValueEquals(
			{ rows: [{ id: 1, name: 'Bob' }] },
			{ row: 0, column: 'name', value: 'Alice' },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Alice');
		expect(r.message).toContain('Bob');
	});

	it('fails when row index out of bounds', () => {
		const r = assertDbValueEquals(
			{ rows: [{ id: 1 }] },
			{ row: 5, column: 'id', value: 1 },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No row at index 5');
	});

	it('fails when rows are empty', () => {
		const r = assertDbValueEquals(
			{ rows: [] },
			{ row: 0, column: 'id', value: 1 },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No row at index 0');
	});

	it('handles undefined rows (defaults to empty)', () => {
		const r = assertDbValueEquals({}, { row: 0, column: 'id', value: 1 });
		expect(r.passed).toBe(false);
	});

	it('tries snake_case column name fallback', () => {
		const r = assertDbValueEquals(
			{ rows: [{ created_at: '2026-01-01' }] },
			{ row: 0, column: 'createdAt', value: '2026-01-01' },
		);
		expect(r.passed).toBe(true);
	});

	it('handles primitive spec (non-object) — defaults', () => {
		const r = assertDbValueEquals({ rows: [{ '': 42 }] }, 42);
		// primitive spec → { row: 0, column: '', value: 42 }
		expect(r.type).toBe('db.value.equals');
	});

	it('handles null spec as primitive', () => {
		const r = assertDbValueEquals({ rows: [] }, null);
		expect(r.passed).toBe(false);
	});

	it('handles rowData being undefined', () => {
		// rows array with sparse element
		const rows = [undefined];
		const r = assertDbValueEquals({ rows }, { row: 0, column: 'id', value: 1 });
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Row 0 is empty');
	});
});

describe('assertDbOutput', () => {
	it('passes when all rows and columns match', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', name: 'Alice' }] },
			{ columns: ['id', 'name'], rows: [['1', 'Alice']] },
		);
		expect(r.passed).toBe(true);
		expect(r.type).toBe('db.output');
	});

	it('fails on row count mismatch', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1' }, { id: '2' }] },
			{ columns: ['id'], rows: [['1']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Expected 1 rows, got 2');
	});

	it('fails when expected column not in actual row', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', name: 'Alice' }] },
			{ columns: ['id', 'email'], rows: [['1', 'alice@test.com']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('email');
		expect(r.message).toContain('not found');
	});

	it('handles NULL matching (expected "NULL" matches null actual)', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', bio: null }] },
			{ columns: ['id', 'bio'], rows: [['1', 'NULL']] },
		);
		expect(r.passed).toBe(true);
	});

	it('handles NULL matching (expected "NULL" matches undefined actual)', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', bio: undefined }] },
			{ columns: ['id', 'bio'], rows: [['1', 'NULL']] },
		);
		expect(r.passed).toBe(true);
	});

	it('fails when expected NULL but actual is not null', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', bio: 'has value' }] },
			{ columns: ['id', 'bio'], rows: [['1', 'NULL']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('NULL');
	});

	it('fails when expected non-NULL but actual is null', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', bio: null }] },
			{ columns: ['id', 'bio'], rows: [['1', 'has value']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('has value');
	});

	it('normalizes Date values to ISO string', () => {
		const date = new Date('2026-01-15T00:00:00.000Z');
		const r = assertDbOutput(
			{ rows: [{ id: '1', ts: date }] },
			{
				columns: ['id', 'ts'],
				rows: [['1', '2026-01-15T00:00:00.000Z']],
			},
		);
		expect(r.passed).toBe(true);
	});

	it('normalizes object values via JSON.stringify', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', data: { a: 1 } }] },
			{
				columns: ['id', 'data'],
				rows: [['1', '{"a":1}']],
			},
		);
		expect(r.passed).toBe(true);
	});

	it('fails on value mismatch', () => {
		const r = assertDbOutput(
			{ rows: [{ id: '1', name: 'Bob' }] },
			{ columns: ['id', 'name'], rows: [['1', 'Alice']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Row 1, column "name"');
		expect(r.message).toContain('Alice');
		expect(r.message).toContain('Bob');
	});

	it('handles empty expected and actual rows', () => {
		const r = assertDbOutput({ rows: [] }, { columns: ['id'], rows: [] });
		expect(r.passed).toBe(true);
	});

	it('handles rows with undefined values (defaults to empty array)', () => {
		const r = assertDbOutput({}, { columns: ['id'], rows: [] });
		expect(r.passed).toBe(true);
	});

	it('formats actual table in error when rows > 0 and mismatch', () => {
		const r = assertDbOutput(
			{
				rows: [
					{ id: '1', name: 'Alice' },
					{ id: '2', name: 'Bob' },
				],
			},
			{ columns: ['id', 'name'], rows: [['1', 'Alice']] },
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Actual data:');
		expect(r.message).toContain('Alice');
	});

	it('formats "(no rows)" when actual is empty and row count mismatches', () => {
		const r = assertDbOutput({ rows: [] }, { columns: ['id'], rows: [['1']] });
		expect(r.passed).toBe(false);
		expect(r.message).toContain('(no rows)');
	});

	it('skips when expectedRow or actualRow is falsy in loop', () => {
		// Multiple rows — but all match
		const r = assertDbOutput(
			{
				rows: [
					{ id: '1', name: 'a' },
					{ id: '2', name: 'b' },
				],
			},
			{
				columns: ['id', 'name'],
				rows: [
					['1', 'a'],
					['2', 'b'],
				],
			},
		);
		expect(r.passed).toBe(true);
	});

	it('uses columns from actual rows when none specified for formatActualTable', () => {
		const r = assertDbOutput(
			{
				rows: [
					{ id: '1', name: 'Alice' },
					{ id: '2', name: 'Bob' },
				],
			},
			{ columns: [], rows: [['1']] },
		);
		// columns is empty → formatActualTable should use Object.keys from first actual row
		// But row count will mismatch (2 vs 1)
		expect(r.passed).toBe(false);
	});

	it('handles numeric values via String() normalization', () => {
		const r = assertDbOutput(
			{ rows: [{ id: 42, name: 'test' }] },
			{ columns: ['id', 'name'], rows: [['42', 'test']] },
		);
		expect(r.passed).toBe(true);
	});
});

// ============================================================
// INTENT ASSERTIONS
// ============================================================

describe('assertIntentType', () => {
	it('passes when intent type matches', () => {
		const r = assertIntentType(
			{
				intent: {
					type: 'query',
					table: 'users',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'query',
		);
		expect(r.passed).toBe(true);
	});

	it('fails when intent type mismatches', () => {
		const r = assertIntentType(
			{
				intent: {
					type: 'insert',
					table: 'users',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'query',
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('query');
		expect(r.message).toContain('insert');
	});

	it('fails when no intent available', () => {
		const r = assertIntentType({}, 'query');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No intent available');
	});
});

describe('assertIntentTable', () => {
	it('passes when table matches (case-insensitive)', () => {
		const r = assertIntentTable(
			{
				intent: {
					type: 'query',
					table: 'Users',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'users',
		);
		expect(r.passed).toBe(true);
	});

	it('fails when table mismatches', () => {
		const r = assertIntentTable(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'users',
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('users');
		expect(r.message).toContain('posts');
	});

	it('fails when no intent available', () => {
		const r = assertIntentTable({}, 'users');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No intent available');
	});
});

describe('assertIntentWith', () => {
	it('passes when single relation present', () => {
		const r = assertIntentWith(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: ['comments'],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'comments',
		);
		expect(r.passed).toBe(true);
	});

	it('passes when all expected relations present', () => {
		const r = assertIntentWith(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: ['comments', 'users'],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			['comments', 'users'],
		);
		expect(r.passed).toBe(true);
	});

	it('passes with case-insensitive matching', () => {
		const r = assertIntentWith(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: ['Comments'],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'comments',
		);
		expect(r.passed).toBe(true);
	});

	it('fails when relation missing', () => {
		const r = assertIntentWith(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: ['comments'],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			['comments', 'users'],
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('Missing relations');
		expect(r.message).toContain('users');
	});

	it('fails when no intent available', () => {
		const r = assertIntentWith({}, 'comments');
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No intent available');
	});

	it('handles empty with array (no relations)', () => {
		const r = assertIntentWith(
			{
				intent: {
					type: 'query',
					table: 'posts',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			'comments',
		);
		expect(r.passed).toBe(false);
	});
});

describe('assertIntentHasWhere', () => {
	it('passes when hasWhere=true and expected=true', () => {
		const r = assertIntentHasWhere(
			{
				intent: {
					type: 'query',
					table: 'users',
					with: [],
					hasWhere: true,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			true,
		);
		expect(r.passed).toBe(true);
	});

	it('passes when hasWhere=false and expected=false', () => {
		const r = assertIntentHasWhere(
			{
				intent: {
					type: 'query',
					table: 'users',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			false,
		);
		expect(r.passed).toBe(true);
	});

	it('fails on mismatch', () => {
		const r = assertIntentHasWhere(
			{
				intent: {
					type: 'query',
					table: 'users',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			true,
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('hasWhere');
	});

	it('fails when no intent', () => {
		const r = assertIntentHasWhere({}, true);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('No intent available');
	});

	it('defaults to false when field missing on intent', () => {
		const r = assertIntentHasWhere(
			{ intent: { type: 'query', table: 'users', with: [] } },
			false,
		);
		expect(r.passed).toBe(true);
	});
});

describe('assertIntentHasGroupBy', () => {
	it('passes when hasGroupBy matches', () => {
		const r = assertIntentHasGroupBy(
			{
				intent: {
					type: 'query',
					table: 'u',
					with: [],
					hasWhere: false,
					hasGroupBy: true,
					hasOrderBy: false,
				},
			},
			true,
		);
		expect(r.passed).toBe(true);
	});

	it('fails when no intent', () => {
		const r = assertIntentHasGroupBy({}, true);
		expect(r.passed).toBe(false);
	});

	it('fails on mismatch', () => {
		const r = assertIntentHasGroupBy(
			{
				intent: {
					type: 'query',
					table: 'u',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			true,
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('hasGroupBy');
	});
});

describe('assertIntentHasOrderBy', () => {
	it('passes when hasOrderBy matches', () => {
		const r = assertIntentHasOrderBy(
			{
				intent: {
					type: 'query',
					table: 'u',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: true,
				},
			},
			true,
		);
		expect(r.passed).toBe(true);
	});

	it('fails when no intent', () => {
		const r = assertIntentHasOrderBy({}, true);
		expect(r.passed).toBe(false);
	});

	it('fails on mismatch', () => {
		const r = assertIntentHasOrderBy(
			{
				intent: {
					type: 'query',
					table: 'u',
					with: [],
					hasWhere: false,
					hasGroupBy: false,
					hasOrderBy: false,
				},
			},
			true,
		);
		expect(r.passed).toBe(false);
		expect(r.message).toContain('hasOrderBy');
	});
});
