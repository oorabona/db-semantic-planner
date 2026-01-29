/**
 * Tests for Handler Infrastructure (Block 1)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
	ALL_OPERATORS,
	COLLECTION_OPERATORS,
	// Constants
	COMPARISON_OPERATORS,
	clearHandlers,
	// Factory
	createCompilerState,
	type ExpressionHandler,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	// Debugging
	getRegistryStats,
	// Lookup
	getWhereHandler,
	hasExpressionHandler,
	hasIncludeHandler,
	hasWhereHandler,
	type IncludeHandler,
	LOGICAL_OPERATORS,
	NULL_OPERATORS,
	PATTERN_OPERATORS,
	registerExpressionHandler,
	registerIncludeHandler,
	// Registration
	registerWhereHandler,
	// Types
	type WhereHandler,
} from '../index.js';

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
			types: ['column', 'alias'],
			compile: (_decision, _ctx, _state) => {
				return { A_Const: { sval: { sval: 'expr' } } };
			},
		};

		it('registers handler for multiple types', () => {
			registerExpressionHandler(mockExprHandler);

			expect(hasExpressionHandler('column')).toBe(true);
			expect(hasExpressionHandler('alias')).toBe(true);
			expect(hasExpressionHandler('unknown')).toBe(false);
		});

		it('retrieves registered handler', () => {
			registerExpressionHandler(mockExprHandler);

			const handler = getExpressionHandler('column');
			expect(handler).toBe(mockExprHandler);
		});

		it('throws on duplicate type registration', () => {
			registerExpressionHandler(mockExprHandler);

			const duplicate: ExpressionHandler = {
				types: ['column'],
				compile: () => ({ A_Const: { sval: { sval: 'dup' } } }),
			};

			expect(() => registerExpressionHandler(duplicate)).toThrow(
				'EXPRESSION handler already registered for type: column',
			);
		});

		it('throws when getting unregistered type', () => {
			expect(() => getExpressionHandler('unknown')).toThrow(
				'No EXPRESSION handler registered for type: unknown',
			);
		});
	});

	describe('INCLUDE Handler Registry', () => {
		const mockIncludeHandler: IncludeHandler = {
			strategy: 'json_agg',
			compile: (_decision, _ctx, _state) => {
				return { targets: [] };
			},
		};

		it('registers handler for strategy', () => {
			registerIncludeHandler(mockIncludeHandler);

			expect(hasIncludeHandler('json_agg')).toBe(true);
			expect(hasIncludeHandler('lateral')).toBe(false);
		});

		it('retrieves registered handler', () => {
			registerIncludeHandler(mockIncludeHandler);

			const handler = getIncludeHandler('json_agg');
			expect(handler).toBe(mockIncludeHandler);
		});

		it('throws on duplicate strategy registration', () => {
			registerIncludeHandler(mockIncludeHandler);

			const duplicate: IncludeHandler = {
				strategy: 'json_agg',
				compile: () => ({}),
			};

			expect(() => registerIncludeHandler(duplicate)).toThrow(
				'INCLUDE handler already registered for strategy: json_agg',
			);
		});

		it('throws when getting unregistered strategy', () => {
			expect(() => getIncludeHandler('cte')).toThrow(
				'No INCLUDE handler registered for strategy: cte',
			);
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
			registerWhereHandler({
				operators: ['eq', 'neq'],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});
			registerExpressionHandler({
				types: ['column'],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});
			registerIncludeHandler({
				strategy: 'join',
				compile: () => ({}),
			});

			const stats = getRegistryStats();

			expect(stats.where).toBe(2); // eq and neq
			expect(stats.expression).toBe(1);
			expect(stats.include).toBe(1);
		});
	});

	describe('Registered Operators', () => {
		it('returns registered operator names', () => {
			registerWhereHandler({
				operators: ['eq', 'neq'],
				compile: () => ({ A_Const: { sval: { sval: '' } } }),
			});

			const operators = getRegisteredOperators();

			expect(operators.where).toContain('eq');
			expect(operators.where).toContain('neq');
		});
	});

	describe('Operator Constants', () => {
		it('has comparison operators', () => {
			expect(COMPARISON_OPERATORS.EQ).toBe('=');
			expect(COMPARISON_OPERATORS.NEQ).toBe('!=');
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
