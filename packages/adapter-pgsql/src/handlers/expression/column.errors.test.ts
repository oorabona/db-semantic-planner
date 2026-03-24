/**
 * Error-path tests for column.ts expression handlers.
 *
 * Covers: columnHandler, columnAliasHandler
 * Focus: error branches and edge cases only.
 * Note: starHandler has no error paths (no throws).
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import { columnAliasHandler, columnHandler } from './column.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// columnHandler errors
// ============================================================================

describe('columnHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'column' } as CompilerDecision;
		expect(() => columnHandler.compile(decision, ctx, state)).toThrow(
			'Column handler requires column',
		);
	});

	it('throws when column is undefined explicitly', () => {
		const state = createCompilerState();
		const decision = {
			type: 'column',
			column: undefined,
		} as unknown as CompilerDecision;
		expect(() => columnHandler.compile(decision, ctx, state)).toThrow(
			'Column handler requires column',
		);
	});
});

// ============================================================================
// columnAliasHandler errors
// ============================================================================

describe('columnAliasHandler errors', () => {
	const ctx = makeCtx();

	it('throws when column is missing', () => {
		const state = createCompilerState();
		const decision = {
			type: 'columnAlias',
			alias: 'user_name',
		} as CompilerDecision;
		expect(() => columnAliasHandler.compile(decision, ctx, state)).toThrow(
			'Column alias handler requires column',
		);
	});

	it('throws when column is undefined explicitly', () => {
		const state = createCompilerState();
		const decision = {
			type: 'columnAlias',
			column: undefined,
			alias: 'user_name',
		} as unknown as CompilerDecision;
		expect(() => columnAliasHandler.compile(decision, ctx, state)).toThrow(
			'Column alias handler requires column',
		);
	});
});
