// @ts-nocheck — coverage test: runtime assertions on AST nodes
/**
 * Coverage tests for handlers/index.ts.
 *
 * Focus: Branch coverage for the handler registry including:
 * - Registration functions (where, expression, include)
 * - Lookup functions (get/has handlers)
 * - Error paths (duplicate registration, missing handlers)
 * - normalizeToDecision (WhereIntent → Decision conversion)
 * - createWhereDispatcher (operator aliases, recursive dispatch)
 * - Registry stats and operator listing
 * - clearHandlers
 */

import { deparseSync } from 'pgsql-deparser';
import { describe, expect, it, vi } from 'vitest';
import { compilePlan } from '../compiler.js';
import {
	clearHandlers,
	createCompilerState,
	createWhereDispatcher,
	getExpressionHandler,
	getIncludeHandler,
	getRegisteredOperators,
	getRegistryStats,
	getWhereHandler,
	hasExpressionHandler,
	hasIncludeHandler,
	hasWhereHandler,
	registerExpressionHandler,
	registerIncludeHandler,
	registerWhereHandler,
} from './index.js';
import * as whereHandlerModule from './where/index.js';

function ensureRegistered() {
	const dispatch = createWhereDispatcher();
	const state = createCompilerState();
	const ctx = {
		naming: { toDatabase: (s) => s, toModel: (s) => s },
		rootTable: 'test',
		maxRecursiveDepth: 100,
	};
	dispatch(
		{ type: 'where', column: 'x', operator: '=', value: 1 },
		ctx as any,
		state,
	);
}

function restoreAllHandlerFamilies() {
	ensureRegistered();
	compilePlan({
		rootTable: 'orders',
		decisions: [
			{
				type: 'selectFunction',
				function: 'count',
				column: '*',
				alias: 'total',
			},
		],
	});
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
	});
	const operators = getRegisteredOperators();
	expect(operators.where).toContain('=');
	expect(operators.expression).toContain('count');
	expect(operators.include).toContain('join');
}

describe('handlers/index - Coverage Tests', () => {
	describe('createWhereDispatcher (triggers lazy init)', () => {
		it('shares the dispatcher across recursive compilation', () => {
			const operator = '__dispatcher_identity_probe__';
			const receivedDispatchers: unknown[] = [];
			const handler = {
				operators: [operator],
				compile: (decision, ctx, state, dispatch) => {
					receivedDispatchers.push(dispatch);
					if (decision.value === 'outer') {
						return dispatch(
							{
								type: 'where',
								column: 'nested',
								operator,
								value: 'nested',
							},
							ctx,
							state,
						);
					}
					return {};
				},
			};

			clearHandlers();
			try {
				registerWhereHandler(handler as any);
				const dispatch = createWhereDispatcher();
				const state = createCompilerState();
				const ctx = {
					naming: { toDatabase: (s) => s, toModel: (s) => s },
					rootTable: 'users',
					maxRecursiveDepth: 100,
				};

				dispatch(
					{
						type: 'where',
						column: 'outer',
						operator,
						value: 'outer',
					},
					ctx as any,
					state,
				);

				expect(receivedDispatchers).toHaveLength(2);
				expect(receivedDispatchers[0]).toBe(receivedDispatchers[1]);
				expect(receivedDispatchers[0]).toBe(dispatch);
			} finally {
				clearHandlers();
				ensureRegistered();
			}
		});

		it('dispatches a simple comparison', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const decision = {
				type: 'where',
				column: 'active',
				operator: '=',
				value: true,
			};
			const node = dispatch(decision, ctx as any, state);
			expect(node).toBeDefined();
			expect(state.parameters.length).toBeGreaterThan(0);
		});

		it('dispatches with operator alias (eq → =)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const decision = {
				type: 'where',
				column: 'id',
				operator: 'eq',
				value: 1,
			};
			const node = dispatch(decision, ctx as any, state);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (ne → !=)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'id', operator: 'ne', value: 0 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (neq → !=)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'id', operator: 'neq', value: 0 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (lt → <)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'age', operator: 'lt', value: 18 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (lte → <=)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'age', operator: 'lte', value: 65 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (gt → >)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'score', operator: 'gt', value: 50 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});

		it('dispatches with operator alias (gte → >=)', () => {
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (s) => s, toModel: (s) => s },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};
			const node = dispatch(
				{ type: 'where', column: 'score', operator: 'gte', value: 90 },
				ctx as any,
				state,
			);
			expect(node).toBeDefined();
		});
	});

	describe('registry stats after dispatcher init', () => {
		it('returns counts of registered handlers', () => {
			ensureRegistered();
			const stats = getRegistryStats();
			expect(stats.where).toBeGreaterThan(0);
			expect(typeof stats.expression).toBe('number');
			expect(typeof stats.include).toBe('number');
		});
	});

	describe('getRegisteredOperators', () => {
		it('returns arrays of registered operators after init', () => {
			ensureRegistered();
			const ops = getRegisteredOperators();
			expect(Array.isArray(ops.where)).toBe(true);
			expect(Array.isArray(ops.expression)).toBe(true);
			expect(Array.isArray(ops.include)).toBe(true);
		});

		it('contains known WHERE operators', () => {
			ensureRegistered();
			const ops = getRegisteredOperators();
			expect(ops.where).toContain('=');
			expect(ops.where).toContain('!=');
			expect(ops.where).toContain('like');
		});
	});

	describe('hasWhereHandler', () => {
		it('returns true for registered operator', () => {
			ensureRegistered();
			expect(hasWhereHandler('=')).toBe(true);
		});

		it('returns false for unregistered operator', () => {
			expect(hasWhereHandler('__nonexistent__')).toBe(false);
		});
	});

	describe('hasExpressionHandler', () => {
		it('returns false for unregistered type', () => {
			expect(hasExpressionHandler('__nonexistent__')).toBe(false);
		});
	});

	describe('hasIncludeHandler', () => {
		it('returns false for unregistered strategy', () => {
			expect(hasIncludeHandler('__fake__' as any)).toBe(false);
		});
	});

	describe('getWhereHandler - error path', () => {
		it('throws for unregistered operator', () => {
			expect(() => getWhereHandler('__nonexistent_op__')).toThrow(
				/No WHERE handler registered for operator/,
			);
		});
	});

	describe('getExpressionHandler - error path', () => {
		it('throws for unregistered type', () => {
			expect(() => getExpressionHandler('__nonexistent_type__')).toThrow(
				/No EXPRESSION handler registered for type/,
			);
		});
	});

	describe('getIncludeHandler - error path', () => {
		it('throws for unregistered strategy', () => {
			expect(() => getIncludeHandler('__fake__' as any)).toThrow(
				/No INCLUDE handler registered for strategy/,
			);
		});
	});

	describe('normalizeToDecision via dispatcher (WhereIntent kinds)', () => {
		const dispatch = createWhereDispatcher();
		const state = () => createCompilerState();
		const ctx = {
			naming: { toDatabase: (s) => s, toModel: (s) => s },
			rootTable: 'users',
			maxRecursiveDepth: 100,
		} as any;

		it('normalizes comparison kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'comparison',
					field: 'name',
					operator: '=',
					value: 'Alice',
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes and kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'and',
					conditions: [
						{ kind: 'comparison', field: 'a', operator: '=', value: 1 },
						{ kind: 'comparison', field: 'b', operator: '=', value: 2 },
					],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes or kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'or',
					conditions: [
						{ kind: 'comparison', field: 'a', operator: '=', value: 1 },
						{ kind: 'comparison', field: 'b', operator: '=', value: 2 },
					],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes not kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'not',
					condition: {
						kind: 'comparison',
						field: 'a',
						operator: '=',
						value: 1,
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes null kind (isNull)', () => {
			const s = state();
			const node = dispatch(
				{ kind: 'null', field: 'email', operator: 'isNull' } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes null kind (isNotNull)', () => {
			const s = state();
			const node = dispatch(
				{ kind: 'null', field: 'email', operator: 'isNotNull' } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with array values', () => {
			const s = state();
			const node = dispatch(
				{ kind: 'in', field: 'id', values: [1, 2, 3] } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with not flag', () => {
			const s = state();
			const node = dispatch(
				{ kind: 'in', field: 'id', values: [1, 2, 3], not: true } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes like kind', () => {
			const s = state();
			const node = dispatch(
				{ kind: 'like', field: 'name', pattern: '%Alice%' } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes like kind with caseInsensitive', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'like',
					field: 'name',
					pattern: '%alice%',
					caseInsensitive: true,
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with subquery', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'in',
					field: 'id',
					subquery: {
						from: 'active_users',
						select: 'user_id',
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with subquery + not flag', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'in',
					field: 'id',
					not: true,
					subquery: {
						from: 'blocked_users',
						select: 'user_id',
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with subquery + where', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'in',
					field: 'id',
					subquery: {
						from: 'users',
						select: 'id',
						where: {
							kind: 'comparison',
							field: 'active',
							operator: '=',
							value: true,
						},
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in kind with subquery + limit + orderBy', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'in',
					field: 'id',
					subquery: {
						from: 'users',
						select: 'id',
						limit: 10,
						orderBy: [{ field: 'created_at', direction: 'desc' }],
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes having type as where', () => {
			const s = state();
			const node = dispatch(
				{ type: 'having', column: 'cnt', operator: '>', value: 5 } as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes whereAnd type', () => {
			const s = state();
			const node = dispatch(
				{
					type: 'whereAnd',
					conditions: [{ type: 'where', column: 'a', operator: '=', value: 1 }],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes whereOr type', () => {
			const s = state();
			const node = dispatch(
				{
					type: 'whereOr',
					conditions: [{ type: 'where', column: 'a', operator: '=', value: 1 }],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes whereNot type', () => {
			const s = state();
			const node = dispatch(
				{
					type: 'whereNot',
					conditions: [{ type: 'where', column: 'a', operator: '=', value: 1 }],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes comparison with jsonPath', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'comparison',
					field: 'data',
					operator: '=',
					value: 'test',
					jsonPath: ['key'],
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes already-normalized decision with jsonPath', () => {
			const s = state();
			const node = dispatch(
				{
					type: 'where',
					column: 'data',
					operator: 'eq',
					value: 'test',
					jsonPath: ['key'],
					jsonMode: 'text',
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes jsonContains kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'jsonContains',
					field: 'data',
					value: { a: 1 },
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes jsonContains reversed kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'jsonContains',
					field: 'data',
					value: { a: 1 },
					reversed: true,
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes jsonExists kind', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'jsonExists',
					field: 'data',
					key: 'name',
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in subquery with select as object (fields)', () => {
			const s = state();
			const node = dispatch(
				{
					kind: 'in',
					field: 'id',
					subquery: {
						from: 'users',
						select: { type: 'fields', fields: ['user_id'] },
					},
				} as any,
				ctx,
				s,
			);
			expect(node).toBeDefined();
		});

		it('normalizes in subquery with select as non-string non-fields object → throws (SELECT * inside ANY is invalid SQL)', () => {
			// select: { type: 'all' } produces SELECT * inside ANY(...), which PostgreSQL
			// rejects — it would silently change which rows match.  The guard now throws
			// clearly instead of compiling broken SQL.
			const s = state();
			expect(() =>
				dispatch(
					{
						kind: 'in',
						field: 'id',
						subquery: {
							from: 'users',
							select: { type: 'all' },
						},
					} as any,
					ctx,
					s,
				),
			).toThrow(/IN subquery with SELECT \* \/ all.*is not supported/);
		});
	});

	describe('clearHandlers and re-init', () => {
		it('clears all handlers and stats return 0', () => {
			expect(() => clearHandlers()).not.toThrow();
			const stats = getRegistryStats();
			expect(stats.where).toBe(0);
			expect(stats.expression).toBe(0);
			expect(stats.include).toBe(0);
		});

		it('re-registers handlers via dispatcher (lazy init)', () => {
			// createWhereDispatcher triggers ensureHandlersRegistered
			ensureRegistered();
			// WHERE handlers should be re-populated
			expect(getRegistryStats().where).toBeGreaterThan(0);
		});

		it('re-registers expression handlers through compilePlan after clearing', () => {
			const plan = {
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						column: '*',
						alias: 'total',
					},
				],
			};

			clearHandlers();
			try {
				compilePlan(plan);
				clearHandlers();
				expect(() => compilePlan(plan)).not.toThrow();
			} finally {
				clearHandlers();
				restoreAllHandlerFamilies();
			}
		});

		it('re-registers include handlers through compilePlan after clearing', () => {
			const plan = {
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
			};

			clearHandlers();
			try {
				compilePlan(plan);
				clearHandlers();
				expect(() => compilePlan(plan)).not.toThrow();
			} finally {
				clearHandlers();
				restoreAllHandlerFamilies();
			}
		});

		it('rolls back failed WHERE initialization and retries it', () => {
			const plan = {
				rootTable: 'users',
				decisions: [
					{ type: 'select', column: '*' },
					{ type: 'where', column: 'active', operator: '=', value: true },
				],
			};
			const partiallyRegisteredHandler = {
				operators: ['__partial_where_registration__'],
				compile: () => ({}),
			};
			const failingHandler = {
				get operators() {
					throw new Error('simulated WHERE initialization failure');
				},
				compile: () => ({}),
			};

			clearHandlers();
			try {
				const beforeAttempt = getRegisteredOperators();
				vi.spyOn(
					whereHandlerModule,
					'allWhereHandlers',
					'get',
				).mockReturnValueOnce([
					partiallyRegisteredHandler,
					failingHandler,
				] as any);

				expect(() => compilePlan(plan)).toThrow(
					/simulated WHERE initialization failure/,
				);
				expect(getRegisteredOperators()).toEqual(beforeAttempt);
				expect(() => compilePlan(plan)).not.toThrow();
			} finally {
				vi.restoreAllMocks();
				clearHandlers();
				ensureRegistered();
			}
		});

		it('refuses reentrant WHERE registration during initialization and retries coherently', () => {
			const reentrantOperator = '__reentrant__';
			const outerOperator = '__outer_initialization__';
			const operators = [outerOperator];
			Object.defineProperty(operators, 0, {
				configurable: true,
				get() {
					registerWhereHandler({
						operators: [reentrantOperator],
						compile: () => ({}),
					} as any);
					return outerOperator;
				},
			});
			const reentrantHandler = { operators, compile: () => ({}) };
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (value) => value, toModel: (value) => value },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};

			clearHandlers();
			try {
				const beforeAttempt = getRegisteredOperators();
				vi.spyOn(
					whereHandlerModule,
					'allWhereHandlers',
					'get',
				).mockReturnValueOnce([reentrantHandler] as any);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).toThrow(
					'Cannot use WHERE handler registry reentrantly while WHERE handlers are initializing',
				);
				expect(getRegisteredOperators()).toEqual(beforeAttempt);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).not.toThrow();
				expect(hasWhereHandler('=')).toBe(true);
			} finally {
				vi.restoreAllMocks();
				clearHandlers();
				ensureRegistered();
			}
		});

		it('refuses a reset during WHERE initialization and retries coherently', () => {
			const outerOperator = '__reset_during_initialization__';
			const operators = [outerOperator];
			Object.defineProperty(operators, 0, {
				configurable: true,
				get() {
					clearHandlers();
					return outerOperator;
				},
			});
			const resetHandler = { operators, compile: () => ({}) };
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (value) => value, toModel: (value) => value },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};

			clearHandlers();
			try {
				const beforeAttempt = getRegisteredOperators();
				vi.spyOn(
					whereHandlerModule,
					'allWhereHandlers',
					'get',
				).mockReturnValueOnce([resetHandler] as any);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).toThrow(
					'Cannot use WHERE handler registry reentrantly while WHERE handlers are initializing',
				);
				expect(getRegisteredOperators()).toEqual(beforeAttempt);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).not.toThrow();
				expect(hasWhereHandler('=')).toBe(true);
			} finally {
				vi.restoreAllMocks();
				clearHandlers();
				ensureRegistered();
			}
		});

		it('refuses a reset without erasing a WHERE initialization prefix', () => {
			const originalHandlers = whereHandlerModule.allWhereHandlers;
			const outerOperator = '__reset_during_initialization__';
			let resetError: unknown;
			const operators = [outerOperator];
			Object.defineProperty(operators, 0, {
				configurable: true,
				get() {
					try {
						clearHandlers();
					} catch (error) {
						resetError = error;
					}
					return outerOperator;
				},
			});
			const resetHandler = { operators, compile: () => ({}) };
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (value) => value, toModel: (value) => value },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};

			clearHandlers();
			try {
				vi.spyOn(
					whereHandlerModule,
					'allWhereHandlers',
					'get',
				).mockReturnValueOnce([
					...originalHandlers.slice(0, 2),
					resetHandler,
					...originalHandlers.slice(2),
				] as any);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).not.toThrow();
				expect(hasWhereHandler('=')).toBe(true);
				expect(resetError).toHaveProperty(
					'message',
					'Cannot use WHERE handler registry reentrantly while WHERE handlers are initializing',
				);
			} finally {
				vi.restoreAllMocks();
				clearHandlers();
				ensureRegistered();
			}
		});

		it('publishes WHERE initialization only after every built-in installs', () => {
			const outerOperator = '__outer_initialization__';
			const originalHandlers = whereHandlerModule.allWhereHandlers;
			let reentrantError: unknown;
			const operators = [outerOperator];
			Object.defineProperty(operators, 0, {
				configurable: true,
				get() {
					try {
						registerWhereHandler({
							operators: [outerOperator],
							compile: () => ({}),
						} as any);
					} catch (error) {
						reentrantError = error;
					}
					return outerOperator;
				},
			});
			const reentrantHandler = { operators, compile: () => ({}) };
			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const ctx = {
				naming: { toDatabase: (value) => value, toModel: (value) => value },
				rootTable: 'users',
				maxRecursiveDepth: 100,
			};

			clearHandlers();
			try {
				vi.spyOn(
					whereHandlerModule,
					'allWhereHandlers',
					'get',
				).mockReturnValueOnce([reentrantHandler, ...originalHandlers] as any);

				expect(() =>
					dispatch(
						{ type: 'where', column: 'active', operator: '=', value: true },
						ctx as any,
						state,
					),
				).not.toThrow();
				expect(reentrantError).toHaveProperty(
					'message',
					'Cannot use WHERE handler registry reentrantly while WHERE handlers are initializing',
				);
				expect(hasWhereHandler('=')).toBe(true);
			} finally {
				vi.restoreAllMocks();
				clearHandlers();
				ensureRegistered();
			}
		});
	});

	describe('registration contract', () => {
		const compile = () => ({});

		it('installs WHERE built-ins after a custom registration before dispatch', () => {
			clearHandlers();
			const customHandler = { operators: ['__custom__', '@>'], compile };
			registerWhereHandler(customHandler as any);

			const dispatch = createWhereDispatcher();
			const state = createCompilerState();
			const node = dispatch(
				{ type: 'where', column: 'id', operator: '=', value: 42 },
				{
					naming: { toDatabase: (value) => value, toModel: (value) => value },
					rootTable: 'users',
					maxRecursiveDepth: 100,
				} as any,
				state,
			);
			const sql = deparseSync([{ SelectStmt: { whereClause: node } }])
				.replace(/^SELECT\s+WHERE\s+/i, '')
				.trim();

			expect(sql).toBe('users.id = $1');
			expect(hasWhereHandler('__custom__')).toBe(true);
			expect(hasWhereHandler('@>')).toBe(true);
			expect(
				getRegisteredOperators().where.every((key) => typeof key === 'string'),
			).toBe(true);
		});

		it('uses a copied WHERE key list for validation and application', () => {
			clearHandlers();
			let reads = 0;
			const operators = ['__copied_key__'];
			Object.defineProperty(operators, 0, {
				get: () => (reads++ === 0 ? '__copied_key__' : '__changed_key__'),
			});

			registerWhereHandler({ operators, compile } as any);

			expect(hasWhereHandler('__copied_key__')).toBe(true);
			expect(hasWhereHandler('__changed_key__')).toBe(false);
		});

		it('refuses WHERE aliases without registering the requested key', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({ operators: ['eq'], compile } as any),
			).toThrow(/eq is an alias for =/);
			expect(getRegisteredOperators().where).not.toContain('eq');
		});

		it('does not treat isDistinctFrom as an alias and dispatches it canonically', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({ operators: ['isDistinctFrom'], compile } as any),
			).toThrow(/already registered/);

			const state = createCompilerState();
			const node = createWhereDispatcher()(
				{
					type: 'where',
					column: 'left_value',
					operator: 'isDistinctFrom',
					value: 42,
				},
				{
					naming: { toDatabase: (value) => value, toModel: (value) => value },
					rootTable: 'users',
					maxRecursiveDepth: 100,
				} as any,
				state,
			);
			const sql = deparseSync([{ SelectStmt: { whereClause: node } }]);

			expect(sql).toContain('IS DISTINCT FROM');
		});

		it('checks every requested WHERE collision before adding any requested key', () => {
			clearHandlers();
			const firstHandler = { operators: ['__existing__'], compile };
			const secondHandler = { operators: ['__new__', '__existing__'], compile };
			registerWhereHandler(firstHandler as any);

			expect(() => registerWhereHandler(secondHandler as any)).toThrow(
				/__existing__/,
			);
			expect(hasWhereHandler('__new__')).toBe(false);
			expect(getWhereHandler('__existing__')).toBe(firstHandler);
		});

		it('refuses empty WHERE key lists without registration', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({ operators: [], compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().where).toEqual([]);
		});

		it('refuses blank WHERE keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({ operators: [' \t'], compile } as any),
			).toThrow(/cannot be blank.*\\t/);
			expect(getRegisteredOperators().where).toEqual([]);
		});

		it('refuses non-string WHERE keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({ operators: [1], compile } as unknown as any),
			).toThrow(/expected a string, received number/);
			expect(hasWhereHandler(1 as any)).toBe(false);
			expect(hasWhereHandler('1')).toBe(false);
		});

		it('refuses duplicate WHERE keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerWhereHandler({
					operators: ['__dup__', '__dup__'],
					compile,
				} as any),
			).toThrow(/duplicate __dup__/);
			expect(hasWhereHandler('__dup__')).toBe(false);
		});

		it('refuses empty EXPRESSION key lists without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [], compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses empty EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [''], compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses non-string EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({ types: [1], compile } as any),
			).toThrow(/expected a string, received number/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses duplicate EXPRESSION keys without registration', () => {
			clearHandlers();
			expect(() =>
				registerExpressionHandler({
					types: ['__d__', '__d__'],
					compile,
				} as any),
			).toThrow(/duplicate __d__/);
			expect(getRegisteredOperators().expression).toEqual([]);
		});

		it('refuses empty INCLUDE strategies without registration', () => {
			clearHandlers();
			expect(() =>
				registerIncludeHandler({ strategy: '', compile } as any),
			).toThrow(/cannot be empty/);
			expect(getRegisteredOperators().include).toEqual([]);
		});

		it('refuses blank INCLUDE strategies without registration', () => {
			clearHandlers();
			expect(() =>
				registerIncludeHandler({ strategy: ' \t', compile } as any),
			).toThrow(/cannot be blank.*\\t/);
			expect(getRegisteredOperators().include).toEqual([]);
		});

		it('refuses non-string INCLUDE strategies without registration', () => {
			clearHandlers();
			expect(() =>
				registerIncludeHandler({ strategy: 1, compile } as any),
			).toThrow(/expected a string, received number/);
			expect(getRegisteredOperators().include).toEqual([]);
		});

		it('refuses malformed handlers with diagnostics instead of property TypeErrors', () => {
			clearHandlers();
			expect(() => registerWhereHandler(null as any)).toThrow(
				/expected an object, received null/,
			);
			expect(() =>
				registerWhereHandler({ operators: 'nope', compile } as any),
			).toThrow(/operators: expected an array, received string/);
			expect(() =>
				registerWhereHandler({ operators: ['x'], compile: 'no' } as any),
			).toThrow(/compile: expected a function, received string/);
		});

		it('reinitializes all handler families through compilation after clearHandlers', () => {
			clearHandlers();
			restoreAllHandlerFamilies();
		});
	});

	describe('duplicate registration errors', () => {
		it('throws on duplicate WHERE operator registration', () => {
			ensureRegistered();
			const handler = {
				operators: ['='],
				compile: () => ({}),
			};
			expect(() => registerWhereHandler(handler as any)).toThrow(
				/already registered/,
			);
		});

		it('throws on duplicate EXPRESSION type registration', () => {
			compilePlan({
				rootTable: 'orders',
				decisions: [
					{
						type: 'selectFunction',
						function: 'count',
						column: '*',
						alias: 'total',
					},
				],
			});
			const ops = getRegisteredOperators();
			if (ops.expression.length > 0) {
				const handler = {
					types: [ops.expression[0]],
					compile: () => ({}),
				};
				expect(() => registerExpressionHandler(handler as any)).toThrow(
					/already registered/,
				);
			}
		});

		it('throws on duplicate INCLUDE strategy registration', () => {
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
			});
			const ops = getRegisteredOperators();
			if (ops.include.length > 0) {
				const handler = {
					strategy: ops.include[0],
					compile: () => ({}),
				};
				expect(() => registerIncludeHandler(handler as any)).toThrow(
					/already registered/,
				);
			}
		});
	});
});
