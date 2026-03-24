/**
 * Error-path tests for coalesce.ts expression handlers.
 *
 * Covers: coalesceHandler, nullIfHandler, greatestHandler, leastHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// coalesceHandler errors
// ============================================================================

describe('coalesceHandler errors', () => {
	const ctx = makeCtx();

	it('throws when no column, no args, no defaultValue', () => {
		const state = createCompilerState();
		const decision = { type: 'coalesce' } as CompilerDecision;
		expect(() => coalesceHandler.compile(decision, ctx, state)).toThrow(
			'COALESCE requires at least one argument',
		);
	});

	it('throws with undefined args and no column or defaultValue', () => {
		const state = createCompilerState();
		const decision = {
			type: 'coalesce',
			args: undefined,
		} as unknown as CompilerDecision;
		expect(() => coalesceHandler.compile(decision, ctx, state)).toThrow(
			'COALESCE requires at least one argument',
		);
	});

	it('succeeds when only column is provided', () => {
		const state = createCompilerState();
		const decision = { type: 'coalesce', column: 'name' } as CompilerDecision;
		expect(() => coalesceHandler.compile(decision, ctx, state)).not.toThrow();
	});

	it('succeeds when only defaultValue is provided', () => {
		const state = createCompilerState();
		const decision = {
			type: 'coalesce',
			value: 'fallback',
		} as CompilerDecision;
		expect(() => coalesceHandler.compile(decision, ctx, state)).not.toThrow();
	});

	it('throws when args is an empty array and no column or defaultValue', () => {
		const state = createCompilerState();
		const decision = {
			type: 'coalesce',
			args: [],
		} as unknown as CompilerDecision;
		expect(() => coalesceHandler.compile(decision, ctx, state)).toThrow(
			'COALESCE requires at least one argument',
		);
	});
});

// ============================================================================
// nullIfHandler errors
// ============================================================================

describe('nullIfHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'nullIf', value: 'x' } as CompilerDecision;
		expect(() => nullIfHandler.compile(decision, ctx, state)).toThrow(
			'NULLIF requires a column',
		);
	});

	it('throws when column is empty string (falsy)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'nullIf',
			column: '',
			value: 'x',
		} as CompilerDecision;
		expect(() => nullIfHandler.compile(decision, ctx, state)).toThrow(
			'NULLIF requires a column',
		);
	});

	it('throws when value is undefined', () => {
		const state = createCompilerState();
		const decision = { type: 'nullIf', column: 'status' } as CompilerDecision;
		expect(() => nullIfHandler.compile(decision, ctx, state)).toThrow(
			'NULLIF requires a comparison value',
		);
	});

	it('throws column error first when both column and value are missing', () => {
		const state = createCompilerState();
		const decision = { type: 'nullIf' } as CompilerDecision;
		expect(() => nullIfHandler.compile(decision, ctx, state)).toThrow(
			'NULLIF requires a column',
		);
	});

	it('accepts null as a valid comparison value (not undefined)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'nullIf',
			column: 'status',
			value: null,
		} as CompilerDecision;
		expect(() => nullIfHandler.compile(decision, ctx, state)).not.toThrow();
	});
});

// ============================================================================
// greatestHandler errors
// ============================================================================

describe('greatestHandler errors', () => {
	const ctx = makeCtx();

	it('throws when args is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'greatest' } as CompilerDecision;
		expect(() => greatestHandler.compile(decision, ctx, state)).toThrow(
			'GREATEST requires at least one argument',
		);
	});

	it('throws when args is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'greatest',
			args: [],
		} as unknown as CompilerDecision;
		expect(() => greatestHandler.compile(decision, ctx, state)).toThrow(
			'GREATEST requires at least one argument',
		);
	});

	it('throws when args is not an array (string)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'greatest',
			args: 'not-an-array',
		} as unknown as CompilerDecision;
		expect(() => greatestHandler.compile(decision, ctx, state)).toThrow(
			'GREATEST requires at least one argument',
		);
	});

	it('throws when args is null', () => {
		const state = createCompilerState();
		const decision = {
			type: 'greatest',
			args: null,
		} as unknown as CompilerDecision;
		expect(() => greatestHandler.compile(decision, ctx, state)).toThrow(
			'GREATEST requires at least one argument',
		);
	});
});

// ============================================================================
// leastHandler errors
// ============================================================================

describe('leastHandler errors', () => {
	const ctx = makeCtx();

	it('throws when args is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'least' } as CompilerDecision;
		expect(() => leastHandler.compile(decision, ctx, state)).toThrow(
			'LEAST requires at least one argument',
		);
	});

	it('throws when args is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'least',
			args: [],
		} as unknown as CompilerDecision;
		expect(() => leastHandler.compile(decision, ctx, state)).toThrow(
			'LEAST requires at least one argument',
		);
	});

	it('throws when args is not an array (number)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'least',
			args: 42,
		} as unknown as CompilerDecision;
		expect(() => leastHandler.compile(decision, ctx, state)).toThrow(
			'LEAST requires at least one argument',
		);
	});

	it('throws when args is null', () => {
		const state = createCompilerState();
		const decision = {
			type: 'least',
			args: null,
		} as unknown as CompilerDecision;
		expect(() => leastHandler.compile(decision, ctx, state)).toThrow(
			'LEAST requires at least one argument',
		);
	});
});
