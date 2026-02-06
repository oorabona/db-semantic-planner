/**
 * @module hooks
 * Query/Mutation hook system for cross-cutting concerns.
 * Part of E17b: Query Hooks System.
 *
 * Hooks enable intercepting query/mutation execution for logging,
 * auditing, caching, data transformation, and tenant injection.
 *
 * @example
 * ```typescript
 * const hooks = createHookManager()
 *   .beforeQuery(ctx => {
 *     console.log(`Query on ${ctx.table}`);
 *     return ctx;
 *   })
 *   .afterQuery((ctx, results) => {
 *     console.log(`Got ${results.length} rows in ${ctx.duration}ms`);
 *     return results;
 *   });
 *
 * const orm = createOrm({ schema, adapter, hooks });
 * ```
 */

import type {
	DeleteIntent,
	InsertIntent,
	QueryIntent,
	UpdateIntent,
	UpsertIntent,
} from '../intent-ast.js';

// ============================================================================
// Hook Context Types
// ============================================================================

/** Query execution result types for afterQuery generics */
export type QueryResultType =
	| 'all'
	| 'first'
	| 'count'
	| 'exists'
	| 'aggregate';

/**
 * Context passed to query hooks (beforeQuery/afterQuery).
 * Frozen via Object.freeze — hooks must return new objects to modify.
 */
export type QueryHookContext = {
	readonly table: string;
	readonly operation: 'select';
	readonly intent: QueryIntent;
	readonly schemaName?: string;
	readonly inTransaction?: boolean;
	readonly correlationId?: string;
	readonly resultType: QueryResultType;
	readonly isStreaming?: boolean;
	// Available in afterQuery only:
	readonly sql?: string;
	/** Query parameters. May contain PII — redact before logging. */
	readonly parameters?: readonly unknown[];
	readonly duration?: number;
};

/** Union of all mutation intent types */
export type MutationIntent =
	| InsertIntent
	| UpdateIntent
	| DeleteIntent
	| UpsertIntent;

/** Mutation operation types */
export type MutationOperation = 'insert' | 'update' | 'delete' | 'upsert';

/**
 * Context passed to mutation hooks (beforeMutation/afterMutation).
 * Frozen via Object.freeze — hooks must return new objects to modify.
 */
export type MutationHookContext<T = unknown> = {
	readonly table: string;
	readonly operation: MutationOperation;
	readonly intent: MutationIntent;
	readonly schemaName?: string;
	readonly inTransaction?: boolean;
	readonly correlationId?: string;
	readonly cardinality: 'single' | 'bulk';
	readonly data?: T | T[] | Partial<T>;
	// Available in afterMutation only:
	readonly sql?: string;
	/** Query parameters. May contain PII — redact before logging. */
	readonly parameters?: readonly unknown[];
	readonly duration?: number;
	readonly affectedRows?: number;
};

/** Hook phase identifier */
export type HookPhase =
	| 'beforeQuery'
	| 'afterQuery'
	| 'beforeMutation'
	| 'afterMutation';

/**
 * Context passed to onError hooks.
 */
export type ErrorHookContext = {
	readonly table: string;
	readonly operation: string;
	readonly error: Error;
	readonly intent: QueryIntent | MutationIntent;
	readonly phase: HookPhase;
	readonly sql?: string;
	readonly inTransaction?: boolean;
};

// ============================================================================
// Hook Signatures
// ============================================================================

/** Hook invoked before query execution. Can modify intent via return. */
export type BeforeQueryHook = (
	ctx: QueryHookContext,
) => QueryHookContext | Promise<QueryHookContext> | undefined;

/** Hook invoked after query execution. Can transform results via return. */
export type AfterQueryHook = <R>(
	ctx: QueryHookContext,
	result: R,
) => R | Promise<R> | undefined;

/** Hook invoked before mutation execution. Can modify context via return. */
export type BeforeMutationHook = <T>(
	ctx: MutationHookContext<T>,
) => MutationHookContext<T> | Promise<MutationHookContext<T>> | undefined;

/** Hook invoked after mutation execution. Can transform RETURNING results. */
export type AfterMutationHook = <T>(
	ctx: MutationHookContext<T>,
	result: T[],
) => T[] | Promise<T[]> | undefined;

/** Hook invoked on query/mutation errors. Can transform the error. */
export type OnErrorHook = (
	ctx: ErrorHookContext,
) => undefined | Error | Promise<undefined | Error>;

/**
 * Error handler for hook failures.
 * Returns 'continue' to skip failed hook, 'abort' to propagate error.
 */
export type HookErrorHandler = (
	error: Error,
	hookName: string,
	ctx: QueryHookContext | MutationHookContext,
	phase: string,
) => 'continue' | 'abort';

// ============================================================================
// Hook Manager Interface
// ============================================================================

/** Immutable builder interface for registering hooks */
export interface HookManager {
	beforeQuery(hook: BeforeQueryHook): HookManager;
	afterQuery(hook: AfterQueryHook): HookManager;
	beforeMutation(hook: BeforeMutationHook): HookManager;
	afterMutation(hook: AfterMutationHook): HookManager;
	onError(hook: OnErrorHook): HookManager;
	freeze(): HookManager;
}

// ============================================================================
// Internal Hook Storage
// ============================================================================

/** @internal Hook storage — exposed for runner access */
export type HookStore = {
	readonly beforeQuery: readonly BeforeQueryHook[];
	readonly afterQuery: readonly AfterQueryHook[];
	readonly beforeMutation: readonly BeforeMutationHook[];
	readonly afterMutation: readonly AfterMutationHook[];
	readonly onError: readonly OnErrorHook[];
	readonly frozen: boolean;
};

// ============================================================================
// Hook Manager Implementation
// ============================================================================

class HookManagerImpl implements HookManager {
	private readonly store: HookStore;

	constructor(store?: HookStore) {
		this.store = store ?? {
			beforeQuery: [],
			afterQuery: [],
			beforeMutation: [],
			afterMutation: [],
			onError: [],
			frozen: false,
		};
	}

	beforeQuery(hook: BeforeQueryHook): HookManager {
		this.assertNotFrozen();
		return new HookManagerImpl({
			...this.store,
			beforeQuery: [...this.store.beforeQuery, hook],
		});
	}

	afterQuery(hook: AfterQueryHook): HookManager {
		this.assertNotFrozen();
		return new HookManagerImpl({
			...this.store,
			afterQuery: [...this.store.afterQuery, hook],
		});
	}

	beforeMutation(hook: BeforeMutationHook): HookManager {
		this.assertNotFrozen();
		return new HookManagerImpl({
			...this.store,
			beforeMutation: [...this.store.beforeMutation, hook],
		});
	}

	afterMutation(hook: AfterMutationHook): HookManager {
		this.assertNotFrozen();
		return new HookManagerImpl({
			...this.store,
			afterMutation: [...this.store.afterMutation, hook],
		});
	}

	onError(hook: OnErrorHook): HookManager {
		this.assertNotFrozen();
		return new HookManagerImpl({
			...this.store,
			onError: [...this.store.onError, hook],
		});
	}

	freeze(): HookManager {
		if (this.store.frozen) return this;
		return new HookManagerImpl({ ...this.store, frozen: true });
	}

	/** @internal Access hook store for runner */
	getStore(): HookStore {
		return this.store;
	}

	private assertNotFrozen(): void {
		if (this.store.frozen) {
			throw new Error(
				'HookManager is frozen — hooks cannot be added after ORM creation. ' +
					'Register all hooks before passing to createOrm().',
			);
		}
	}
}

// ============================================================================
// Hook Runner
// ============================================================================

/**
 * @internal
 * Extracts the hook store from a HookManager.
 * Used by ORM internals to access hooks for execution.
 */
export function getHookStore(manager: HookManager): HookStore {
	return (manager as HookManagerImpl).getStore();
}

// ============================================================================
// Re-entrancy Guard (INV-07)
// ============================================================================

/**
 * @internal
 * Tracks hook stores that are currently executing hooks.
 * Prevents infinite loops when hooks issue queries/mutations.
 */
const activeHookStores = new WeakSet<HookStore>();

/**
 * @internal
 * Marks a hook store as actively executing hooks.
 * Returns a cleanup function to call when done.
 */
export function enterHookExecution(store: HookStore): () => void {
	activeHookStores.add(store);
	return () => activeHookStores.delete(store);
}

/**
 * @internal
 * Executes `fn` within a re-entrancy guard.
 * While `fn` runs, `hasHooks(store)` returns false — preventing infinite loops
 * when hooks issue queries/mutations themselves.
 */
export async function withReentrancyGuard<R>(
	store: HookStore,
	fn: (store: HookStore) => Promise<R>,
): Promise<R> {
	const exit = enterHookExecution(store);
	try {
		return await fn(store);
	} finally {
		exit();
	}
}

/**
 * @internal
 * Checks whether a hook manager has any hooks registered
 * AND is not currently in a re-entrant execution.
 * Used for zero-cost optimization: skip hook execution when no hooks exist
 * or when called from within a hook (preventing infinite loops).
 */
export function hasHooks(store: HookStore): boolean {
	// Re-entrancy guard: if this store is already executing hooks, skip
	if (activeHookStores.has(store)) return false;

	return (
		store.beforeQuery.length > 0 ||
		store.afterQuery.length > 0 ||
		store.beforeMutation.length > 0 ||
		store.afterMutation.length > 0 ||
		store.onError.length > 0
	);
}

/**
 * @internal
 * Runs beforeQuery hooks in registration order (FIFO).
 * Returns the (potentially modified) context.
 * Context is frozen before each hook invocation.
 */
export async function runBeforeQueryHooks(
	hooks: readonly BeforeQueryHook[],
	ctx: QueryHookContext,
	onHookError?: HookErrorHandler,
): Promise<QueryHookContext> {
	let current = ctx;
	for (const hook of hooks) {
		const frozen = Object.freeze({ ...current });
		try {
			const result = await hook(frozen);
			if (result !== undefined && result !== null) {
				current = result;
			}
		} catch (error) {
			if (onHookError) {
				const action = onHookError(
					error as Error,
					hook.name || 'anonymous',
					frozen,
					'beforeQuery',
				);
				if (action === 'continue') continue;
			}
			throw error;
		}
	}
	return current;
}

/**
 * @internal
 * Runs afterQuery hooks in reverse registration order (LIFO — middleware semantics).
 * Returns the (potentially transformed) result.
 */
export async function runAfterQueryHooks<R>(
	hooks: readonly AfterQueryHook[],
	ctx: QueryHookContext,
	result: R,
	onHookError?: HookErrorHandler,
): Promise<R> {
	let current = result;
	// LIFO order: last registered hook runs first
	for (let i = hooks.length - 1; i >= 0; i--) {
		const hook = hooks[i];
		if (!hook) continue;
		const frozen = Object.freeze({ ...ctx });
		try {
			const transformed = await hook(frozen, current);
			if (transformed !== undefined && transformed !== null) {
				current = transformed;
			}
		} catch (error) {
			if (onHookError) {
				const action = onHookError(
					error as Error,
					hook.name || 'anonymous',
					frozen,
					'afterQuery',
				);
				if (action === 'continue') continue;
			}
			throw error;
		}
	}
	return current;
}

/**
 * @internal
 * Runs beforeMutation hooks in registration order (FIFO).
 */
export async function runBeforeMutationHooks<T>(
	hooks: readonly BeforeMutationHook[],
	ctx: MutationHookContext<T>,
	onHookError?: HookErrorHandler,
): Promise<MutationHookContext<T>> {
	let current = ctx;
	for (const hook of hooks) {
		const frozen = Object.freeze({ ...current });
		try {
			const result = await hook(frozen);
			if (result !== undefined && result !== null) {
				current = result as MutationHookContext<T>;
			}
		} catch (error) {
			if (onHookError) {
				const action = onHookError(
					error as Error,
					hook.name || 'anonymous',
					frozen,
					'beforeMutation',
				);
				if (action === 'continue') continue;
			}
			throw error;
		}
	}
	return current;
}

/**
 * @internal
 * Runs afterMutation hooks in reverse registration order (LIFO).
 */
export async function runAfterMutationHooks<T>(
	hooks: readonly AfterMutationHook[],
	ctx: MutationHookContext<T>,
	result: T[],
	onHookError?: HookErrorHandler,
): Promise<T[]> {
	let current = result;
	for (let i = hooks.length - 1; i >= 0; i--) {
		const hook = hooks[i];
		if (!hook) continue;
		const frozen = Object.freeze({ ...ctx });
		try {
			const transformed = await hook(frozen, current);
			if (transformed !== undefined && transformed !== null) {
				current = transformed as T[];
			}
		} catch (error) {
			if (onHookError) {
				const action = onHookError(
					error as Error,
					hook.name || 'anonymous',
					frozen,
					'beforeMutation',
				);
				if (action === 'continue') continue;
			}
			throw error;
		}
	}
	return current;
}

/**
 * @internal
 * Runs onError hooks. Returns transformed error or original.
 */
export async function runOnErrorHooks(
	hooks: readonly OnErrorHook[],
	ctx: ErrorHookContext,
): Promise<Error> {
	let currentError = ctx.error;
	for (const hook of hooks) {
		const frozen = Object.freeze({ ...ctx, error: currentError });
		try {
			const result = await hook(frozen);
			if (result instanceof Error) {
				currentError = result;
			}
		} catch {
			// onError hooks should not throw; if they do, ignore and continue
		}
	}
	return currentError;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Creates a new HookManager instance for registering query/mutation hooks.
 *
 * @example
 * ```typescript
 * const hooks = createHookManager()
 *   .beforeQuery(ctx => { console.log(ctx.table); return ctx; })
 *   .afterQuery((ctx, results) => results);
 * ```
 */
export function createHookManager(): HookManager {
	return new HookManagerImpl();
}
