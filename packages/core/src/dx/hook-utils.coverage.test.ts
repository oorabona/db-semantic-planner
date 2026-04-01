/**
 * @fileoverview Branch coverage tests for hook-utils.ts
 * Targets the uncovered `if (result !== undefined)` = false path in compose* functions.
 * When a compose hook returns undefined, the current context/result is preserved.
 */

import { describe, expect, it } from 'vitest';
import type { MutationIntent, QueryIntent } from '../index.js';
import {
	composeAfterMutationHooks,
	composeAfterQueryHooks,
	composeBeforeMutationHooks,
	composeBeforeQueryHooks,
	composeOnErrorHooks,
} from './hook-utils.js';
import type {
	AfterMutationHook,
	AfterQueryHook,
	BeforeMutationHook,
	BeforeQueryHook,
	ErrorHookContext,
	MutationHookContext,
	OnErrorHook,
	QueryHookContext,
} from './hooks.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeQueryCtx(overrides?: Partial<QueryHookContext>): QueryHookContext {
	return {
		table: 'users',
		operation: 'select',
		intent: { type: 'select', from: 'users' } as QueryIntent,
		resultType: 'rows',
		...overrides,
	};
}

function makeMutationCtx(
	overrides?: Partial<MutationHookContext>,
): MutationHookContext {
	return {
		table: 'users',
		operation: 'insert',
		intent: {
			type: 'insert',
			into: 'users',
			values: [],
		} as unknown as MutationIntent,
		cardinality: 'bulk',
		...overrides,
	};
}

function makeErrorCtx(overrides?: Partial<ErrorHookContext>): ErrorHookContext {
	return {
		table: 'users',
		operation: 'select',
		error: new Error('original'),
		intent: { type: 'select', from: 'users' } as QueryIntent,
		phase: 'afterQuery' as const,
		...overrides,
	};
}

// ============================================================================
// composeBeforeQueryHooks — undefined-returning hook (result=undefined path)
// ============================================================================

describe('composeBeforeQueryHooks — undefined return path', () => {
	it('preserves current context when hook returns undefined', async () => {
		// h2 runs first (right-to-left), returns undefined → context unchanged
		// h1 runs second, receives original context
		const visited: string[] = [];
		const h1: BeforeQueryHook = (ctx) => {
			visited.push(`h1:${ctx.correlationId ?? 'none'}`);
			return ctx;
		};
		const h2: BeforeQueryHook = (_ctx) => {
			visited.push('h2-undefined');
			return undefined; // uncovered path: result = undefined
		};
		const composed = composeBeforeQueryHooks(h1, h2);
		const result = await composed(makeQueryCtx({ correlationId: 'original' }));
		// h2 runs first (reversed), returns undefined → ctx unchanged
		// h1 runs next, gets unchanged ctx
		expect(visited).toEqual(['h2-undefined', 'h1:original']);
		expect(result.correlationId).toBe('original');
	});
});

// ============================================================================
// composeAfterQueryHooks — undefined-returning hook (result=undefined path)
// ============================================================================

describe('composeAfterQueryHooks — undefined return path', () => {
	it('preserves current result when hook returns undefined', async () => {
		const h1: AfterQueryHook = (_ctx, r) => `${String(r)}-h1`;
		const h2: AfterQueryHook = () => undefined; // uncovered: result = undefined
		// Compose: h2 runs first, h1 runs second
		const composed = composeAfterQueryHooks(h1, h2);
		const result = await composed(makeQueryCtx(), 'start');
		// h2 runs first, returns undefined → 'start' unchanged
		// h1 runs next, gets 'start', returns 'start-h1'
		expect(result).toBe('start-h1');
	});
});

// ============================================================================
// composeBeforeMutationHooks — undefined-returning hook
// ============================================================================

describe('composeBeforeMutationHooks — undefined return path', () => {
	it('preserves current context when hook returns undefined', async () => {
		const visited: string[] = [];
		const h1: BeforeMutationHook = (ctx) => {
			visited.push(`h1:${ctx.correlationId ?? 'none'}`);
			return ctx;
		};
		const h2: BeforeMutationHook = (_ctx) => {
			visited.push('h2-undefined');
			return undefined; // uncovered path
		};
		const composed = composeBeforeMutationHooks(h1, h2);
		const result = await composed(
			makeMutationCtx({ correlationId: 'mut-orig' }),
		);
		expect(visited).toEqual(['h2-undefined', 'h1:mut-orig']);
		expect(result.correlationId).toBe('mut-orig');
	});
});

// ============================================================================
// composeAfterMutationHooks — undefined-returning hook
// ============================================================================

describe('composeAfterMutationHooks — undefined return path', () => {
	it('preserves current rows when hook returns undefined', async () => {
		const h1: AfterMutationHook = (_ctx, rows) => [
			...(rows as unknown[]),
			'h1',
		];
		const h2: AfterMutationHook = () => undefined; // uncovered path
		// Compose: h2 runs first, h1 runs second
		const composed = composeAfterMutationHooks(h1, h2);
		const result = await composed(makeMutationCtx(), ['start']);
		// h2 runs first, returns undefined → ['start'] unchanged
		// h1 runs next, appends 'h1'
		expect(result).toEqual(['start', 'h1']);
	});
});

// ============================================================================
// composeOnErrorHooks — undefined-returning hook
// ============================================================================

describe('composeOnErrorHooks — undefined return path', () => {
	it('preserves current error context when hook returns undefined', async () => {
		const error1 = new Error('error1');
		const error2 = new Error('error2');
		const h1: OnErrorHook = (ctx) => {
			// Transforms the error — h1 runs second (rightmost = first in reversed)
			return ctx.error === error1 ? error2 : ctx.error;
		};
		const h2: OnErrorHook = () => undefined; // uncovered: result = undefined, error unchanged
		// Compose: h2 runs first (reversed), h1 runs second
		const composed = composeOnErrorHooks(h1, h2);
		const ctx = makeErrorCtx({ error: error1 });
		const result = await composed(ctx);
		// h2 runs first, returns undefined → error1 unchanged
		// h1 runs second with error1, returns error2
		expect(result).toBe(error2);
	});
});
