// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for column.ts expression handlers.
 * Focus: Branch coverage for columnHandler, columnAliasHandler, starHandler
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import { createCompilerState } from '../types.js';
import { columnAliasHandler, columnHandler, starHandler } from './column.js';

function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

describe('columnHandler — coverage', () => {
	it('compiles column reference with rootTable', () => {
		const state = createCompilerState();
		const node = columnHandler.compile(
			{ type: 'column', column: 'name' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('compiles column reference with currentAlias', () => {
		const state = createCompilerState();
		const node = columnHandler.compile(
			{ type: 'column', column: 'email' },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			columnHandler.compile({ type: 'column' }, makeCtx(), state),
		).toThrow('Column handler requires column');
	});
});

describe('columnAliasHandler — coverage', () => {
	it('compiles column with alias → ResTarget', () => {
		const state = createCompilerState();
		const node = columnAliasHandler.compile(
			{ type: 'columnAlias', column: 'email', alias: 'user_email' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
		expect(node.ResTarget.name).toBe('user_email');
	});

	it('compiles column without alias → bare ColumnRef', () => {
		const state = createCompilerState();
		const node = columnAliasHandler.compile(
			{ type: 'columnAlias', column: 'email' },
			makeCtx(),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
	});

	it('throws when column is missing', () => {
		const state = createCompilerState();
		expect(() =>
			columnAliasHandler.compile(
				{ type: 'columnAlias', alias: 'x' },
				makeCtx(),
				state,
			),
		).toThrow('Column alias handler requires column');
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const node = columnAliasHandler.compile(
			{ type: 'columnAlias', column: 'name', alias: 'n' },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('ResTarget');
	});
});

describe('starHandler — coverage', () => {
	it('compiles qualified star with rootTable', () => {
		const state = createCompilerState();
		const node = starHandler.compile({ type: 'star' }, makeCtx(), state);
		expect(node).toHaveProperty('ColumnRef');
		// Should produce table.* with A_Star
		const fields = node.ColumnRef.fields;
		expect(fields).toHaveLength(2);
		expect(fields[1]).toHaveProperty('A_Star');
	});

	it('compiles qualified star with currentAlias', () => {
		const state = createCompilerState();
		const node = starHandler.compile(
			{ type: '*' },
			makeCtx({ currentAlias: 'u' }),
			state,
		);
		expect(node).toHaveProperty('ColumnRef');
		expect(node.ColumnRef.fields[0].String.sval).toBe('u');
	});
});
