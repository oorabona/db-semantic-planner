/**
 * Tests for Handler Infrastructure (Block 1)
 */

import { createOrm, ref, schema } from '@dbsp/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileExpressionIntent } from '../handlers/expression/custom.js';
import * as includeHandlerModule from '../handlers/include/index.js';
import {
	ALL_OPERATORS,
	COLLECTION_OPERATORS,
	COMPARISON_OPERATORS,
	clearHandlers,
	createCompilerState,
	cteIncludeHandler,
	type Decision,
	type ExpressionHandler,
	ensureExpressionHandlersRegistered,
	ensureIncludeHandlersRegistered,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	getRegistryStats,
	hasExpressionHandler,
	hasIncludeHandler,
	INCLUDE_STRATEGIES,
	type IncludeHandler,
	LOGICAL_OPERATORS,
	NULL_OPERATORS,
	PATTERN_OPERATORS,
	registerExpressionHandler,
} from '../handlers/index.js';
import { createPgCompileOnlyAdapter } from '../pgsql-adapter.js';
import { includeHandlerFixture } from './include-handler-fixture.js';

function expectOneLineError(fn: () => unknown, expected: string): void {
	expect(fn).toThrow(expected);
	try {
		fn();
	} catch (error) {
		expect((error as Error).message).toBe(expected);
		expect((error as Error).message).not.toMatch(/[\r\n]/);
	}
}

describe('Handler Infrastructure', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		// Clear handlers before each test
		clearHandlers();
	});

	describe('CompilerState', () => {
		it('creates fresh state with default values', () => {
			const state = createCompilerState();

			expect(state.parameters).toEqual([]);
			expect(state.paramIndex).toBe(0);
			expect(state.ctes.size).toBe(0);
			expect(state.aliases.size).toBe(0);
			expect(state.joins).toEqual([]);
		});

		it('allows mutation of state', () => {
			const state = createCompilerState();

			state.parameters.push('test');
			state.paramIndex = 1;
			state.ctes.set('cte1', { A_Const: { sval: { sval: 'test' } } });
			state.aliases.set('users', 'u');

			expect(state.parameters).toEqual(['test']);
			expect(state.paramIndex).toBe(1);
			expect(state.ctes.size).toBe(1);
			expect(state.aliases.size).toBe(1);
		});
	});

	describe('EXPRESSION Handler Registry', () => {
		const mockExprHandler: ExpressionHandler = {
			types: ['__test_column__', '__test_alias__'],
			compile: (_decision, _ctx, _state) => {
				return { A_Const: { sval: { sval: 'expr' } } };
			},
		};

		it('registers handler for multiple types', () => {
			registerExpressionHandler(mockExprHandler);

			expect(hasExpressionHandler('__test_column__')).toBe(true);
			expect(hasExpressionHandler('__test_alias__')).toBe(true);
			expect(hasExpressionHandler('unknown')).toBe(false);
		});

		it('retrieves registered handler', () => {
			registerExpressionHandler(mockExprHandler);

			const handler = getExpressionHandler('__test_column__');
			expect(handler).toBe(mockExprHandler);
		});

		it('throws on duplicate type registration', () => {
			registerExpressionHandler(mockExprHandler);

			const duplicate: ExpressionHandler = {
				types: ['__test_column__'],
				compile: () => ({ A_Const: { sval: { sval: 'dup' } } }),
			};

			expect(() => registerExpressionHandler(duplicate)).toThrow(
				'EXPRESSION handler already registered for type: __test_column__',
			);
		});

		it('throws when getting unregistered type', () => {
			expect(() => getExpressionHandler('unknown')).toThrow(
				'No EXPRESSION handler registered for type: unknown',
			);
		});

		it('escapes an unregistered type key in its diagnostic', () => {
			expectOneLineError(
				() => getExpressionHandler('custom\nFAKE'),
				'No EXPRESSION handler registered for type: custom\\nFAKE',
			);
		});
	});

	describe('INCLUDE Handler Registry', () => {
		const compile: IncludeHandler['compile'] = () => ({ targets: [] });
		const includeDb = schema({
			authors: { id: { type: 'integer', primaryKey: true }, name: 'text' },
			posts: {
				id: { type: 'integer', primaryKey: true },
				authorId: ref('authors', { as: 'author' }),
			},
		});
		const includeOrm = createOrm({
			schema: includeDb,
			adapter: createPgCompileOnlyAdapter({ model: includeDb.model }),
		});
		const compileIncludePlan = () =>
			includeOrm.select('posts').include('author').dump();

		it('freezes the built-in strategy set at runtime', () => {
			expect(() =>
				(INCLUDE_STRATEGIES as unknown as string[]).push('custom'),
			).toThrow(TypeError);
		});

		it('refuses an injected strategy outside the built-in set, rolls back, then initializes normally', () => {
			vi.spyOn(
				includeHandlerModule,
				'allIncludeHandlers',
				'get',
			).mockReturnValueOnce([
				{ strategy: '__nope__', compile } as unknown as IncludeHandler,
			]);

			expect(() => ensureIncludeHandlersRegistered()).toThrow(
				new Error(
					`Invalid INCLUDE handler strategy: __nope__ is not one of ${INCLUDE_STRATEGIES.join(', ')}`,
				),
			);
			expect(getRegisteredOperators().include).toEqual([]);
			expect(() => compileIncludePlan()).not.toThrow();
			expect(getRegisteredOperators().include).toEqual(INCLUDE_STRATEGIES);
		});

		it('refuses injected non-string, empty, and blank strategies without mutating the registry', () => {
			vi.spyOn(includeHandlerModule, 'allIncludeHandlers', 'get')
				.mockReturnValueOnce([{ strategy: 1, compile }] as any)
				.mockReturnValueOnce([{ strategy: '', compile }] as any)
				.mockReturnValueOnce([{ strategy: ' \t', compile }] as any);

			expect(() => ensureIncludeHandlersRegistered()).toThrow(
				new Error(
					'Invalid INCLUDE handler strategy: expected a string, received number',
				),
			);
			expect(getRegisteredOperators().include).toEqual([]);
			expect(() => ensureIncludeHandlersRegistered()).toThrow(
				new Error(
					'Invalid INCLUDE handler strategy: cannot be empty (received )',
				),
			);
			expect(getRegisteredOperators().include).toEqual([]);
			expect(() => ensureIncludeHandlersRegistered()).toThrow(
				new Error(
					'Invalid INCLUDE handler strategy: cannot be blank (received  \\t)',
				),
			);
			expect(getRegisteredOperators().include).toEqual([]);
			expect(() => compileIncludePlan()).not.toThrow();
			expect(getRegisteredOperators().include).toEqual(INCLUDE_STRATEGIES);
		});

		it('installs every built-in strategy for ordinary include compilation', () => {
			expect(() => compileIncludePlan()).not.toThrow();
			expect(getRegisteredOperators().include).toEqual(INCLUDE_STRATEGIES);
			expect(hasIncludeHandler('lateral')).toBe(true);
			expect(getIncludeHandler('json_agg').strategy).toBe('json_agg');
		});

		it('escapes an unregistered strategy key in its diagnostic', () => {
			expectOneLineError(
				() => getIncludeHandler('join\nFAKE' as never),
				'No INCLUDE handler registered for strategy: join\\nFAKE',
			);
		});
	});

	describe('Registry Stats', () => {
		it('returns zero counts when empty', () => {
			const stats = getRegistryStats();

			expect(stats.expression).toBe(0);
			expect(stats.include).toBe(0);
		});
	});

	describe('Operator Constants', () => {
		it('has comparison operators', () => {
			expect(COMPARISON_OPERATORS.EQ).toBe('=');
			expect(COMPARISON_OPERATORS.NEQ).toBe('!=');
			expect(COMPARISON_OPERATORS.IS_DISTINCT_FROM).toBe('isDistinctFrom');
			expect(COMPARISON_OPERATORS.LT).toBe('<');
			expect(COMPARISON_OPERATORS.LTE).toBe('<=');
			expect(COMPARISON_OPERATORS.GT).toBe('>');
			expect(COMPARISON_OPERATORS.GTE).toBe('>=');
		});

		it('has pattern operators', () => {
			expect(PATTERN_OPERATORS.LIKE).toBe('like');
			expect(PATTERN_OPERATORS.ILIKE).toBe('ilike');
		});

		it('has null operators', () => {
			expect(NULL_OPERATORS.IS_NULL).toBe('isNull');
			expect(NULL_OPERATORS.IS_NOT_NULL).toBe('isNotNull');
		});

		it('has collection operators', () => {
			expect(COLLECTION_OPERATORS.IN).toBe('in');
			expect(COLLECTION_OPERATORS.NOT_IN).toBe('notIn');
		});

		it('has logical operators', () => {
			expect(LOGICAL_OPERATORS.AND).toBe('and');
			expect(LOGICAL_OPERATORS.OR).toBe('or');
			expect(LOGICAL_OPERATORS.NOT).toBe('not');
		});

		it('ALL_OPERATORS contains all operators', () => {
			expect(ALL_OPERATORS).toMatchObject(COMPARISON_OPERATORS);
			expect(ALL_OPERATORS).toMatchObject(PATTERN_OPERATORS);
			expect(ALL_OPERATORS).toMatchObject(NULL_OPERATORS);
			expect(ALL_OPERATORS).toMatchObject(COLLECTION_OPERATORS);
			expect(ALL_OPERATORS).toMatchObject(LOGICAL_OPERATORS);
		});
	});
});

describe("handlers refuse a condition without core's resolution (#1105)", () => {
	it('AC6b case-registry: the registry holds no Decision-based CASE handler', () => {
		ensureExpressionHandlersRegistered();
		expect(hasExpressionHandler('case')).toBe(false);
		expect(hasExpressionHandler('simpleCase')).toBe(true);
	});

	it('AC6b custom-case: a CASE expression without compileCaseCondition is refused', () => {
		expect(() =>
			compileExpressionIntent(
				{
					kind: 'case',
					when: [
						{
							condition: {
								kind: 'comparison',
								field: 'id',
								operator: 'eq',
								value: 1,
							},
							result: { kind: 'literal', value: 1 },
						},
					],
				} as never,
				{ rootTable: 'users', maxRecursiveDepth: 100 } as never,
				createCompilerState(),
			),
		).toThrow(
			"CASE WHEN condition reached the adapter without core's resolution.",
		);
	});

	it('AC6b cte-include: an include decision carrying conditions is refused', () => {
		const ctx = { rootTable: 'users', maxRecursiveDepth: 100 } as never;
		const decision = {
			type: 'includeStrategy',
			relation: 'posts',
			targetTable: 'posts',
			sourceColumn: 'id',
			targetColumn: 'user_id',
			strategy: 'cte',
			conditions: [
				{ type: 'where', column: 'published', operator: '=', value: true },
			],
		} as Decision;
		expect(() =>
			cteIncludeHandler.compile(
				includeHandlerFixture(decision, ctx),
				ctx,
				createCompilerState(),
			),
		).toThrow(
			"An include condition reached the adapter without core's resolution.",
		);
	});
});
