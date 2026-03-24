/**
 * Error-path tests for window.ts expression handlers.
 *
 * Covers: lagHandler, leadHandler, firstValueHandler, lastValueHandler,
 *         genericWindowHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	firstValueHandler,
	genericWindowHandler,
	lagHandler,
	lastValueHandler,
	leadHandler,
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
// lagHandler errors
// ============================================================================

describe('lagHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'lag' } as CompilerDecision;
		expect(() => lagHandler.compile(decision, ctx, state)).toThrow(
			'LAG requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lag',
			column: undefined,
		} as unknown as CompilerDecision;
		expect(() => lagHandler.compile(decision, ctx, state)).toThrow(
			'LAG requires a column',
		);
	});
});

// ============================================================================
// leadHandler errors
// ============================================================================

describe('leadHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'lead' } as CompilerDecision;
		expect(() => leadHandler.compile(decision, ctx, state)).toThrow(
			'LEAD requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lead',
			column: undefined,
		} as unknown as CompilerDecision;
		expect(() => leadHandler.compile(decision, ctx, state)).toThrow(
			'LEAD requires a column',
		);
	});
});

// ============================================================================
// firstValueHandler errors
// ============================================================================

describe('firstValueHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'firstValue' } as CompilerDecision;
		expect(() => firstValueHandler.compile(decision, ctx, state)).toThrow(
			'FIRST_VALUE requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'firstValue',
			column: undefined,
		} as unknown as CompilerDecision;
		expect(() => firstValueHandler.compile(decision, ctx, state)).toThrow(
			'FIRST_VALUE requires a column',
		);
	});
});

// ============================================================================
// lastValueHandler errors
// ============================================================================

describe('lastValueHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'lastValue' } as CompilerDecision;
		expect(() => lastValueHandler.compile(decision, ctx, state)).toThrow(
			'LAST_VALUE requires a column',
		);
	});

	it('throws when column is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'lastValue',
			column: undefined,
		} as unknown as CompilerDecision;
		expect(() => lastValueHandler.compile(decision, ctx, state)).toThrow(
			'LAST_VALUE requires a column',
		);
	});
});

// ============================================================================
// genericWindowHandler errors
// ============================================================================

describe('genericWindowHandler errors', () => {
	const ctx = makeCtx();

	it('throws when function name is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'window' } as CompilerDecision;
		expect(() => genericWindowHandler.compile(decision, ctx, state)).toThrow(
			'Window function requires function name',
		);
	});

	it('throws when function name is empty string', () => {
		const state = createCompilerState();
		const decision = {
			type: 'window',
			function: '',
		} as unknown as CompilerDecision;
		expect(() => genericWindowHandler.compile(decision, ctx, state)).toThrow(
			'Window function requires function name',
		);
	});
});
