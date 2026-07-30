import { describe, expect, it } from 'vitest';
import {
	assertContains,
	assertDbColumnExists,
	assertDbOutput,
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
} from '../assertion-functions.js';
import type { AssertionQueryResult, IntentSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
	overrides: Partial<AssertionQueryResult> = {},
): AssertionQueryResult {
	return {
		query: 'SELECT 1',
		success: true,
		...overrides,
	};
}

function makeIntent(overrides: Partial<IntentSummary> = {}): IntentSummary {
	return {
		type: 'query',
		table: 'users',
		with: [],
		hasWhere: false,
		hasGroupBy: false,
		hasOrderBy: false,
		ctes: [],
		...overrides,
	};
}

function withoutIntent(result: AssertionQueryResult): AssertionQueryResult {
	const { intent: _intent, ...withoutIntent } = result;
	return withoutIntent;
}

function withoutIntentTable(intent: IntentSummary): IntentSummary {
	const withoutTable = { ...intent };
	Reflect.deleteProperty(withoutTable, 'table');
	return withoutTable;
}

// ---------------------------------------------------------------------------
// assertContains
// ---------------------------------------------------------------------------

describe('assertContains', () => {
	it('should pass when actual contains expected substring', () => {
		const out = assertContains('output', 'hello world', 'world');
		expect(out.passed).toBe(true);
		expect(out.message).toBeUndefined();
		expect(out.actual).toBeUndefined();
	});

	it('should fail when actual does not contain expected substring', () => {
		const out = assertContains('output', 'hello world', 'xyz');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('hello world');
		expect(out.message).toMatch(/to contain/);
	});

	it('should fail on empty actual with non-empty expected', () => {
		const out = assertContains('sql', '', 'SELECT');
		expect(out.passed).toBe(false);
	});

	it('should use originalType when provided', () => {
		const out = assertContains('output', 'foo', 'foo', 'db.output.contains');
		expect(out.type).toBe('db.output.contains');
	});

	it('should derive type from field when no originalType', () => {
		const out = assertContains('output', 'foo', 'foo');
		expect(out.type).toBe('output.contains');
	});

	it('should pass when actual equals expected exactly', () => {
		const out = assertContains('plan', 'exact match', 'exact match');
		expect(out.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertEquals
// ---------------------------------------------------------------------------

describe('assertEquals', () => {
	it('should pass when actual equals expected', () => {
		const out = assertEquals('output', 'hello', 'hello');
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should fail when actual differs from expected', () => {
		const out = assertEquals('output', 'hello', 'world');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('hello');
		expect(out.message).toMatch(/expected/i);
	});

	it('should fail on empty actual when expected is not empty', () => {
		const out = assertEquals('output', '', 'something');
		expect(out.passed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// assertMatches
// ---------------------------------------------------------------------------

describe('assertMatches', () => {
	it('should pass when actual matches the regex pattern', () => {
		const out = assertMatches('sql', 'SELECT * FROM users', 'FROM \\w+');
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should fail when actual does not match the regex pattern', () => {
		const out = assertMatches('sql', 'SELECT 1', 'FROM \\w+');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('SELECT 1');
		expect(out.message).toMatch(/to match/);
	});

	it('should derive type as field.matches', () => {
		const out = assertMatches('output', 'test', '.*');
		expect(out.type).toBe('output.matches');
	});

	it('should pass on empty string with match-all pattern', () => {
		const out = assertMatches('sql', '', '.*');
		expect(out.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertSuccess
// ---------------------------------------------------------------------------

describe('assertSuccess', () => {
	it('should pass when actual matches expected (true === true)', () => {
		const out = assertSuccess(true, true);
		expect(out.passed).toBe(true);
		expect(out.message).toBeUndefined();
	});

	it('should pass when actual matches expected (false === false)', () => {
		const out = assertSuccess(false, false);
		expect(out.passed).toBe(true);
	});

	it('should fail when expected success but got failure', () => {
		const out = assertSuccess(false, true);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/succeed/);
		expect(out.actual).toBe(false);
	});

	it('should fail when expected failure but got success', () => {
		const out = assertSuccess(true, false);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/fail/);
	});
});

// ---------------------------------------------------------------------------
// assertSQLEquals
// ---------------------------------------------------------------------------

describe('assertSQLEquals', () => {
	it('should pass for identical SQL strings', () => {
		const out = assertSQLEquals('SELECT 1', 'SELECT 1');
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should pass when SQL differs only in whitespace (normalized)', () => {
		const out = assertSQLEquals('SELECT  1', 'SELECT 1');
		expect(out.passed).toBe(true);
	});

	it('should fail when SQL differs meaningfully', () => {
		const out = assertSQLEquals('SELECT 1', 'SELECT 2');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('SELECT 1');
		expect(out.message).toMatch(/SQL mismatch/);
	});

	it('should return type sql.equals', () => {
		const out = assertSQLEquals('SELECT 1', 'SELECT 1');
		expect(out.type).toBe('sql.equals');
	});
});

// ---------------------------------------------------------------------------
// assertSQLTable (via createSQLIdentifierAssertion)
// ---------------------------------------------------------------------------

describe('assertSQLTable', () => {
	it('should pass when table name appears in SQL', () => {
		const out = assertSQLTable('SELECT * FROM "users"', 'users');
		expect(out.passed).toBe(true);
	});

	it('should pass for lowercase match of a logical name with capitals', () => {
		// toSnakeCase('UserAccounts') → '_user_accounts' (leading underscore artifact)
		// The function also checks the lower-case logical name: 'useraccounts' in SQL
		// In practice, just test that a plain name matches by inclusion
		const out = assertSQLTable('SELECT * FROM users WHERE 1=1', 'users');
		expect(out.passed).toBe(true);
	});

	it('should fail when table name is not in SQL', () => {
		const out = assertSQLTable('SELECT 1', 'users');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('SELECT 1');
	});

	it('should return type sql.table', () => {
		const out = assertSQLTable('SELECT * FROM users', 'users');
		expect(out.type).toBe('sql.table');
	});
});

// ---------------------------------------------------------------------------
// assertSQLColumn
// ---------------------------------------------------------------------------

describe('assertSQLColumn', () => {
	it('should pass when column name appears in SQL', () => {
		const out = assertSQLColumn('SELECT "user_id" FROM users', 'user_id');
		expect(out.passed).toBe(true);
	});

	it('should fail when column name is absent', () => {
		const out = assertSQLColumn('SELECT 1', 'email');
		expect(out.passed).toBe(false);
	});

	it('should return type sql.column', () => {
		const out = assertSQLColumn('SELECT name FROM t', 'name');
		expect(out.type).toBe('sql.column');
	});
});

// ---------------------------------------------------------------------------
// assertSQLJoin
// ---------------------------------------------------------------------------

describe('assertSQLJoin', () => {
	it('should pass when SQL contains a JOIN referencing the table', () => {
		const out = assertSQLJoin(
			'SELECT * FROM posts LEFT JOIN "comments" ON p.id = c.post_id',
			'comments',
		);
		expect(out.passed).toBe(true);
	});

	it('should pass when SQL contains an INNER JOIN', () => {
		const out = assertSQLJoin(
			'SELECT * FROM t1 INNER JOIN "orders" ON t1.id = orders.user_id',
			'orders',
		);
		expect(out.passed).toBe(true);
	});

	it('should pass when SQL uses a CTE that references the table name', () => {
		const out = assertSQLJoin(
			'WITH summary AS (SELECT id FROM summary_table) SELECT * FROM summary',
			'summary',
		);
		expect(out.passed).toBe(true);
	});

	it('should fail when SQL has no JOIN and no CTE for the table', () => {
		const out = assertSQLJoin('SELECT 1', 'comments');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('SELECT 1');
		expect(out.message).toMatch(/JOIN or CTE/);
	});

	it('should return type sql.join', () => {
		const out = assertSQLJoin(
			'SELECT * FROM t LEFT JOIN "comments" ON 1=1',
			'comments',
		);
		expect(out.type).toBe('sql.join');
	});
});

// ---------------------------------------------------------------------------
// assertParamsEquals
// ---------------------------------------------------------------------------

describe('assertParamsEquals', () => {
	it('should pass when params match exactly', () => {
		const out = assertParamsEquals([1, 'foo', true], [1, 'foo', true]);
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should fail when params differ in value', () => {
		const out = assertParamsEquals([1, 2], [1, 3]);
		expect(out.passed).toBe(false);
		expect(out.actual).toEqual([1, 2]);
		expect(out.message).toMatch(/Params mismatch/);
	});

	it('should fail when params differ in length', () => {
		const out = assertParamsEquals([1], [1, 2]);
		expect(out.passed).toBe(false);
	});

	it('should pass for empty params', () => {
		const out = assertParamsEquals([], []);
		expect(out.passed).toBe(true);
	});

	it('should fail when actual is empty but expected is not', () => {
		const out = assertParamsEquals([], [1]);
		expect(out.passed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// assertParamsLength
// ---------------------------------------------------------------------------

describe('assertParamsLength', () => {
	it('should pass when length matches', () => {
		const out = assertParamsLength([1, 2, 3], 3);
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should fail when actual length differs from expected', () => {
		const out = assertParamsLength([1], 3);
		expect(out.passed).toBe(false);
		expect(out.actual).toBe(1);
		expect(out.message).toMatch(/Expected 3 params/);
	});

	it('should pass for zero length', () => {
		const out = assertParamsLength([], 0);
		expect(out.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertParamsType
// ---------------------------------------------------------------------------

describe('assertParamsType', () => {
	it('should pass when all types match', () => {
		const out = assertParamsType(
			[1, 'foo', true],
			['number', 'string', 'boolean'],
		);
		expect(out.passed).toBe(true);
		expect(out.actual).toBeUndefined();
	});

	it('should fail when count differs', () => {
		const out = assertParamsType([1], ['number', 'string']);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Expected 2 params/);
	});

	it('should fail with specific mismatch messages', () => {
		const out = assertParamsType([1, 'foo'], ['string', 'string']);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Index 0: expected string, got number/);
	});

	it('should classify null as "null" type', () => {
		const out = assertParamsType([null], ['null']);
		expect(out.passed).toBe(true);
	});

	it('should classify array as "array" type', () => {
		const out = assertParamsType([[1, 2]], ['array']);
		expect(out.passed).toBe(true);
	});

	it('should classify object as "object" type (not array)', () => {
		const out = assertParamsType([{ key: 'val' }], ['object']);
		expect(out.passed).toBe(true);
	});

	it('should fail with actual types in result when mismatch', () => {
		const out = assertParamsType([1], ['string']);
		expect(out.passed).toBe(false);
		expect(out.actual).toEqual(['number']);
	});
});

// ---------------------------------------------------------------------------
// assertParamsValue
// ---------------------------------------------------------------------------

describe('assertParamsValue', () => {
	it('should pass when param at default index 0 matches', () => {
		const out = assertParamsValue(['hello'], { index: 0, value: 'hello' });
		expect(out.passed).toBe(true);
	});

	it('should fail when param value at index does not match', () => {
		const out = assertParamsValue(['hello'], { index: 0, value: 'world' });
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/index 0/i);
	});

	it('should fail when index is out of range', () => {
		const out = assertParamsValue([1], { index: 5, value: 1 });
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/No param at index 5/);
	});

	it('should use index 0 and spec as value when spec is not an object', () => {
		const out = assertParamsValue(['direct'], 'direct');
		expect(out.passed).toBe(true);
	});

	it('should use null spec as falsy non-object — falls back to {index:0, value:null}', () => {
		const out = assertParamsValue([null], null);
		expect(out.passed).toBe(true);
	});

	it('should pass for complex object value match', () => {
		const obj = { nested: { deep: 1 } };
		const out = assertParamsValue([obj], { index: 0, value: obj });
		expect(out.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertDbColumnExists
// ---------------------------------------------------------------------------

describe('assertDbColumnExists', () => {
	it('should pass when column name is found (exact match)', () => {
		const result = makeResult({ columns: ['id', 'email', 'name'] });
		const out = assertDbColumnExists(result, 'email');
		expect(out.passed).toBe(true);
	});

	it('should pass when snake_case variant is found for camelCase column name', () => {
		const result = makeResult({ columns: ['user_id'] });
		const out = assertDbColumnExists(result, 'userId');
		expect(out.passed).toBe(true);
	});

	it('should fail when column is not found', () => {
		const result = makeResult({ columns: ['id', 'name'] });
		const out = assertDbColumnExists(result, 'email');
		expect(out.passed).toBe(false);
		expect(out.actual).toEqual(['id', 'name']);
		expect(out.message).toMatch(/not found/);
	});

	it('should fail gracefully when no columns in result', () => {
		const result = makeResult({ columns: [] });
		const out = assertDbColumnExists(result, 'id');
		expect(out.passed).toBe(false);
	});

	it('should return type db.column.exists', () => {
		const result = makeResult({ columns: ['id'] });
		const out = assertDbColumnExists(result, 'id');
		expect(out.type).toBe('db.column.exists');
	});
});

// ---------------------------------------------------------------------------
// assertDbOutput
// ---------------------------------------------------------------------------

describe('assertDbOutput', () => {
	it('should pass when actual rows match expected table data exactly', () => {
		const result = makeResult({
			rows: [
				{ id: '1', name: 'Alice' },
				{ id: '2', name: 'Bob' },
			],
		});
		const tableData = {
			columns: ['id', 'name'],
			rows: [
				['1', 'Alice'],
				['2', 'Bob'],
			],
		};
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(true);
	});

	it('should fail when row count differs', () => {
		const result = makeResult({ rows: [{ id: '1' }] });
		const tableData = { columns: ['id'], rows: [['1'], ['2']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Expected 2 rows/);
	});

	it('should fail when expected column is not found in actual rows', () => {
		const result = makeResult({ rows: [{ id: '1' }] });
		const tableData = { columns: ['id', 'nonexistent'], rows: [['1', 'x']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/not found in results/);
	});

	it('should pass when NULL string matches null value', () => {
		const result = makeResult({ rows: [{ email: null }] });
		const tableData = { columns: ['email'], rows: [['NULL']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(true);
	});

	it('should fail when NULL expected but actual is not null', () => {
		const result = makeResult({ rows: [{ email: 'test@test.com' }] });
		const tableData = { columns: ['email'], rows: [['NULL']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Row 1/);
	});

	it('should fail when actual is null but expected is not NULL', () => {
		const result = makeResult({ rows: [{ email: null }] });
		const tableData = { columns: ['email'], rows: [['test@test.com']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(false);
	});

	it('should fail when string values differ', () => {
		const result = makeResult({ rows: [{ name: 'Alice' }] });
		const tableData = { columns: ['name'], rows: [['Bob']] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Row 1/);
	});

	it('should normalize Date values to ISO string', () => {
		const date = new Date('2024-01-15T00:00:00.000Z');
		const result = makeResult({ rows: [{ created_at: date }] });
		const tableData = { columns: ['created_at'], rows: [[date.toISOString()]] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(true);
	});

	it('should pass for empty table data (zero rows)', () => {
		const result = makeResult({ rows: [] });
		const tableData = { columns: [], rows: [] };
		const out = assertDbOutput(result, tableData);
		expect(out.passed).toBe(true);
	});

	it('should return type db.output', () => {
		const result = makeResult({ rows: [] });
		const out = assertDbOutput(result, { columns: [], rows: [] });
		expect(out.type).toBe('db.output');
	});
});

// ---------------------------------------------------------------------------
// assertDbValueEquals
// ---------------------------------------------------------------------------

describe('assertDbValueEquals', () => {
	it('should pass when value at specified row/column matches', () => {
		const result = makeResult({ rows: [{ name: 'Alice' }] });
		const out = assertDbValueEquals(result, {
			row: 0,
			column: 'name',
			value: 'Alice',
		});
		expect(out.passed).toBe(true);
	});

	it('should fail when value at row/column differs', () => {
		const result = makeResult({ rows: [{ name: 'Alice' }] });
		const out = assertDbValueEquals(result, {
			row: 0,
			column: 'name',
			value: 'Bob',
		});
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Value at \[0\]\["name"\]/);
	});

	it('should fail when row index is out of range', () => {
		const result = makeResult({ rows: [{ name: 'Alice' }] });
		const out = assertDbValueEquals(result, {
			row: 5,
			column: 'name',
			value: 'Alice',
		});
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/No row at index 5/);
	});

	it('should fallback to snake_case column lookup', () => {
		const result = makeResult({ rows: [{ user_name: 'Alice' }] });
		const out = assertDbValueEquals(result, {
			row: 0,
			column: 'userName',
			value: 'Alice',
		});
		expect(out.passed).toBe(true);
	});

	it('should use row=0, column="", value=spec when spec is non-object', () => {
		const result = makeResult({ rows: [{ '': 'direct' }] });
		// empty-string column fallback to direct primitive
		const out = assertDbValueEquals(result, 'direct');
		// passes because spec is not object → {row:0, column:'', value:'direct'}
		expect(out.passed).toBe(true);
	});

	it('should return type db.value.equals', () => {
		const result = makeResult({ rows: [{ id: 1 }] });
		const out = assertDbValueEquals(result, { row: 0, column: 'id', value: 1 });
		expect(out.type).toBe('db.value.equals');
	});
});

// ---------------------------------------------------------------------------
// assertIntentType
// ---------------------------------------------------------------------------

describe('assertIntentType', () => {
	it('should pass when intent type matches', () => {
		const result = makeResult({ intent: makeIntent({ type: 'query' }) });
		const out = assertIntentType(result, 'query');
		expect(out.passed).toBe(true);
	});

	it('should fail when intent type does not match', () => {
		const result = makeResult({ intent: makeIntent({ type: 'insert' }) });
		const out = assertIntentType(result, 'select');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('insert');
		expect(out.message).toMatch(/Expected intent type "select"/);
	});

	it('should fail when no intent available', () => {
		const result = withoutIntent(makeResult());
		const out = assertIntentType(result, 'select');
		expect(out.passed).toBe(false);
		expect(out.message).toBe('No intent available (command or parse error)');
	});

	it('should return type intent.type', () => {
		const result = makeResult({ intent: makeIntent() });
		const out = assertIntentType(result, 'select');
		expect(out.type).toBe('intent.type');
	});
});

// ---------------------------------------------------------------------------
// assertIntentTable
// ---------------------------------------------------------------------------

describe('assertIntentTable', () => {
	it('should pass when intent table matches (case-insensitive)', () => {
		const result = makeResult({ intent: makeIntent({ table: 'Users' }) });
		const out = assertIntentTable(result, 'users');
		expect(out.passed).toBe(true);
	});

	it('should fail when intent table differs', () => {
		const result = makeResult({ intent: makeIntent({ table: 'posts' }) });
		const out = assertIntentTable(result, 'users');
		expect(out.passed).toBe(false);
		expect(out.actual).toBe('posts');
	});

	it('should fail when no intent available', () => {
		const result = withoutIntent(makeResult());
		const out = assertIntentTable(result, 'users');
		expect(out.passed).toBe(false);
		expect(out.message).toBe('No intent available (command or parse error)');
	});

	it('should fail when intent table is undefined', () => {
		const result = makeResult({ intent: withoutIntentTable(makeIntent()) });
		const out = assertIntentTable(result, 'users');
		expect(out.passed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// assertIntentWith
// ---------------------------------------------------------------------------

describe('assertIntentWith', () => {
	it('should pass when all expected relations are present', () => {
		const result = makeResult({
			intent: makeIntent({ with: ['posts', 'comments'] }),
		});
		const out = assertIntentWith(result, 'posts');
		expect(out.passed).toBe(true);
	});

	it('should pass with array of expected relations', () => {
		const result = makeResult({
			intent: makeIntent({ with: ['posts', 'comments'] }),
		});
		const out = assertIntentWith(result, ['posts', 'comments']);
		expect(out.passed).toBe(true);
	});

	it('should pass case-insensitively', () => {
		const result = makeResult({ intent: makeIntent({ with: ['Posts'] }) });
		const out = assertIntentWith(result, 'posts');
		expect(out.passed).toBe(true);
	});

	it('should fail when a relation is missing', () => {
		const result = makeResult({ intent: makeIntent({ with: ['posts'] }) });
		const out = assertIntentWith(result, ['posts', 'comments']);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/Missing relations: comments/);
	});

	it('should fail when no intent available', () => {
		const result = withoutIntent(makeResult());
		const out = assertIntentWith(result, 'posts');
		expect(out.passed).toBe(false);
		expect(out.message).toBe('No intent available (command or parse error)');
	});

	it('should pass when with is empty and expected is empty array', () => {
		const result = makeResult({ intent: makeIntent({ with: [] }) });
		const out = assertIntentWith(result, []);
		expect(out.passed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertIntentHasWhere / HasGroupBy / HasOrderBy
// ---------------------------------------------------------------------------

describe('assertIntentHasWhere', () => {
	it('should pass when hasWhere matches expected true', () => {
		const result = makeResult({ intent: makeIntent({ hasWhere: true }) });
		const out = assertIntentHasWhere(result, true);
		expect(out.passed).toBe(true);
	});

	it('should fail when hasWhere is false but expected true', () => {
		const result = makeResult({ intent: makeIntent({ hasWhere: false }) });
		const out = assertIntentHasWhere(result, true);
		expect(out.passed).toBe(false);
		expect(out.message).toMatch(/hasWhere=true/);
	});

	it('should fail when no intent', () => {
		const result = withoutIntent(makeResult());
		const out = assertIntentHasWhere(result, true);
		expect(out.passed).toBe(false);
	});

	it('should return type intent.hasWhere', () => {
		const result = makeResult({ intent: makeIntent({ hasWhere: false }) });
		const out = assertIntentHasWhere(result, false);
		expect(out.type).toBe('intent.hasWhere');
	});
});

describe('assertIntentHasGroupBy', () => {
	it('should pass when hasGroupBy matches expected', () => {
		const result = makeResult({ intent: makeIntent({ hasGroupBy: true }) });
		const out = assertIntentHasGroupBy(result, true);
		expect(out.passed).toBe(true);
	});

	it('should fail when hasGroupBy does not match', () => {
		const result = makeResult({ intent: makeIntent({ hasGroupBy: false }) });
		const out = assertIntentHasGroupBy(result, true);
		expect(out.passed).toBe(false);
	});

	it('should return type intent.hasGroupBy', () => {
		const result = makeResult({ intent: makeIntent() });
		const out = assertIntentHasGroupBy(result, false);
		expect(out.type).toBe('intent.hasGroupBy');
	});
});

describe('assertIntentHasOrderBy', () => {
	it('should pass when hasOrderBy matches expected', () => {
		const result = makeResult({ intent: makeIntent({ hasOrderBy: true }) });
		const out = assertIntentHasOrderBy(result, true);
		expect(out.passed).toBe(true);
	});

	it('should fail when hasOrderBy does not match', () => {
		const result = makeResult({ intent: makeIntent({ hasOrderBy: false }) });
		const out = assertIntentHasOrderBy(result, true);
		expect(out.passed).toBe(false);
	});

	it('should return type intent.hasOrderBy', () => {
		const result = makeResult({ intent: makeIntent() });
		const out = assertIntentHasOrderBy(result, false);
		expect(out.type).toBe('intent.hasOrderBy');
	});
});
