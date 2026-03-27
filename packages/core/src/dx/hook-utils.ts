/**
 * Hook composition utilities (ARCH-008).
 * Provides compose/pipe for combining multiple hooks into one,
 * and priority-ordered registration helpers.
 */

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
// Priority
// ============================================================================

/**
 * Priority levels for hook ordering.
 * Hooks with higher priority run first when sorted.
 */
export type HookPriority = 'critical' | 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<HookPriority, number> = {
	critical: 0,
	high: 1,
	normal: 2,
	low: 3,
};

/**
 * A hook wrapped with an explicit priority for ordering.
 * Use {@link sortByPriority} to produce an ordered array.
 */
export type PrioritizedHook<TFn> = {
	readonly hook: TFn;
	readonly priority: HookPriority;
};

/**
 * Wraps a hook with a priority level for use with {@link sortByPriority}.
 *
 * @example
 * ```typescript
 * const hooks = [
 *   withPriority(auditHook, 'low'),
 *   withPriority(authHook, 'critical'),
 * ];
 * const ordered = sortByPriority(hooks); // authHook runs first
 * ```
 */
export function withPriority<TFn>(hook: TFn, priority: HookPriority): PrioritizedHook<TFn> {
	return { hook, priority };
}

/**
 * Sorts an array of prioritized hooks by priority (critical → high → normal → low).
 * Stable: hooks with the same priority retain their original relative order.
 *
 * @returns A new array of unwrapped hook functions in priority order.
 */
export function sortByPriority<TFn>(hooks: readonly PrioritizedHook<TFn>[]): TFn[] {
	return [...hooks]
		.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
		.map((p) => p.hook);
}

// ============================================================================
// BeforeQueryHook composition
// ============================================================================

/**
 * Composes multiple {@link BeforeQueryHook}s into one (right-to-left execution).
 * The rightmost hook runs first; its output feeds into the next.
 * If a hook returns `undefined`, the current context is passed unchanged.
 *
 * @example
 * ```typescript
 * const composed = composeBeforeQueryHooks(loggingHook, tracingHook);
 * // tracingHook runs first, then loggingHook
 * ```
 */
export function composeBeforeQueryHooks(
	...hooks: BeforeQueryHook[]
): BeforeQueryHook {
	// reverse so rightmost runs first
	const ordered = [...hooks].reverse();
	return async (ctx: QueryHookContext): Promise<QueryHookContext | undefined> => {
		let current: QueryHookContext = ctx;
		for (const hook of ordered) {
			const result = await hook(current);
			if (result !== undefined) {
				current = result;
			}
		}
		return current;
	};
}

/**
 * Pipes multiple {@link BeforeQueryHook}s together (left-to-right execution).
 * The leftmost hook runs first; its output feeds into the next.
 * If a hook returns `undefined`, the current context is passed unchanged.
 *
 * @example
 * ```typescript
 * const piped = pipeBeforeQueryHooks(tracingHook, loggingHook);
 * // tracingHook runs first, then loggingHook
 * ```
 */
export function pipeBeforeQueryHooks(...hooks: BeforeQueryHook[]): BeforeQueryHook {
	return async (ctx: QueryHookContext): Promise<QueryHookContext | undefined> => {
		let current: QueryHookContext = ctx;
		for (const hook of hooks) {
			const result = await hook(current);
			if (result !== undefined) {
				current = result;
			}
		}
		return current;
	};
}

// ============================================================================
// AfterQueryHook composition
// ============================================================================

/**
 * Composes multiple {@link AfterQueryHook}s into one (right-to-left execution).
 * The rightmost hook runs first; its output becomes the result for the next.
 * If a hook returns `undefined`, the current result is passed unchanged.
 */
export function composeAfterQueryHooks(...hooks: AfterQueryHook[]): AfterQueryHook {
	const ordered = [...hooks].reverse();
	return async <R>(ctx: QueryHookContext, result: R): Promise<R | undefined> => {
		let current: R = result;
		for (const hook of ordered) {
			const next = await hook(ctx, current);
			if (next !== undefined) {
				current = next as R;
			}
		}
		return current;
	};
}

/**
 * Pipes multiple {@link AfterQueryHook}s together (left-to-right execution).
 * The leftmost hook runs first; its output becomes the result for the next.
 * If a hook returns `undefined`, the current result is passed unchanged.
 */
export function pipeAfterQueryHooks(...hooks: AfterQueryHook[]): AfterQueryHook {
	return async <R>(ctx: QueryHookContext, result: R): Promise<R | undefined> => {
		let current: R = result;
		for (const hook of hooks) {
			const next = await hook(ctx, current);
			if (next !== undefined) {
				current = next as R;
			}
		}
		return current;
	};
}

// ============================================================================
// BeforeMutationHook composition
// ============================================================================

/**
 * Composes multiple {@link BeforeMutationHook}s into one (right-to-left execution).
 * If a hook returns `undefined`, the current context is passed unchanged.
 */
export function composeBeforeMutationHooks(
	...hooks: BeforeMutationHook[]
): BeforeMutationHook {
	const ordered = [...hooks].reverse();
	return async <T>(
		ctx: MutationHookContext<T>,
	): Promise<MutationHookContext<T> | undefined> => {
		let current: MutationHookContext<T> = ctx;
		for (const hook of ordered) {
			const result = await hook(current);
			if (result !== undefined) {
				current = result;
			}
		}
		return current;
	};
}

/**
 * Pipes multiple {@link BeforeMutationHook}s together (left-to-right execution).
 * If a hook returns `undefined`, the current context is passed unchanged.
 */
export function pipeBeforeMutationHooks(...hooks: BeforeMutationHook[]): BeforeMutationHook {
	return async <T>(
		ctx: MutationHookContext<T>,
	): Promise<MutationHookContext<T> | undefined> => {
		let current: MutationHookContext<T> = ctx;
		for (const hook of hooks) {
			const result = await hook(current);
			if (result !== undefined) {
				current = result;
			}
		}
		return current;
	};
}

// ============================================================================
// AfterMutationHook composition
// ============================================================================

/**
 * Composes multiple {@link AfterMutationHook}s into one (right-to-left execution).
 * If a hook returns `undefined`, the current rows are passed unchanged.
 */
export function composeAfterMutationHooks(...hooks: AfterMutationHook[]): AfterMutationHook {
	const ordered = [...hooks].reverse();
	return async <T>(ctx: MutationHookContext<T>, result: T[]): Promise<T[] | undefined> => {
		let current: T[] = result;
		for (const hook of ordered) {
			const next = await hook(ctx, current);
			if (next !== undefined) {
				current = next;
			}
		}
		return current;
	};
}

/**
 * Pipes multiple {@link AfterMutationHook}s together (left-to-right execution).
 * If a hook returns `undefined`, the current rows are passed unchanged.
 */
export function pipeAfterMutationHooks(...hooks: AfterMutationHook[]): AfterMutationHook {
	return async <T>(ctx: MutationHookContext<T>, result: T[]): Promise<T[] | undefined> => {
		let current: T[] = result;
		for (const hook of hooks) {
			const next = await hook(ctx, current);
			if (next !== undefined) {
				current = next;
			}
		}
		return current;
	};
}

// ============================================================================
// OnErrorHook composition
// ============================================================================

/**
 * Composes multiple {@link OnErrorHook}s into one (right-to-left execution).
 * Each hook receives the error from the previous; if a hook returns `undefined`,
 * the current error is passed unchanged.
 */
export function composeOnErrorHooks(...hooks: OnErrorHook[]): OnErrorHook {
	const ordered = [...hooks].reverse();
	return async (ctx: ErrorHookContext): Promise<undefined | Error> => {
		let currentCtx: ErrorHookContext = ctx;
		for (const hook of ordered) {
			const result = await hook(currentCtx);
			if (result !== undefined) {
				// Pass the transformed error forward via a new context
				currentCtx = { ...currentCtx, error: result };
			}
		}
		return currentCtx.error;
	};
}

/**
 * Pipes multiple {@link OnErrorHook}s together (left-to-right execution).
 * Each hook receives the error from the previous; if a hook returns `undefined`,
 * the current error is passed unchanged.
 */
export function pipeOnErrorHooks(...hooks: OnErrorHook[]): OnErrorHook {
	return async (ctx: ErrorHookContext): Promise<undefined | Error> => {
		let currentCtx: ErrorHookContext = ctx;
		for (const hook of hooks) {
			const result = await hook(currentCtx);
			if (result !== undefined) {
				currentCtx = { ...currentCtx, error: result };
			}
		}
		return currentCtx.error;
	};
}
