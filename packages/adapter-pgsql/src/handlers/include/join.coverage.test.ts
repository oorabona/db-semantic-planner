// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for handlers/include/join.ts
 * Focus: Branch coverage for joinIncludeHandler
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import { createCompilerState } from '../types.js';
import { joinIncludeHandler } from './join.js';

function makeCtx(overrides = {}) {
	return {
		naming: identityNaming,
		rootTable: 'posts',
		maxRecursiveDepth: 100,
		...overrides,
	};
}

describe('joinIncludeHandler — coverage', () => {
	it('compiles LEFT JOIN with explicit sourceColumn and targetColumn', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
		expect(result.join.JoinExpr.jointype).toBe('JOIN_LEFT');
	});

	it('derives targetColumn from FK convention when not specified', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
	});

	it('uses relation as targetTable when targetTable not specified', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'tags',
				sourceColumn: 'tag_id',
				targetColumn: 'id',
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
	});

	it('throws when no targetTable and no relation', () => {
		const state = createCompilerState();
		expect(() =>
			joinIncludeHandler.compile(
				{
					type: 'includeStrategy',
					strategy: 'join',
					sourceColumn: 'id',
				},
				makeCtx(),
				state,
			),
		).toThrow('JOIN include requires targetTable');
	});

	it('compiles with wildcard columns', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
				columns: ['*'],
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
		expect(result.targets).toBeDefined();
		expect(result.targets.length).toBeGreaterThan(0);
	});

	it('compiles with specific columns', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
				columns: ['name', 'email'],
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
		expect(result.targets).toHaveLength(2);
	});

	it('compiles without columns (no targets)', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
			},
			makeCtx(),
			state,
		);
		expect(result.targets).toBeUndefined();
	});

	it('uses currentAlias when available', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
			},
			makeCtx({ currentAlias: 'p' }),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
	});

	it('includes schema in JOIN when ctx.schema is set', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
			},
			makeCtx({ schema: 'tenant_1' }),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
	});

	it('uses custom deriveFkColumnName from ctx', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
			},
			makeCtx({
				defaultPkColumnName: 'uuid',
				deriveFkColumnName: (table, pk) => `fk_${table}_${pk}`,
			}),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
	});

	it('defaults to LEFT JOIN when joinType is not set', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
			},
			makeCtx(),
			state,
		);
		expect(result.join.JoinExpr.jointype).toBe('JOIN_LEFT');
	});

	it('produces INNER JOIN when joinType is "inner"', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
				joinType: 'inner',
			},
			makeCtx(),
			state,
		);
		expect(result.join).toHaveProperty('JoinExpr');
		expect(result.join.JoinExpr.jointype).toBe('JOIN_INNER');
	});

	it('produces LEFT JOIN when joinType is "left"', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'author',
				targetTable: 'users',
				sourceColumn: 'author_id',
				targetColumn: 'id',
				joinType: 'left',
			},
			makeCtx(),
			state,
		);
		expect(result.join.JoinExpr.jointype).toBe('JOIN_LEFT');
	});

	it('produces INNER JOIN with specific columns', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'file',
				targetTable: 'files',
				sourceColumn: 'file_id',
				targetColumn: 'id',
				joinType: 'inner',
				columns: ['path', 'name'],
			},
			makeCtx(),
			state,
		);
		expect(result.join.JoinExpr.jointype).toBe('JOIN_INNER');
		expect(result.targets).toHaveLength(2);
	});

	// RELATION-COL-RESULT fix: columnAliases must be used as output alias
	it('uses user-supplied alias from columnAliases for target', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'file',
				targetTable: 'files',
				sourceColumn: 'file_id',
				targetColumn: 'id',
				columns: ['path'],
				columnAliases: { path: 'file_path' },
			},
			makeCtx(),
			state,
		);
		expect(result.targets).toHaveLength(1);
		// The ResTarget name must be the user-supplied alias, not "file.path"
		const target = result.targets[0];
		expect(target.ResTarget.name).toBe('file_path');
	});

	it('falls back to relation.column alias when no columnAliases entry', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'file',
				targetTable: 'files',
				sourceColumn: 'file_id',
				targetColumn: 'id',
				columns: ['path'],
				// No columnAliases — fall back to convention
			},
			makeCtx(),
			state,
		);
		expect(result.targets).toHaveLength(1);
		const target = result.targets[0];
		expect(target.ResTarget.name).toBe('file.path');
	});

	it('uses user alias for one column, falls back for another', () => {
		const state = createCompilerState();
		const result = joinIncludeHandler.compile(
			{
				type: 'includeStrategy',
				strategy: 'join',
				relation: 'file',
				targetTable: 'files',
				sourceColumn: 'file_id',
				targetColumn: 'id',
				columns: ['path', 'name'],
				columnAliases: { path: 'file_path' }, // only 'path' aliased
			},
			makeCtx(),
			state,
		);
		expect(result.targets).toHaveLength(2);
		const pathTarget = result.targets[0];
		const nameTarget = result.targets[1];
		expect(pathTarget.ResTarget.name).toBe('file_path');
		expect(nameTarget.ResTarget.name).toBe('file.name');
	});
});
