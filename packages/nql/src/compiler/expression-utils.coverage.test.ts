// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for expression-utils.ts — exercises all uncovered branches
 * in pure expression utility functions: expressionToField, expressionToValue,
 * expressionToSql, expressionToRangeValue, resolveFilterValue,
 * isAggregateFunction, mapComparisonOperator, validateWhereField.
 */

import { getNqlBindingRefName, isNqlBindingRef } from '@dbsp/types/internal';
import { describe, expect, it, vi } from 'vitest';
import { NqlErrorCodes, NqlSemanticException } from '../errors/types.js';
import type {
	NqlBinaryExpression,
	NqlBooleanLiteral,
	NqlExpression,
	NqlFunctionCall,
	NqlNullLiteral,
	NqlNumberLiteral,
	NqlPathExpression,
	NqlRangeLiteral,
	NqlStringLiteral,
	NqlUnaryExpression,
} from '../parser/ast.js';
import {
	expressionToField,
	expressionToRangeValue,
	expressionToSql,
	expressionToValue,
	isAggregateFunction,
	mapComparisonOperator,
	resolveFilterValue,
	validateWhereField,
} from './expression-utils.js';
import type { CompilerContext } from './types.js';

function expectNqlBindingRef(value: unknown, name: string): void {
	expect(isNqlBindingRef(value)).toBe(true);
	expect(getNqlBindingRefName(value)).toBe(name);
}

// ============================================================================
// expressionToField
// ============================================================================

describe('expressionToField', () => {
	it('returns field name for single-segment path', () => {
		const expr: NqlPathExpression = { type: 'path', segments: ['name'] };
		expect(expressionToField(expr)).toBe('name');
	});

	it('returns dotted field for multi-segment path', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['users', 'name'],
		};
		expect(expressionToField(expr)).toBe('users.name');
	});

	it('strips aliasContext prefix from path', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['o', 'status'],
		};
		expect(expressionToField(expr, 'o')).toBe('status');
	});

	it('strips aliasContext prefix with deep path', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['o', 'item', 'name'],
		};
		expect(expressionToField(expr, 'o')).toBe('item.name');
	});

	it('does not strip when single segment matches alias', () => {
		const expr: NqlPathExpression = { type: 'path', segments: ['o'] };
		// Single segment — aliasContext stripping requires length > 1
		expect(expressionToField(expr, 'o')).toBe('o');
	});

	it('does not strip when first segment does not match alias', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['x', 'status'],
		};
		expect(expressionToField(expr, 'o')).toBe('x.status');
	});

	it('returns null for non-path expression', () => {
		const expr: NqlNumberLiteral = { type: 'number', value: 42 };
		expect(expressionToField(expr)).toBeNull();
	});

	it('returns null for string literal', () => {
		const expr: NqlStringLiteral = { type: 'string', value: 'hello' };
		expect(expressionToField(expr)).toBeNull();
	});

	it('returns null for boolean literal', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: true };
		expect(expressionToField(expr)).toBeNull();
	});

	it('returns null for null literal', () => {
		const expr: NqlNullLiteral = { type: 'null' };
		expect(expressionToField(expr)).toBeNull();
	});
});

// ============================================================================
// expressionToValue
// ============================================================================

describe('expressionToValue', () => {
	it('converts string literal', () => {
		const expr: NqlStringLiteral = { type: 'string', value: 'hello' };
		expect(expressionToValue(expr)).toBe('hello');
	});

	it('converts number literal', () => {
		const expr: NqlNumberLiteral = { type: 'number', value: 42 };
		expect(expressionToValue(expr)).toBe(42);
	});

	it('converts boolean true', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: true };
		expect(expressionToValue(expr)).toBe(true);
	});

	it('converts boolean false', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: false };
		expect(expressionToValue(expr)).toBe(false);
	});

	it('converts null literal', () => {
		const expr: NqlNullLiteral = { type: 'null' };
		expect(expressionToValue(expr)).toBeNull();
	});

	it('converts path to branded binding ref', () => {
		const expr: NqlPathExpression = { type: 'path', segments: ['name'] };
		const value = expressionToValue(expr);

		expectNqlBindingRef(value, 'name');
		expect(isNqlBindingRef({ name: 'name' })).toBe(false);
		expect(isNqlBindingRef({ $ref: 'name' })).toBe(false);
		expect(isNqlBindingRef(JSON.parse(JSON.stringify(value)))).toBe(false);
	});

	it('converts dotted path to branded binding ref', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['users', 'name'],
		};
		expectNqlBindingRef(expressionToValue(expr), 'users.name');
	});

	it('converts function call to $fn', () => {
		const expr: NqlFunctionCall = {
			type: 'function',
			name: 'now',
			args: [],
		};
		expect(expressionToValue(expr)).toEqual({ $fn: 'now', $args: [] });
	});

	it('converts function call with args', () => {
		const expr: NqlFunctionCall = {
			type: 'function',
			name: 'upper',
			args: [{ type: 'path', segments: ['name'] } as NqlPathExpression],
		};
		const value = expressionToValue(expr) as {
			$fn: string;
			$args: readonly unknown[];
		};

		expect(value.$fn).toBe('upper');
		expectNqlBindingRef(value.$args[0], 'name');
	});

	it('converts binary expression to $op', () => {
		const expr: NqlBinaryExpression = {
			type: 'binary',
			operator: '+',
			left: { type: 'number', value: 1 } as NqlNumberLiteral,
			right: { type: 'number', value: 2 } as NqlNumberLiteral,
		};
		expect(expressionToValue(expr)).toEqual({
			$op: '+',
			$left: 1,
			$right: 2,
		});
	});

	it('converts binary expression with field refs', () => {
		const expr: NqlBinaryExpression = {
			type: 'binary',
			operator: '*',
			left: { type: 'path', segments: ['price'] } as NqlPathExpression,
			right: { type: 'path', segments: ['qty'] } as NqlPathExpression,
		};
		const value = expressionToValue(expr) as {
			$op: string;
			$left: unknown;
			$right: unknown;
		};

		expect(value.$op).toBe('*');
		expectNqlBindingRef(value.$left, 'price');
		expectNqlBindingRef(value.$right, 'qty');
	});

	it('converts unary minus with number operand to negated number', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: '-',
			operand: { type: 'number', value: 5 } as NqlNumberLiteral,
		};
		expect(expressionToValue(expr)).toBe(-5);
	});

	it('converts unary minus with zero to negative zero', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: '-',
			operand: { type: 'number', value: 0 } as NqlNumberLiteral,
		};
		expect(expressionToValue(expr)).toBe(-0);
	});

	it('converts unary minus with non-number to multiplication by -1', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: '-',
			operand: { type: 'path', segments: ['price'] } as NqlPathExpression,
		};
		const value = expressionToValue(expr) as {
			$op: string;
			$left: unknown;
			$right: unknown;
		};

		expect(value.$op).toBe('*');
		expect(value.$left).toBe(-1);
		expectNqlBindingRef(value.$right, 'price');
	});

	it('throws for unsupported unary operator', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: 'not',
			operand: { type: 'boolean', value: true } as NqlBooleanLiteral,
		};
		expect(() => expressionToValue(expr)).toThrow(
			/Unsupported unary operator in value context: not/,
		);
	});

	it('converts rangeLiteral with inclusive bounds', () => {
		const expr: NqlRangeLiteral = {
			type: 'rangeLiteral',
			value: '[1,10]',
			lowerInclusive: true,
			upperInclusive: true,
			lower: '1',
			upper: '10',
		};
		expect(expressionToValue(expr)).toBe('[1,10]');
	});

	it('converts rangeLiteral with exclusive bounds', () => {
		const expr: NqlRangeLiteral = {
			type: 'rangeLiteral',
			value: '(1,10)',
			lowerInclusive: false,
			upperInclusive: false,
			lower: '1',
			upper: '10',
		};
		expect(expressionToValue(expr)).toBe('(1,10)');
	});

	it('converts rangeLiteral with mixed bounds [lower, upper)', () => {
		const expr: NqlRangeLiteral = {
			type: 'rangeLiteral',
			value: '[1,10)',
			lowerInclusive: true,
			upperInclusive: false,
			lower: '1',
			upper: '10',
		};
		expect(expressionToValue(expr)).toBe('[1,10)');
	});

	it('converts rangeLiteral with mixed bounds (lower, upper]', () => {
		const expr: NqlRangeLiteral = {
			type: 'rangeLiteral',
			value: '(1,10]',
			lowerInclusive: false,
			upperInclusive: true,
			lower: '1',
			upper: '10',
		};
		expect(expressionToValue(expr)).toBe('(1,10]');
	});

	it('throws for unsupported expression type', () => {
		// Cast to NqlExpression to simulate an unknown type
		const expr = {
			type: 'jsonAccess',
			base: { type: 'path', segments: ['data'] },
			path: ['key'],
			mode: 'json',
		} as NqlExpression;
		expect(() => expressionToValue(expr)).toThrow(
			/Cannot convert jsonAccess to value/,
		);
	});
});

// ============================================================================
// expressionToSql
// ============================================================================

describe('expressionToSql', () => {
	it('converts path to dotted SQL identifier', () => {
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['users', 'name'],
		};
		expect(expressionToSql(expr)).toBe('users.name');
	});

	it('converts single-segment path', () => {
		const expr: NqlPathExpression = { type: 'path', segments: ['name'] };
		expect(expressionToSql(expr)).toBe('name');
	});

	it('converts string literal with SQL quoting', () => {
		const expr: NqlStringLiteral = { type: 'string', value: 'hello' };
		expect(expressionToSql(expr)).toBe("'hello'");
	});

	it('converts string with embedded single quote', () => {
		const expr: NqlStringLiteral = { type: 'string', value: "it's" };
		expect(expressionToSql(expr)).toBe("'it''s'");
	});

	it('converts integer number', () => {
		const expr: NqlNumberLiteral = { type: 'number', value: 42 };
		expect(expressionToSql(expr)).toBe('42');
	});

	it('converts float number', () => {
		const expr: NqlNumberLiteral = { type: 'number', value: 3.14 };
		expect(expressionToSql(expr)).toBe('3.14');
	});

	it('converts boolean true', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: true };
		expect(expressionToSql(expr)).toBe('true');
	});

	it('converts boolean false', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: false };
		expect(expressionToSql(expr)).toBe('false');
	});

	it('converts null to NULL', () => {
		const expr: NqlNullLiteral = { type: 'null' };
		expect(expressionToSql(expr)).toBe('NULL');
	});

	it('converts function call with no args', () => {
		const expr: NqlFunctionCall = {
			type: 'function',
			name: 'now',
			args: [],
		};
		expect(expressionToSql(expr)).toBe('now()');
	});

	it('converts function call with args', () => {
		const expr: NqlFunctionCall = {
			type: 'function',
			name: 'upper',
			args: [{ type: 'path', segments: ['name'] } as NqlPathExpression],
		};
		expect(expressionToSql(expr)).toBe('upper(name)');
	});

	it('converts function call with multiple args', () => {
		const expr: NqlFunctionCall = {
			type: 'function',
			name: 'coalesce',
			args: [
				{ type: 'path', segments: ['name'] } as NqlPathExpression,
				{ type: 'string', value: 'unknown' } as NqlStringLiteral,
			],
		};
		expect(expressionToSql(expr)).toBe("coalesce(name, 'unknown')");
	});

	it('converts binary expression to parenthesized SQL', () => {
		const expr: NqlBinaryExpression = {
			type: 'binary',
			operator: '+',
			left: { type: 'number', value: 1 } as NqlNumberLiteral,
			right: { type: 'number', value: 2 } as NqlNumberLiteral,
		};
		expect(expressionToSql(expr)).toBe('(1 + 2)');
	});

	it('converts nested binary expressions', () => {
		const expr: NqlBinaryExpression = {
			type: 'binary',
			operator: '*',
			left: {
				type: 'binary',
				operator: '+',
				left: { type: 'number', value: 1 } as NqlNumberLiteral,
				right: { type: 'number', value: 2 } as NqlNumberLiteral,
			} as NqlBinaryExpression,
			right: { type: 'number', value: 3 } as NqlNumberLiteral,
		};
		expect(expressionToSql(expr)).toBe('((1 + 2) * 3)');
	});

	it('converts unary expression', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: '-',
			operand: { type: 'number', value: 5 } as NqlNumberLiteral,
		};
		expect(expressionToSql(expr)).toBe('- 5');
	});

	it('converts unary not expression', () => {
		const expr: NqlUnaryExpression = {
			type: 'unary',
			operator: 'not',
			operand: { type: 'path', segments: ['active'] } as NqlPathExpression,
		};
		expect(expressionToSql(expr)).toBe('not active');
	});

	it('throws NqlSemanticException for unknown expression type (L-7)', () => {
		const expr = {
			type: 'jsonAccess',
			base: { type: 'path', segments: ['data'] },
			path: ['key'],
			mode: 'json',
		} as NqlExpression;
		// L-7: the old default was String(expr) → '[object Object]' — now throws.
		// This is a programming error (unrecognised expr type); the caller surfaces it.
		// Assert typed exception contract: both the class and the error code must match.
		let caught: unknown;
		try {
			expressionToSql(expr);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(NqlSemanticException);
		// L-1 (R3): unknown expression type is a programming error (SEM_UNREACHABLE),
		// not a user syntax error (SEM_INVALID_SYNTAX).
		expect((caught as NqlSemanticException).code).toBe(
			NqlErrorCodes.SEM_UNREACHABLE,
		);
		expect((caught as NqlSemanticException).message).toMatch(
			/Cannot convert expression type 'jsonAccess' to SQL fragment/,
		);
	});
});

// ============================================================================
// expressionToRangeValue
// ============================================================================

describe('expressionToRangeValue', () => {
	it('converts rangeLiteral to its value', () => {
		const expr: NqlRangeLiteral = {
			type: 'rangeLiteral',
			value: '[1,10)',
			lowerInclusive: true,
			upperInclusive: false,
			lower: '1',
			upper: '10',
		};
		expect(expressionToRangeValue(expr)).toBe('[1,10)');
	});

	it('converts number to string', () => {
		const expr: NqlNumberLiteral = { type: 'number', value: 25 };
		expect(expressionToRangeValue(expr)).toBe('25');
	});

	it('converts string literal to its value', () => {
		const expr: NqlStringLiteral = { type: 'string', value: '2024-01-01' };
		expect(expressionToRangeValue(expr)).toBe('2024-01-01');
	});

	it('throws for unsupported type', () => {
		const expr: NqlBooleanLiteral = { type: 'boolean', value: true };
		expect(() => expressionToRangeValue(expr)).toThrow(
			/Range operator requires a range literal or scalar value, got boolean/,
		);
	});

	it('throws for path expression', () => {
		const expr: NqlPathExpression = { type: 'path', segments: ['col'] };
		expect(() => expressionToRangeValue(expr)).toThrow(
			/Range operator requires a range literal or scalar value, got path/,
		);
	});
});

// ============================================================================
// resolveFilterValue
// ============================================================================

describe('resolveFilterValue', () => {
	const makeCtx = (overrides?: Partial<CompilerContext>): CompilerContext => ({
		currentFromTable: 'users',
		currentRelationTarget: 'posts',
		pseudoColumnKeywords: new Set(),
		recursiveKeywords: new Set(),
		validator: null,
		bindingOutputColumns: new Map(),
		...overrides,
	});

	it('delegates to expressionToValue when no aliasContext', () => {
		const ctx = makeCtx();
		const expr: NqlStringLiteral = { type: 'string', value: 'hello' };
		expect(resolveFilterValue(expr, ctx)).toBe('hello');
	});

	it('returns inner FieldRef for alias-prefixed path', () => {
		const ctx = makeCtx();
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['r', 'status'],
		};
		const result = resolveFilterValue(expr, ctx, 'r');
		expect(result).toEqual({
			kind: 'fieldRef',
			column: 'status',
			scope: 'inner',
		});
	});

	it('returns inner FieldRef with deep path after alias', () => {
		const ctx = makeCtx();
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['r', 'item', 'name'],
		};
		const result = resolveFilterValue(expr, ctx, 'r');
		expect(result).toEqual({
			kind: 'fieldRef',
			column: 'item.name',
			scope: 'inner',
		});
	});

	it('returns outer FieldRef for outerAlias-prefixed path', () => {
		const ctx = makeCtx();
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['u', 'name'],
		};
		const result = resolveFilterValue(expr, ctx, 'r', ['u']);
		expect(result).toEqual({
			kind: 'fieldRef',
			column: 'name',
			scope: 'outer',
			alias: 'u',
		});
	});

	it('returns outer FieldRef for bare column in aliased context', () => {
		const ctx = makeCtx();
		const expr: NqlPathExpression = { type: 'path', segments: ['email'] };
		const result = resolveFilterValue(expr, ctx, 'r');
		expect(result).toEqual({
			kind: 'fieldRef',
			column: 'email',
			scope: 'outer',
		});
	});

	it('returns standard value for non-path expression in aliased context', () => {
		const ctx = makeCtx();
		const expr: NqlStringLiteral = { type: 'string', value: 'active' };
		const result = resolveFilterValue(expr, ctx, 'r');
		expect(result).toBe('active');
	});

	it('returns standard value for number literal in aliased context', () => {
		const ctx = makeCtx();
		const expr: NqlNumberLiteral = { type: 'number', value: 42 };
		const result = resolveFilterValue(expr, ctx, 'r');
		expect(result).toBe(42);
	});

	it('validates inner column when validator is provided', () => {
		const validateColumn = vi.fn();
		const ctx = makeCtx({
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
			currentRelationTarget: 'orders',
		});
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['r', 'status'],
		};
		resolveFilterValue(expr, ctx, 'r');
		expect(validateColumn).toHaveBeenCalledWith('orders', 'status');
	});

	it('validates outer column when validator is provided and outerAlias used', () => {
		const validateColumn = vi.fn();
		const ctx = makeCtx({
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
			currentFromTable: 'users',
		});
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['u', 'name'],
		};
		resolveFilterValue(expr, ctx, 'r', ['u']);
		expect(validateColumn).toHaveBeenCalledWith('users', 'name');
	});

	it('validates bare column against root table', () => {
		const validateColumn = vi.fn();
		const ctx = makeCtx({
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
			currentFromTable: 'users',
		});
		const expr: NqlPathExpression = { type: 'path', segments: ['email'] };
		resolveFilterValue(expr, ctx, 'r');
		expect(validateColumn).toHaveBeenCalledWith('users', 'email');
	});

	it('skips validation for dotted inner column', () => {
		const validateColumn = vi.fn();
		const ctx = makeCtx({
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
			currentRelationTarget: 'orders',
		});
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['r', 'item', 'name'],
		};
		resolveFilterValue(expr, ctx, 'r');
		// Dotted column (item.name) — validation skipped because includes '.'
		expect(validateColumn).not.toHaveBeenCalled();
	});

	it('skips validation when no currentRelationTarget for inner scope', () => {
		const validateColumn = vi.fn();
		const ctx = makeCtx({
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
			currentRelationTarget: undefined,
		});
		const expr: NqlPathExpression = {
			type: 'path',
			segments: ['r', 'status'],
		};
		resolveFilterValue(expr, ctx, 'r');
		expect(validateColumn).not.toHaveBeenCalled();
	});
});

// ============================================================================
// isAggregateFunction
// ============================================================================

describe('isAggregateFunction', () => {
	it('returns true for count', () => {
		expect(isAggregateFunction('count')).toBe(true);
	});

	it('returns true for sum', () => {
		expect(isAggregateFunction('sum')).toBe(true);
	});

	it('returns true for avg', () => {
		expect(isAggregateFunction('avg')).toBe(true);
	});

	it('returns true for min', () => {
		expect(isAggregateFunction('min')).toBe(true);
	});

	it('returns true for max', () => {
		expect(isAggregateFunction('max')).toBe(true);
	});

	it('returns false for array_agg', () => {
		expect(isAggregateFunction('array_agg')).toBe(false);
	});

	it('returns false for string_agg', () => {
		expect(isAggregateFunction('string_agg')).toBe(false);
	});

	it('is case-insensitive', () => {
		expect(isAggregateFunction('COUNT')).toBe(true);
		expect(isAggregateFunction('SUM')).toBe(true);
		expect(isAggregateFunction('Avg')).toBe(true);
	});

	it('returns false for non-aggregate functions', () => {
		expect(isAggregateFunction('upper')).toBe(false);
		expect(isAggregateFunction('now')).toBe(false);
		expect(isAggregateFunction('coalesce')).toBe(false);
		expect(isAggregateFunction('rank')).toBe(false);
	});
});

// ============================================================================
// mapComparisonOperator
// ============================================================================

describe('mapComparisonOperator', () => {
	it('maps = to eq', () => {
		expect(mapComparisonOperator('=')).toBe('eq');
	});

	it('maps != to neq', () => {
		expect(mapComparisonOperator('!=')).toBe('neq');
	});

	it('maps < to lt', () => {
		expect(mapComparisonOperator('<')).toBe('lt');
	});

	it('maps > to gt', () => {
		expect(mapComparisonOperator('>')).toBe('gt');
	});

	it('maps <= to lte', () => {
		expect(mapComparisonOperator('<=')).toBe('lte');
	});

	it('maps >= to gte', () => {
		expect(mapComparisonOperator('>=')).toBe('gte');
	});

	it('throws for unsupported operator (like)', () => {
		expect(() => mapComparisonOperator('like')).toThrow(
			/Cannot map operator like to ComparisonOperator/,
		);
	});
});

// ============================================================================
// validateWhereField
// ============================================================================

describe('validateWhereField', () => {
	it('does nothing when no validator', () => {
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: undefined,
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			validator: null,
			bindingOutputColumns: new Map(),
		};
		// Should not throw
		validateWhereField(ctx, 'name');
	});

	it('validates simple column against root table', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: undefined,
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		validateWhereField(ctx, 'name');
		expect(validateColumn).toHaveBeenCalledWith('users', 'name');
	});

	it('validates inner scope column with aliasContext', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: 'orders',
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		const originalExpr: NqlPathExpression = {
			type: 'path',
			segments: ['o', 'status'],
		};
		validateWhereField(ctx, 'status', 'o', originalExpr);
		expect(validateColumn).toHaveBeenCalledWith('orders', 'status');
	});

	it('validates outer scope column with aliasContext (non-alias path)', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: 'orders',
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		// Path that doesn't start with alias → outer scope
		const originalExpr: NqlPathExpression = {
			type: 'path',
			segments: ['email'],
		};
		validateWhereField(ctx, 'email', 'o', originalExpr);
		expect(validateColumn).toHaveBeenCalledWith('users', 'email');
	});

	it('validates against relation target when no aliasContext and currentRelationTarget set', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: 'orders',
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		validateWhereField(ctx, 'status');
		expect(validateColumn).toHaveBeenCalledWith('orders', 'status');
	});

	it('skips validation for dotted field with aliasContext', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: 'orders',
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		const originalExpr: NqlPathExpression = {
			type: 'path',
			segments: ['o', 'item', 'name'],
		};
		validateWhereField(ctx, 'item.name', 'o', originalExpr);
		// Dotted field — validation skipped
		expect(validateColumn).not.toHaveBeenCalled();
	});

	it('skips validation for dotted field on root table', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: 'users',
			currentRelationTarget: undefined,
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		validateWhereField(ctx, 'data.key');
		expect(validateColumn).not.toHaveBeenCalled();
	});

	it('skips validation when no currentFromTable and no currentRelationTarget', () => {
		const validateColumn = vi.fn();
		const ctx: CompilerContext = {
			currentFromTable: undefined,
			currentRelationTarget: undefined,
			pseudoColumnKeywords: new Set(),
			recursiveKeywords: new Set(),
			bindingOutputColumns: new Map(),
			validator: {
				validateTable: vi.fn(),
				validateColumn,
				resolveRelationTarget: vi.fn(),
			},
		};
		validateWhereField(ctx, 'name');
		expect(validateColumn).not.toHaveBeenCalled();
	});
});
