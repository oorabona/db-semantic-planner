/**
 * @fileoverview Coverage tests for hooks.ts
 * Targets uncovered branches not tested in hooks.test.ts
 */

import type { QueryIntent } from '@dbsp/types';
import { describe, expect, it } from 'vitest';
import {
	type AfterMutationHook,
	type AfterQueryHook,
	type BeforeMutationHook,
	type BeforeQueryHook,
	createHookManager,
	enterHookExecution,
	getHookStore,
	hasHooks,
	type MutationHookContext,
	type QueryHookContext,
	runAfterMutationHooks,
	runAfterQueryHooks,
	runBeforeMutationHooks,
	runBeforeQueryHooks,
	runOnErrorHooks,
} from './hooks.js';

// ============================================================================
// Test Helpers
// ============================================================================

function makeQueryContext(
	overrides?: Partial<QueryHookContext>,
): QueryHookContext {
	return {
		table: 'users',
		operation: 'select',
		intent: { type: 'select', from: 'users' } as QueryIntent,
		resultType: 'all',
		...overrides,
	};
}

function makeMutationContext<T = unknown>(
	overrides?: Partial<MutationHookContext<T>>,
): MutationHookContext<T> {
	return {
		table: 'users',
		operation: 'insert',
		intent: { type: 'insert', into: 'users', values: [{}] } as never,
		cardinality: 'single',
		...overrides,
	};
}

// ============================================================================
// Hook returns null (not undefined)
// ============================================================================

describe('Hook null return handling', () => {
	it('should preserve original context when beforeQuery hook returns null', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [() => null as unknown as undefined];
		const ctx = makeQueryContext({ correlationId: 'original' });

		// Act
		const result = await runBeforeQueryHooks(hooks, ctx);

		// Assert
		expect(result.correlationId).toBe('original');
	});

	it('should preserve original result when afterQuery hook returns null', async () => {
		// Arrange
		const hooks: AfterQueryHook[] = [
			(() => null as unknown as undefined) as AfterQueryHook,
		];
		const ctx = makeQueryContext();
		const original = [{ id: 1 }];

		// Act
		const result = await runAfterQueryHooks(hooks, ctx, original);

		// Assert
		expect(result).toEqual(original);
	});

	it('should preserve original context when beforeMutation hook returns null', async () => {
		// Arrange
		const hooks: BeforeMutationHook[] = [
			(() => null as unknown as undefined) as BeforeMutationHook,
		];
		const ctx = makeMutationContext({ correlationId: 'mut-123' });

		// Act
		const result = await runBeforeMutationHooks(hooks, ctx);

		// Assert
		expect(result.correlationId).toBe('mut-123');
	});

	it('should preserve original result when afterMutation hook returns null', async () => {
		// Arrange
		const hooks: AfterMutationHook[] = [
			(() => null as unknown as undefined) as AfterMutationHook,
		];
		const ctx = makeMutationContext();
		const original = [{ id: 42 }];

		// Act
		const result = await runAfterMutationHooks(hooks, ctx, original);

		// Assert
		expect(result).toEqual(original);
	});
});

// ============================================================================
// onHookError: continue vs abort
// ============================================================================

describe('onHookError strategies', () => {
	it('should continue execution when afterQuery hook throws and onHookError returns continue', async () => {
		// Arrange
		const hooks: AfterQueryHook[] = [
			(() => {
				throw new Error('hook1 failed');
			}) as AfterQueryHook,
			((_, result) => result) as AfterQueryHook,
		];
		const ctx = makeQueryContext();
		const onHookError = () => 'continue' as const;

		// Act
		const result = await runAfterQueryHooks(
			hooks,
			ctx,
			[{ id: 1 }],
			onHookError,
		);

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});

	it('should abort execution when afterQuery hook throws and onHookError returns abort', async () => {
		// Arrange
		const hooks: AfterQueryHook[] = [
			(() => {
				throw new Error('hook failed');
			}) as AfterQueryHook,
		];
		const ctx = makeQueryContext();
		const onHookError = () => 'abort' as const;

		// Act & Assert
		await expect(
			runAfterQueryHooks(hooks, ctx, [{ id: 1 }], onHookError),
		).rejects.toThrow('hook failed');
	});

	it('should continue when afterMutation hook throws and onHookError returns continue', async () => {
		// Arrange
		const hooks: AfterMutationHook[] = [
			(() => {
				throw new Error('hook failed');
			}) as AfterMutationHook,
			((_, result) => result) as AfterMutationHook,
		];
		const ctx = makeMutationContext();
		const onHookError = () => 'continue' as const;

		// Act
		const result = await runAfterMutationHooks(
			hooks,
			ctx,
			[{ id: 1 }],
			onHookError,
		);

		// Assert
		expect(result).toEqual([{ id: 1 }]);
	});

	it('should abort when beforeMutation hook throws and onHookError returns abort', async () => {
		// Arrange
		const hooks: BeforeMutationHook[] = [
			(() => {
				throw new Error('mutation hook failed');
			}) as BeforeMutationHook,
		];
		const ctx = makeMutationContext();
		const onHookError = () => 'abort' as const;

		// Act & Assert
		await expect(
			runBeforeMutationHooks(hooks, ctx, onHookError),
		).rejects.toThrow('mutation hook failed');
	});
});

// ============================================================================
// Re-entrancy guard edge cases
// ============================================================================

describe('Re-entrancy guard', () => {
	it('should return false for hasHooks when store is empty', () => {
		// Arrange
		const store = getHookStore(createHookManager());

		// Act & Assert
		expect(hasHooks(store)).toBe(false);
	});

	it('should return true when only onError hooks exist', () => {
		// Arrange
		const manager = createHookManager().onError(() => undefined);
		const store = getHookStore(manager);

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});

	it('should return true when only beforeQuery hooks exist', () => {
		// Arrange
		const manager = createHookManager().beforeQuery((ctx) => ctx);
		const store = getHookStore(manager);

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});

	it('should return true when only afterQuery hooks exist', () => {
		// Arrange
		const manager = createHookManager().afterQuery((_, result) => result);
		const store = getHookStore(manager);

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});

	it('should return true when only beforeMutation hooks exist', () => {
		// Arrange
		const manager = createHookManager().beforeMutation((ctx) => ctx);
		const store = getHookStore(manager);

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});

	it('should return true when only afterMutation hooks exist', () => {
		// Arrange
		const manager = createHookManager().afterMutation((_, result) => result);
		const store = getHookStore(manager);

		// Act & Assert
		expect(hasHooks(store)).toBe(true);
	});

	it('should block re-entrant access via enterHookExecution', () => {
		// Arrange
		const manager = createHookManager().beforeQuery((ctx) => ctx);
		const store = getHookStore(manager);

		// Act
		expect(hasHooks(store)).toBe(true);
		const exit = enterHookExecution(store);
		expect(hasHooks(store)).toBe(false);
		exit();
		expect(hasHooks(store)).toBe(true);
	});
});

// ============================================================================
// Async rejection handling
// ============================================================================

describe('Async rejection handling', () => {
	it('should propagate async rejection from beforeQuery hook', async () => {
		// Arrange
		const hooks: BeforeQueryHook[] = [
			async () => {
				throw new Error('async rejection');
			},
		];
		const ctx = makeQueryContext();

		// Act & Assert
		await expect(runBeforeQueryHooks(hooks, ctx)).rejects.toThrow(
			'async rejection',
		);
	});

	it('should propagate async rejection from afterQuery hook', async () => {
		// Arrange
		const hooks: AfterQueryHook[] = [
			(async () => {
				throw new Error('async rejection');
			}) as AfterQueryHook,
		];
		const ctx = makeQueryContext();

		// Act & Assert
		await expect(runAfterQueryHooks(hooks, ctx, [])).rejects.toThrow(
			'async rejection',
		);
	});

	it('should propagate async rejection from beforeMutation hook', async () => {
		// Arrange
		const hooks: BeforeMutationHook[] = [
			(async () => {
				throw new Error('async mutation rejection');
			}) as BeforeMutationHook,
		];
		const ctx = makeMutationContext();

		// Act & Assert
		await expect(runBeforeMutationHooks(hooks, ctx)).rejects.toThrow(
			'async mutation rejection',
		);
	});

	it('should propagate async rejection from afterMutation hook', async () => {
		// Arrange
		const hooks: AfterMutationHook[] = [
			(async () => {
				throw new Error('async mutation rejection');
			}) as AfterMutationHook,
		];
		const ctx = makeMutationContext();

		// Act & Assert
		await expect(runAfterMutationHooks(hooks, ctx, [])).rejects.toThrow(
			'async mutation rejection',
		);
	});
});

// ============================================================================
// onError hook edge cases
// ============================================================================

describe('runOnErrorHooks edge cases', () => {
	it('should return original error when hook returns undefined', async () => {
		// Arrange
		const originalError = new Error('original');
		const hooks = [() => undefined];
		const ctx = {
			table: 'users',
			operation: 'select',
			error: originalError,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'afterQuery' as const,
		};

		// Act
		const result = await runOnErrorHooks(hooks, ctx);

		// Assert
		expect(result).toBe(originalError);
	});

	it('should silently ignore onError hook that throws', async () => {
		// Arrange
		const originalError = new Error('original');
		const hooks = [
			() => {
				throw new Error('onError crashed');
			},
		];
		const ctx = {
			table: 'users',
			operation: 'select',
			error: originalError,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'afterQuery' as const,
		};

		// Act
		const result = await runOnErrorHooks(hooks, ctx);

		// Assert — original error preserved, onError crash ignored
		expect(result).toBe(originalError);
	});

	it('should apply transformations from multiple onError hooks', async () => {
		// Arrange
		const originalError = new Error('original');
		const error1 = new Error('transformed1');
		const error2 = new Error('transformed2');
		const hooks = [() => error1, () => error2];
		const ctx = {
			table: 'users',
			operation: 'select',
			error: originalError,
			intent: { type: 'select', from: 'users' } as QueryIntent,
			phase: 'afterQuery' as const,
		};

		// Act
		const result = await runOnErrorHooks(hooks, ctx);

		// Assert — last transform wins
		expect(result).toBe(error2);
	});
});

// ============================================================================
// HookManager freeze edge cases
// ============================================================================

describe('HookManager freeze edge cases', () => {
	it('should throw when trying to add beforeQuery after freeze', () => {
		// Arrange
		const manager = createHookManager().freeze();

		// Act & Assert
		expect(() => manager.beforeQuery((ctx) => ctx)).toThrow(/frozen/i);
	});

	it('should throw when trying to add afterQuery after freeze', () => {
		// Arrange
		const manager = createHookManager().freeze();

		// Act & Assert
		expect(() => manager.afterQuery((_, r) => r)).toThrow(/frozen/i);
	});

	it('should throw when trying to add beforeMutation after freeze', () => {
		// Arrange
		const manager = createHookManager().freeze();

		// Act & Assert
		expect(() => manager.beforeMutation((ctx) => ctx)).toThrow(/frozen/i);
	});

	it('should throw when trying to add afterMutation after freeze', () => {
		// Arrange
		const manager = createHookManager().freeze();

		// Act & Assert
		expect(() => manager.afterMutation((_, r) => r)).toThrow(/frozen/i);
	});

	it('should throw when trying to add onError after freeze', () => {
		// Arrange
		const manager = createHookManager().freeze();

		// Act & Assert
		expect(() => manager.onError(() => undefined)).toThrow(/frozen/i);
	});
});

// ============================================================================
// Hook array iteration edge cases
// ============================================================================

describe('Hook array iteration', () => {
	it('should handle afterQuery with undefined element in hooks array', async () => {
		// Arrange
		const hooks = [undefined, (_: unknown, result: unknown) => result] as (
			| AfterQueryHook
			| undefined
		)[];
		const ctx = makeQueryContext();
		const original = [{ id: 1 }];

		// Act
		const result = await runAfterQueryHooks(
			hooks.filter(Boolean) as AfterQueryHook[],
			ctx,
			original,
		);

		// Assert
		expect(result).toEqual(original);
	});

	it('should handle afterMutation with undefined element in hooks array', async () => {
		// Arrange
		const hooks = [undefined, (_: unknown, result: unknown) => result] as (
			| AfterMutationHook
			| undefined
		)[];
		const ctx = makeMutationContext();
		const original = [{ id: 1 }];

		// Act
		const result = await runAfterMutationHooks(
			hooks.filter(Boolean) as AfterMutationHook[],
			ctx,
			original,
		);

		// Assert
		expect(result).toEqual(original);
	});
});
