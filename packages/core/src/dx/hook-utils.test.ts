import { describe, expect, it, vi } from 'vitest';
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
import {
	composeAfterMutationHooks,
	composeAfterQueryHooks,
	composeBeforeMutationHooks,
	composeBeforeQueryHooks,
	composeOnErrorHooks,
	pipeAfterMutationHooks,
	pipeAfterQueryHooks,
	pipeBeforeMutationHooks,
	pipeBeforeQueryHooks,
	pipeOnErrorHooks,
	sortByPriority,
	withPriority,
} from './hook-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQueryCtx(overrides?: Partial<QueryHookContext>): QueryHookContext {
	return {
		table: 'users',
		operation: 'select',
		intent: {} as QueryHookContext['intent'],
		resultType: 'rows',
		...overrides,
	};
}

function makeMutationCtx<T = unknown>(
	overrides?: Partial<MutationHookContext<T>>,
): MutationHookContext<T> {
	return {
		table: 'users',
		operation: 'insert',
		intent: {} as MutationHookContext<T>['intent'],
		cardinality: 'bulk',
		...overrides,
	};
}

function makeErrorCtx(overrides?: Partial<ErrorHookContext>): ErrorHookContext {
	return {
		table: 'users',
		operation: 'select',
		error: new Error('original'),
		intent: {} as ErrorHookContext['intent'],
		phase: 'before',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// withPriority + sortByPriority
// ---------------------------------------------------------------------------

describe('withPriority', () => {
	it('wraps a hook with the given priority', () => {
		const hook: BeforeQueryHook = vi.fn();
		const wrapped = withPriority(hook, 'high');
		expect(wrapped.hook).toBe(hook);
		expect(wrapped.priority).toBe('high');
	});
});

describe('sortByPriority', () => {
	it('orders hooks critical → high → normal → low', () => {
		const a: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);
		const b: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);
		const c: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);
		const d: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);

		const sorted = sortByPriority([
			withPriority(d, 'low'),
			withPriority(b, 'high'),
			withPriority(c, 'normal'),
			withPriority(a, 'critical'),
		]);

		expect(sorted).toEqual([a, b, c, d]);
	});

	it('preserves relative order for same priority (stable sort)', () => {
		const first: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);
		const second: BeforeQueryHook = vi.fn().mockImplementation(() => undefined);

		const sorted = sortByPriority([
			withPriority(first, 'normal'),
			withPriority(second, 'normal'),
		]);

		expect(sorted[0]).toBe(first);
		expect(sorted[1]).toBe(second);
	});

	it('returns empty array for empty input', () => {
		expect(sortByPriority([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// BeforeQueryHook: pipe vs compose
// ---------------------------------------------------------------------------

describe('pipeBeforeQueryHooks', () => {
	it('runs hooks left-to-right, threading context', async () => {
		const order: string[] = [];
		const h1: BeforeQueryHook = (ctx) => {
			order.push('h1');
			return { ...ctx, correlationId: 'h1' };
		};
		const h2: BeforeQueryHook = (ctx) => {
			order.push('h2');
			return { ...ctx, correlationId: `${ctx.correlationId}-h2` };
		};
		const piped = pipeBeforeQueryHooks(h1, h2);
		const result = await piped(makeQueryCtx());
		expect(order).toEqual(['h1', 'h2']);
		expect(result?.correlationId).toBe('h1-h2');
	});

	it('passes context unchanged when hook returns undefined', async () => {
		const h1: BeforeQueryHook = (ctx) => ({ ...ctx, correlationId: 'set' });
		const h2: BeforeQueryHook = () => undefined;
		const piped = pipeBeforeQueryHooks(h1, h2);
		const result = await piped(makeQueryCtx());
		expect(result?.correlationId).toBe('set');
	});

	it('works with a single hook', async () => {
		const h1: BeforeQueryHook = (ctx) => ({ ...ctx, correlationId: 'only' });
		const piped = pipeBeforeQueryHooks(h1);
		const result = await piped(makeQueryCtx());
		expect(result?.correlationId).toBe('only');
	});

	it('handles async hooks', async () => {
		const h1: BeforeQueryHook = async (ctx) =>
			Promise.resolve({ ...ctx, correlationId: 'async' });
		const piped = pipeBeforeQueryHooks(h1);
		const result = await piped(makeQueryCtx());
		expect(result?.correlationId).toBe('async');
	});
});

describe('composeBeforeQueryHooks', () => {
	it('runs hooks right-to-left (opposite of pipe)', async () => {
		const order: string[] = [];
		const h1: BeforeQueryHook = (ctx) => {
			order.push('h1');
			return ctx;
		};
		const h2: BeforeQueryHook = (ctx) => {
			order.push('h2');
			return ctx;
		};
		const composed = composeBeforeQueryHooks(h1, h2);
		await composed(makeQueryCtx());
		expect(order).toEqual(['h2', 'h1']);
	});

	it('threads context right-to-left', async () => {
		const h1: BeforeQueryHook = (ctx) => ({ ...ctx, correlationId: `${ctx.correlationId}-h1` });
		const h2: BeforeQueryHook = (ctx) => ({ ...ctx, correlationId: 'h2' });
		const composed = composeBeforeQueryHooks(h1, h2);
		const result = await composed(makeQueryCtx());
		expect(result?.correlationId).toBe('h2-h1');
	});
});

// ---------------------------------------------------------------------------
// AfterQueryHook: pipe vs compose
// ---------------------------------------------------------------------------

describe('pipeAfterQueryHooks', () => {
	it('runs left-to-right, threading result', async () => {
		const order: string[] = [];
		const h1: AfterQueryHook = (_ctx, result: unknown) => {
			order.push('h1');
			return (result as string) + '-h1';
		};
		const h2: AfterQueryHook = (_ctx, result: unknown) => {
			order.push('h2');
			return (result as string) + '-h2';
		};
		const piped = pipeAfterQueryHooks(h1, h2);
		const result = await piped(makeQueryCtx(), 'start');
		expect(order).toEqual(['h1', 'h2']);
		expect(result).toBe('start-h1-h2');
	});

	it('passes result unchanged when hook returns undefined', async () => {
		const h1: AfterQueryHook = (_ctx, r: unknown) => (r as string) + '-h1';
		const h2: AfterQueryHook = () => undefined;
		const piped = pipeAfterQueryHooks(h1, h2);
		const result = await piped(makeQueryCtx(), 'x');
		expect(result).toBe('x-h1');
	});
});

describe('composeAfterQueryHooks', () => {
	it('runs right-to-left', async () => {
		const order: string[] = [];
		const h1: AfterQueryHook = (_ctx, r: unknown) => {
			order.push('h1');
			return r;
		};
		const h2: AfterQueryHook = (_ctx, r: unknown) => {
			order.push('h2');
			return r;
		};
		const composed = composeAfterQueryHooks(h1, h2);
		await composed(makeQueryCtx(), 'x');
		expect(order).toEqual(['h2', 'h1']);
	});
});

// ---------------------------------------------------------------------------
// BeforeMutationHook: pipe vs compose
// ---------------------------------------------------------------------------

describe('pipeBeforeMutationHooks', () => {
	it('runs left-to-right, threading context', async () => {
		const order: string[] = [];
		const h1: BeforeMutationHook = (ctx) => {
			order.push('h1');
			return { ...ctx, correlationId: 'h1' };
		};
		const h2: BeforeMutationHook = (ctx) => {
			order.push('h2');
			return { ...ctx, correlationId: `${ctx.correlationId}-h2` };
		};
		const piped = pipeBeforeMutationHooks(h1, h2);
		const result = await piped(makeMutationCtx());
		expect(order).toEqual(['h1', 'h2']);
		expect(result?.correlationId).toBe('h1-h2');
	});

	it('passes context unchanged when hook returns undefined', async () => {
		const h1: BeforeMutationHook = (ctx) => ({ ...ctx, correlationId: 'set' });
		const h2: BeforeMutationHook = () => undefined;
		const piped = pipeBeforeMutationHooks(h1, h2);
		const result = await piped(makeMutationCtx());
		expect(result?.correlationId).toBe('set');
	});
});

describe('composeBeforeMutationHooks', () => {
	it('runs right-to-left', async () => {
		const order: string[] = [];
		const h1: BeforeMutationHook = (ctx) => { order.push('h1'); return ctx; };
		const h2: BeforeMutationHook = (ctx) => { order.push('h2'); return ctx; };
		const composed = composeBeforeMutationHooks(h1, h2);
		await composed(makeMutationCtx());
		expect(order).toEqual(['h2', 'h1']);
	});
});

// ---------------------------------------------------------------------------
// AfterMutationHook: pipe vs compose
// ---------------------------------------------------------------------------

describe('pipeAfterMutationHooks', () => {
	it('runs left-to-right, threading rows', async () => {
		const order: string[] = [];
		const h1: AfterMutationHook = (_ctx, rows: unknown[]) => {
			order.push('h1');
			return [...rows, 'h1'] as unknown[];
		};
		const h2: AfterMutationHook = (_ctx, rows: unknown[]) => {
			order.push('h2');
			return [...rows, 'h2'] as unknown[];
		};
		const piped = pipeAfterMutationHooks(h1, h2);
		const result = await piped(makeMutationCtx(), []);
		expect(order).toEqual(['h1', 'h2']);
		expect(result).toEqual(['h1', 'h2']);
	});

	it('passes rows unchanged when hook returns undefined', async () => {
		const h1: AfterMutationHook = (_ctx, rows: unknown[]) => [...rows, 'h1'] as unknown[];
		const h2: AfterMutationHook = () => undefined;
		const piped = pipeAfterMutationHooks(h1, h2);
		const result = await piped(makeMutationCtx(), []);
		expect(result).toEqual(['h1']);
	});
});

describe('composeAfterMutationHooks', () => {
	it('runs right-to-left', async () => {
		const order: string[] = [];
		const h1: AfterMutationHook = (_ctx, r) => { order.push('h1'); return r; };
		const h2: AfterMutationHook = (_ctx, r) => { order.push('h2'); return r; };
		const composed = composeAfterMutationHooks(h1, h2);
		await composed(makeMutationCtx(), []);
		expect(order).toEqual(['h2', 'h1']);
	});
});

// ---------------------------------------------------------------------------
// OnErrorHook: pipe vs compose
// ---------------------------------------------------------------------------

describe('pipeOnErrorHooks', () => {
	it('runs left-to-right, threading the error via context', async () => {
		const order: string[] = [];
		const h1: OnErrorHook = (_ctx) => {
			order.push('h1');
			return new Error('from-h1');
		};
		const h2: OnErrorHook = (ctx) => {
			order.push('h2');
			return new Error(`${ctx.error.message}-h2`);
		};
		const piped = pipeOnErrorHooks(h1, h2);
		const result = await piped(makeErrorCtx());
		expect(order).toEqual(['h1', 'h2']);
		expect(result?.message).toBe('from-h1-h2');
	});

	it('passes error unchanged when hook returns undefined', async () => {
		const h1: OnErrorHook = () => new Error('replaced');
		const h2: OnErrorHook = () => undefined;
		const piped = pipeOnErrorHooks(h1, h2);
		const result = await piped(makeErrorCtx());
		expect(result?.message).toBe('replaced');
	});

	it('returns original error when all hooks return undefined', async () => {
		const h1: OnErrorHook = () => undefined;
		const piped = pipeOnErrorHooks(h1);
		const ctx = makeErrorCtx({ error: new Error('orig') });
		const result = await piped(ctx);
		expect(result?.message).toBe('orig');
	});
});

describe('composeOnErrorHooks', () => {
	it('runs right-to-left', async () => {
		const order: string[] = [];
		const h1: OnErrorHook = (ctx) => { order.push('h1'); return ctx.error; };
		const h2: OnErrorHook = (ctx) => { order.push('h2'); return ctx.error; };
		const composed = composeOnErrorHooks(h1, h2);
		await composed(makeErrorCtx());
		expect(order).toEqual(['h2', 'h1']);
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
	it('pipeBeforeQueryHooks with zero hooks returns the original context', async () => {
		const piped = pipeBeforeQueryHooks();
		const ctx = makeQueryCtx({ correlationId: 'unchanged' });
		const result = await piped(ctx);
		expect(result?.correlationId).toBe('unchanged');
	});

	it('composeBeforeQueryHooks with zero hooks returns the original context', async () => {
		const composed = composeBeforeQueryHooks();
		const ctx = makeQueryCtx({ correlationId: 'unchanged' });
		const result = await composed(ctx);
		expect(result?.correlationId).toBe('unchanged');
	});

	it('sortByPriority does not mutate the input array', () => {
		const hooks = [
			withPriority(vi.fn() as unknown as BeforeQueryHook, 'low'),
			withPriority(vi.fn() as unknown as BeforeQueryHook, 'critical'),
		];
		const original = [...hooks];
		sortByPriority(hooks);
		expect(hooks).toEqual(original);
	});
});
