// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for coalesce.ts expression handlers.
 * Focus: Branch coverage for coalesceHandler, nullIfHandler, greatestHandler, leastHandler
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import { createCompilerState } from '../types.js';
import {
	coalesceHandler,
	greatestHandler,
	leastHandler,
	nullIfHandler,
} from './coalesce.js';

function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

describe('coalesceHandler — coverage', () => {
	it('compiles COALESCE with column + args (column refs)', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', column: 'nickname', args: ['first_name', 'email'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
		expect(node.CoalesceExpr.args).toHaveLength(3);
	});

	it('compiles COALESCE with args only (no column)', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', args: ['a', 'b'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
		expect(node.CoalesceExpr.args).toHaveLength(2);
	});

	it('compiles COALESCE with default value (parameterized)', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', column: 'name', value: 42 },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
		// column + default value = 2 args
		expect(node.CoalesceExpr.args).toHaveLength(2);
		expect(state.parameters).toContain(42);
	});

	it('compiles COALESCE with decision-type arg { type: "column" }', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{
				type: 'coalesce',
				args: [{ type: 'column', column: 'alt_name' }],
			},
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
	});

	it('compiles COALESCE with non-string literal arg (parameterized)', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', args: [42] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
		expect(state.parameters).toContain(42);
	});

	it('compiles COALESCE with string containing space (parameterized)', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', args: ['hello world'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
		expect(state.parameters).toContain('hello world');
	});

	it('throws when no arguments provided', () => {
		const state = createCompilerState();
		expect(() =>
			coalesceHandler.compile({ type: 'coalesce' }, makeCtx(), state),
		).toThrow('COALESCE requires at least one argument');
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const node = coalesceHandler.compile(
			{ type: 'coalesce', column: 'name' },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('CoalesceExpr');
	});
});

describe('nullIfHandler — coverage', () => {
	it('compiles NULLIF(column, value)', () => {
		const state = createCompilerState();
		const node = nullIfHandler.compile(
			{ type: 'nullIf', column: 'status', value: 'deleted' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('NullIfExpr');
		expect(node.NullIfExpr.args).toHaveLength(2);
		expect(state.parameters).toContain('deleted');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			nullIfHandler.compile({ type: 'nullIf', value: 'x' }, makeCtx(), state),
		).toThrow('NULLIF requires a column');
	});

	it('throws when value is missing', () => {
		const state = createCompilerState();
		expect(() =>
			nullIfHandler.compile(
				{ type: 'nullIf', column: 'status' },
				makeCtx(),
				state,
			),
		).toThrow('NULLIF requires a comparison value');
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const node = nullIfHandler.compile(
			{ type: 'nullIf', column: 'status', value: 'x' },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('NullIfExpr');
	});
});

describe('greatestHandler — coverage', () => {
	it('compiles GREATEST with column args', () => {
		const state = createCompilerState();
		const node = greatestHandler.compile(
			{ type: 'greatest', args: ['price', 'min_price'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('MinMaxExpr');
		expect(node.MinMaxExpr.op).toBe('IS_GREATEST');
	});

	it('compiles GREATEST with literal values', () => {
		const state = createCompilerState();
		const node = greatestHandler.compile(
			{ type: 'greatest', args: [10, 20, 30] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('MinMaxExpr');
		expect(state.parameters).toHaveLength(3);
	});

	it('throws with empty args', () => {
		const state = createCompilerState();
		expect(() =>
			greatestHandler.compile({ type: 'greatest', args: [] }, makeCtx(), state),
		).toThrow('GREATEST requires at least one argument');
	});

	it('throws with no args', () => {
		const state = createCompilerState();
		expect(() =>
			greatestHandler.compile({ type: 'greatest' }, makeCtx(), state),
		).toThrow('GREATEST requires at least one argument');
	});
});

describe('leastHandler — coverage', () => {
	it('compiles LEAST with column args', () => {
		const state = createCompilerState();
		const node = leastHandler.compile(
			{ type: 'least', args: ['price', 'max_price'] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('MinMaxExpr');
		expect(node.MinMaxExpr.op).toBe('IS_LEAST');
	});

	it('compiles LEAST with literal values', () => {
		const state = createCompilerState();
		const node = leastHandler.compile(
			{ type: 'least', args: [100, 200] },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('MinMaxExpr');
		expect(state.parameters).toHaveLength(2);
	});

	it('throws with empty args', () => {
		const state = createCompilerState();
		expect(() =>
			leastHandler.compile({ type: 'least', args: [] }, makeCtx(), state),
		).toThrow('LEAST requires at least one argument');
	});

	it('throws with no args', () => {
		const state = createCompilerState();
		expect(() =>
			leastHandler.compile({ type: 'least' }, makeCtx(), state),
		).toThrow('LEAST requires at least one argument');
	});
});
