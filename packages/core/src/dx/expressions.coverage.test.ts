// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Branch coverage tests for expressions.ts.
 * Targets:
 * - arrayAgg() — 0% (L430-436): string col branch + aggOrderBy branch
 * - stringAgg() — 0% (L444-451): string col branch + aggOrderBy branch
 * - fn() with aggOrderBy args (L298) — isAggOrderByArg true path
 * - fn() without aggOrderBy — aggOrderBy absent from intent
 * - filter() success path (L190) — customFn returns new ExpressionRef
 * - filter() error path — non-customFn kind
 * - aggOrderBy() default direction
 * - namedArg() invalid name
 */

import { describe, expect, it } from 'vitest';
import {
	aggOrderBy,
	arrayAgg,
	fn,
	literal,
	namedArg,
	param,
	ref,
	stringAgg,
} from './expressions.js';
import { distinct, eq } from './filters.js';

// ============================================================================
// arrayAgg — 0% coverage
// ============================================================================

describe('arrayAgg()', () => {
	it('wraps a ref column ref', () => {
		const expr = arrayAgg(ref('name'));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('array_agg');
		expect(expr.intent.args).toHaveLength(1);
		expect(expr.intent.aggOrderBy).toBeUndefined();
	});

	it('accepts a string column name (branch: typeof col === string)', () => {
		const expr = arrayAgg('name');
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('array_agg');
		expect(expr.intent.args).toHaveLength(1);
		expect(expr.intent.args[0].kind).toBe('ref');
		expect(expr.intent.args[0].column).toBe('name');
	});

	it('accepts aggOrderBy argument — ORDER BY branch', () => {
		const expr = arrayAgg(ref('name'), aggOrderBy('path'));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('array_agg');
		expect(expr.intent.aggOrderBy).toHaveLength(1);
		expect(expr.intent.aggOrderBy[0].field).toBe('path');
		expect(expr.intent.aggOrderBy[0].direction).toBe('asc');
	});

	it('accepts aggOrderBy with desc direction', () => {
		const expr = arrayAgg('name', aggOrderBy('path', 'desc'));
		expect(expr.intent.aggOrderBy[0].direction).toBe('desc');
	});

	it('accepts multiple aggOrderBy args', () => {
		const expr = arrayAgg(
			ref('name'),
			aggOrderBy('a'),
			aggOrderBy('b', 'desc'),
		);
		expect(expr.intent.aggOrderBy).toHaveLength(2);
	});

	it('accepts a DistinctField (#247 finding 3: was TS-rejected before widening the param type)', () => {
		const expr = arrayAgg(distinct('name'));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('array_agg');
		expect(expr.intent.distinct).toBe(true);
		expect(expr.intent.args).toHaveLength(1);
		expect(expr.intent.args[0]).toEqual({ kind: 'ref', column: 'name' });
	});
});

// ============================================================================
// stringAgg — 0% coverage
// ============================================================================

describe('stringAgg()', () => {
	it('wraps a ref with literal separator', () => {
		const expr = stringAgg(ref('name'), literal(','));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('string_agg');
		expect(expr.intent.args).toHaveLength(2);
		expect(expr.intent.aggOrderBy).toBeUndefined();
	});

	it('accepts string column name (branch: typeof col === string)', () => {
		const expr = stringAgg('name', literal(','));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('string_agg');
		expect(expr.intent.args[0].kind).toBe('ref');
		expect(expr.intent.args[0].column).toBe('name');
	});

	it('accepts aggOrderBy argument', () => {
		const expr = stringAgg(ref('name'), literal(','), aggOrderBy('name'));
		expect(expr.intent.aggOrderBy).toHaveLength(1);
		expect(expr.intent.aggOrderBy[0].field).toBe('name');
	});

	it('accepts multiple aggOrderBy args', () => {
		const expr = stringAgg(
			ref('name'),
			literal(','),
			aggOrderBy('a'),
			aggOrderBy('b', 'desc'),
		);
		expect(expr.intent.aggOrderBy).toHaveLength(2);
	});

	it('accepts a DistinctField (#247 finding 3: was TS-rejected before widening the param type)', () => {
		const expr = stringAgg(distinct('name'), literal(','));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.name).toBe('string_agg');
		expect(expr.intent.distinct).toBe(true);
		expect(expr.intent.args).toHaveLength(2);
		expect(expr.intent.args[0]).toEqual({ kind: 'ref', column: 'name' });
	});
});

// ============================================================================
// fn() — aggOrderBy branch (L298): isAggOrderByArg(arg) === true path
// ============================================================================

describe('fn() with aggOrderBy args', () => {
	it('separates orderBy args from regular args', () => {
		const expr = fn('array_agg', ref('name'), aggOrderBy('path'));
		expect(expr.intent.kind).toBe('customFn');
		expect(expr.intent.args).toHaveLength(1);
		expect(expr.intent.aggOrderBy).toHaveLength(1);
		expect(expr.intent.aggOrderBy[0].field).toBe('path');
	});

	it('orderBy marker is NOT placed in args', () => {
		const orderBy = aggOrderBy('created_at', 'desc');
		const expr = fn('array_agg', ref('id'), orderBy);
		expect(expr.intent.args).toHaveLength(1);
		expect(expr.intent.aggOrderBy).toHaveLength(1);
	});

	it('with no aggOrderBy args, aggOrderBy absent from intent', () => {
		const expr = fn('count', ref('id'));
		expect(expr.intent.aggOrderBy).toBeUndefined();
	});

	it('with only no args, args array is empty', () => {
		const expr = fn('now');
		expect(expr.intent.args).toHaveLength(0);
		expect(expr.intent.aggOrderBy).toBeUndefined();
	});
});

// ============================================================================
// filter() — success path (L190): customFn → new ExpressionRef with filter
// ============================================================================

describe('ExpressionRef.filter()', () => {
	it('returns new ExpressionRef with filter condition on customFn', () => {
		const expr = fn('array_agg', ref('name'));
		const filtered = expr.filter(eq('active', true));
		expect(filtered.intent.kind).toBe('customFn');
		expect(filtered.intent.filter).toBeDefined();
	});

	it('original ExpressionRef is not mutated (immutable)', () => {
		const expr = fn('array_agg', ref('name'));
		expr.filter(eq('active', true));
		expect(expr.intent.filter).toBeUndefined();
	});

	it('throws on non-customFn expression (ref kind)', () => {
		const r = ref('name');
		expect(() => r.filter(eq('active', true))).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'ref'",
		);
	});

	it('throws on non-customFn expression (param kind)', () => {
		const p = param(42);
		expect(() => p.filter(eq('x', 1))).toThrow(
			"filter() can only be used on function expressions created with fn(). Got kind: 'param'",
		);
	});
});

// ============================================================================
// aggOrderBy() — default direction branch
// ============================================================================

describe('aggOrderBy()', () => {
	it('defaults to asc direction', () => {
		const ob = aggOrderBy('name');
		expect(ob.__aggOrderBy).toBe(true);
		expect(ob.field).toBe('name');
		expect(ob.direction).toBe('asc');
	});

	it('respects explicit desc direction', () => {
		const ob = aggOrderBy('name', 'desc');
		expect(ob.direction).toBe('desc');
	});
});

// ============================================================================
// namedArg() — invalid name branches
// ============================================================================

describe('namedArg() invalid name', () => {
	it('throws for empty name', () => {
		expect(() => namedArg('', literal('x'))).toThrow(
			'namedArg: invalid argument name:',
		);
	});

	it('throws for name with spaces', () => {
		expect(() => namedArg('bad name', literal('x'))).toThrow(
			'namedArg: invalid argument name:',
		);
	});
});
