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

// ============================================================
// LOCK clause strength variants
// ============================================================

describe('visit-query: lock clause strength variants', () => {
	it('FOR NO KEY UPDATE strength', () => {
		const ast = parseNql('users | for no key update');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forNoKeyUpdate');
		expect(lock.waitPolicy).toBe('block');
	});

	it('FOR KEY SHARE strength', () => {
		const ast = parseNql('users | for key share');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forKeyShare');
		expect(lock.waitPolicy).toBe('block');
	});

	it('FOR SHARE NOWAIT', () => {
		const ast = parseNql('users | for share nowait');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lock = stmt.clauses.find((c) => c.type === 'lock')!;
		if (lock.type !== 'lock') return;
		expect(lock.strength).toBe('forShare');
		expect(lock.waitPolicy).toBe('noWait');
	});
});

// ============================================================
// SET clause variants (Intersect, Except)
// ============================================================

describe('visit-query: set clause variants', () => {
	it('parses INTERSECT clause', () => {
		const ast = parseNql('users | select id | intersect (orders | select id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setClause = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setClause.type !== 'setOperation') return;
		expect(setClause.op).toBe('intersect');
		expect(setClause.all).toBe(false);
	});

	it('parses EXCEPT ALL clause', () => {
		const ast = parseNql('users | select id | except all (orders | select id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const setClause = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setClause.type !== 'setOperation') return;
		expect(setClause.op).toBe('except');
		expect(setClause.all).toBe(true);
	});

	it('parses set clause with bound name operand', () => {
		const ast = parseNql(
			'users | select id | bind sub1\nusers | select id | union sub1',
		);
		// Second statement has the set clause with bound name
		const stmt = ast.statements[1]!;
		if (stmt.type !== 'query') return;
		const setClause = stmt.clauses.find((c) => c.type === 'setOperation')!;
		if (setClause.type !== 'setOperation') return;
		expect(setClause.op).toBe('union');
		expect(setClause.boundName).toBe('sub1');
	});
});

// ============================================================
// FLAT clause
// ============================================================

describe('visit-query: flat clause', () => {
	it('parses flat clause', () => {
		const ast = parseNql('users | select id, posts.title | flat');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const flat = stmt.clauses.find((c) => c.type === 'flat');
		expect(flat).toBeDefined();
		expect(flat!.type).toBe('flat');
	});
});

// ============================================================
// GROUP BY clause
// ============================================================

describe('visit-query: group clause', () => {
	it('parses group by multiple fields', () => {
		const ast = parseNql(
			'orders | group by status, region | select status, region, count() as cnt',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const group = stmt.clauses.find((c) => c.type === 'groupBy')!;
		if (group.type !== 'groupBy') return;
		expect(group.expressions).toHaveLength(2);
	});
});

// ============================================================
// ORDER BY clause
// ============================================================

describe('visit-query: order clause', () => {
	it('parses order by with mixed directions', () => {
		const ast = parseNql('users | order by name asc, age desc');
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
// LIMIT with relation (per-include limit)
// ============================================================

describe('visit-query: limit with relation', () => {
	it('parses per-include limit', () => {
		const ast = parseNql('users | select id, posts.title | limit posts 5');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limitClause = stmt.clauses.find((c) => c.type === 'limit')!;
		if (limitClause.type !== 'limit') return;
		expect(limitClause.count).toBe(5);
		expect(limitClause.relation).toBe('posts');
	});

	it('parses per-include limit with dotted relation', () => {
		const ast = parseNql(
			'users | select id, posts.comments.text | limit posts.comments 3',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const limitClause = stmt.clauses.find((c) => c.type === 'limit')!;
		if (limitClause.type !== 'limit') return;
		expect(limitClause.count).toBe(3);
		expect(limitClause.relation).toBe('posts.comments');
	});
});

// ============================================================
// RELATION STAR expression
// ============================================================

describe('visit-query: relation star expression', () => {
	it('parses relation.* in select list', () => {
		const ast = parseNql('orders | select customer.*');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		expect(sel.items).toHaveLength(1);
		const item = sel.items[0]!;
		expect(item.type).toBe('relationStar');
		if (item.type === 'relationStar') {
			expect(item.relation).toEqual(['customer']);
		}
	});
});

// ============================================================
// BIND clause in query
// ============================================================

describe('visit-query: bind clause', () => {
	it('parses bind clause in query', () => {
		const ast = parseNql(
			'users | where active = true | select id | bind activeIds',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const bind = stmt.clauses.find((c) => c.type === 'bind');
		expect(bind).toBeDefined();
		if (bind && bind.type === 'bind') {
			expect(bind.name).toBe('activeIds');
		}
	});
});

// ============================================================
// MULTI-STATEMENT parsing
// ============================================================

describe('visit-query: multi-statement', () => {
	it('parses two statements separated by newline', () => {
		const ast = parseNql(
			'users | select id | bind sub\norders | where userId in (sub)',
		);
		expect(ast.statements).toHaveLength(2);
		expect(ast.statements[0]!.type).toBe('query');
		expect(ast.statements[1]!.type).toBe('query');
	});
});

// ===========================================================================
// ROUND 2: Additional branches in visit-query.ts
// ===========================================================================

// ============================================================
// visitSelectClause — empty select list (line 88)
// ============================================================

describe('visit-query R2: select clause branches', () => {
	it('select * produces star item (line 88 — selectList present)', () => {
		const ast = parseNql('users | select *');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		expect(selectClause).toBeDefined();
		if (selectClause && 'items' in selectClause) {
			expect(selectClause.items.length).toBeGreaterThan(0);
			expect(selectClause.items[0]!.type).toBe('star');
		}
	});

	it('select with multiple items (line 189 — selectList iteration)', () => {
		const ast = parseNql('users | select id, name, email');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			expect(selectClause.items).toHaveLength(3);
		}
	});
});

// ============================================================
// visitGroupClause — with expression list (line 101)
// ============================================================

describe('visit-query R2: group clause', () => {
	it('parses GROUP BY with expression list (line 101)', () => {
		const ast = parseNql('orders | select status, count(id) | group by status');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const groupClause = stmt.clauses.find((c) => c.type === 'groupBy');
		expect(groupClause).toBeDefined();
		if (groupClause && 'expressions' in groupClause) {
			expect(groupClause.expressions.length).toBeGreaterThan(0);
		}
	});

	it('parses GROUP BY with multiple columns', () => {
		const ast = parseNql(
			'orders | select status, region, sum(amount) | group by status, region',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const groupClause = stmt.clauses.find((c) => c.type === 'groupBy');
		if (groupClause && 'expressions' in groupClause) {
			expect(groupClause.expressions).toHaveLength(2);
		}
	});
});

// ============================================================
// visitOrderClause — with order items (line 110)
// ============================================================

describe('visit-query R2: order clause', () => {
	it('parses ORDER BY single column (line 110)', () => {
		const ast = parseNql('users | order by name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const orderClause = stmt.clauses.find((c) => c.type === 'orderBy');
		expect(orderClause).toBeDefined();
		if (orderClause && 'items' in orderClause) {
			expect(orderClause.items).toHaveLength(1);
			expect(orderClause.items[0]!.direction).toBe('asc');
		}
	});

	it('parses ORDER BY desc (line 233 — orderList iteration)', () => {
		const ast = parseNql('users | order by name desc, age asc');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const orderClause = stmt.clauses.find((c) => c.type === 'orderBy');
		if (orderClause && 'items' in orderClause) {
			expect(orderClause.items).toHaveLength(2);
			expect(orderClause.items[0]!.direction).toBe('desc');
			expect(orderClause.items[1]!.direction).toBe('asc');
		}
	});
});

// ============================================================
// visitRelationStarExpr — relation.* (line 220)
// ============================================================

describe('visit-query R2: relation star expression', () => {
	it('parses relation.* select expression (line 220)', () => {
		const ast = parseNql('users | select orders.*');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const selectClause = stmt.clauses.find((c) => c.type === 'select');
		if (selectClause && 'items' in selectClause) {
			const item = selectClause.items[0]!;
			expect(item.type).toBe('relationStar');
			if (item.type === 'relationStar') {
				expect(item.relation).toEqual(['orders']);
			}
		}
	});
});

// ============================================================
// visitLockClause — forNoKeyUpdate and forKeyShare (line 252)
// ============================================================

describe('visit-query R2: lock clause variants', () => {
	it('parses FOR NO KEY UPDATE (line 252)', () => {
		const ast = parseNql('users | where active = true | for no key update');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lockClause = stmt.clauses.find((c) => c.type === 'lock');
		expect(lockClause).toBeDefined();
		if (lockClause && 'strength' in lockClause) {
			expect(lockClause.strength).toBe('forNoKeyUpdate');
		}
	});

	it('parses FOR KEY SHARE (line 252)', () => {
		const ast = parseNql('users | where active = true | for key share');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const lockClause = stmt.clauses.find((c) => c.type === 'lock');
		expect(lockClause).toBeDefined();
		if (lockClause && 'strength' in lockClause) {
			expect(lockClause.strength).toBe('forKeyShare');
		}
	});
});
