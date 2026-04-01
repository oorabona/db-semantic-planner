/**
 * Tests for FR-9: ORDER BY inside aggregate functions via fn() + aggOrderBy().
 *
 * Covers:
 * - fn('array_agg', ref('name'), aggOrderBy('path')) → array_agg("name" ORDER BY "path" ASC)
 * - fn('string_agg', ..., aggOrderBy(...)) → string_agg("name", ',' ORDER BY "name" ASC)
 * - arrayAgg() and stringAgg() helpers
 * - Multiple ORDER BY entries
 * - aggOrderBy() intent structure (unit level)
 */

import {
	aggOrderBy,
	arrayAgg,
	exprRef,
	fn,
	literal,
	stringAgg,
} from '@dbsp/core';

// exprRef is the correct alias for expressions.ref from @dbsp/core
// ('ref' from @dbsp/core resolves to the schema ref(), not the expression ref())
const ref = exprRef;

import type { AggOrderByArg, CustomFnExpressionIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import { normalizeSQL } from '../ast-helpers.js';
import { compilePlan, type SimplifiedPlanReport } from '../compiler.js';

// ============================================================================
// Helpers
// ============================================================================

function getExprIntent(expr: ReturnType<typeof fn>): CustomFnExpressionIntent {
	return (expr as unknown as { intent: CustomFnExpressionIntent }).intent;
}

function compilePlanFromExpr(
	expr: ReturnType<typeof fn>,
	alias: string,
	rootTable = 'users',
): { sql: string; parameters: readonly unknown[] } {
	const plan: SimplifiedPlanReport = {
		rootTable,
		decisions: [
			{
				type: 'selectCustomExpression',
				expressionIntent: getExprIntent(expr),
				alias,
			},
		],
	};
	return compilePlan(plan);
}

// ============================================================================
// aggOrderBy() — intent structure unit tests
// ============================================================================

describe('aggOrderBy() — intent structure', () => {
	it('creates AggOrderByArg with default direction asc', () => {
		const ob = aggOrderBy('path');
		expect(ob).toEqual({ __aggOrderBy: true, field: 'path', direction: 'asc' });
	});

	it('creates AggOrderByArg with explicit asc', () => {
		const ob = aggOrderBy('path', 'asc');
		expect(ob).toEqual({ __aggOrderBy: true, field: 'path', direction: 'asc' });
	});

	it('creates AggOrderByArg with desc direction', () => {
		const ob = aggOrderBy('line', 'desc');
		expect(ob).toEqual({
			__aggOrderBy: true,
			field: 'line',
			direction: 'desc',
		});
	});
});

// ============================================================================
// fn() with aggOrderBy — intent building unit tests
// ============================================================================

describe('fn() with aggOrderBy — intent building', () => {
	it('fn without aggOrderBy: no aggOrderBy field on intent', () => {
		const expr = fn('array_agg', ref('name'));
		const intent = getExprIntent(expr);
		expect(intent.kind).toBe('customFn');
		expect(intent.aggOrderBy).toBeUndefined();
		expect(intent.args).toHaveLength(1);
	});

	it('fn with single aggOrderBy: separates from args', () => {
		const expr = fn('array_agg', ref('name'), aggOrderBy('path'));
		const intent = getExprIntent(expr);
		// aggOrderBy is NOT in args
		expect(intent.args).toHaveLength(1);
		// aggOrderBy goes into aggOrderBy field
		expect(intent.aggOrderBy).toHaveLength(1);
		const ob = intent.aggOrderBy![0] as AggOrderByArg;
		expect(ob.field).toBe('path');
		expect(ob.direction).toBe('asc');
	});

	it('fn with multiple aggOrderBy entries: all collected in aggOrderBy field', () => {
		const expr = fn(
			'array_agg',
			ref('name'),
			aggOrderBy('path'),
			aggOrderBy('line', 'desc'),
		);
		const intent = getExprIntent(expr);
		expect(intent.args).toHaveLength(1);
		expect(intent.aggOrderBy).toHaveLength(2);
		expect(intent.aggOrderBy![0]).toMatchObject({
			field: 'path',
			direction: 'asc',
		});
		expect(intent.aggOrderBy![1]).toMatchObject({
			field: 'line',
			direction: 'desc',
		});
	});

	it('fn with aggOrderBy after separator arg (string_agg style)', () => {
		const expr = fn(
			'string_agg',
			ref('name'),
			literal(','),
			aggOrderBy('name'),
		);
		const intent = getExprIntent(expr);
		// Both ref('name') and literal(',') are regular args
		expect(intent.args).toHaveLength(2);
		expect(intent.aggOrderBy).toHaveLength(1);
		expect(intent.aggOrderBy![0]).toMatchObject({
			field: 'name',
			direction: 'asc',
		});
	});
});

// ============================================================================
// fn() with aggOrderBy — SQL compilation tests
//
// Note on rendering in the compile-only context:
// - ExpressionRef (ref('name')) args compile to $N parameters in the test context.
// - String shorthand args ('name') compile to unquoted column names.
// - ORDER BY fields compile without quotes: path, line etc.
// - literal(',') compiles to ', ' (with space, SQL string literal style).
// ============================================================================

describe('fn() with aggOrderBy — SQL output', () => {
	it('fn("array_agg", ref("name")) without ORDER BY → array_agg(name) — no ORDER BY', () => {
		const expr = fn('array_agg', ref('name')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name)');
		expect(sql).not.toContain('order by');
		expect(result.parameters).toEqual([]);
	});

	it('fn("array_agg", ref("name"), aggOrderBy("path")) → array_agg(name ORDER BY path ASC)', () => {
		const expr = fn('array_agg', ref('name'), aggOrderBy('path')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path asc)');
		expect(result.parameters).toEqual([]);
	});

	it('fn("array_agg", ref("name"), aggOrderBy("path", "desc")) → array_agg(name ORDER BY path DESC)', () => {
		const expr = fn('array_agg', ref('name'), aggOrderBy('path', 'desc')).as(
			'names',
		);
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path desc)');
		expect(result.parameters).toEqual([]);
	});

	it('fn("string_agg", ref("name"), literal(","), aggOrderBy("name")) → string_agg(name, \', \' ORDER BY name ASC)', () => {
		const expr = fn(
			'string_agg',
			ref('name'),
			literal(','),
			aggOrderBy('name'),
		).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		// normalizeSQL replaces all commas (including inside string literals) with ', '
		expect(sql).toContain("string_agg(name, ', ' order by name asc)");
		expect(result.parameters).toEqual([]);
	});

	it('multiple aggOrderBy: fn("array_agg", ..., aggOrderBy("path"), aggOrderBy("line", "desc")) → array_agg(name ORDER BY path ASC, line DESC)', () => {
		const expr = fn(
			'array_agg',
			ref('name'),
			aggOrderBy('path'),
			aggOrderBy('line', 'desc'),
		).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path asc, line desc)');
		expect(result.parameters).toEqual([]);
	});

	it('fn without aggOrderBy does not produce ORDER BY inside aggregate', () => {
		const expr = fn('array_agg', exprRef('name')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).not.toContain('order by');
	});
});

// ============================================================================
// arrayAgg() helper — SQL compilation tests
// ============================================================================

describe('arrayAgg() helper', () => {
	it('arrayAgg(ref("name")) → array_agg(name) — no ORDER BY', () => {
		const expr = arrayAgg(ref('name')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name)');
		expect(sql).not.toContain('order by');
	});

	it('arrayAgg(ref("name"), aggOrderBy("path")) → array_agg(name ORDER BY path ASC)', () => {
		const expr = arrayAgg(ref('name'), aggOrderBy('path')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path asc)');
	});

	it('arrayAgg("name", aggOrderBy("path", "desc")) — string shorthand col → array_agg(name ORDER BY path DESC)', () => {
		const expr = arrayAgg('name', aggOrderBy('path', 'desc')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path desc)');
	});

	it('arrayAgg with multiple orderBy entries → array_agg(name ORDER BY path ASC, line DESC)', () => {
		const expr = arrayAgg(
			ref('name'),
			aggOrderBy('path'),
			aggOrderBy('line', 'desc'),
		).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		expect(sql).toContain('array_agg(name order by path asc, line desc)');
	});
});

// ============================================================================
// stringAgg() helper — SQL compilation tests
// ============================================================================

describe('stringAgg() helper', () => {
	it('stringAgg(ref("name"), literal(",")) → string_agg(name, \', \') — no ORDER BY', () => {
		const expr = stringAgg(ref('name'), literal(',')).as('names');
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		// normalizeSQL replaces all commas with ', ' including those inside string literals
		expect(sql).toContain("string_agg(name, ', ')");
		expect(sql).not.toContain('order by');
	});

	it('stringAgg(ref("name"), literal(","), aggOrderBy("name")) → string_agg(name, \', \' ORDER BY name ASC)', () => {
		const expr = stringAgg(ref('name'), literal(','), aggOrderBy('name')).as(
			'names',
		);
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		// normalizeSQL replaces all commas with ', ' including those inside string literals
		expect(sql).toContain("string_agg(name, ', ' order by name asc)");
	});

	it("stringAgg with string shorthand for col → string_agg(name, ', ' ORDER BY name DESC)", () => {
		const expr = stringAgg('name', literal(','), aggOrderBy('name', 'desc')).as(
			'names',
		);
		const result = compilePlanFromExpr(expr, 'names');
		const sql = normalizeSQL(result.sql);
		// normalizeSQL replaces all commas with ', ' including those inside string literals
		expect(sql).toContain("string_agg(name, ', ' order by name desc)");
	});
});
