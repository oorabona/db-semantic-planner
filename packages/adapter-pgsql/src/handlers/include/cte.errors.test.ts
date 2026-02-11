/**
 * Error-path tests for cte.ts include handler.
 *
 * Covers: cteIncludeHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision } from '../types.js';
import { createCompilerState } from '../types.js';
import { cteIncludeHandler } from './cte.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

function buildDecision(overrides: Record<string, unknown> = {}): Decision {
	return {
		type: 'includeStrategy',
		relation: 'posts',
		targetTable: 'posts',
		sourceColumn: 'id',
		targetColumn: 'user_id',
		strategy: 'cte',
		...overrides,
	} as Decision;
}

// ============================================================================
// cteIncludeHandler — missing required fields
// ============================================================================

describe('cteIncludeHandler errors', () => {
	const ctx = makeCtx();

	it('throws when sourceColumn is missing', () => {
		const state = createCompilerState();
		const decision = buildDecision({ sourceColumn: undefined });
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			"Missing required column 'sourceColumn' in CTE include",
		);
	});

	it('throws when sourceColumn is empty string', () => {
		const state = createCompilerState();
		const decision = buildDecision({ sourceColumn: '' });
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			"Missing required column 'sourceColumn' in CTE include",
		);
	});

	it('throws when targetTable is missing and relation is also missing', () => {
		const state = createCompilerState();
		// targetTable falls back to relation, so both must be absent to trigger
		const decision = buildDecision({
			targetTable: undefined,
			relation: undefined,
		});
		// sourceColumn check fires first if present — but here relation is undefined
		// so targetTable = decision.targetTable ?? relation = undefined
		// Then the check !targetTable triggers
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			'CTE include requires targetTable',
		);
	});

	it('throws when relation is missing (even if targetTable is present)', () => {
		const state = createCompilerState();
		const decision = buildDecision({
			relation: undefined,
			targetTable: 'posts',
		});
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			'CTE include requires relation name',
		);
	});

	it('throws when relation is empty string', () => {
		const state = createCompilerState();
		const decision = buildDecision({
			relation: '',
			targetTable: 'posts',
		});
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			'CTE include requires relation name',
		);
	});

	it('throws when both targetTable and relation are empty strings', () => {
		const state = createCompilerState();
		const decision = buildDecision({
			targetTable: '',
			relation: '',
		});
		// targetTable = '' ?? '' = '' which is falsy → throws targetTable error first
		expect(() => cteIncludeHandler.compile(decision, ctx, state)).toThrow(
			'CTE include requires targetTable',
		);
	});
});
