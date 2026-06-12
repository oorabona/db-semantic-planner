// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for json.ts expression handlers.
 * Focus: Branch coverage for jsonExtractHandler, jsonPathExtractHandler
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import { createCompilerState } from '../types.js';
import { jsonExtractHandler, jsonPathExtractHandler } from './json.js';

function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

describe('jsonExtractHandler — coverage', () => {
	it('compiles single-key text extraction (col->>key)', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{ type: 'jsonExtract', column: 'metadata', args: ['name'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('A_Expr');
		expect(node.A_Expr.name[0].String.sval).toBe('->>');
	});

	it('compiles multi-key chain with text mode (->...->...->>) ', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{
				type: 'jsonExtract',
				column: 'data',
				args: ['a', 'b', 'c'],
				jsonMode: 'text',
			},
			makeCtx(),
			state,
		);
		// Outermost should be ->> (text mode, last key)
		expect(node.A_Expr.name[0].String.sval).toBe('->>');
	});

	it('compiles multi-key chain with json mode (all ->)', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{
				type: 'jsonExtract',
				column: 'data',
				args: ['a', 'b'],
				jsonMode: 'json',
			},
			makeCtx(),
			state,
		);
		// Last key should be -> (json mode)
		expect(node.A_Expr.name[0].String.sval).toBe('->');
	});

	it('compiles with empty path (no extraction)', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{ type: 'jsonExtract', column: 'data', args: [] },
			makeCtx(),
			state,
		);
		// With no path keys, returns just the ColumnRef
		expect(node).toHaveProperty('ColumnRef');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			jsonExtractHandler.compile(
				{ type: 'jsonExtract', args: ['key'] },
				makeCtx(),
				state,
			),
		).toThrow('JSON extract handler requires a column');
	});

	it('defaults to text mode when jsonMode not set', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{ type: 'jsonExtract', column: 'meta', args: ['key'] },
			makeCtx(),
			state,
		);
		expect(node.A_Expr.name[0].String.sval).toBe('->>');
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const node = jsonExtractHandler.compile(
			{ type: 'jsonExtract', column: 'data', args: ['x'] },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('A_Expr');
	});
});

describe('jsonPathExtractHandler — coverage', () => {
	it('compiles text mode (#>>)', () => {
		const state = createCompilerState();
		const node = jsonPathExtractHandler.compile(
			{
				type: 'jsonPathExtract',
				column: 'data',
				args: ['a', 'b'],
				jsonMode: 'text',
			},
			makeCtx(),
			state,
		);
		expect(node.A_Expr.name[0].String.sval).toBe('#>>');
	});

	it('compiles json mode (#>)', () => {
		const state = createCompilerState();
		const node = jsonPathExtractHandler.compile(
			{
				type: 'jsonPathExtract',
				column: 'data',
				args: ['a', 'b'],
				jsonMode: 'json',
			},
			makeCtx(),
			state,
		);
		expect(node.A_Expr.name[0].String.sval).toBe('#>');
	});

	it('defaults to text mode', () => {
		const state = createCompilerState();
		const node = jsonPathExtractHandler.compile(
			{ type: 'jsonPathExtract', column: 'data', args: ['x'] },
			makeCtx(),
			state,
		);
		expect(node.A_Expr.name[0].String.sval).toBe('#>>');
	});

	it('uses empty object literal when args is empty', () => {
		const state = createCompilerState();
		const node = jsonPathExtractHandler.compile(
			{ type: 'jsonPathExtract', column: 'data' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('A_Expr');
		expect(state.parameters).toContainEqual([]);
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			jsonPathExtractHandler.compile(
				{ type: 'jsonPathExtract', args: ['{a}'] },
				makeCtx(),
				state,
			),
		).toThrow('JSON path extract handler requires a column');
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const node = jsonPathExtractHandler.compile(
			{ type: 'jsonPathExtract', column: 'meta', args: ['a'] },
			makeCtx({ currentAlias: 't0' }),
			state,
		);
		expect(node).toHaveProperty('A_Expr');
	});
});
