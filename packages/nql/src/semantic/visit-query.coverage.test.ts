import { describe, expect, it } from 'vitest';
import { compile, parse } from '../index.js';

/**
 * Coverage tests for visit-query.ts branches (non-error paths).
 * Exercises query clauses: WHERE, SELECT, GROUP BY, ORDER BY, LIMIT, OFFSET,
 * LOCK, FLAT, DISTINCT, SET operations, BIND via parse() / compile().
 */

function parseNql(input: string) {
	const result = parse(input);
	if (!result.success)
		throw new Error(`Parse error: ${result.errors[0]?.message}`);
	return result.ast!;
}

function compileNql(input: string) {
	const result = compile(input, null);
	if (!result.success)
		throw new Error(`Compile error: ${result.errors[0]?.message}`);
	return result.ast!;
}

// ============================================================
// BARE QUERY (no clauses)
// ============================================================

describe('visit-query: bare query', () => {
	it('parses bare table reference', () => {
		const ast = parseNql('users');
		expect(ast.statements).toHaveLength(1);
		const stmt = ast.statements[0]!;
		expect(stmt.type).toBe('query');
		if (stmt.type !== 'query') return;
		expect(stmt.table).toBe('users');
		expect(stmt.clauses).toHaveLength(0);
	});
});

// ============================================================
// WHERE CLAUSE
// ============================================================

describe('visit-query: WHERE', () => {
	it('parses single WHERE clause', () => {
		const ast = parseNql('users | where active = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const clauses = stmt.clauses.filter((c) => c.type === 'where');
		expect(clauses).toHaveLength(1);
	});

	it('parses multiple WHERE clauses (combined as separate clauses)', () => {
		const ast = parseNql('users | where a = 1 | where b = 2');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const whereClauses = stmt.clauses.filter((c) => c.type === 'where');
		expect(whereClauses).toHaveLength(2);
	});
});

// ============================================================
// SELECT CLAUSE
// ============================================================

describe('visit-query: SELECT', () => {
	it('parses SELECT with column list', () => {
		const ast = parseNql('users | select name, email, age');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		expect(sel.distinct).toBe(false);
		expect(sel.items).toHaveLength(3);
	});

	it('parses SELECT DISTINCT', () => {
		const ast = parseNql('users | select distinct name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		expect(sel.distinct).toBe(true);
		expect(sel.items).toHaveLength(1);
	});

	it('parses SELECT *', () => {
		const ast = parseNql('users | select *');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		expect(sel.items).toHaveLength(1);
		expect(sel.items[0]!.type).toBe('star');
	});

	it('parses SELECT with alias', () => {
		const ast = parseNql('users | select name as full_name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		expect(item.type).toBe('expression');
		if (item.type !== 'expression') return;
		expect(item.alias).toBe('full_name');
	});

	it('parses SELECT relation.*', () => {
		const ast = parseNql('users | select orders.*');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		expect(sel.items).toHaveLength(1);
		const item = sel.items[0]!;
		expect(item.type).toBe('relationStar');
		if (item.type !== 'relationStar') return;
		expect(item.relation).toEqual(['orders']);
	});

	it('parses SELECT with deep relation.* path', () => {
		const ast = parseNql('users | select orders.items.*');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		expect(item.type).toBe('relationStar');
		if (item.type !== 'relationStar') return;
		expect(item.relation).toEqual(['orders', 'items']);
	});
});

// ============================================================
// GROUP BY CLAUSE
// ============================================================

describe('visit-query: GROUP BY', () => {
	it('parses GROUP BY single column', () => {
		const ast = parseNql('users | group by department');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const group = stmt.clauses.find((c) => c.type === 'groupBy')!;
		if (group.type !== 'groupBy') return;
		expect(group.expressions).toHaveLength(1);
	});

	it('parses GROUP BY multiple columns', () => {
		const ast = parseNql('users | group by department, role');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const group = stmt.clauses.find((c) => c.type === 'groupBy')!;
		if (group.type !== 'groupBy') return;
		expect(group.expressions).toHaveLength(2);
	});
});

// ============================================================
// ORDER BY CLAUSE
// ============================================================

describe('visit-query: ORDER BY', () => {
	it('parses ORDER BY with ASC direction', () => {
		const ast = parseNql('users | order by name asc');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const order = stmt.clauses.find((c) => c.type === 'orderBy')!;
		if (order.type !== 'orderBy') return;
		expect(order.items).toHaveLength(1);
		expect(order.items[0]!.direction).toBe('asc');
	});

	it('parses ORDER BY with DESC direction', () => {
		const ast = parseNql('users | order by created_at desc');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const order = stmt.clauses.find((c) => c.type === 'orderBy')!;
		if (order.type !== 'orderBy') return;
		expect(order.items[0]!.direction).toBe('desc');
	});

	it('parses ORDER BY with default direction (asc)', () => {
		const ast = parseNql('users | order by name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const order = stmt.clauses.find((c) => c.type === 'orderBy')!;
		if (order.type !== 'orderBy') return;
		expect(order.items[0]!.direction).toBe('asc');
	});

	it('parses ORDER BY with multiple columns and mixed directions', () => {
		const ast = parseNql('users | order by department asc, name desc');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const order = stmt.clauses.find((c) => c.type === 'orderBy')!;
		if (order.type !== 'orderBy') return;
		expect(order.items).toHaveLength(2);
		expect(order.items[0]!.direction).toBe('asc');
		expect(order.items[1]!.direction).toBe('desc');
	});
});

// ============================================================
// LIMIT / OFFSET CLAUSES
// ============================================================

describe('visit-query: LIMIT / OFFSET', () => {
	it('parses LIMIT clause', () => {
		const ast = parseNql('users | limit 10');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limit = stmt.clauses.find((c) => c.type === 'limit')!;
		if (limit.type !== 'limit') return;
		expect(limit.count).toBe(10);
		expect(limit.relation).toBeUndefined();
	});

	it('parses OFFSET clause', () => {
		const ast = parseNql('users | offset 5');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const offset = stmt.clauses.find((c) => c.type === 'offset')!;
		if (offset.type !== 'offset') return;
		expect(offset.count).toBe(5);
	});

	it('parses LIMIT + OFFSET together', () => {
		const ast = parseNql('users | limit 10 | offset 20');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limit = stmt.clauses.find((c) => c.type === 'limit')!;
		const offset = stmt.clauses.find((c) => c.type === 'offset')!;
		if (limit.type !== 'limit') return;
		if (offset.type !== 'offset') return;
		expect(limit.count).toBe(10);
		expect(offset.count).toBe(20);
	});

	it('parses per-relation LIMIT (include limit)', () => {
		const ast = parseNql('users | limit orders 3');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limit = stmt.clauses.find((c) => c.type === 'limit')!;
		if (limit.type !== 'limit') return;
		expect(limit.count).toBe(3);
		expect(limit.relation).toBe('orders');
	});

	it('parses per-relation LIMIT with dotted path', () => {
		const ast = parseNql('users | limit orders.items 5');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limit = stmt.clauses.find((c) => c.type === 'limit')!;
		if (limit.type !== 'limit') return;
		expect(limit.count).toBe(5);
		expect(limit.relation).toBe('orders.items');
	});
});

// ============================================================
// LOCK CLAUSES
// ============================================================

describe('visit-query: LOCK', () => {
	it('parses FOR UPDATE', () => {
		const ast = parseNql('users | for update');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forUpdate');
		expect(lock.waitPolicy).toBe('block');
	});

	it('parses FOR UPDATE SKIP LOCKED', () => {
		const ast = parseNql('users | for update skip locked');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forUpdate');
		expect(lock.waitPolicy).toBe('skipLocked');
	});

	it('parses FOR UPDATE NOWAIT', () => {
		const ast = parseNql('users | for update nowait');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forUpdate');
		expect(lock.waitPolicy).toBe('noWait');
	});

	it('parses FOR SHARE', () => {
		const ast = parseNql('users | for share');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forShare');
	});

	it('parses FOR NO KEY UPDATE', () => {
		const ast = parseNql('users | for no key update');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forNoKeyUpdate');
	});

	it('parses FOR KEY SHARE', () => {
		const ast = parseNql('users | for key share');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forKeyShare');
	});
});

// ============================================================
// FLAT CLAUSE
// ============================================================

describe('visit-query: FLAT', () => {
	it('parses FLAT clause', () => {
		const ast = parseNql('users | flat');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const flat = stmt.clauses.find((c) => c.type === 'flat')!;
		expect(flat.type).toBe('flat');
	});
});

// ============================================================
// SET OPERATIONS
// ============================================================

describe('visit-query: SET operations', () => {
	it('parses UNION with inline query', () => {
		const ast = parseNql(
			'users | where active = true | union (users | where admin = true)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setClauses = stmt.clauses.filter((c) => c.type === 'setOperation');
		expect(setClauses).toHaveLength(1);
		const setOp = setClauses[0]!;
		if (setOp.type !== 'setOperation') return;
		expect(setOp.op).toBe('union');
		expect(setOp.all).toBe(false);
		expect(setOp.right).toBeDefined();
	});

	it('parses UNION ALL', () => {
		const ast = parseNql(
			'users | where active = true | union all (users | where admin = true)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setOp = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setOp.type !== 'setOperation') return;
		expect(setOp.op).toBe('union');
		expect(setOp.all).toBe(true);
	});

	it('parses INTERSECT', () => {
		const ast = parseNql(
			'users | where active = true | intersect (users | where admin = true)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setOp = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setOp.type !== 'setOperation') return;
		expect(setOp.op).toBe('intersect');
	});

	it('parses EXCEPT', () => {
		const ast = parseNql(
			'users | where active = true | except (users | where admin = true)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setOp = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setOp.type !== 'setOperation') return;
		expect(setOp.op).toBe('except');
	});

	it('parses SET operation with bound name reference', () => {
		const ast = parseNql('users | where active = true | union admins');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setOp = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setOp.type !== 'setOperation') return;
		expect(setOp.op).toBe('union');
		expect(setOp.boundName).toBe('admins');
		expect(setOp.right).toBeUndefined();
	});
});

// ============================================================
// BIND CLAUSE
// ============================================================

describe('visit-query: BIND', () => {
	it('parses bind clause', () => {
		const ast = parseNql('users | where active = true | bind activeUsers');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const bind = stmt.clauses.find((c) => c.type === 'bind')!;
		if (bind.type !== 'bind') return;
		expect(bind.name).toBe('activeUsers');
	});
});

// ============================================================
// PROGRAM WITH MULTIPLE STATEMENTS
// ============================================================

describe('visit-query: multi-statement program', () => {
	it('parses multiple query statements', () => {
		const ast = parseNql(
			'users | where active = true | bind result\nresult | select name',
		);
		expect(ast.statements).toHaveLength(2);
		expect(ast.statements[0]!.type).toBe('query');
		expect(ast.statements[1]!.type).toBe('query');
	});
});

// ============================================================
// COMPLEX COMBINED QUERIES
// ============================================================

describe('visit-query: complex combined queries', () => {
	it('parses query with many clause types', () => {
		const ast = parseNql(
			'users | where active = true | select name, email | group by department | order by name asc | limit 10 | offset 5',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		expect(stmt.clauses).toHaveLength(6);
		expect(stmt.clauses[0]!.type).toBe('where');
		expect(stmt.clauses[1]!.type).toBe('select');
		expect(stmt.clauses[2]!.type).toBe('groupBy');
		expect(stmt.clauses[3]!.type).toBe('orderBy');
		expect(stmt.clauses[4]!.type).toBe('limit');
		expect(stmt.clauses[5]!.type).toBe('offset');
	});

	it('parses query with WHERE + FOR UPDATE SKIP LOCKED', () => {
		const ast = parseNql(
			'jobs | where status = 1 | limit 5 | for update skip locked',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		expect(stmt.clauses).toHaveLength(3);
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forUpdate');
		expect(lock.waitPolicy).toBe('skipLocked');
	});
});
