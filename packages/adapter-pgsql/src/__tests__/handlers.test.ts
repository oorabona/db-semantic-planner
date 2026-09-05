/**
 * Tests for Handler Infrastructure (Block 1)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { compilePlan } from '../compiler.js';
import {
	ALL_OPERATORS,
	COLLECTION_OPERATORS,
	COMPARISON_OPERATORS,
	clearHandlers,
	createCompilerState,
	createWhereDispatcher,
	type ExpressionHandler,
	ensureExpressionHandlersRegistered,
	ensureIncludeHandlersRegistered,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	getRegistryStats,
	getWhereHandler,
	hasExpressionHandler,
	hasIncludeHandler,
	hasWhereHandler,
	INCLUDE_STRATEGIES,
	type IncludeHandler,
	LOGICAL_OPERATORS,
	NULL_OPERATORS,
	PATTERN_OPERATORS,
	registerExpressionHandler,
	registerIncludeHandler,
	registerWhereHandler,
	type WhereHandler,
} from '../handlers/index.js';

describe('Handler Infrastructure', () => {
	beforeEach(() => {
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

	describe('WHERE Handler Registry', () => {
		const mockWhereHandler: WhereHandler = {
			operators: ['testOp', 'anotherOp'],
			compile: (_decision, _ctx, _state, _dispatch) => {
				return { A_Const: { sval: { sval: 'mock' } } };
			},
		};

		it('registers handler for multiple operators', () => {
			registerWhereHandler(mockWhereHandler);

			expect(hasWhereHandler('testOp')).toBe(true);
			expect(hasWhereHandler('anotherOp')).toBe(true);
			expect(hasWhereHandler('unknown')).toBe(false);
		});

		it('retrieves registered handler', () => {
			registerWhereHandler(mockWhereHandler);

			const handler = getWhereHandler('testOp');
			expect(handler).toBe(mockWhereHandler);
		});

		it('throws on duplicate operator registration', () => {
			registerWhereHandler(mockWhereHandler);

			const duplicate: WhereHandler = {
				operators: ['testOp'], // Already registered
				compile: () => ({ A_Const: { sval: { sval: 'dup' } } }),
			};

			expect(() => registerWhereHandler(duplicate)).toThrow(
				'WHERE handler already registered for operator: testOp',
			);
		});

		it('throws when getting unregistered operator', () => {
			expect(() => getWhereHandler('unknown')).toThrow(
				'No WHERE handler registered for operator: unknown',
			);
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
	});

	describe('INCLUDE Handler Registry', () => {
		const compile: IncludeHandler['compile'] = () => ({ targets: [] });

		it('refuses a strategy outside the built-in set without mutating the registry', () => {
			const invalidHandler = {
				strategy: '__nope__',
				compile,
			} as unknown as IncludeHandler;

			expect(() => registerIncludeHandler(invalidHandler)).toThrow(
				`Invalid INCLUDE handler strategy: __nope__ is not one of ${INCLUDE_STRATEGIES.join(', ')}`,
			);
			expect(getRegisteredOperators().include).not.toContain('__nope__');
			expect(() => getIncludeHandler('cte')).toThrow(
				'No INCLUDE handler registered for strategy: cte',
			);
		});

		it('refuses a valid strategy already registered by lazy initialization', () => {
			expect(() =>
				registerIncludeHandler({ strategy: 'json_agg', compile }),
			).toThrow('INCLUDE handler already registered for strategy: json_agg');
		});

		it('installs every built-in strategy for include compilation before refusing duplicate registration', () => {
			expect(() =>
				compilePlan({
					rootTable: 'posts',
					decisions: [
						{ type: 'select', column: '*', table: 'posts' },
						{
							type: 'includeStrategy',
							choice: 'join',
							relationName: 'author',
							targetTable: 'authors',
							relationType: 'belongsTo',
							foreignKey: 'author_id',
							parentKey: 'id',
							columns: ['id', 'name'],
						},
					],
				}),
			).not.toThrow();
			expect(getRegisteredOperators().include).toEqual(INCLUDE_STRATEGIES);
			expect(hasIncludeHandler('lateral')).toBe(true);
			expect(getIncludeHandler('json_agg').strategy).toBe('json_agg');
			expect(() =>
				registerIncludeHandler({ strategy: 'join', compile }),
			).toThrow('INCLUDE handler already registered for strategy: join');
		});
	});

	describe('Registry Stats', () => {
		it('returns zero counts when empty', () => {
			const stats = getRegistryStats();

			expect(stats.where).toBe(0);
			expect(stats.expression).toBe(0);
			expect(stats.include).toBe(0);
		});

		it('returns correct counts after registration', () => {
			const whereOperator = '__handlers_test_where__';
			const expressionType = '__handlers_test_expression__';
			createWhereDispatcher()(
				{ type: 'where', column: 'id', operator: '=', value: 1 },
				{
					naming: {
						toDatabase: (value: string) => value,
						toModel: (value: string) => value,
					},
					rootTable: 'test',
					maxRecursiveDepth: 100,
				} as any,
				createCompilerState(),
			);
			ensureExpressionHandlersRegistered();
			ensureIncludeHandlersRegistered();
			const before = getRegistryStats();
			registerWhereHandler({
				operators: [whereOperator],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});
			registerExpressionHandler({
				types: [expressionType],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});
			const after = getRegistryStats();

			expect(after.where).toBe(before.where + 1);
			expect(after.expression).toBe(before.expression + 1);
			expect(after.include).toBe(before.include);
		});
	});

	describe('Registered Operators', () => {
		it('returns registered operator names', () => {
			const whereOperator = '__handlers_test_registered_operator__';
			registerWhereHandler({
				operators: [whereOperator],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});

			const operators = getRegisteredOperators();

			expect(operators.where).toContain(whereOperator);
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
