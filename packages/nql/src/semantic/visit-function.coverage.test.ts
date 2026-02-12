import { describe, expect, it } from 'vitest';
import { compile, parse } from '../index.js';

/**
 * Coverage tests for visit-function.ts branches.
 * Exercises function calls (regular + aggregate), window functions,
 * DISTINCT modifier, partition/order clauses via parse() / compile().
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
// REGULAR FUNCTION CALLS
// ============================================================

describe('visit-function: regular functions', () => {
	it('parses upper(name)', () => {
		const ast = parseNql('users | select upper(name)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('upper');
		expect(item.expression.args).toHaveLength(1);
	});

	it('parses function with multiple args', () => {
		const ast = parseNql('users | select coalesce(name, email)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('coalesce');
		expect(item.expression.args).toHaveLength(2);
	});

	it('parses function with no args', () => {
		const ast = parseNql('users | select now()');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('now');
		expect(item.expression.args).toHaveLength(0);
	});
});

// ============================================================
// AGGREGATE FUNCTIONS
// ============================================================

describe('visit-function: aggregate functions', () => {
	it('parses count(*)', () => {
		const ast = parseNql('users | select count(*)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('count');
		// count(*) — Star is consumed inside funcArgList; funcCall sees empty args
		expect(item.expression.args).toHaveLength(0);
	});

	it('parses count(column)', () => {
		const ast = parseNql('users | select count(id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('count');
		expect(item.expression.args).toHaveLength(1);
		expect(item.expression.args[0]!.type).toBe('path');
	});

	it('parses count(distinct name)', () => {
		const ast = parseNql('users | select count(distinct name)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('count');
		expect(item.expression.distinct).toBe(true);
	});

	it('parses sum(column)', () => {
		const ast = parseNql('orders | select sum(total)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('sum');
	});

	it('parses avg(column)', () => {
		const ast = parseNql('orders | select avg(total)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('avg');
	});

	it('parses max(column)', () => {
		const ast = parseNql('orders | select max(total)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('max');
	});

	it('parses min(column)', () => {
		const ast = parseNql('orders | select min(total)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('min');
	});
});

// ============================================================
// WINDOW FUNCTIONS — row_number, rank, dense_rank
// ============================================================

describe('visit-function: window functions (keywords)', () => {
	it('parses row_number() over (order by id)', () => {
		const ast = parseNql('users | select row_number() over (order by id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('row_number');
		expect(item.expression.args).toHaveLength(0);
		expect(item.expression.partitionBy).toHaveLength(0);
		expect(item.expression.orderBy).toHaveLength(1);
	});

	it('parses rank() over (order by score)', () => {
		const ast = parseNql('users | select rank() over (order by score)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('rank');
	});

	it('parses dense_rank() over (order by score)', () => {
		const ast = parseNql('users | select dense_rank() over (order by score)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('dense_rank');
	});
});

// ============================================================
// WINDOW FUNCTIONS — lag, lead
// ============================================================

describe('visit-function: lag / lead', () => {
	it('parses lag(salary, 1) over (order by id)', () => {
		const ast = parseNql(
			'employees | select lag(salary, 1) over (order by id)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('lag');
		expect(item.expression.args).toHaveLength(2);
	});

	it('parses lead(salary, 1) over (order by id)', () => {
		const ast = parseNql(
			'employees | select lead(salary, 1) over (order by id)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('lead');
		expect(item.expression.args).toHaveLength(2);
	});
});

// ============================================================
// WINDOW — partition by + order by
// ============================================================

describe('visit-function: window with partition and order', () => {
	it('parses window with partition by only', () => {
		const ast = parseNql(
			'orders | select sum(amount) over (partition by dept)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.function).toBe('sum');
		expect(item.expression.partitionBy).toHaveLength(1);
		expect(item.expression.orderBy).toHaveLength(0);
	});

	it('parses window with order by only', () => {
		const ast = parseNql('users | select rank() over (order by score desc)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'window') return;
		expect(item.expression.partitionBy).toHaveLength(0);
		expect(item.expression.orderBy).toHaveLength(1);
		expect(item.expression.orderBy[0]!.direction).toBe('desc');
	});

	it('parses window with both partition by and order by', () => {
		const ast = parseNql(
			'orders | select row_number() over (partition by dept order by created_at desc)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'window') return;
		expect(item.expression.partitionBy).toHaveLength(1);
		expect(item.expression.orderBy).toHaveLength(1);
		expect(item.expression.orderBy[0]!.direction).toBe('desc');
	});

	it('parses window with multiple partition columns', () => {
		const ast = parseNql(
			'orders | select sum(amount) over (partition by dept, region)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'window') return;
		expect(item.expression.partitionBy).toHaveLength(2);
	});

	it('parses window with multiple order by columns', () => {
		const ast = parseNql(
			'orders | select row_number() over (order by dept asc, id desc)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'window') return;
		expect(item.expression.orderBy).toHaveLength(2);
		expect(item.expression.orderBy[0]!.direction).toBe('asc');
		expect(item.expression.orderBy[1]!.direction).toBe('desc');
	});

	it('parses empty OVER clause', () => {
		const ast = parseNql('orders | select count(*) over ()');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('window');
		if (item.expression.type !== 'window') return;
		expect(item.expression.partitionBy).toHaveLength(0);
		expect(item.expression.orderBy).toHaveLength(0);
	});
});

// ============================================================
// FUNCTION WITH DISTINCT — non-count aggregate
// ============================================================

describe('visit-function: distinct modifier on non-count', () => {
	it('parses sum(distinct amount)', () => {
		const ast = parseNql('orders | select sum(distinct amount)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
		if (item.expression.type !== 'function') return;
		expect(item.expression.name).toBe('sum');
		expect(item.expression.distinct).toBe(true);
		expect(item.expression.args).toHaveLength(1);
	});
});

// ============================================================
// FUNCTION without OVER = regular function (not window)
// ============================================================

describe('visit-function: function without OVER is not window', () => {
	it('returns function type (not window) when OVER is absent', () => {
		const ast = parseNql('users | select count(id)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('function');
	});
});

// ============================================================
// FUNCTION CALL in WHERE context
// ============================================================

describe('visit-function: function in WHERE', () => {
	it('parses function in comparison within WHERE', () => {
		const ast = parseNql("users | where lower(name) = 'john'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		expect(where.condition.left.type).toBe('function');
		if (where.condition.left.type !== 'function') return;
		expect(where.condition.left.name).toBe('lower');
	});
});
