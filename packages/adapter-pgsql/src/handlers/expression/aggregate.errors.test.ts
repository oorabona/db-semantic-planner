/**
 * Error-path tests for aggregate.ts expression handlers.
 *
 * Covers: countDistinctHandler, sumHandler, avgHandler, minHandler,
 *         maxHandler, genericAggregateHandler (via buildAggregate)
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	avgHandler,
	countDistinctHandler,
	genericAggregateHandler,
	maxHandler,
	minHandler,
	sumHandler,
} from './aggregate.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// countDistinctHandler errors
// ============================================================================

describe('countDistinctHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'countDistinct' } as Decision;
		expect(() => countDistinctHandler.compile(decision, ctx, state)).toThrow(
			'COUNT DISTINCT requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'countDistinct',
			column: undefined,
		} as unknown as Decision;
		expect(() => countDistinctHandler.compile(decision, ctx, state)).toThrow(
			'COUNT DISTINCT requires a column',
		);
	});
});

// ============================================================================
// sumHandler errors (via buildAggregate)
// ============================================================================

describe('sumHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'sum' } as Decision;
		expect(() => sumHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate sum requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sum',
			column: undefined,
		} as unknown as Decision;
		expect(() => sumHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate sum requires a column',
		);
	});
});

// ============================================================================
// avgHandler errors (via buildAggregate)
// ============================================================================

describe('avgHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'avg' } as Decision;
		expect(() => avgHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate avg requires a column',
		);
	});
});

// ============================================================================
// minHandler errors (via buildAggregate)
// ============================================================================

describe('minHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'min' } as Decision;
		expect(() => minHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate min requires a column',
		);
	});
});

// ============================================================================
// maxHandler errors (via buildAggregate)
// ============================================================================

describe('maxHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'max' } as Decision;
		expect(() => maxHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate max requires a column',
		);
	});
});

// ============================================================================
// genericAggregateHandler errors
// ============================================================================

describe('genericAggregateHandler errors', () => {
	const ctx = makeCtx();

	it('throws when function name is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'aggregate' } as Decision;
		expect(() => genericAggregateHandler.compile(decision, ctx, state)).toThrow(
			'Generic aggregate requires function name',
		);
	});

	it('throws when function name is empty string', () => {
		const state = createCompilerState();
		const decision = {
			type: 'aggregate',
			function: '',
		} as unknown as Decision;
		expect(() => genericAggregateHandler.compile(decision, ctx, state)).toThrow(
			'Generic aggregate requires function name',
		);
	});

	it('throws when column is missing for non-count aggregate', () => {
		const state = createCompilerState();
		const decision = {
			type: 'aggregate',
			function: 'string_agg',
		} as Decision;
		expect(() => genericAggregateHandler.compile(decision, ctx, state)).toThrow(
			'Aggregate string_agg requires a column',
		);
	});
});
