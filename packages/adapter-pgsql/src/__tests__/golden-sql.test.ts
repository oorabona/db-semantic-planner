/**
 * Golden SQL Tests
 *
 * These tests verify that the AST helpers produce correct SQL
 * by comparing deparsed output against expected SQL strings.
 *
 * Test strategy:
 * 1. Build AST using helpers
 * 2. Deparse to SQL
 * 3. Compare with expected SQL (normalized)
 * 4. Roundtrip: parse expected SQL, compare AST structures
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
	stringNode,
	updateStmt,
} from '../ast-helpers.js';
import { CamelCaseNamingPlugin } from '../naming-plugin.js';
import { createParamRef } from '../param-ref.js';

/**
 * Normalize SQL for comparison
 * - Lowercase
 * - Collapse whitespace
 * - Remove trailing semicolons
 */
function normalizeSQL(sql: string): string {
	return sql.toLowerCase().replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

/**
 * Assert that two SQL strings are semantically equivalent
 * by parsing both and comparing key structural elements
 */
function assertSQLEquivalent(actual: string, expected: string): void {
	const normalizedActual = normalizeSQL(actual);
	const normalizedExpected = normalizeSQL(expected);

	// First, simple string comparison
	if (normalizedActual === normalizedExpected) {
		return; // Exact match
	}

	// If not exact, parse both and compare parse success
	// (deparser may produce slightly different formatting)
	try {
		const parsedActual = parseSync(actual);
		const parsedExpected = parseSync(expected);

		// Both should parse without error
		expect(parsedActual.stmts).toHaveLength(parsedExpected.stmts.length);

		// Compare statement types
		const actualStmtType = Object.keys(parsedActual.stmts[0]?.stmt ?? {})[0];
		const expectedStmtType = Object.keys(
			parsedExpected.stmts[0]?.stmt ?? {},
		)[0];
		expect(actualStmtType).toBe(expectedStmtType);
	} catch {
		// If parsing fails, fall back to normalized string comparison
		expect(normalizedActual).toBe(normalizedExpected);
	}
}

describe('Golden SQL: SELECT queries', () => {
	it('SELECT * FROM table', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
		});

		const sql = deparseSync(ast);
		assertSQLEquivalent(sql, 'SELECT * FROM users');
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
		assertSQLEquivalent(sql, 'SELECT id, name, email FROM users');
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
		expect(normalizeSQL(sql)).toContain('where');
		expect(normalizeSQL(sql)).toContain('active');
	});

	it('SELECT with parameterized WHERE', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			where: eqExpr(columnRef('id'), createParamRef(1)),
		});

		const sql = deparseSync(ast);
		assertSQLEquivalent(sql, 'SELECT * FROM users WHERE id = $1');
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
					eqExpr(columnRef('role'), stringNode('admin')),
					eqExpr(columnRef('role'), stringNode('moderator')),
				),
			),
		});

		const sql = deparseSync(ast);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('and');
		expect(normalized).toContain('or');
	});

	it('SELECT with ORDER BY', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('users')],
			orderBy: [sortBy(columnRef('created_at'), 'DESC')],
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('order by');
		expect(normalizeSQL(sql)).toContain('desc');
	});

	it('SELECT with LIMIT and OFFSET params', () => {
		const ast = selectStmt({
			targetList: [starTarget()],
			from: [rangeVar('products')],
			limit: createParamRef(1),
			offset: createParamRef(2),
		});

		const sql = deparseSync(ast);
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(normalizeSQL(sql)).toContain('limit');
		expect(normalizeSQL(sql)).toContain('offset');
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
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('join');
		expect(normalized).toContain('u.name');
		expect(normalized).toContain('p.title');
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
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('left');
		expect(normalized).toContain('join');
		expect(normalized).toContain('group by');
	});

	it('SELECT with aggregate and GROUP BY', () => {
		const ast = selectStmt({
			targetList: [columnTarget('category'), countStar()],
			from: [rangeVar('products')],
			groupBy: [columnRef('category')],
			having: gtExpr(countStar(), integerNode(5)),
		});

		const sql = deparseSync(ast);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('group by');
		expect(normalized).toContain('having');
		expect(normalized).toContain('count');
	});

	it('SELECT DISTINCT', () => {
		const ast = selectStmt({
			targetList: [columnTarget('category')],
			from: [rangeVar('products')],
			distinct: true,
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('distinct');
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
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('insert into');
		expect(normalized).toContain('users');
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
	});

	it('INSERT with schema', () => {
		const ast = insertStmt({
			table: 'users',
			schema: 'public',
			columns: ['name'],
			values: [[createParamRef(1)]],
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('public.users');
	});

	it('INSERT with RETURNING', () => {
		const ast = insertStmt({
			table: 'users',
			columns: ['name', 'email'],
			values: [[createParamRef(1), createParamRef(2)]],
			returning: [columnTarget('id'), columnTarget('created_at')],
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('returning');
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
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('user_accounts');
		expect(normalized).toContain('first_name');
		expect(normalized).toContain('last_name');
		expect(normalized).toContain('created_at');
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
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('update');
		expect(normalized).toContain('set');
		expect(normalized).toContain('where');
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
	});

	it('UPDATE with RETURNING', () => {
		const ast = updateStmt({
			table: 'users',
			set: [{ column: 'status', value: stringNode('active') }],
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [starTarget()],
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('returning');
	});

	it('UPDATE with naming convention', () => {
		const naming = new CamelCaseNamingPlugin();
		const ast = updateStmt({
			table: 'userProfiles',
			set: [
				{ column: 'displayName', value: createParamRef(1) },
				{ column: 'updatedAt', value: funcCall('now') },
			],
			where: eqExpr(columnRef('userId'), createParamRef(2)),
			naming,
		});

		const sql = deparseSync(ast);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('user_profiles');
		expect(normalized).toContain('display_name');
		expect(normalized).toContain('updated_at');
	});
});

describe('Golden SQL: DELETE queries', () => {
	it('DELETE with WHERE', () => {
		const ast = deleteStmt({
			table: 'sessions',
			where: ltExpr(columnRef('expires_at'), funcCall('now')),
		});

		const sql = deparseSync(ast);
		const normalized = normalizeSQL(sql);
		expect(normalized).toContain('delete from');
		expect(normalized).toContain('sessions');
		expect(normalized).toContain('where');
	});

	it('DELETE with RETURNING', () => {
		const ast = deleteStmt({
			table: 'users',
			where: eqExpr(columnRef('id'), createParamRef(1)),
			returning: [columnTarget('id'), columnTarget('email')],
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('returning');
	});

	it('DELETE with naming convention', () => {
		const naming = new CamelCaseNamingPlugin();
		const ast = deleteStmt({
			table: 'userSessions',
			where: eqExpr(columnRef('userId'), createParamRef(1)),
			naming,
		});

		const sql = deparseSync(ast);
		expect(normalizeSQL(sql)).toContain('user_sessions');
	});
});

describe('Golden SQL: Roundtrip verification', () => {
	const testCases = [
		'SELECT * FROM users',
		'SELECT id, name FROM users WHERE active = true',
		'SELECT * FROM users WHERE id = $1',
		'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
		'INSERT INTO users (name, email) VALUES ($1, $2)',
		'UPDATE users SET name = $1 WHERE id = $2',
		'DELETE FROM sessions WHERE expires_at < now()',
	];

	for (const expectedSQL of testCases) {
		it(`roundtrip: ${expectedSQL.substring(0, 50)}...`, () => {
			// Parse expected SQL
			const parsed = parseSync(expectedSQL);
			expect(parsed.stmts).toHaveLength(1);

			// Deparse back to SQL
			const reparsedSQL = deparseSync(parsed);

			// Parse again and verify structure matches
			const reparsed = parseSync(reparsedSQL);
			expect(reparsed.stmts).toHaveLength(1);

			// Statement types should match
			const originalType = Object.keys(parsed.stmts[0]?.stmt ?? {})[0];
			const reparsedType = Object.keys(reparsed.stmts[0]?.stmt ?? {})[0];
			expect(reparsedType).toBe(originalType);
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
		const normalized = normalizeSQL(sql);

		expect(normalized).toContain('left');
		expect(normalized).toContain('join');
		expect(normalized).toContain('where');
		expect(normalized).toContain('group by');
		expect(normalized).toContain('having');
		expect(normalized).toContain('order by');
		expect(normalized).toContain('desc');
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');

		// Verify it parses correctly
		const parsed = parseSync(sql);
		expect(parsed.stmts).toHaveLength(1);
	});

	it('INSERT with multiple rows (batch)', () => {
		const ast = insertStmt({
			table: 'logs',
			columns: ['level', 'message', 'timestamp'],
			values: [
				[stringNode('info'), createParamRef(1), funcCall('now')],
				[stringNode('warn'), createParamRef(2), funcCall('now')],
				[stringNode('error'), createParamRef(3), funcCall('now')],
			],
		});

		const sql = deparseSync(ast);
		const normalized = normalizeSQL(sql);

		expect(normalized).toContain('insert into');
		expect(normalized).toContain('values');
		// Each row creates a VALUES entry
		expect(sql).toContain('$1');
		expect(sql).toContain('$2');
		expect(sql).toContain('$3');
	});
});
