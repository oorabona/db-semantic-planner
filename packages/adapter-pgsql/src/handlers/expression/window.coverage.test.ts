// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for window.ts expression handlers.
 *
 * Covers: ALL window function handlers and their branches
 * Focus: parameter defaults, count(*) special case, frame specs, PARTITION BY, ORDER BY combinations
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	denseRankHandler,
	firstValueHandler,
	genericWindowHandler,
	lagHandler,
	lastValueHandler,
	leadHandler,
	ntileHandler,
	rankHandler,
	rowNumberHandler,
} from './window.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// rowNumberHandler coverage
// ============================================================================

describe('rowNumberHandler', () => {
	const ctx = makeCtx();

	it('compiles with no PARTITION BY or ORDER BY', () => {
		const state = createCompilerState();
		const decision = { type: 'rowNumber' } as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result).toHaveProperty('FuncCall');
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('row_number');
		expect(result.FuncCall?.over).toBeDefined();
	});

	it('compiles with PARTITION BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			partition: ['dept_id'],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
	});

	it('compiles with ORDER BY ASC', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			orderBy: [{ column: 'salary', direction: 'ASC' }],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause?.[0]?.SortBy?.sortby_dir).toBe(
			'SORTBY_ASC',
		);
	});

	it('compiles with ORDER BY DESC', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			orderBy: [{ column: 'salary', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause?.[0]?.SortBy?.sortby_dir).toBe(
			'SORTBY_DESC',
		);
	});

	it('compiles with ORDER BY no direction (defaults to ASC)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			orderBy: [{ column: 'salary', direction: undefined }],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause?.[0]?.SortBy?.sortby_dir).toBe(
			'SORTBY_ASC',
		);
	});

	it('compiles with PARTITION BY and ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			partition: ['dept_id'],
			orderBy: [{ column: 'salary', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('compiles with multiple PARTITION BY columns', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			partition: ['dept_id', 'location'],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(2);
	});

	it('compiles with multiple ORDER BY columns', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			orderBy: [
				{ column: 'salary', direction: 'DESC' },
				{ column: 'name', direction: 'ASC' },
			],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(2);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'alias1' });
		const decision = {
			type: 'rowNumber',
			partition: ['dept_id'],
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctxWithAlias, state);
		// Verify alias1 is used in partition clause
		const colRef = result.FuncCall?.over?.partitionClause?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'alias1' } });
	});

	it('compiles with frame clause (currently ignored)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rowNumber',
			frame: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
		} as unknown as CompilerDecision;
		const result = rowNumberHandler.compile(decision, ctx, state);
		// Frame is currently ignored in implementation
		expect(result.FuncCall?.over).toBeDefined();
	});
});

// ============================================================================
// rankHandler coverage
// ============================================================================

describe('rankHandler', () => {
	const ctx = makeCtx();

	it('compiles with no PARTITION BY or ORDER BY', () => {
		const state = createCompilerState();
		const decision = { type: 'rank' } as CompilerDecision;
		const result = rankHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('rank');
	});

	it('compiles with PARTITION BY and ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'rank',
			partition: ['category'],
			orderBy: [{ column: 'score', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = rankHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});
});

// ============================================================================
// denseRankHandler coverage
// ============================================================================

describe('denseRankHandler', () => {
	const ctx = makeCtx();

	it('compiles with no PARTITION BY or ORDER BY', () => {
		const state = createCompilerState();
		const decision = { type: 'denseRank' } as CompilerDecision;
		const result = denseRankHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('dense_rank');
	});

	it('compiles with PARTITION BY and ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'denseRank',
			partition: ['team'],
			orderBy: [{ column: 'points', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = denseRankHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});
});

// ============================================================================
// ntileHandler coverage
// ============================================================================

describe('ntileHandler', () => {
	const ctx = makeCtx();

	it('compiles with default n=4 when value is undefined', () => {
		const state = createCompilerState();
		const decision = { type: 'ntile' } as CompilerDecision;
		const result = ntileHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('ntile');
		expect(state.parameters).toContain(4);
	});

	it('compiles with value from decision.value', () => {
		const state = createCompilerState();
		const decision = { type: 'ntile', value: 10 } as CompilerDecision;
		const result = ntileHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain(10);
	});

	it('compiles with value from decision.args[0]', () => {
		const state = createCompilerState();
		const decision = { type: 'ntile', args: [5] } as unknown as CompilerDecision;
		const result = ntileHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain(5);
	});

	it('compiles with PARTITION BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'ntile',
			value: 3,
			partition: ['dept'],
		} as unknown as CompilerDecision;
		const result = ntileHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
	});
});

// ============================================================================
// lagHandler coverage
// ============================================================================

describe('lagHandler', () => {
	const ctx = makeCtx();

	it('compiles with column and default offset=1', () => {
		const state = createCompilerState();
		const decision = { type: 'lag', column: 'price' } as CompilerDecision;
		const result = lagHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('lag');
		expect(result.FuncCall?.args).toHaveLength(2); // column + offset
		expect(state.parameters).toContain(1); // default offset
	});

	it('compiles with custom offset', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lag',
			column: 'price',
			args: [3],
		} as unknown as CompilerDecision;
		const result = lagHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(2);
		expect(state.parameters).toContain(3);
	});

	it('compiles with default value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lag',
			column: 'price',
			value: 0,
		} as CompilerDecision;
		const result = lagHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(3); // column + offset + default
		expect(state.parameters).toContain(1); // offset
		expect(state.parameters).toContain(0); // default value
	});

	it('compiles with custom offset and default value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lag',
			column: 'price',
			args: [2],
			value: 100,
		} as unknown as CompilerDecision;
		const result = lagHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(3);
		expect(state.parameters).toContain(2);
		expect(state.parameters).toContain(100);
	});

	it('compiles with PARTITION BY and ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lag',
			column: 'price',
			partition: ['product_id'],
			orderBy: [{ column: 'date', direction: 'ASC' }],
		} as unknown as CompilerDecision;
		const result = lagHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 't1' });
		const decision = { type: 'lag', column: 'price' } as CompilerDecision;
		const result = lagHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.FuncCall?.args?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 't1' } });
	});
});

// ============================================================================
// leadHandler coverage
// ============================================================================

describe('leadHandler', () => {
	const ctx = makeCtx();

	it('compiles with column and default offset=1', () => {
		const state = createCompilerState();
		const decision = { type: 'lead', column: 'price' } as CompilerDecision;
		const result = leadHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('lead');
		expect(result.FuncCall?.args).toHaveLength(2);
		expect(state.parameters).toContain(1);
	});

	it('compiles with custom offset', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lead',
			column: 'price',
			args: [3],
		} as unknown as CompilerDecision;
		const result = leadHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(2);
		expect(state.parameters).toContain(3);
	});

	it('compiles with default value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lead',
			column: 'price',
			value: 0,
		} as CompilerDecision;
		const result = leadHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(3);
		expect(state.parameters).toContain(1);
		expect(state.parameters).toContain(0);
	});

	it('compiles with custom offset and default value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lead',
			column: 'price',
			args: [2],
			value: 999,
		} as unknown as CompilerDecision;
		const result = leadHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(3);
		expect(state.parameters).toContain(2);
		expect(state.parameters).toContain(999);
	});

	it('compiles with PARTITION BY and ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lead',
			column: 'price',
			partition: ['category'],
			orderBy: [{ column: 'date', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = leadHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 't2' });
		const decision = { type: 'lead', column: 'amount' } as CompilerDecision;
		const result = leadHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.FuncCall?.args?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 't2' } });
	});
});

// ============================================================================
// firstValueHandler coverage
// ============================================================================

describe('firstValueHandler', () => {
	const ctx = makeCtx();

	it('compiles with column', () => {
		const state = createCompilerState();
		const decision = { type: 'firstValue', column: 'price' } as CompilerDecision;
		const result = firstValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('first_value');
		expect(result.FuncCall?.args).toHaveLength(1);
	});

	it('compiles with PARTITION BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'firstValue',
			column: 'price',
			partition: ['group_id'],
		} as unknown as CompilerDecision;
		const result = firstValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
	});

	it('compiles with ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'firstValue',
			column: 'price',
			orderBy: [{ column: 'timestamp', direction: 'ASC' }],
		} as unknown as CompilerDecision;
		const result = firstValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'w1' });
		const decision = { type: 'firstValue', column: 'value' } as CompilerDecision;
		const result = firstValueHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.FuncCall?.args?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'w1' } });
	});
});

// ============================================================================
// lastValueHandler coverage
// ============================================================================

describe('lastValueHandler', () => {
	const ctx = makeCtx();

	it('compiles with column', () => {
		const state = createCompilerState();
		const decision = { type: 'lastValue', column: 'price' } as CompilerDecision;
		const result = lastValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('last_value');
		expect(result.FuncCall?.args).toHaveLength(1);
	});

	it('compiles with PARTITION BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lastValue',
			column: 'price',
			partition: ['group_id'],
		} as unknown as CompilerDecision;
		const result = lastValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
	});

	it('compiles with ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lastValue',
			column: 'price',
			orderBy: [{ column: 'timestamp', direction: 'DESC' }],
		} as unknown as CompilerDecision;
		const result = lastValueHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'w2' });
		const decision = { type: 'lastValue', column: 'result' } as CompilerDecision;
		const result = lastValueHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.FuncCall?.args?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'w2' } });
	});
});

// ============================================================================
// genericWindowHandler coverage
// ============================================================================

describe('genericWindowHandler', () => {
	const ctx = makeCtx();

	it('compiles count(*) with agg_star when no column or args', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'count',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('count');
		expect(result.FuncCall?.agg_star).toBe(true);
	});

	it('compiles COUNT(*) case-insensitive', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'COUNT',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.agg_star).toBe(true);
	});

	it('compiles count(column) with column ref (not agg_star)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'count',
			column: 'user_id',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.agg_star).toBeUndefined();
		expect(result.FuncCall?.args).toHaveLength(1);
	});

	it('compiles count with args (not agg_star)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'count',
			args: [1],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.agg_star).toBeUndefined();
		expect(result.FuncCall?.args).toHaveLength(1);
		expect(state.parameters).toContain(1);
	});

	it('compiles generic function with column only', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'sum',
			column: 'amount',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.funcname?.[0]?.String?.sval).toBe('sum');
		expect(result.FuncCall?.args).toHaveLength(1);
	});

	it('compiles generic function with args', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'custom_func',
			args: [10, 20],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(2);
		expect(state.parameters).toContain(10);
		expect(state.parameters).toContain(20);
	});

	it('compiles with column and args', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'substring',
			column: 'text',
			args: [1, 5],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(3); // column + 2 args
	});

	it('compiles with value (default parameter)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'coalesce',
			column: 'score',
			value: 0,
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(2); // column + value
		expect(state.parameters).toContain(0);
	});

	it('compiles with column, args, and value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'replace',
			column: 'text',
			args: ['old', 'new'],
			value: 'fallback',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.args).toHaveLength(4); // column + 2 args + value
	});

	it('compiles with PARTITION BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'sum',
			column: 'amount',
			partition: ['category'],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(1);
	});

	it('compiles with ORDER BY', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'avg',
			column: 'score',
			orderBy: [{ column: 'date', direction: 'ASC' }],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(1);
	});

	it('compiles with full window spec', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: 'max',
			column: 'value',
			partition: ['dept', 'location'],
			orderBy: [
				{ column: 'date', direction: 'DESC' },
				{ column: 'id', direction: 'ASC' },
			],
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctx, state);
		expect(result.FuncCall?.over?.partitionClause).toHaveLength(2);
		expect(result.FuncCall?.over?.orderClause).toHaveLength(2);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'w3' });
		const decision = {
			type: 'window',
			function: 'min',
			column: 'price',
		} as unknown as CompilerDecision;
		const result = genericWindowHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.FuncCall?.args?.[0]?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'w3' } });
	});
});
