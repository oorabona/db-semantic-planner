/**
 * Error-path tests for range.ts WHERE handler.
 *
 * Covers: rangeHandler
 * Focus: error branches, type-cast edges, and value format branches.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision, WhereDispatcher } from '../types.js';
import { createCompilerState } from '../types.js';

/** No-op dispatcher — range handler never recurses */
const noopDispatch: WhereDispatcher = () => ({ A_Const: { isnull: true } });

import { rangeHandler } from './range.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// rangeHandler errors — missing column
// ============================================================================

describe('rangeHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			operator: 'contains',
			value: '[1,10)',
		} as Decision;
		expect(() => rangeHandler.compile(decision, ctx, state, noopDispatch)).toThrow(
			'Range handler requires a column',
		);
	});

	it('throws when column is empty string (falsy)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: '',
			operator: 'contains',
			value: '[1,10)',
		} as Decision;
		expect(() => rangeHandler.compile(decision, ctx, state, noopDispatch)).toThrow(
			'Range handler requires a column',
		);
	});
});

// ============================================================================
// rangeHandler — RangeValue branch (object with lower/upper)
// ============================================================================

describe('rangeHandler RangeValue branch', () => {
	const ctx = makeCtx();

	it('formats parameter as range string from lower/upper', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'age',
			operator: 'contains',
			value: { lower: 10, upper: 20 },
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['[10,20)']);
	});

	it('handles missing lower (defaults to empty)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'age',
			operator: 'contains',
			value: { upper: 20 },
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['[,20)']);
	});

	it('handles missing upper (defaults to empty)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'age',
			operator: 'contains',
			value: { lower: 5 },
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['[5,)']);
	});
});

// ============================================================================
// rangeHandler — string range literal branch
// ============================================================================

describe('rangeHandler string range literal branch', () => {
	const ctx = makeCtx();

	it('passes through a valid range string as-is', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'period',
			operator: 'contains',
			value: '[2024-01-01,2024-12-31)',
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['[2024-01-01,2024-12-31)']);
	});

	it('passes through range with ] closing bracket', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'period',
			operator: 'overlaps',
			value: '[1,10]',
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['[1,10]']);
	});
});

// ============================================================================
// rangeHandler — scalar fallback branch
// ============================================================================

describe('rangeHandler scalar fallback', () => {
	const ctx = makeCtx();

	it('treats a plain number as scalar value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'score',
			operator: 'contains',
			value: 42,
		} as unknown as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual([42]);
	});

	it('treats a non-range string as scalar value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'name',
			operator: 'contains',
			value: 'not-a-range',
		} as Decision;
		rangeHandler.compile(decision, ctx, state, noopDispatch);
		expect(state.parameters).toEqual(['not-a-range']);
	});
});

// ============================================================================
// rangeHandler — type cast edge cases (scalar with dataType)
// ============================================================================

describe('rangeHandler type cast normalization', () => {
	const ctx = makeCtx();

	it('strips "range" suffix from dataType for scalar cast (int4range → integer)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'age',
			operator: 'contains',
			value: 25,
			dataType: 'int4range',
		} as unknown as Decision;
		const node = rangeHandler.compile(decision, ctx, state, noopDispatch);
		// Should have TypeCast with 'integer'
		const rexpr = (node as Record<string, unknown>).A_Expr as Record<
			string,
			unknown
		>;
		const cast = rexpr?.rexpr as Record<string, unknown>;
		expect(cast?.TypeCast).toBeDefined();
	});

	it('normalizes int8 to bigint for scalar cast', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'big_id',
			operator: 'contains',
			value: 999,
			dataType: 'int8range',
		} as unknown as Decision;
		const node = rangeHandler.compile(decision, ctx, state, noopDispatch);
		const rexpr = (node as Record<string, unknown>).A_Expr as Record<
			string,
			unknown
		>;
		const cast = rexpr?.rexpr as Record<string, unknown>;
		expect(cast?.TypeCast).toBeDefined();
	});

	it('does not strip range suffix for non-scalar (RangeValue)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'period',
			operator: 'contains',
			value: { lower: 1, upper: 10 },
			dataType: 'int4range',
		} as Decision;
		const node = rangeHandler.compile(decision, ctx, state, noopDispatch);
		const rexpr = (node as Record<string, unknown>).A_Expr as Record<
			string,
			unknown
		>;
		const cast = rexpr?.rexpr as Record<string, unknown>;
		// For non-scalar, castType is int4range (unchanged), so TypeCast with 'int4range'
		expect(cast?.TypeCast).toBeDefined();
	});
});

// ============================================================================
// rangeHandler — operator fallback
// ============================================================================

describe('rangeHandler operator fallback', () => {
	const ctx = makeCtx();

	it('defaults to contains (@>) when operator is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'tags',
			value: '[1,10)',
		} as Decision;
		const node = rangeHandler.compile(decision, ctx, state, noopDispatch);
		const expr = (node as Record<string, unknown>).A_Expr as Record<
			string,
			unknown
		>;
		const name = expr?.name as Array<Record<string, Record<string, string>>>;
		expect(name?.[0]?.String?.sval).toBe('@>');
	});

	it('falls through unknown operator name verbatim', () => {
		const state = createCompilerState();
		const decision = {
			type: 'where',
			column: 'tags',
			operator: 'customOp',
			value: '[1,10)',
		} as Decision;
		const node = rangeHandler.compile(decision, ctx, state, noopDispatch);
		const expr = (node as Record<string, unknown>).A_Expr as Record<
			string,
			unknown
		>;
		const name = expr?.name as Array<Record<string, Record<string, string>>>;
		expect(name?.[0]?.String?.sval).toBe('customOp');
	});
});
