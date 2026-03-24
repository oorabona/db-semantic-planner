/**
 * Error-path tests for raw.ts expression handlers.
 *
 * Covers: rawHandler, sqlFunctionHandler, literalHandler
 * Focus: error branches and edge cases only.
 */

import { describe, expect, it, vi } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, CompilerDecision } from '../types.js';
import { createCompilerState } from '../types.js';
import { literalHandler, rawHandler, sqlFunctionHandler } from './raw.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'test_table',
		maxRecursiveDepth: 100,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// rawHandler errors
// ============================================================================

describe('rawHandler errors', () => {
	const ctx = makeCtx();

	it('throws when value is a number', () => {
		const state = createCompilerState();
		const decision = { type: 'raw', value: 123 } as unknown as CompilerDecision;
		expect(() => rawHandler.compile(decision, ctx, state)).toThrow(
			'Raw expression requires a string SQL value',
		);
	});

	it('throws when value is null', () => {
		const state = createCompilerState();
		const decision = { type: 'raw', value: null } as CompilerDecision;
		expect(() => rawHandler.compile(decision, ctx, state)).toThrow(
			'Raw expression requires a string SQL value',
		);
	});

	it('throws when value is undefined', () => {
		const state = createCompilerState();
		const decision = { type: 'raw' } as CompilerDecision;
		expect(() => rawHandler.compile(decision, ctx, state)).toThrow(
			'Raw expression requires a string SQL value',
		);
	});

	it('throws when value is an object', () => {
		const state = createCompilerState();
		const decision = { type: 'raw', value: { sql: 'SELECT 1' } } as CompilerDecision;
		expect(() => rawHandler.compile(decision, ctx, state)).toThrow(
			'Raw expression requires a string SQL value',
		);
	});

	it('throws when value is an empty string', () => {
		const state = createCompilerState();
		const decision = { type: 'raw', value: '' } as CompilerDecision;
		expect(() => rawHandler.compile(decision, ctx, state)).toThrow(
			'Raw expression cannot be empty',
		);
	});

	it('calls ctx.onRawSQL callback when present', () => {
		const onRawSQL = vi.fn();
		const ctxWithCallback = makeCtx({ onRawSQL });
		const state = createCompilerState();
		const decision = { type: 'raw', value: 'NOW()' } as CompilerDecision;

		rawHandler.compile(decision, ctxWithCallback, state);

		expect(onRawSQL).toHaveBeenCalledOnce();
		expect(onRawSQL).toHaveBeenCalledWith('NOW()');
	});

	it('does not crash when ctx.onRawSQL is absent', () => {
		const ctxNoCallback = makeCtx();
		const state = createCompilerState();
		const decision = { type: 'raw', value: 'NOW()' } as CompilerDecision;

		expect(() =>
			rawHandler.compile(decision, ctxNoCallback, state),
		).not.toThrow();
	});
});

// ============================================================================
// sqlFunctionHandler errors
// ============================================================================

describe('sqlFunctionHandler errors', () => {
	const ctx = makeCtx();

	it('throws when function name is missing', () => {
		const state = createCompilerState();
		const decision = { type: 'sqlFunction' } as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'SQL function requires function name',
		);
	});

	it('throws when function name is empty string', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: '',
		} as unknown as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'SQL function requires function name',
		);
	});

	it('throws when function name starts with a digit', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: '123func',
		} as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'Invalid function name: 123func',
		);
	});

	it('throws when function name contains a space', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: 'func name',
		} as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'Invalid function name: func name',
		);
	});

	it('throws when function name contains a semicolon (injection attempt)', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: 'func;',
		} as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'Invalid function name: func;',
		);
	});

	it('throws when function name contains SQL comment syntax', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: 'func--',
		} as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'Invalid function name: func--',
		);
	});

	it('throws on SQL injection attempt with DROP TABLE', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: '; DROP TABLE users',
		} as CompilerDecision;
		expect(() => sqlFunctionHandler.compile(decision, ctx, state)).toThrow(
			'Invalid function name:',
		);
	});

	it('does not crash when args is undefined', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: 'now',
		} as CompilerDecision;

		expect(() =>
			sqlFunctionHandler.compile(decision, ctx, state),
		).not.toThrow();
	});

	it('does not crash when args is an empty array', () => {
		const state = createCompilerState();
		const decision = {
			type: 'sqlFunction',
			function: 'now',
			args: [],
		} as unknown as CompilerDecision;

		const result = sqlFunctionHandler.compile(decision, ctx, state);
		expect(result).toBeDefined();
	});
});

// ============================================================================
// literalHandler edge cases
// ============================================================================

describe('literalHandler edge cases', () => {
	const ctx = makeCtx();

	it('produces isnull for null value', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: null } as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { isnull: true } });
	});

	it('produces isnull for undefined value', () => {
		const state = createCompilerState();
		const decision = { type: 'literal' } as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { isnull: true } });
	});

	it('produces boolval for true', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: true } as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { boolval: { boolval: true } } });
	});

	it('produces boolval for false', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: false } as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { boolval: { boolval: false } } });
	});

	it('produces ival for integer', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: 42 } as unknown as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { ival: { ival: 42 } } });
	});

	it('produces fval for float', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: 3.14 } as unknown as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { fval: { fval: '3.14' } } });
	});

	it('produces sval for string', () => {
		const state = createCompilerState();
		const decision = { type: 'literal', value: 'hello' } as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { sval: { sval: 'hello' } } });
	});

	it('stringifies object to sval', () => {
		const state = createCompilerState();
		const decision = {
			type: 'literal',
			value: { foo: 'bar' },
		} as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({
			A_Const: { sval: { sval: '[object Object]' } },
		});
	});

	it('stringifies array to sval', () => {
		const state = createCompilerState();
		const decision = {
			type: 'literal',
			value: [1, 2, 3],
		} as unknown as CompilerDecision;
		const result = literalHandler.compile(decision, ctx, state);
		expect(result).toEqual({ A_Const: { sval: { sval: '1,2,3' } } });
	});
});
