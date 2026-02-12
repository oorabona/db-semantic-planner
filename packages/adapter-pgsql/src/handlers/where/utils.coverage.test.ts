// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for utils.ts WHERE handler utilities.
 *
 * Covers: buildColumnRef, buildParamRef, compileValue, compileValueOrFieldRef
 * Focus: all utility function branches, parameter handling, FieldRef resolution.
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext } from '../types.js';
import { createCompilerState } from '../types.js';
import {
	buildColumnRef,
	buildParamRef,
	compileValue,
	compileValueOrFieldRef,
} from './utils.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// buildColumnRef
// ============================================================================

describe('buildColumnRef', () => {
	it('builds column ref using rootTable when no currentAlias', () => {
		const ctx = makeCtx();
		const node = buildColumnRef('title', ctx);

		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef?.fields).toHaveLength(2);
		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('posts');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('title');
	});

	it('builds column ref using currentAlias when available', () => {
		const ctx = makeCtx({ currentAlias: 'p' });
		const node = buildColumnRef('title', ctx);

		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('p');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('title');
	});

	it('does not include schema in column ref', () => {
		const ctx = makeCtx({ schema: 'public' });
		const node = buildColumnRef('title', ctx);

		// Should only have table + column, no schema
		expect(node.ColumnRef?.fields).toHaveLength(2);
	});

	it('applies naming plugin transformation', () => {
		const ctx = makeCtx({
			naming: {
				toDatabase: (name) => name.toUpperCase(),
				fromDatabase: (name) => name.toLowerCase(),
			},
		});
		const node = buildColumnRef('title', ctx);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('POSTS');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('TITLE');
	});
});

// ============================================================================
// buildParamRef
// ============================================================================

describe('buildParamRef', () => {
	it('increments paramIndex and adds value to parameters', () => {
		const state = createCompilerState();
		const node = buildParamRef('hello', state);

		expect(state.paramIndex).toBe(1);
		expect(state.parameters).toEqual(['hello']);
		expect(node).toHaveProperty('ParamRef');
		expect(node.ParamRef?.number).toBe(1);
	});

	it('handles sequential parameter additions', () => {
		const state = createCompilerState();

		buildParamRef('first', state);
		buildParamRef('second', state);
		buildParamRef('third', state);

		expect(state.paramIndex).toBe(3);
		expect(state.parameters).toEqual(['first', 'second', 'third']);
	});

	it('handles ParamRef with pre-assigned paramIndex', () => {
		const state = createCompilerState();
		const paramRef = { paramIndex: 5, value: 'preassigned' };

		const node = buildParamRef(paramRef, state);

		expect(state.parameters).toEqual(['preassigned']);
		expect(node.ParamRef?.number).toBe(5);
		// paramIndex should NOT be incremented
		expect(state.paramIndex).toBe(0);
	});

	it('handles various value types', () => {
		const state = createCompilerState();

		buildParamRef(42, state);
		buildParamRef(true, state);
		buildParamRef(null, state);
		buildParamRef({ key: 'value' }, state);

		expect(state.parameters).toEqual([42, true, null, { key: 'value' }]);
	});
});

// ============================================================================
// compileValue
// ============================================================================

describe('compileValue', () => {
	it('returns null const for null value', () => {
		const state = createCompilerState();
		const node = compileValue(null, state);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.isnull).toBe(true);
		expect(state.parameters).toEqual([]);
	});

	it('returns null const for undefined value', () => {
		const state = createCompilerState();
		const node = compileValue(undefined, state);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.isnull).toBe(true);
		expect(state.parameters).toEqual([]);
	});

	it('handles ParamRef with pre-assigned index', () => {
		const state = createCompilerState();
		const paramRef = { paramIndex: 3, value: 'assigned' };

		const node = compileValue(paramRef, state);

		expect(node).toHaveProperty('ParamRef');
		expect(node.ParamRef?.number).toBe(3);
		expect(state.parameters).toEqual(['assigned']);
		expect(state.paramIndex).toBe(0);
	});

	it('creates param ref for regular values', () => {
		const state = createCompilerState();

		const node1 = compileValue('hello', state);
		expect(node1.ParamRef?.number).toBe(1);

		const node2 = compileValue(42, state);
		expect(node2.ParamRef?.number).toBe(2);

		expect(state.parameters).toEqual(['hello', 42]);
		expect(state.paramIndex).toBe(2);
	});

	it('handles boolean values', () => {
		const state = createCompilerState();
		const node = compileValue(true, state);

		expect(node.ParamRef?.number).toBe(1);
		expect(state.parameters).toEqual([true]);
	});

	it('handles object values', () => {
		const state = createCompilerState();
		const obj = { key: 'value' };
		const node = compileValue(obj, state);

		expect(node.ParamRef?.number).toBe(1);
		expect(state.parameters).toEqual([obj]);
	});
});

// ============================================================================
// compileValueOrFieldRef
// ============================================================================

describe('compileValueOrFieldRef', () => {
	const ctx = makeCtx();

	it('handles FieldRef with scope:inner (default)', () => {
		const state = createCompilerState();
		const fieldRef = {
			kind: 'fieldRef' as const,
			column: 'author_id',
			scope: 'inner' as const,
		};

		const node = compileValueOrFieldRef(fieldRef, ctx, state);

		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('posts');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('author_id');
		expect(state.parameters).toEqual([]);
	});

	it('handles FieldRef with scope:outer', () => {
		const state = createCompilerState();
		const ctxWithOuter = makeCtx({ outerAlias: 'parent', currentAlias: 'sub' });
		const fieldRef = {
			kind: 'fieldRef' as const,
			column: 'id',
			scope: 'outer' as const,
		};

		const node = compileValueOrFieldRef(fieldRef, ctxWithOuter, state);

		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('parent');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('id');
	});

	it('uses outerAlias when scope:outer and outerAlias is set', () => {
		const state = createCompilerState();
		const ctxWithOuter = makeCtx({ outerAlias: 'o', currentAlias: 'c' });
		const fieldRef = {
			kind: 'fieldRef' as const,
			column: 'pk',
			scope: 'outer' as const,
		};

		const node = compileValueOrFieldRef(fieldRef, ctxWithOuter, state);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('o');
	});

	it('falls back to rootTable when scope:outer but no outerAlias', () => {
		const state = createCompilerState();
		const ctxNoOuter = makeCtx({ currentAlias: 'sub' });
		const fieldRef = { kind: 'fieldRef' as const, column: 'id', scope: 'outer' as const };

		const node = compileValueOrFieldRef(fieldRef, ctxNoOuter, state);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('posts');
	});

	it('uses currentAlias when scope:inner and currentAlias is set', () => {
		const state = createCompilerState();
		const ctxWithAlias = makeCtx({ currentAlias: 'p' });
		const fieldRef = { kind: 'fieldRef' as const, column: 'title', scope: 'inner' as const };

		const node = compileValueOrFieldRef(fieldRef, ctxWithAlias, state);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('p');
	});

	it('falls back to rootTable when scope:inner but no currentAlias', () => {
		const state = createCompilerState();
		const fieldRef = { kind: 'fieldRef' as const, column: 'title', scope: 'inner' as const };

		const node = compileValueOrFieldRef(fieldRef, ctx, state);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('posts');
	});

	it('handles non-FieldRef values as regular values', () => {
		const state = createCompilerState();
		const node = compileValueOrFieldRef('plain string', ctx, state);

		expect(node).toHaveProperty('ParamRef');
		expect(state.parameters).toEqual(['plain string']);
	});

	it('handles null as regular value', () => {
		const state = createCompilerState();
		const node = compileValueOrFieldRef(null, ctx, state);

		expect(node).toHaveProperty('A_Const');
		expect(node.A_Const?.isnull).toBe(true);
	});

	it('handles numbers as regular values', () => {
		const state = createCompilerState();
		const node = compileValueOrFieldRef(42, ctx, state);

		expect(node).toHaveProperty('ParamRef');
		expect(state.parameters).toEqual([42]);
	});

	it('handles objects without column property as regular values', () => {
		const state = createCompilerState();
		const obj = { key: 'value' };
		const node = compileValueOrFieldRef(obj, ctx, state);

		expect(node).toHaveProperty('ParamRef');
		expect(state.parameters).toEqual([obj]);
	});

	it('applies naming plugin to FieldRef columns', () => {
		const state = createCompilerState();
		const ctxWithNaming = makeCtx({
			naming: {
				toDatabase: (name) => name.toUpperCase(),
				fromDatabase: (name) => name.toLowerCase(),
			},
		});
		const fieldRef = { kind: 'fieldRef' as const, column: 'author_id', scope: 'inner' as const };

		const node = compileValueOrFieldRef(fieldRef, ctxWithNaming, state);

		expect(node.ColumnRef?.fields?.[0]?.String?.sval).toBe('POSTS');
		expect(node.ColumnRef?.fields?.[1]?.String?.sval).toBe('AUTHOR_ID');
	});
});
