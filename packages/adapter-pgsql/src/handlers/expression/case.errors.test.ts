/**
 * Error-path tests for case.ts expression handlers.
 *
 * Covers: caseHandler, simpleCaseHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision } from '../types.js';
import { createCompilerState } from '../types.js';
import { caseHandler, simpleCaseHandler } from './case.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// caseHandler errors
// ============================================================================

describe('caseHandler errors', () => {
	const ctx = makeCtx();

	it('throws when conditions is undefined', () => {
		const state = createCompilerState();
		const decision = { type: 'case' } as Decision;
		expect(() => caseHandler.compile(decision, ctx, state)).toThrow(
			'CASE requires at least one WHEN condition',
		);
	});

	it('throws when conditions is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'case',
			conditions: [],
		} as unknown as Decision;
		expect(() => caseHandler.compile(decision, ctx, state)).toThrow(
			'CASE requires at least one WHEN condition',
		);
	});

	it('throws when conditions is null-ish (explicitly set to null)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'case',
			conditions: null,
		} as unknown as Decision;
		expect(() => caseHandler.compile(decision, ctx, state)).toThrow(
			'CASE requires at least one WHEN condition',
		);
	});
});

// ============================================================================
// simpleCaseHandler errors
// ============================================================================

describe('simpleCaseHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { type: 'eq', value: 1 }, then: 'a' }],
		} as unknown as Decision;
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires a column',
		);
	});

	it('throws when column is undefined and conditions present', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: undefined,
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { type: 'eq', value: 1 }, then: 'a' }],
		} as unknown as Decision;
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires a column',
		);
	});

	it('throws when column is empty string', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: '',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { type: 'eq', value: 1 }, then: 'a' }],
		} as unknown as Decision;
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires a column',
		);
	});

	it('throws when conditions is undefined (even with column)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
		} as Decision;
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires at least one WHEN condition',
		);
	});

	it('throws when conditions is an empty array (even with column)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			conditions: [],
		} as unknown as Decision;
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires at least one WHEN condition',
		);
	});

	it('throws column error before conditions error when both missing', () => {
		const state = createCompilerState();
		const decision = { type: 'simpleCase' } as Decision;
		// Column check comes first (line 113) before conditions check (line 117)
		expect(() => simpleCaseHandler.compile(decision, ctx, state)).toThrow(
			'Simple CASE requires a column',
		);
	});
});
