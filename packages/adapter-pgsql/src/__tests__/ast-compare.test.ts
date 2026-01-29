/**
 * AST Comparison Tests
 */
import { describe, expect, it } from 'vitest';

import {
	assertRoundtrip,
	compareAST,
	compareSQLByAST,
	normalizeSQL,
	roundtripTest,
} from '../ast-compare.js';

describe('compareAST', () => {
	it('compares equal primitives', () => {
		expect(compareAST(1, 1).equal).toBe(true);
		expect(compareAST('a', 'a').equal).toBe(true);
		expect(compareAST(true, true).equal).toBe(true);
	});

	it('detects different primitives', () => {
		const result = compareAST(1, 2);
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('1');
		expect(result.differences[0]).toContain('2');
	});

	it('compares equal objects', () => {
		const result = compareAST({ a: 1, b: 2 }, { a: 1, b: 2 });
		expect(result.equal).toBe(true);
	});

	it('compares objects with different key order', () => {
		const result = compareAST({ a: 1, b: 2 }, { b: 2, a: 1 });
		expect(result.equal).toBe(true); // Order shouldn't matter
	});

	it('ignores location fields', () => {
		const result = compareAST({ a: 1, location: 42 }, { a: 1, location: 100 });
		expect(result.equal).toBe(true);
	});

	it('compares equal arrays', () => {
		const result = compareAST([1, 2, 3], [1, 2, 3]);
		expect(result.equal).toBe(true);
	});

	it('detects array length differences', () => {
		const result = compareAST([1, 2], [1, 2, 3]);
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('length');
	});

	it('compares nested structures', () => {
		const a = { outer: { inner: [1, 2, { deep: true }] } };
		const b = { outer: { inner: [1, 2, { deep: true }] } };
		expect(compareAST(a, b).equal).toBe(true);
	});

	it('detects missing keys', () => {
		const result = compareAST({ a: 1, b: 2 }, { a: 1 });
		expect(result.equal).toBe(false);
		expect(result.differences.some((d) => d.includes('missing'))).toBe(true);
	});
});

describe('roundtripTest', () => {
	it('roundtrips simple SELECT', () => {
		const result = roundtripTest('SELECT * FROM users');
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips SELECT with WHERE', () => {
		const result = roundtripTest(
			'SELECT id, name FROM users WHERE active = true',
		);
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips parameterized query', () => {
		const result = roundtripTest('SELECT * FROM users WHERE id = $1');
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips INSERT', () => {
		const result = roundtripTest('INSERT INTO users (name) VALUES ($1)');
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips UPDATE', () => {
		const result = roundtripTest('UPDATE users SET name = $1 WHERE id = $2');
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips DELETE', () => {
		const result = roundtripTest('DELETE FROM users WHERE id = $1');
		expect(result.comparison.equal).toBe(true);
	});

	it('roundtrips complex query', () => {
		const sql = `
			SELECT u.*, COUNT(o.id) as order_count
			FROM users u
			LEFT JOIN orders o ON u.id = o.user_id
			WHERE u.active = true
			GROUP BY u.id
			HAVING COUNT(o.id) > 5
			ORDER BY order_count DESC
			LIMIT 10
		`;
		const result = roundtripTest(sql);
		expect(result.comparison.equal).toBe(true);
	});
});

describe('assertRoundtrip', () => {
	it('passes for valid SQL', () => {
		expect(() => assertRoundtrip('SELECT * FROM users')).not.toThrow();
	});

	it('passes for complex SQL', () => {
		expect(() =>
			assertRoundtrip(`
				SELECT u.name, p.title
				FROM users u
				INNER JOIN posts p ON u.id = p.author_id
				WHERE p.published = true
				ORDER BY p.created_at DESC
			`),
		).not.toThrow();
	});
});

describe('normalizeSQL', () => {
	it('lowercases SQL', () => {
		expect(normalizeSQL('SELECT * FROM Users')).toBe('select * from users');
	});

	it('collapses whitespace', () => {
		expect(normalizeSQL('SELECT   *   FROM   users')).toBe(
			'select * from users',
		);
	});

	it('removes trailing semicolons', () => {
		expect(normalizeSQL('SELECT * FROM users;')).toBe('select * from users');
	});

	it('normalizes parentheses', () => {
		expect(normalizeSQL('( a, b )')).toBe('(a, b)');
	});
});

describe('compareSQLByAST', () => {
	it('compares equivalent SQL with different formatting', () => {
		const result = compareSQLByAST(
			'SELECT * FROM users',
			'select   *   from   users',
		);
		expect(result.equal).toBe(true);
	});

	it('detects semantically different SQL', () => {
		const result = compareSQLByAST(
			'SELECT * FROM users',
			'SELECT * FROM orders',
		);
		expect(result.equal).toBe(false);
	});

	it('handles parse errors gracefully', () => {
		const result = compareSQLByAST(
			'SELECT * FROM users',
			'SELECTT * FROMM users', // Invalid SQL
		);
		expect(result.equal).toBe(false);
		expect(result.differences[0]).toContain('Parse error');
	});

	it('compares complex equivalent queries', () => {
		const sql1 = 'SELECT u.id, u.name FROM users u WHERE u.active = true';
		const sql2 =
			'SELECT  u.id,  u.name  FROM  users  u  WHERE  u.active  =  true';
		const result = compareSQLByAST(sql1, sql2);
		expect(result.equal).toBe(true);
	});
});
