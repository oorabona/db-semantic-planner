/**
 * Tests for range operator helpers (packages/core/src/dx/range.ts).
 *
 * Covers:
 * - Tuple API → ExpressionRef with op('&&' | '@>' | '<@', ref(col), fn(rangeType, ...))
 * - Object API → WhereRangeIntent (backward-compat planner path)
 * - Default rangeType ('daterange')
 * - Custom rangeType (int4range, tsrange, etc.)
 */

import { describe, expect, it } from 'vitest';
import { rangeContainedBy, rangeContains, rangeOverlaps } from '../range.js';

// ---------------------------------------------------------------------------
// Helpers: inspect ExpressionRef intent tree
// ---------------------------------------------------------------------------

function intentOf(expr: { intent?: unknown }) {
	return expr.intent;
}

// ---------------------------------------------------------------------------
// rangeOverlaps
// ---------------------------------------------------------------------------

describe('rangeOverlaps', () => {
	describe('tuple API → ExpressionRef', () => {
		it('produces && operator with default daterange constructor', () => {
			const expr = rangeOverlaps('period', ['2024-01-01', '2024-01-31']);

			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			expect(intent.kind).toBe('customOp');
			expect(intent.operator).toBe('&&');

			const left = intent.left as Record<string, unknown>;
			expect(left.kind).toBe('ref');
			expect(left.column).toBe('period');

			const right = intent.right as Record<string, unknown>;
			expect(right.kind).toBe('customFn');
			expect(right.name).toBe('daterange');
			expect(Array.isArray(right.args)).toBe(true);
			const args = right.args as Array<Record<string, unknown>>;
			expect(args).toHaveLength(2);
			expect(args[0].kind).toBe('param');
			expect(args[0].value).toBe('2024-01-01');
			expect(args[1].kind).toBe('param');
			expect(args[1].value).toBe('2024-01-31');
		});

		it('respects custom int4range rangeType', () => {
			const expr = rangeOverlaps('span', [1, 100], 'int4range');
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			expect(right.kind).toBe('customFn');
			expect(right.name).toBe('int4range');
		});

		it('respects tsrange rangeType', () => {
			const expr = rangeOverlaps(
				'window',
				['2024-01-01T00:00:00', '2024-12-31T23:59:59'],
				'tsrange',
			);
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe('tsrange');
		});

		it('ExpressionRef is a proper ExpressionRef instance', () => {
			const expr = rangeOverlaps('col', ['a', 'b']);
			expect(typeof (expr as { __expr?: unknown }).__expr).toBe('boolean');
			expect((expr as { __expr?: unknown }).__expr).toBe(true);
		});
	});

	describe('object API → WhereRangeIntent (backward compat)', () => {
		it('produces WhereRangeIntent with overlaps operator', () => {
			const result = rangeOverlaps('dates', {
				lower: '2025-01-15',
				upper: '2025-01-20',
			});
			expect(result).toEqual({
				kind: 'range',
				field: 'dates',
				operator: 'overlaps',
				value: { lower: '2025-01-15', upper: '2025-01-20' },
			});
		});

		it('supports custom bounds', () => {
			const result = rangeOverlaps('period', {
				lower: 10,
				upper: 20,
				bounds: '[]',
			});
			expect(result).toEqual({
				kind: 'range',
				field: 'period',
				operator: 'overlaps',
				value: { lower: 10, upper: 20, bounds: '[]' },
			});
		});
	});
});

// ---------------------------------------------------------------------------
// rangeContains
// ---------------------------------------------------------------------------

describe('rangeContains', () => {
	describe('tuple API → ExpressionRef', () => {
		it('produces @> operator with default daterange constructor', () => {
			const expr = rangeContains('dateRange', ['2024-06-15', '2024-06-15']);
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			expect(intent.kind).toBe('customOp');
			expect(intent.operator).toBe('@>');

			const left = intent.left as Record<string, unknown>;
			expect(left.column).toBe('dateRange');

			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe('daterange');
		});

		it('respects custom numrange rangeType', () => {
			const expr = rangeContains('salary', [40000, 60000], 'numrange');
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe('numrange');
		});
	});

	describe('object API → WhereRangeIntent (backward compat)', () => {
		it('produces WhereRangeIntent for scalar value', () => {
			const result = rangeContains('salary_range', 50000);
			expect(result).toEqual({
				kind: 'range',
				field: 'salary_range',
				operator: 'contains',
				value: 50000,
			});
		});

		it('produces WhereRangeIntent for RangeValue object', () => {
			const result = rangeContains('date_range', {
				lower: '2025-01-01',
				upper: '2025-01-05',
			});
			expect(result).toEqual({
				kind: 'range',
				field: 'date_range',
				operator: 'contains',
				value: { lower: '2025-01-01', upper: '2025-01-05' },
			});
		});
	});
});

// ---------------------------------------------------------------------------
// rangeContainedBy
// ---------------------------------------------------------------------------

describe('rangeContainedBy', () => {
	describe('tuple API → ExpressionRef', () => {
		it('produces <@ operator with default daterange constructor', () => {
			const expr = rangeContainedBy('dateRange', ['2024-01-01', '2024-12-31']);
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			expect(intent.kind).toBe('customOp');
			expect(intent.operator).toBe('<@');

			const left = intent.left as Record<string, unknown>;
			expect(left.column).toBe('dateRange');

			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe('daterange');
		});

		it('respects custom int8range rangeType', () => {
			const expr = rangeContainedBy('ids', [1000, 9999], 'int8range');
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe('int8range');
		});

		it('binds both tuple elements as params', () => {
			const expr = rangeContainedBy('period', ['2024-03-01', '2024-03-31']);
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			const args = right.args as Array<Record<string, unknown>>;
			expect(args[0].value).toBe('2024-03-01');
			expect(args[1].value).toBe('2024-03-31');
		});
	});

	describe('object API → WhereRangeIntent (backward compat)', () => {
		it('produces WhereRangeIntent with containedBy operator', () => {
			const result = rangeContainedBy('event_dates', {
				lower: '2025-01-01',
				upper: '2025-12-31',
			});
			expect(result).toEqual({
				kind: 'range',
				field: 'event_dates',
				operator: 'containedBy',
				value: { lower: '2025-01-01', upper: '2025-12-31' },
			});
		});
	});
});

// ---------------------------------------------------------------------------
// Cross-cutting: all six RangeType values are accepted
// ---------------------------------------------------------------------------

describe('RangeType coverage', () => {
	const types = [
		'int4range',
		'int8range',
		'numrange',
		'tsrange',
		'tstzrange',
		'daterange',
	] as const;

	for (const rt of types) {
		it(`rangeOverlaps with rangeType='${rt}'`, () => {
			const expr = rangeOverlaps('col', [0, 1], rt);
			const intent = intentOf(expr as { intent?: unknown }) as Record<
				string,
				unknown
			>;
			const right = intent.right as Record<string, unknown>;
			expect(right.name).toBe(rt);
		});
	}
});

// ---------------------------------------------------------------------------
// Tuple validation — length guard
// ---------------------------------------------------------------------------

describe('range helpers — tuple validation', () => {
	it('throws on length-1 array', () => {
		expect(() =>
			rangeOverlaps('col', ['2024-01-01'] as unknown as [string, string]),
		).toThrow(/exactly 2/);
	});

	it('throws on length-3 array', () => {
		expect(() =>
			rangeContains('col', ['a', 'b', 'c'] as unknown as [string, string]),
		).toThrow(/exactly 2/);
	});

	it('throws on empty array', () => {
		expect(() =>
			rangeContainedBy('col', [] as unknown as [string, string]),
		).toThrow(/exactly 2/);
	});

	it('still routes object input to legacy path (WhereRangeIntent)', () => {
		const result = rangeContains('col', { lower: 1, upper: 100 });
		expect(result).toMatchObject({
			kind: 'range',
			field: 'col',
			operator: 'contains',
		});
	});
});
