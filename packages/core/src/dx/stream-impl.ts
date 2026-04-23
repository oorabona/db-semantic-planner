/**
 * Stream implementation extracted from QueryBuilderImpl.
 *
 * Free function that accepts a QueryBuilderImpl instance and implements the
 * stream() logic.  It accesses only fields and methods declared
 * @internal public on QueryBuilderImpl.
 *
 * @internal
 */

import type { Dump } from '../adapter.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions } from '../planner.js';
import type { QueryHookContext } from './hooks.js';
import { hasHooks, runBeforeQueryHooks, runOnErrorHooks } from './hooks.js';
import type { QueryBuilderImpl } from './query-builder.js';
import type { StreamOptions } from './types.js';

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

	// Only pass chunkSize to adapter; onStart is handled in the wrapper
	const adapterOptions =
		options?.chunkSize !== undefined
			? { chunkSize: options.chunkSize }
			: undefined;

	// E17b: Fire beforeQuery hook with isStreaming=true (afterQuery does NOT fire for streams)
	const hookStore = builder.hookStore;
	const onHookError = builder.onHookError;
	const table = builder.from;
	const schemaName = builder.schemaName;
	const txFlag = builder.inTransaction;

	// Capture builder references needed inside the lazy iterator closure.
	// These are captured once to avoid re-reading mutable builder state on
	// every next() call (the builder could theoretically be modified between
	// iterator creation and first consumption).
	const onStartCallback = options?.onStart;

	// FIND-017: dumpResult (planning + compilation) MUST happen AFTER
	// beforeQuery hooks run, because hooks can modify the intent (e.g. inject
	// a tenant WHERE clause).  Moving compilation inside the lazy iterator's
	// first-next guard ensures hook changes are reflected in the executed SQL.
	let compiledQuery: { sql: string; parameters: readonly unknown[] } | null =
		null;
	let capturedDump: Dump | null = null;
	let adapterIterator: AsyncIterableIterator<TResult> | null = null;
	let onStartCalled = false;
	let hooksFired = false;

	const lazyIterator: AsyncIterableIterator<TResult> = {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
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
						const afterHookCtx = await runBeforeQueryHooks(
							hookStore.beforeQuery,
							ctx,
							onHookError,
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
						...(builder.dialectCapabilities && {
							dialectCapabilities: builder.dialectCapabilities,
						}),
						...builder.planOptionsOverride,
					};
					const planReport = builder.planWithAmbiguityHandling(
						intentWithHints,
						planOptions,
					);
					const compileOptions: { schemaName?: string; model: ModelIR } = {
						model: builder.model,
					};
					if (schemaName !== undefined) {
						compileOptions.schemaName = schemaName;
					}
					const compiled = adapter.compile(planReport, compileOptions);
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
					// No hooks: compute dump eagerly (same as original fast path)
					const dumpResult = builder.dump();
					compiledQuery = {
						sql: dumpResult.sql,
						parameters: dumpResult.params as readonly unknown[],
					};
					capturedDump = dumpResult;
				}
			}

			// Initialize adapter iterator lazily (compiledQuery is now set)
			if (!adapterIterator) {
				// compiledQuery is guaranteed non-null: hooksFired is true at this
				// point, meaning the block above has completed and set compiledQuery.
				adapterIterator = adapter.stream<TResult>(
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
