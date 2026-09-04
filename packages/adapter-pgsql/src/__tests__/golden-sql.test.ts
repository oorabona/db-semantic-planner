/**
 * Golden SQL Tests
 *
 * These tests verify that the AST helpers produce correct SQL
 * by comparing deparsed output against expected SQL strings.
 *
 * Test strategy:
 * 1. Build AST using helpers
 * 2. Deparse to SQL
 * 3. Compare with expected SQL byte for byte
 * 4. Roundtrip: parse expected SQL, then deparse it exactly
 */

import { deparseSync } from 'pgsql-deparser';
import { parseSync } from 'pgsql-parser';
import { describe, expect, it } from 'vitest';

import {
	andExpr,
	columnRef,
	columnTarget,
	countStar,
	deleteStmt,
	eqExpr,
	funcCall,
	gtExpr,
	innerJoin,
	insertStmt,
	integerNode,
	leftJoin,
	ltExpr,
	orExpr,
	rangeVar,
	selectStmt,
	sortBy,
	starTarget,
	updateStmt,
} from '../ast-helpers.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import { createParamRef } from '../param-ref.js';

/**
 * A golden asserts the SQL the deparser emits, byte for byte. A tolerant comparison is what let a
 * projection change pass unnoticed; a whitespace-collapsing one would equate a string literal
 * containing two spaces with one containing a single space.
 */
function assertSQLGolden(actual: string, expected: string): void {
	expect(actual).toBe(expected);
}

describe('Golden SQL: SELECT queries', () => {
	it('SELECT * FROM table', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM users`,
		);
	});

	it('SELECT columns FROM table', () => {
		const ast = selectStmt({
			targetList: [
				columnTarget('id'),
				columnTarget('name'),
				columnTarget('email'),
			],
			from: [rangeVar('users')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT
  id,
  name,
  email
FROM users`,
		);
	});

	it('SELECT with WHERE clause', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			where: eqExpr(columnRef('active'), {
				A_Const: { boolval: { boolval: true } },
			}),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM users
WHERE
  active = true`,
		);
	});

	it('SELECT with parameterized WHERE', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			where: eqExpr(columnRef('id'), createParamRef(1)),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM users
WHERE
  id = $1`,
		);
	});

	it('SELECT with AND/OR conditions', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			where: andExpr(
				eqExpr(columnRef('active'), {
					A_Const: { boolval: { boolval: true } },
				}),
				orExpr(
					eqExpr(columnRef('role'), { A_Const: { sval: { sval: 'admin' } } }),
					eqExpr(columnRef('role'), {
						A_Const: { sval: { sval: 'moderator' } },
					}),
				),
			),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM users
WHERE
  active = true
  AND (role = 'admin'
  OR role = 'moderator')`,
		);
	});

	it('SELECT with ORDER BY', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			orderBy: [sortBy(columnRef('created_at'), 'DESC')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM users
ORDER BY
  created_at DESC`,
		);
	});

	it('SELECT with LIMIT and OFFSET params', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('products')],
			limit: createParamRef(1),
			offset: createParamRef(2),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT *
FROM products
LIMIT $1
OFFSET $2`,
		);
	});

	it('SELECT with INNER JOIN', () => {
		const ast = selectStmt({
			targetList: [
				columnTarget('name', undefined, 'u'),
				columnTarget('title', undefined, 'p'),
			],
			from: [
				innerJoin(
					rangeVar('users', 'u'),
					rangeVar('posts', 'p'),
					eqExpr(columnRef('id', 'u'), columnRef('author_id', 'p')),
				),
			],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT
  u.name,
  p.title
FROM users AS u
JOIN posts AS p ON u.id = p.author_id`,
		);
	});

	it('SELECT with LEFT JOIN', () => {
		const ast = selectStmt({
			targetList: [starTarget('u'), countStar()],
			from: [
				leftJoin(
					rangeVar('users', 'u'),
					rangeVar('orders', 'o'),
					eqExpr(columnRef('id', 'u'), columnRef('user_id', 'o')),
				),
			],
			groupBy: [columnRef('id', 'u')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT
  u.*,
  count(*)
FROM users AS u
LEFT JOIN orders AS o ON u.id = o.user_id
GROUP BY
  u.id`,
		);
	});

	it('SELECT with aggregate and GROUP BY', () => {
		const ast = selectStmt({
			targetList: [columnTarget('category'), countStar()],
			from: [rangeVar('products')],
			groupBy: [columnRef('category')],
			having: gtExpr(countStar(), integerNode(5)),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT
  category,
  count(*)
FROM products
GROUP BY
  category
HAVING
  count(*) > 5`,
		);
	});

	it('SELECT DISTINCT', () => {
		const ast = selectStmt({
			targetList: [columnTarget('category')],
			from: [rangeVar('products')],
			distinct: true,
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT DISTINCT category
FROM products`,
		);
	});
});

describe('Golden SQL: INSERT queries', () => {
	it('INSERT with VALUES', () => {
		const ast = insertStmt({
			table: 'users',
			columns: ['name', 'email'],
			values: [[createParamRef(1), createParamRef(2)]],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`INSERT INTO users (
  name,
  email
) VALUES
  ($1, $2)`,
		);
	});

	it('INSERT with schema', () => {
		const ast = insertStmt({
			table: 'users',
			schema: 'public',
			columns: ['name'],
			values: [[createParamRef(1)]],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`INSERT INTO public.users (
  name
) VALUES
  ($1)`,
		);
	});

	it('INSERT with RETURNING', () => {
		const ast = insertStmt({
			table: 'users',
			columns: ['name', 'email'],
			values: [[createParamRef(1), createParamRef(2)]],
			returning: [columnTarget('id'), columnTarget('created_at')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`INSERT INTO users (
  name,
  email
) VALUES
  ($1, $2) RETURNING id, created_at`,
		);
	});

	it('INSERT with naming convention', () => {
		const naming = new CamelCaseNamingPlugin();
		const ast = insertStmt({
			table: 'userAccounts',
			columns: ['firstName', 'lastName', 'createdAt'],
			values: [[createParamRef(1), createParamRef(2), funcCall('now')]],
			naming,
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`INSERT INTO user_accounts (
  first_name,
  last_name,
  created_at
) VALUES
  ($1, $2, now())`,
		);
	});
});

describe('Golden SQL: UPDATE queries', () => {
	it('UPDATE with SET and WHERE', () => {
		const ast = updateStmt({
			table: 'users',
			set: [
				{ column: 'name', value: createParamRef(1) },
				{ column: 'updated_at', value: funcCall('now') },
			],
			where: eqExpr(columnRef('id'), createParamRef(2)),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`UPDATE users SET name = $1,updated_at = now() WHERE id = $2`,
		);
	});

	it('UPDATE with RETURNING', () => {
		const ast = updateStmt({
			table: 'users',
			set: [
				{ column: 'status', value: { A_Const: { sval: { sval: 'active' } } } },
			],
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [starTarget()],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`UPDATE users SET status = 'active' WHERE id = $1 RETURNING *`,
		);
	});

	it('UPDATE with naming convention', () => {
		const naming = new CamelCaseNamingPlugin();
		const ast = updateStmt({
			table: 'userProfiles',
			set: [
				{ column: 'displayName', value: createParamRef(1) },
				{ column: 'updatedAt', value: funcCall('now') },
			],
			where: eqExpr(
				columnRef('userId', undefined, undefined, naming),
				createParamRef(2),
			),
			naming,
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`UPDATE user_profiles SET display_name = $1,updated_at = now() WHERE user_id = $2`,
		);
	});
});

describe('Golden SQL: DELETE queries', () => {
	it('DELETE with WHERE', () => {
		const ast = deleteStmt({
			table: 'sessions',
			where: ltExpr(columnRef('expires_at'), funcCall('now')),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(sql, `DELETE FROM sessions WHERE expires_at < now()`);
	});

	it('DELETE with RETURNING', () => {
		const ast = deleteStmt({
			table: 'users',
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [columnTarget('id'), columnTarget('email')],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(sql, `DELETE FROM users WHERE id = $1 RETURNING id, email`);
	});

	it('DELETE with naming convention', () => {
		const naming = new CamelCaseNamingPlugin();
		const ast = deleteStmt({
			table: 'userSessions',
			where: eqExpr(
				columnRef('userId', undefined, undefined, naming),
				createParamRef(1),
			),
			naming,
		});

		const sql = deparseSync(ast);
		assertSQLGolden(sql, `DELETE FROM user_sessions WHERE user_id = $1`);
	});
});

describe('Golden SQL: Roundtrip verification', () => {
	const testCases = [
		{
			input: 'SELECT * FROM users',
			expected: `SELECT *
FROM users`,
		},
		{
			input: 'SELECT id, name FROM users WHERE active = true',
			expected: `SELECT
  id,
  name
FROM users
WHERE
  active = true`,
		},
		{
			input: 'SELECT * FROM users WHERE id = $1',
			expected: `SELECT *
FROM users
WHERE
  id = $1`,
		},
		{
			input: 'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
			expected: `SELECT *
FROM users
ORDER BY
  created_at DESC
LIMIT $1
OFFSET $2`,
		},
		{
			input: 'INSERT INTO users (name, email) VALUES ($1, $2)',
			expected: `INSERT INTO users (
  name,
  email
) VALUES
  ($1, $2)`,
		},
		{
			input: 'UPDATE users SET name = $1 WHERE id = $2',
			expected: `UPDATE users SET name = $1 WHERE id = $2`,
		},
		{
			input: 'DELETE FROM sessions WHERE expires_at < now()',
			expected: `DELETE FROM sessions WHERE expires_at < now()`,
		},
	];

	for (const { input, expected } of testCases) {
		it(`roundtrip: ${input.substring(0, 50)}...`, () => {
			const emitted = deparseSync(parseSync(input));
			assertSQLGolden(emitted, expected);
			assertSQLGolden(deparseSync(parseSync(emitted)), expected);
		});
	}
});

describe('Golden SQL: Complex queries', () => {
	it('SELECT with multiple JOINs and conditions', () => {
		// Build: SELECT u.*, COUNT(o.id) as order_count
		//        FROM users u
		//        LEFT JOIN orders o ON u.id = o.user_id
		//        WHERE u.active = true
		//        GROUP BY u.id
		//        HAVING COUNT(o.id) > $1
		//        ORDER BY order_count DESC
		//        LIMIT $2

		const ast = selectStmt({
			targetList: [
				starTarget('u'),
				{
					ResTarget: {
						val: funcCall('count', [columnRef('id', 'o')]),
						name: 'order_count',
					},
				},
			],
			from: [
				leftJoin(
					rangeVar('users', 'u'),
					rangeVar('orders', 'o'),
					eqExpr(columnRef('id', 'u'), columnRef('user_id', 'o')),
				),
			],
			where: eqExpr(columnRef('active', 'u'), {
				A_Const: { boolval: { boolval: true } },
			}),
			groupBy: [columnRef('id', 'u')],
			having: gtExpr(
				funcCall('count', [columnRef('id', 'o')]),
				createParamRef(1),
			),
			orderBy: [sortBy(columnRef('order_count'), 'DESC')],
			limit: createParamRef(2),
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`SELECT
  u.*,
  count(o.id) AS order_count
FROM users AS u
LEFT JOIN orders AS o ON u.id = o.user_id
WHERE
  u.active = true
GROUP BY
  u.id
HAVING
  count(o.id) > $1
ORDER BY
  order_count DESC
LIMIT $2`,
		);
	});

	it('INSERT with multiple rows (batch)', () => {
		const ast = insertStmt({
			table: 'logs',
			columns: ['level', 'message', 'timestamp'],
			values: [
				[
					{ A_Const: { sval: { sval: 'info' } } },
					createParamRef(1),
					funcCall('now'),
				],
				[
					{ A_Const: { sval: { sval: 'warn' } } },
					createParamRef(2),
					funcCall('now'),
				],
				[
					{ A_Const: { sval: { sval: 'error' } } },
					createParamRef(3),
					funcCall('now'),
				],
			],
		});

		const sql = deparseSync(ast);
		assertSQLGolden(
			sql,
			`INSERT INTO logs (
  level,
  message,
  "timestamp"
) VALUES
  ('info', $1, now()),
  ('warn', $2, now()),
  ('error', $3, now())`,
		);
	});
});
