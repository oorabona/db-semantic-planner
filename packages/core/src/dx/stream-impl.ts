/**
 * Stream implementation extracted from QueryBuilderImpl.
 *
 * Free function that accepts a QueryBuilderImpl instance and implements the
 * stream() logic.  It accesses only fields and methods declared
 * @internal public on QueryBuilderImpl.
 *
 * @internal
 */

import {
	type AdapterStreamOptions,
	type CompiledQuery,
	type Dump,
	supportsStreaming,
} from '../adapter.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import { ExecutionError } from './errors.js';
import type { QueryHookContext } from './hooks.js';
import {
	hasHooks,
	runBeforeQueryHooks,
	runOnErrorHooks,
	withReentrancyGuard,
} from './hooks.js';
import type { QueryBuilderImpl } from './query-builder.js';
import type { StreamOptions } from './types.js';

function createUnsupportedStreamingError(): ExecutionError {
	return new ExecutionError({
		operation: 'stream()',
		reason:
			'The adapter declares supportsStreaming: false for this ORM instance.',
		fix: 'Use an adapter configuration that supports streaming.',
	});
}

function hasStreamTransactionBeginOptions(
	options: StreamOptions | undefined,
): boolean {
	return (
		options != null &&
		(options.isolationLevel !== undefined ||
			options.readOnly !== undefined ||
			options.lockTimeoutMs !== undefined ||
			options.statementTimeoutMs !== undefined)
	);
}

function hasRuntimeStreamSignalOption(
	options: StreamOptions | undefined,
): boolean {
	return typeof options === 'object' && options !== null && 'signal' in options;
}

function createAdapterStreamOptions(
	options: StreamOptions | undefined,
): AdapterStreamOptions | undefined {
	if (
		options === undefined ||
		(options.chunkSize === undefined &&
			!hasStreamTransactionBeginOptions(options))
	) {
		return undefined;
	}
	return {
		...(options.chunkSize !== undefined && { chunkSize: options.chunkSize }),
		...(options.isolationLevel !== undefined && {
			isolationLevel: options.isolationLevel,
		}),
		...(options.readOnly !== undefined && { readOnly: options.readOnly }),
		...(options.lockTimeoutMs !== undefined && {
			lockTimeoutMs: options.lockTimeoutMs,
		}),
		...(options.statementTimeoutMs !== undefined && {
			statementTimeoutMs: options.statementTimeoutMs,
		}),
	};
}

/**
 * Create a lazy AsyncIterableIterator for streaming query results.
 *
 * Extracted from QueryBuilderImpl.stream().  All hook semantics, lazy
 * compilation, and onStart callback behaviour are preserved identically.
 *
 * @internal
 */
export function stream<TResult>(
	builder: QueryBuilderImpl<TResult>,
	options?: StreamOptions,
): AsyncIterableIterator<TResult> {
	const adapter = builder.getConfiguredAdapter();
	const hasBeginOptions = hasStreamTransactionBeginOptions(options);
	const hasSignalOption = hasRuntimeStreamSignalOption(options);
	const adapterOptions = createAdapterStreamOptions(options);

	// E17b: Fire beforeQuery hook with isStreaming=true (afterQuery does NOT fire for streams)
	const hookStore = builder.ctx.hookStore;
	const onHookError = builder.ctx.onHookError;
	const table = builder.from;
	const schemaName = builder.ctx.schemaName;
	const txFlag = builder.ctx.inTransaction;

	// Capture builder references needed inside the lazy iterator closure.
	// These are captured once to avoid re-reading mutable builder state on
	// every next() call (the builder could theoretically be modified between
	// iterator creation and first consumption).
	const onStartCallback = options?.onStart;

	// FIND-017: dumpResult (planning + compilation) MUST happen AFTER
	// beforeQuery hooks run, because hooks can modify the intent (e.g. inject
	// a tenant WHERE clause).  Moving compilation inside the lazy iterator's
	// first-next guard ensures hook changes are reflected in the executed SQL.
	let compiledQuery: CompiledQuery<TResult> | null = null;
	let capturedDump: Dump | null = null;
	let adapterIterator: AsyncIterableIterator<TResult> | null = null;
	let onStartCalled = false;
	let hooksFired = false;

	const lazyIterator: AsyncIterableIterator<TResult> = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			if (!supportsStreaming(adapter)) {
				throw createUnsupportedStreamingError();
			}
			if (hasSignalOption) {
				throw new Error(
					'stream() does not support signal; AbortSignal is only supported by transaction().',
				);
			}
			if (
				hasBeginOptions &&
				adapter.capabilities.supportsTransactionOptions !== true
			) {
				throw new Error(
					'This adapter does not support stream transaction options (isolationLevel/readOnly/lockTimeoutMs/statementTimeoutMs); it does not declare supportsTransactionOptions.',
				);
			}

			// E17b: Fire beforeQuery on first iteration (lazy), then compile with
			// the hook-modified intent.
			if (!hooksFired) {
				hooksFired = true;

				if (hookStore && hasHooks(hookStore)) {
					// Build raw intent (without defaultFilters) — hooks see raw intent
					const rawIntent = builder.buildIntent(false);
					const ctx: QueryHookContext = {
						table,
						operation: 'select',
						intent: rawIntent,
						resultType: 'all',
						isStreaming: true,
						...(schemaName !== undefined && { schemaName }),
						...(txFlag && { inTransaction: true }),
					};

					let hookIntent = rawIntent;
					try {
						// INV-07: Re-entrancy guard — prevent infinite loops from hooks issuing queries
						const afterHookCtx = await withReentrancyGuard(hookStore, (s) =>
							runBeforeQueryHooks(s.beforeQuery, ctx, onHookError),
						);
						hookIntent = afterHookCtx.intent;
					} catch (error) {
						if (hookStore.onError.length > 0) {
							throw await runOnErrorHooks(hookStore.onError, {
								table,
								operation: 'select',
								error: error as Error,
								intent: rawIntent,
								phase: 'beforeQuery',
							});
						}
						throw error;
					}

					// Apply defaultFilters AFTER hooks (INV-01: cannot be bypassed)
					const intentAfterDefaults =
						builder.applyDefaultFiltersToIntent(hookIntent);
					const intentWithHints =
						builder.applyRelationHints(intentAfterDefaults);
					const planOptions: PlanOptions = {
						...(builder.ctx.dialectCapabilities && {
							dialectCapabilities: builder.ctx.dialectCapabilities,
						}),
						...builder.ctx.planOptionsOverride,
					};
					const planReport = builder.planWithAmbiguityHandling(
						intentWithHints,
						planOptions,
					);
					const compileOptions: { schemaName?: string; model: ModelIR } = {
						model: builder.ctx.model,
					};
					if (schemaName !== undefined) {
						compileOptions.schemaName = schemaName;
					}
					const compiled = adapter.compile<TResult>(planReport, compileOptions);
					compiledQuery = compiled;
					capturedDump = adapter.createDump(planReport, compiled);
					if (
						capturedDump.meta?.schema === undefined &&
						schemaName !== undefined
					) {
						capturedDump = {
							...capturedDump,
							meta: { ...capturedDump.meta, schema: schemaName },
						};
					}
				} else {
					const planReport = builder.plan();
					const compileOptions: { schemaName?: string; model: ModelIR } = {
						model: builder.ctx.model,
					};
					if (schemaName !== undefined) {
						compileOptions.schemaName = schemaName;
					}
					const compiled = adapter.compile<TResult>(planReport, compileOptions);
					compiledQuery = compiled;
					capturedDump = adapter.createDump(planReport, compiled);
					if (
						capturedDump.meta?.schema === undefined &&
						schemaName !== undefined
					) {
						capturedDump = {
							...capturedDump,
							meta: { ...capturedDump.meta, schema: schemaName },
						};
					}
				}
			}

			// Initialize adapter iterator lazily (compiledQuery is now set)
			if (!adapterIterator) {
				// compiledQuery is guaranteed non-null: hooksFired is true at this
				// point, meaning the block above has completed and set compiledQuery.
				adapterIterator = adapter.stream<TResult>(
					// biome-ignore lint/style/noNonNullAssertion: invariant — hooksFired=true means the block above set compiledQuery before reaching this branch
					compiledQuery!,
					adapterOptions,
				);
			}

			// Call onStart only once, on first next() call
			if (!onStartCalled && onStartCallback && capturedDump) {
				onStartCalled = true;
				onStartCallback(capturedDump);
			}

			return adapterIterator.next();
		},
		async return(value?: TResult) {
			if (adapterIterator?.return) {
				return adapterIterator.return(value);
			}
			return { done: true as const, value: undefined };
		},
		async throw(error?: unknown) {
			// E17b: Fire onError for stream errors
			if (hookStore && hookStore.onError.length > 0 && error instanceof Error) {
				const rawIntent = builder.buildIntent(false);
				const finalError = await runOnErrorHooks(hookStore.onError, {
					table,
					operation: 'select',
					error,
					intent: rawIntent,
					phase: 'afterQuery',
				});
				throw finalError;
			}
			if (adapterIterator?.throw) {
				return adapterIterator.throw(error);
			}
			throw error;
		},
	};

	return lazyIterator;
}
