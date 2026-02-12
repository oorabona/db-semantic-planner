import { describe, expect, it } from 'vitest';
import { parse } from '../index.js';

/**
 * Coverage tests for visit-literal.ts branches.
 * Exercises all literal types: string, number, boolean, null, range literal,
 * identifier segments (regular, quoted, pseudo-column keywords),
 * ident list, value list via parse() / compile().
 */

function parseNql(input: string) {
	const result = parse(input);
	if (!result.success)
		throw new Error(`Parse error: ${result.errors[0]?.message}`);
	return result.ast!;
}

// ============================================================
// STRING LITERAL
// ============================================================

describe('visit-literal: string literal', () => {
	it('parses string literal in WHERE', () => {
		const ast = parseNql("users | where name = 'test'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('string');
		if (right.type === 'string') expect(right.value).toBe('test');
	});

	it('parses string literal with escaped single quotes', () => {
		const ast = parseNql("users | where name = 'O''Brien'");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('string');
		if (right.type === 'string') expect(right.value).toBe("O'Brien");
	});

	it('parses empty string literal', () => {
		const ast = parseNql("users | where name = ''");
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('string');
		if (right.type === 'string') expect(right.value).toBe('');
	});
});

// ============================================================
// NUMBER LITERAL
// ============================================================

describe('visit-literal: number literal', () => {
	it('parses integer literal', () => {
		const ast = parseNql('users | where id = 42');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('number');
		if (right.type === 'number') expect(right.value).toBe(42);
	});

	it('parses float literal', () => {
		const ast = parseNql('users | where score = 3.14');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('number');
		if (right.type === 'number') expect(right.value).toBeCloseTo(3.14);
	});

	it('parses zero literal', () => {
		const ast = parseNql('users | where count = 0');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('number');
		if (right.type === 'number') expect(right.value).toBe(0);
	});
});

// ============================================================
// BOOLEAN LITERALS
// ============================================================

describe('visit-literal: boolean literal', () => {
	it('parses true literal', () => {
		const ast = parseNql('users | where active = true');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('boolean');
		if (right.type === 'boolean') expect(right.value).toBe(true);
	});

	it('parses false literal', () => {
		const ast = parseNql('users | where active = false');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'comparison') return;
		const right = where.condition.right;
		expect(right.type).toBe('boolean');
		if (right.type === 'boolean') expect(right.value).toBe(false);
	});
});

// ============================================================
// NULL LITERAL
// ============================================================

describe('visit-literal: null literal', () => {
	it('parses null in assignment', () => {
		const ast = parseNql('insert into users set bio = null');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'insert') return;
		const val = stmt.mutation.rows[0]![0]!.value;
		expect(val.type).toBe('null');
	});
});

// ============================================================
// RANGE LITERAL
// ============================================================

describe('visit-literal: range literal', () => {
	it('parses inclusive-exclusive range [1,100)', () => {
		const ast = parseNql('events | where score overlaps [1,100)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.type).toBe('rangeLiteral');
		expect(range.lowerInclusive).toBe(true);
		expect(range.upperInclusive).toBe(false);
		expect(range.lower).toBe('1');
		expect(range.upper).toBe('100');
	});

	it('parses inclusive-inclusive range [1,100]', () => {
		const ast = parseNql('events | where score overlaps [1,100]');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.lowerInclusive).toBe(true);
		expect(range.upperInclusive).toBe(true);
	});

	it('parses exclusive-exclusive range (0,100)', () => {
		const ast = parseNql('events | where score overlaps (0,100)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.lowerInclusive).toBe(false);
		expect(range.upperInclusive).toBe(false);
	});

	it('parses exclusive-inclusive range (0,100]', () => {
		const ast = parseNql('events | where score overlaps (0,100]');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.lowerInclusive).toBe(false);
		expect(range.upperInclusive).toBe(true);
	});

	it('parses range with date values', () => {
		const ast = parseNql(
			'events | where daterange overlaps [2024-01-01,2024-12-31)',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.lower).toBe('2024-01-01');
		expect(range.upper).toBe('2024-12-31');
	});

	it('parses range with negative number', () => {
		const ast = parseNql('events | where score overlaps [-10,10]');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'rangeOp') return;
		const range = where.condition.range;
		expect(range).toBeDefined();
		if (!range) return;
		expect(range.lower).toBe('-10');
		expect(range.upper).toBe('10');
	});

	it('parses range as value in primary expression context', () => {
		const ast = parseNql('events | select [1,10]');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		expect(item.expression.type).toBe('rangeLiteral');
	});
});

// ============================================================
// IDENTIFIER SEGMENTS
// ============================================================

describe('visit-literal: identifier segments', () => {
	it('parses regular identifier', () => {
		const ast = parseNql('users');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		expect(stmt.table).toBe('users');
	});

	it('parses quoted identifier', () => {
		const ast = parseNql('"my table"');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		expect(stmt.table).toBe('my table');
	});

	it('parses quoted identifier with escaped double quotes', () => {
		const ast = parseNql('"my ""table"""');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		expect(stmt.table).toBe('my "table"');
	});

	it('parses parent as identifier', () => {
		const ast = parseNql('users | select parent.name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'path') return;
		expect(item.expression.segments[0]).toBe('parent');
	});

	it('parses child as identifier', () => {
		const ast = parseNql('users | select child.name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'path') return;
		expect(item.expression.segments[0]).toBe('child');
	});

	it('parses ascendant as identifier', () => {
		const ast = parseNql('categories | select ascendant.name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'path') return;
		expect(item.expression.segments[0]).toBe('ascendant');
	});

	it('parses descendant as identifier', () => {
		const ast = parseNql('categories | select descendant.name');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const sel = stmt.clauses.find((c) => c.type === 'select')!;
		if (sel.type !== 'select') return;
		const item = sel.items[0]!;
		if (item.type !== 'expression') return;
		if (item.expression.type !== 'path') return;
		expect(item.expression.segments[0]).toBe('descendant');
	});
});

// ============================================================
// IDENT LIST
// ============================================================

describe('visit-literal: ident list', () => {
	it('parses ident list in upsert conflict columns', () => {
		const ast = parseNql(
			'upsert into users on (id, email, name) set active = true',
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'mutationPipeline') return;
		if (stmt.mutation.type !== 'upsert') return;
		expect(stmt.mutation.conflictColumns).toEqual(['id', 'email', 'name']);
	});
});

// ============================================================
// VALUE LIST
// ============================================================

describe('visit-literal: value list', () => {
	it('parses value list in IN expression', () => {
		const ast = parseNql(
			"users | where status in ('active', 'pending', 'review')",
		);
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'in') return;
		if (!Array.isArray(where.condition.values)) return;
		expect(where.condition.values).toHaveLength(3);
		const first = where.condition.values[0]!;
		expect(first.type).toBe('string');
		if (first.type === 'string') expect(first.value).toBe('active');
	});

	it('parses value list with mixed types', () => {
		const ast = parseNql('users | where id in (1, 2, 3)');
		const stmt = ast.statements[0]!;
		if (stmt.type !== 'query') return;
		const where = stmt.clauses.find((c) => c.type === 'where')!;
		if (where.condition.type !== 'in') return;
		if (!Array.isArray(where.condition.values)) return;
		expect(where.condition.values).toHaveLength(3);
		for (const v of where.condition.values) {
			expect(v.type).toBe('number');
		}
	});
});
