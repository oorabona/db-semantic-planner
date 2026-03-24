// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for case.ts expression handlers.
 *
 * Covers: simpleCaseHandler (caseHandler tested via integration tests due to dynamic require)
 * Focus: Multiple WHEN/THEN branches, ELSE present/absent, nested expressions, NULL handling
 *
 * NOTE: caseHandler uses dynamic require() for WHERE dispatcher which doesn't work in
 * unit tests. Coverage for caseHandler's success paths is achieved via integration tests.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import { simpleCaseHandler } from './case.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// simpleCaseHandler coverage
// ============================================================================

describe('simpleCaseHandler', () => {
	const ctx = makeCtx();

	it('compiles simple CASE with single WHEN/THEN, no ELSE', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 1 }, then: 'active' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result).toHaveProperty('CaseExpr');
		expect(result.CaseExpr?.arg).toBeDefined(); // test expr present
		expect(result.CaseExpr?.args).toHaveLength(1);
		expect(result.CaseExpr?.defresult).toBeUndefined();
	});

	it('compiles simple CASE with single WHEN/THEN and ELSE', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 1 }, then: 'active' }],
			value: 'unknown',
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result.CaseExpr?.args).toHaveLength(1);
		expect(result.CaseExpr?.defresult).toBeDefined();
	});

	it('compiles simple CASE with multiple WHEN values', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			conditions: [
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 1 }, then: 'active' },
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 2 }, then: 'inactive' },
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 3 }, then: 'pending' },
			],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result.CaseExpr?.args).toHaveLength(3);
	});

	it('compiles with WHEN value as string', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 'new' }, then: 'New Status' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain('new');
	});

	it('compiles with WHEN value as number', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'code',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 404 }, then: 'Not Found' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain(404);
	});

	it('compiles with THEN as number', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'level',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 'high' }, then: 100 }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain(100);
	});

	it('compiles with ELSE as number', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'priority',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 'urgent' }, then: 1 }],
			value: 99,
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result.CaseExpr?.defresult).toBeDefined();
		expect(state.parameters).toContain(99);
	});

	it('compiles with ELSE as null', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 1 }, then: 'active' }],
			value: null,
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result.CaseExpr?.defresult).toBeDefined();
	});

	it('compiles with WHEN value from nested when.value', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { type: 'eq', value: 5 }, then: 'matched' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain(5);
	});

	it('compiles with WHEN as plain value (not object)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: 'active', then: 'Active Status' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(state.parameters).toContain('active');
	});

	it('uses tableAlias for column reference', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 1 }, then: 'active' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		const colRef = result.CaseExpr?.arg?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'test_table' } });
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'alias1' });
		const decision = {
			type: 'simpleCase',
			column: 'status',
			// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
			conditions: [{ when: { value: 1 }, then: 'active' }],
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctxWithAlias, state);
		const colRef = result.CaseExpr?.arg?.ColumnRef;
		expect(colRef?.fields).toContainEqual({ String: { sval: 'alias1' } });
	});

	it('compiles with multiple WHEN/THEN and ELSE', () => {
		const state = createCompilerState();
		const decision = {
			type: 'simpleCase',
			column: 'grade',
			conditions: [
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 'A' }, then: 4.0 },
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 'B' }, then: 3.0 },
				// biome-ignore lint/suspicious/noThenProperty: intentional CaseCondition shape
				{ when: { value: 'C' }, then: 2.0 },
			],
			value: 0.0,
		} as unknown as CompilerDecision;
		const result = simpleCaseHandler.compile(decision, ctx, state);
		expect(result.CaseExpr?.args).toHaveLength(3);
		expect(result.CaseExpr?.defresult).toBeDefined();
		expect(state.parameters).toContain(4.0);
		expect(state.parameters).toContain(3.0);
		expect(state.parameters).toContain(2.0);
		expect(state.parameters).toContain(0.0);
	});
});
