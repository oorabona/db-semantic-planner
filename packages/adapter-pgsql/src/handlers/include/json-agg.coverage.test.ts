// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for json-agg.ts include handler.
 *
 * Covers: jsonAggIncludeHandler
 * Focus: JSON aggregation at different nesting depths, filter merge, empty children, limit propagation
 */

import { describe, expect, it } from 'vitest';
import { identityNaming } from '../../naming-plugin.js';
import type { CompilerContext, Decision } from '../types.js';
import { createCompilerState } from '../types.js';
import { jsonAggIncludeHandler } from './json-agg.js';

function makeCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
	return {
		naming: identityNaming,
		rootTable: 'users',
		maxRecursiveDepth: 100,
		defaultPkColumnName: 'id',
		deriveFkColumnName: (tableName: string) => `${tableName}_id`,
		...overrides,
	} as CompilerContext;
}

// ============================================================================
// jsonAggIncludeHandler coverage
// ============================================================================

describe('jsonAggIncludeHandler', () => {
	it('compiles hasMany relation with basic config', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0]).toHaveProperty('ResTarget');
	});

	it('compiles belongsTo relation', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'user',
			targetTable: 'users',
			relationType: 'belongsTo',
			foreignKey: 'user_id',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with explicit foreignKey', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			foreignKey: 'author_id',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with explicit parentKey', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			parentKey: 'user_id',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with limit', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			limit: 10,
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('ignores limit when not a number', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			limit: 'invalid',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with specific columns', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			columns: ['id', 'title', 'created_at'],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with compiled filter WHERE clause', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			_compiledFilterWhere: {
				A_Expr: {
					kind: 'AEXPR_OP',
					name: [{ String: { sval: '=' } }],
					lexpr: { ColumnRef: { fields: [{ String: { sval: 'status' } }] } },
					rexpr: { ParamRef: { number: 1 } },
				},
			},
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with one level of nested children', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with two levels of nested children', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
					children: [
						{
							relation: 'likes',
							targetTable: 'likes',
							relationType: 'hasMany',
						},
					],
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles with multiple sibling children', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
				},
				{
					relation: 'likes',
					targetTable: 'likes',
					relationType: 'hasMany',
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('skips children missing relation name', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					// No relation name
					targetTable: 'comments',
					relationType: 'hasMany',
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('skips children missing targetTable', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					// No targetTable
					relationType: 'hasMany',
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('skips children missing relationType', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					// No relationType
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('handles empty children array', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('uses relationName when relation is not set', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relationName: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('uses targetTable when targetTable is not set but relation is', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('throws when targetTable is missing', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relationType: 'hasMany',
		} as unknown as Decision;
		expect(() => jsonAggIncludeHandler.compile(decision, ctx, state)).toThrow(
			'JSON_AGG include requires targetTable',
		);
	});

	it('throws when relation name is missing', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			targetTable: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		expect(() => jsonAggIncludeHandler.compile(decision, ctx, state)).toThrow(
			'JSON_AGG include requires relation name',
		);
	});

	it('uses currentAlias when set', () => {
		const state = createCompilerState();
		const ctx = makeCtx({ currentAlias: 'u' });
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('uses schema when set', () => {
		const state = createCompilerState();
		const ctx = makeCtx({ schema: 'tenant_1' });
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles nested child with limit', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
					limit: 5,
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles nested child with columns', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
					columns: ['id', 'text'],
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});

	it('compiles nested child with compiled filter', () => {
		const state = createCompilerState();
		const ctx = makeCtx();
		const decision = {
			type: 'include',
			strategy: 'json_agg',
			relation: 'posts',
			targetTable: 'posts',
			relationType: 'hasMany',
			children: [
				{
					relation: 'comments',
					targetTable: 'comments',
					relationType: 'hasMany',
					_compiledFilterWhere: {
						A_Expr: {
							kind: 'AEXPR_OP',
							name: [{ String: { sval: '=' } }],
							lexpr: {
								ColumnRef: { fields: [{ String: { sval: 'approved' } }] },
							},
							rexpr: { ParamRef: { number: 1 } },
						},
					},
				},
			],
		} as unknown as Decision;
		const result = jsonAggIncludeHandler.compile(decision, ctx, state);
		expect(result.targets).toHaveLength(1);
	});
});
