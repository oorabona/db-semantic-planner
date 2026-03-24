/**
 * Error-path tests for arithmetic.ts expression handler.
 *
 * Covers: arithmeticHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import { arithmeticHandler } from './arithmetic.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// arithmeticHandler errors
// ============================================================================

describe('arithmeticHandler errors', () => {
	const ctx = makeCtx();

	it('throws when both operands are missing (no args)', () => {
		const state = createCompilerState();
		const decision = { type: 'arithmetic' } as CompilerDecision;
		expect(() => arithmeticHandler.compile(decision, ctx, state)).toThrow(
			'Arithmetic handler requires left and right operands',
		);
	});

	it('throws when args is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'arithmetic',
			args: [],
		} as unknown as CompilerDecision;
		expect(() => arithmeticHandler.compile(decision, ctx, state)).toThrow(
			'Arithmetic handler requires left and right operands',
		);
	});

	it('throws when only left operand is provided', () => {
		const state = createCompilerState();
		const decision = {
			type: 'arithmetic',
			args: ['price'],
		} as unknown as CompilerDecision;
		expect(() => arithmeticHandler.compile(decision, ctx, state)).toThrow(
			'Arithmetic handler requires left and right operands',
		);
	});

	it('throws when left is undefined and right is provided', () => {
		const state = createCompilerState();
		const decision = {
			type: 'arithmetic',
			args: [undefined, 'quantity'],
		} as unknown as CompilerDecision;
		expect(() => arithmeticHandler.compile(decision, ctx, state)).toThrow(
			'Arithmetic handler requires left and right operands',
		);
	});

	it('throws when args is undefined explicitly', () => {
		const state = createCompilerState();
		const decision = {
			type: 'arithmetic',
			operator: '*',
			args: undefined,
		} as unknown as CompilerDecision;
		expect(() => arithmeticHandler.compile(decision, ctx, state)).toThrow(
			'Arithmetic handler requires left and right operands',
		);
	});
});
