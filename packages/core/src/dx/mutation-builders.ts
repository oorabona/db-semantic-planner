/**
 * @module mutation-builders
 * Mutation builders for insert, update, and delete operations.
 * Part of DX-010: Mutations.
 */

import {
	type Adapter,
	type CompiledQuery,
	type CompileOptions,
	type DumpMeta,
	type DumpSequenceStep,
	executeCompiledQuery,
	executeCompiledQueryWithMeta,
} from '../adapter.js';
import type {
	BatchUpdateIntent,
	DeleteIntent,
	InsertIntent,
	MutationIntent,
	UpdateIntent,
	UpsertConflictAction,
	UpsertConflictTarget,
	UpsertIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import {
	ExecutionError,
	InvalidOperationError,
	UnsafeOperationError,
} from './errors.js';
import type {
	HookErrorHandler,
	HookStore,
	MutationHookContext,
	MutationOperation,
	ObserverErrorHandler,
} from './hooks.js';
import {
	hasHooks,
	normalizeHookError,
	runAfterMutationHooks,
	runAfterMutationObservers,
	runBeforeMutationHooks,
	runOnErrorHooks,
	withReentrancyGuard,
} from './hooks.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Dump output for mutations.
 * Similar to query Dump but without plan (mutations don't use the planner).
 */
export interface MutationDump {
	/** Compiled SQL string */
	readonly sql: string;
	/** Bound parameter values */
	readonly parameters: readonly unknown[];
	/** The mutation intent */
	readonly intent: MutationIntent;
	/** Optional metadata */
	readonly meta?: DumpMeta;
	/** Compile-only statement sequence for multi-statement NQL programs. */
	readonly sequence?: readonly DumpSequenceStep[];
}

/**
 * Compile a mutation intent through the adapter's mutation-specific compiler.
 *
 * Shared by the fluent mutation builders and NQL tag mutation support so the
 * intent-type dispatch stays in one place.
 */
export function compileMutationIntent(
	adapter: Adapter,
	intent: MutationIntent,
	options?: CompileOptions,
): CompiledQuery {
	switch (intent.type) {
		case 'insert':
			return adapter.compileInsert(intent, options);
		case 'insert_from':
			return adapter.compileInsertFrom(intent, options);
		case 'update':
			return adapter.compileUpdate(intent, options);
		case 'batchUpdate':
			return adapter.compileBatchUpdate(intent, options);
		case 'delete':
			return adapter.compileDelete(intent, options);
		case 'upsert':
			return adapter.compileUpsert(intent, options);
		case 'upsert_from':
			return adapter.compileUpsertFrom(intent, options);
	}
	const _exhaustive: never = intent;
	throw new Error(
		`Unsupported mutation type: ${(_exhaustive as { type: string }).type}`,
	);
}

/** Shared base options for all mutation builders */
type MutationBaseOpts = {
	table: string;
	model: ModelIR;
	adapter?: Adapter | undefined;
	schemaName?: string | undefined;
	hookStore?: HookStore | undefined;
	onHookError?: HookErrorHandler | undefined;
	onObserverError?: ObserverErrorHandler | undefined;
	inTransaction?: boolean | undefined;
};

export type PreparedMutationExecution<T> = {
	readonly sql: string;
	readonly parameters: readonly unknown[];
	readonly execute: () => Promise<PreparedMutationExecutionResult<T>>;
	readonly getAfterMutationResult?: (result: T) => readonly unknown[];
	readonly mapAfterMutationResult?: (
		result: T,
		transformed: readonly unknown[],
	) => T;
	readonly returnAfterMutationResult?: boolean;
};

export type PreparedMutationExecutionResult<T> = {
	readonly result: T;
	readonly affectedRows?: number;
};

export type RunMutationWithHooksOptions<
	T,
	TIntent extends MutationIntent = MutationIntent,
> = {
	readonly table: string;
	readonly intent: TIntent;
	readonly hookStore?: HookStore | undefined;
	readonly onHookError?: HookErrorHandler | undefined;
	readonly onObserverError?: ObserverErrorHandler | undefined;
	readonly schemaName?: string | undefined;
	readonly inTransaction?: boolean | undefined;
	readonly prepare: (intent: TIntent) => PreparedMutationExecution<T>;
};

export async function runMutationWithHooks<
	T,
	TIntent extends MutationIntent = MutationIntent,
>(opts: RunMutationWithHooksOptions<T, TIntent>): Promise<T> {
	const execution = await runMutationWithHooksMeta(opts);
	return execution.result;
}

async function runMutationWithHooksMeta<
	T,
	TIntent extends MutationIntent = MutationIntent,
>(
	opts: RunMutationWithHooksOptions<T, TIntent>,
): Promise<PreparedMutationExecutionResult<T>> {
	if (!opts.hookStore || !hasHooks(opts.hookStore)) {
		const prepared = opts.prepare(opts.intent);
		return prepared.execute();
	}

	return withReentrancyGuard(opts.hookStore, (store) =>
		runMutationWithHooksInner(opts, store),
	);
}

async function runMutationWithHooksInner<
	T,
	TIntent extends MutationIntent = MutationIntent,
>(
	opts: RunMutationWithHooksOptions<T, TIntent>,
	store: HookStore,
): Promise<PreparedMutationExecutionResult<T>> {
	const { intent } = opts;
	const operation = intent.type as MutationOperation;
	const startTime = Date.now();
	const { cardinality, data } = extractMutationIntentData(intent);

	let ctx: MutationHookContext = Object.freeze({
		table: opts.table,
		operation,
		intent,
		cardinality,
		data,
		...(opts.schemaName !== undefined ? { schemaName: opts.schemaName } : {}),
		...(opts.inTransaction ? { inTransaction: true } : {}),
	});

	try {
		if (store.beforeMutation.length > 0) {
			ctx = await runBeforeMutationHooks(
				store.beforeMutation,
				ctx,
				opts.onHookError,
			);
		}

		const executedIntent = intent;
		const prepared = opts.prepare(executedIntent);
		const duration = Date.now() - startTime;
		const execution = await prepared.execute();
		let result = execution.result;

		if (
			store.afterMutationObservers.length > 0 ||
			store.afterMutation.length > 0
		) {
			const { cardinality: executedCardinality, data: executedData } =
				extractMutationIntentData(executedIntent);
			const afterCtx: MutationHookContext = Object.freeze({
				table: executedIntent.table,
				operation: executedIntent.type as MutationOperation,
				intent: executedIntent,
				cardinality: executedCardinality,
				...(executedData !== undefined ? { data: executedData } : {}),
				...(opts.schemaName !== undefined
					? { schemaName: opts.schemaName }
					: {}),
				...(opts.inTransaction !== undefined
					? { inTransaction: opts.inTransaction }
					: {}),
				...(ctx.correlationId !== undefined
					? { correlationId: ctx.correlationId }
					: {}),
				sql: prepared.sql,
				parameters: prepared.parameters,
				duration,
				...(execution.affectedRows !== undefined
					? { affectedRows: execution.affectedRows }
					: {}),
			});
			const afterMutationResult = [
				...(prepared.getAfterMutationResult?.(execution.result) ?? []),
			];
			await runAfterMutationObservers(
				store.afterMutationObservers,
				afterCtx,
				afterMutationResult,
				opts.onObserverError,
			);
			const transformed = await runAfterMutationHooks(
				store.afterMutation,
				afterCtx,
				afterMutationResult,
				opts.onHookError,
			);
			if (prepared.returnAfterMutationResult) {
				result =
					prepared.mapAfterMutationResult?.(result, transformed) ??
					(transformed as T);
			}
		}

		return {
			result,
			...(execution.affectedRows !== undefined
				? { affectedRows: execution.affectedRows }
				: {}),
		};
	} catch (error) {
		if (store.onError.length > 0) {
			const errorCtx = {
				table: opts.table,
				operation,
				error: normalizeHookError(error),
				intent,
				phase: 'beforeMutation' as const,
				...(opts.schemaName !== undefined
					? { schemaName: opts.schemaName }
					: {}),
			};
			const transformed = await runOnErrorHooks(store.onError, errorCtx);
			throw transformed;
		}
		throw error;
	}
}

function extractMutationIntentData(intent: MutationIntent): {
	cardinality: 'single' | 'bulk';
	data: unknown;
} {
	if (intent.type === 'insert' || intent.type === 'upsert') {
		const values = (intent as InsertIntent | UpsertIntent).values;
		return {
			cardinality: values.length > 1 ? 'bulk' : 'single',
			data: values.length > 1 ? values : values[0],
		};
	}
	if (intent.type === 'update') {
		return {
			cardinality: 'single',
			data: (intent as UpdateIntent).set,
		};
	}
	if (intent.type === 'batchUpdate') {
		return {
			cardinality: 'bulk',
			data: (intent as BatchUpdateIntent).updates,
		};
	}
	if (intent.type === 'insert_from' || intent.type === 'upsert_from') {
		return { cardinality: 'bulk', data: undefined };
	}
	return { cardinality: 'single', data: undefined };
}

// ============================================================================
// Abstract Base
// ============================================================================

/**
 * Abstract base class for mutation builders.
 * Consolidates shared fields, adapter validation, dump(), and execute() logic.
 *
 * Subclasses implement:
 * - `buildIntent()`: construct the mutation-specific intent
 * - `compileIntent()`: call the correct adapter.compile* method
 * - `operationName`: label used in error messages
 */
abstract class MutationBuilderBase<
	T,
	TIntent extends
		| InsertIntent
		| UpdateIntent
		| BatchUpdateIntent
		| DeleteIntent
		| UpsertIntent,
> {
	protected readonly table: string;
	protected readonly model: ModelIR;
	protected readonly adapter: Adapter | undefined;
	protected readonly schemaName: string | undefined;
	protected readonly returningColumns: readonly string[] | undefined;
	protected readonly hookStore: HookStore | undefined;
	protected readonly onHookError: HookErrorHandler | undefined;
	protected readonly onObserverError: ObserverErrorHandler | undefined;
	protected readonly inTransaction: boolean | undefined;

	protected constructor(
		opts: MutationBaseOpts & {
			returning?: readonly string[] | undefined;
		},
	) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.returningColumns = opts.returning;
		this.hookStore = opts.hookStore;
		this.onHookError = opts.onHookError;
		this.onObserverError = opts.onObserverError;
		this.inTransaction = opts.inTransaction;
	}

	/** Label used in ExecutionError messages (e.g. 'insert', 'update'). */
	protected abstract readonly operationName: string;

	/** Construct the mutation-specific intent AST node. */
	protected abstract buildIntent(): TIntent;

	/** Delegate to the adapter's mutation-specific compile method. */
	protected abstract compileIntent(
		adapter: Adapter,
		intent: TIntent,
		options?: CompileOptions,
	): CompiledQuery;

	protected get baseOpts(): MutationBaseOpts {
		return {
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			hookStore: this.hookStore,
			onHookError: this.onHookError,
			onObserverError: this.onObserverError,
			inTransaction: this.inTransaction,
		};
	}

	/** Require a configured adapter or throw. */
	protected requireAdapter(operation: string): Adapter {
		if (!this.adapter) {
			throw new ExecutionError({
				operation,
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}
		return this.adapter;
	}

	dump(extraOptions?: CompileOptions): MutationDump {
		const adapter = this.requireAdapter('dump');
		const intent = this.buildIntent();
		const compileOptions: CompileOptions = {
			model: this.model,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...extraOptions,
		};
		const compiled = this.compileIntent(
			adapter,
			intent,
			Object.keys(compileOptions).length > 0 ? compileOptions : undefined,
		);

		const meta: DumpMeta = {
			compiledAt: new Date(),
			...(this.schemaName !== undefined && { schema: this.schemaName }),
			...(extraOptions?.queryName !== undefined && {
				queryName: extraOptions.queryName,
			}),
			...(extraOptions?.correlationId !== undefined && {
				correlationId: extraOptions.correlationId,
			}),
		};

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	async execute(): Promise<T> {
		const adapter = this.requireAdapter(this.operationName);
		const intent = this.buildIntent();

		return runMutationWithHooks({
			table: this.table,
			intent,
			hookStore: this.hookStore,
			onHookError: this.onHookError,
			onObserverError: this.onObserverError,
			schemaName: this.schemaName,
			inTransaction: this.inTransaction,
			prepare: (preparedIntent) =>
				this.prepareMutationExecution(adapter, preparedIntent),
		});
	}

	async affectedRows(): Promise<number> {
		const adapter = this.requireAdapter(this.operationName);
		const intent = this.buildIntent();
		const operation = `${this.operationName}.affectedRows()`;
		if (typeof adapter.executeWithMeta !== 'function') {
			throw new ExecutionError({
				operation,
				reason:
					'this adapter does not support affectedRows(); it does not implement executeWithMeta',
				fix: 'Use an adapter that implements executeWithMeta, or call execute() when row count metadata is not required.',
			});
		}
		const execution = await runMutationWithHooksMeta({
			table: this.table,
			intent,
			hookStore: this.hookStore,
			onHookError: this.onHookError,
			onObserverError: this.onObserverError,
			schemaName: this.schemaName,
			inTransaction: this.inTransaction,
			prepare: (preparedIntent) =>
				this.prepareMutationExecution(adapter, preparedIntent, operation),
		});
		if (execution.affectedRows === undefined) {
			throw new ExecutionError({
				operation,
				reason:
					'this adapter does not support affectedRows(); it did not return executeWithMeta metadata',
				fix: 'Use an adapter that implements executeWithMeta and returns rowCount metadata.',
			});
		}
		return execution.affectedRows;
	}

	private prepareMutationExecution(
		adapter: Adapter,
		intent: TIntent,
		operation = `${this.operationName}()`,
	): PreparedMutationExecution<T> {
		const compileOptions: CompileOptions = {
			model: this.model,
			...(this.schemaName ? { schemaName: this.schemaName } : {}),
		};
		const compiled = this.compileIntent(adapter, intent, compileOptions);

		if (this.returningColumns && this.returningColumns.length > 0) {
			return {
				sql: compiled.sql,
				parameters: compiled.parameters,
				execute: async () => {
					if (typeof adapter.executeWithMeta === 'function') {
						const result = await executeCompiledQueryWithMeta(
							adapter,
							compiled,
							operation,
						);
						return {
							result: result.rows as T,
							affectedRows: result.rowCount,
						};
					}
					const result = await executeCompiledQuery(
						adapter,
						compiled,
						operation,
					);
					return {
						result: result as T,
					};
				},
				getAfterMutationResult: (result) => result as unknown[],
				returnAfterMutationResult: true,
			};
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			execute: async () => {
				if (typeof adapter.executeWithMeta === 'function') {
					const result = await executeCompiledQueryWithMeta(
						adapter,
						compiled,
						operation,
					);
					return {
						result: undefined as T,
						affectedRows: result.rowCount,
					};
				}
				await executeCompiledQuery(adapter, compiled, operation);
				return {
					result: undefined as T,
				};
			},
			getAfterMutationResult: () => [],
		};
	}
}

// ============================================================================
// Insert Builder
// ============================================================================

/**
 * Builder for INSERT operations.
 * Immutable - each method returns a new builder instance.
 */
export class InsertBuilder<T = void> extends MutationBuilderBase<
	T,
	InsertIntent
> {
	private readonly valuesData: readonly Record<string, unknown>[];

	protected readonly operationName = 'insert';

	constructor(
		opts: MutationBaseOpts & {
			values?: readonly Record<string, unknown>[] | undefined;
			returning?: readonly string[] | undefined;
		},
	) {
		super(opts);
		this.valuesData = opts.values ?? [];
	}

	/**
	 * Set values to insert.
	 * Accepts a single object or an array for bulk insert.
	 */
	values(
		data: Record<string, unknown> | readonly Record<string, unknown>[],
	): InsertBuilder<T> {
		const valueArray = Array.isArray(data) ? data : [data];
		return new InsertBuilder({
			...this.baseOpts,
			values: valueArray,
			returning: this.returningColumns,
		});
	}

	/**
	 * Specify columns to return after insert (DX-026).
	 * Requires adapter support for RETURNING clause.
	 *
	 * @example
	 * ```typescript
	 * const inserted = await orm.insert(User)
	 *   .values({ name: 'Alice', email: 'alice@example.com' })
	 *   .returning(['id', 'created_at'])
	 *   .execute();
	 * // inserted = [{ id: 1, created_at: '2024-01-01T00:00:00Z' }]
	 * ```
	 */
	returning<R = Record<string, unknown>>(
		columns: readonly (keyof R & string)[],
	): InsertBuilder<R[]> {
		return new InsertBuilder<R[]>({
			...this.baseOpts,
			values: this.valuesData,
			returning: columns,
		});
	}

	protected buildIntent(): InsertIntent {
		if (this.valuesData.length === 0) {
			throw new InvalidOperationError(
				'insert',
				'No values provided for insert',
			);
		}

		const intent: InsertIntent = {
			type: 'insert',
			table: this.table,
			values: this.valuesData,
		};

		if (this.returningColumns && this.returningColumns.length > 0) {
			return { ...intent, returning: this.returningColumns };
		}

		return intent;
	}

	protected compileIntent(
		adapter: Adapter,
		intent: InsertIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileMutationIntent(adapter, intent, options);
	}
}

// ============================================================================
// Update Builder
// ============================================================================

/**
 * Builder for UPDATE operations.
 * Immutable - each method returns a new builder instance.
 */
export class UpdateBuilder<T = void> extends MutationBuilderBase<
	T,
	UpdateIntent | BatchUpdateIntent
> {
	private readonly setData: Record<string, unknown>;
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;
	private readonly batchMatchColumns: readonly string[] | undefined;
	private readonly batchData: readonly Record<string, unknown>[] | undefined;

	protected readonly operationName = 'update';

	constructor(
		opts: MutationBaseOpts & {
			set?: Record<string, unknown> | undefined;
			where?: WhereIntent | undefined;
			allowAll?: boolean | undefined;
			returning?: readonly string[] | undefined;
			batchMatchColumns?: readonly string[] | undefined;
			batchData?: readonly Record<string, unknown>[] | undefined;
		},
	) {
		super(opts);
		this.setData = opts.set ?? {};
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
		this.batchMatchColumns = opts.batchMatchColumns;
		this.batchData = opts.batchData;
	}

	/**
	 * Set fields to update.
	 * Multiple calls merge fields (last value wins).
	 * When combined with batchSet(), these become scalar SET assignments applied to all rows.
	 */
	set(data: Record<string, unknown>): UpdateBuilder<T> {
		return new UpdateBuilder({
			...this.baseOpts,
			set: { ...this.setData, ...data },
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			returning: this.returningColumns,
			batchMatchColumns: this.batchMatchColumns,
			batchData: this.batchData,
		});
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): UpdateBuilder<T> {
		return new UpdateBuilder({
			...this.baseOpts,
			set: this.setData,
			where: condition,
			allowAll: this.allowAllFlag,
			returning: this.returningColumns,
			batchMatchColumns: this.batchMatchColumns,
			batchData: this.batchData,
		});
	}

	/**
	 * Specify columns to return after update (DX-026).
	 * Requires adapter support for RETURNING clause.
	 *
	 * @example
	 * ```typescript
	 * const updated = await orm.update(User)
	 *   .set({ status: 'active' })
	 *   .where({ type: 'comparison', field: 'id', operator: '=', value: 1 })
	 *   .returning(['id', 'status', 'updated_at'])
	 *   .execute();
	 * ```
	 */
	returning<R = Record<string, unknown>>(
		columns: readonly (keyof R & string)[],
	): UpdateBuilder<R[]> {
		return new UpdateBuilder<R[]>({
			...this.baseOpts,
			set: this.setData,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			returning: columns,
			batchMatchColumns: this.batchMatchColumns,
			batchData: this.batchData,
		});
	}

	/**
	 * Batch update multiple rows using unnest FROM strategy (BATCH-001).
	 *
	 * Generates:
	 *   UPDATE "table" SET "col" = t."col"
	 *   FROM unnest(CAST($1 AS type[]), CAST($2 AS type[])) AS t("match_col", "col")
	 *   WHERE "table"."match_col" = t."match_col"
	 *
	 * Can be chained with .set() for scalar values applied to all rows.
	 *
	 * @param matchColumn - Column(s) used to identify rows to update
	 * @param data - Array of row objects containing match + update column values
	 *
	 * @example
	 * ```typescript
	 * await orm.update('calls')
	 *   .batchSet('id', [{ id: 10, callee_id: 42 }, { id: 20, callee_id: 43 }])
	 *   .execute();
	 * ```
	 */
	batchSet(
		matchColumn: string | string[],
		data: Record<string, unknown>[],
	): UpdateBuilder<T> {
		const matchColumns = Array.isArray(matchColumn)
			? matchColumn
			: [matchColumn];
		return new UpdateBuilder({
			...this.baseOpts,
			set: this.setData,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			returning: this.returningColumns,
			batchMatchColumns: matchColumns,
			batchData: data,
		});
	}

	protected buildIntent(): UpdateIntent | BatchUpdateIntent {
		// Batch path
		if (this.batchMatchColumns && this.batchData) {
			if (this.batchData.length === 0) {
				throw new InvalidOperationError(
					'update',
					'batchSet requires at least one row',
				);
			}

			const intent: BatchUpdateIntent = {
				type: 'batchUpdate',
				table: this.table,
				matchColumns: this.batchMatchColumns,
				updates: this.batchData,
			};

			if (Object.keys(this.setData).length > 0) {
				Object.assign(intent, { scalarSet: this.setData });
			}
			if (this.whereIntent) {
				Object.assign(intent, { where: this.whereIntent });
			}
			if (this.returningColumns && this.returningColumns.length > 0) {
				Object.assign(intent, { returning: this.returningColumns });
			}

			return intent;
		}

		// Regular update path
		if (Object.keys(this.setData).length === 0) {
			throw new InvalidOperationError('update', 'No fields to update');
		}

		if (!this.whereIntent && !this.allowAllFlag) {
			throw new UnsafeOperationError(
				'update',
				'WHERE clause required. Use updateAll() for full-table updates.',
			);
		}

		const intent: UpdateIntent = {
			type: 'update',
			table: this.table,
			set: this.setData,
		};

		if (this.whereIntent) {
			Object.assign(intent, { where: this.whereIntent });
		}
		if (this.allowAllFlag) {
			Object.assign(intent, { allowAll: true });
		}
		if (this.returningColumns && this.returningColumns.length > 0) {
			Object.assign(intent, { returning: this.returningColumns });
		}

		return intent;
	}

	protected compileIntent(
		adapter: Adapter,
		intent: UpdateIntent | BatchUpdateIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileMutationIntent(adapter, intent, options);
	}
}

// ============================================================================
// Delete Builder
// ============================================================================

/**
 * Builder for DELETE operations.
 * Immutable - each method returns a new builder instance.
 */
export class DeleteBuilder<T = void> extends MutationBuilderBase<
	T,
	DeleteIntent
> {
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;
	private readonly cascadeRelations: boolean | readonly string[] | undefined;

	protected readonly operationName = 'delete';

	constructor(
		opts: MutationBaseOpts & {
			where?: WhereIntent | undefined;
			allowAll?: boolean | undefined;
			cascade?: boolean | readonly string[] | undefined;
			returning?: readonly string[] | undefined;
		},
	) {
		super(opts);
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
		this.cascadeRelations = opts.cascade;
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): DeleteBuilder<T> {
		return new DeleteBuilder({
			...this.baseOpts,
			where: condition,
			allowAll: this.allowAllFlag,
			cascade: this.cascadeRelations,
			returning: this.returningColumns,
		});
	}

	/**
	 * Enable cascade delete.
	 * Without arguments: deletes ALL related records.
	 * With array: deletes only specified relations.
	 */
	cascade(relations?: readonly string[]): DeleteBuilder<T> {
		return new DeleteBuilder({
			...this.baseOpts,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			cascade: relations ?? true,
			returning: this.returningColumns,
		});
	}

	/**
	 * Specify columns to return after delete (DX-026).
	 * Requires adapter support for RETURNING clause.
	 *
	 * @example
	 * ```typescript
	 * const deleted = await orm.delete(User)
	 *   .where({ type: 'comparison', field: 'id', operator: '=', value: 1 })
	 *   .returning(['id', 'email'])
	 *   .execute();
	 * ```
	 */
	returning<R = Record<string, unknown>>(
		columns: readonly (keyof R & string)[],
	): DeleteBuilder<R[]> {
		return new DeleteBuilder<R[]>({
			...this.baseOpts,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			cascade: this.cascadeRelations,
			returning: columns,
		});
	}

	protected buildIntent(): DeleteIntent {
		if (!this.whereIntent && !this.allowAllFlag) {
			throw new UnsafeOperationError(
				'delete',
				'WHERE clause required. Use deleteAll() for full-table deletes.',
			);
		}

		const intent: DeleteIntent = {
			type: 'delete',
			table: this.table,
		};

		if (this.whereIntent) {
			Object.assign(intent, { where: this.whereIntent });
		}
		if (this.allowAllFlag) {
			Object.assign(intent, { allowAll: true });
		}
		if (this.cascadeRelations !== undefined) {
			Object.assign(intent, { cascade: this.cascadeRelations });
		}
		if (this.returningColumns && this.returningColumns.length > 0) {
			Object.assign(intent, { returning: this.returningColumns });
		}

		return intent;
	}

	protected compileIntent(
		adapter: Adapter,
		intent: DeleteIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileMutationIntent(adapter, intent, options);
	}
}

// ============================================================================
// Upsert Builder (DX-026)
// ============================================================================

/**
 * Builder for UPSERT operations (INSERT ... ON CONFLICT ... DO UPDATE/NOTHING).
 * Immutable - each method returns a new builder instance.
 *
 * @example
 * ```typescript
 * // Basic upsert with doUpdate
 * await orm.upsert(User)
 *   .values({ id: 1, name: 'Alice', email: 'alice@example.com' })
 *   .onConflict(['id'])
 *   .doUpdate({ name: 'Alice Updated' })
 *   .execute();
 *
 * // Upsert with doNothing
 * await orm.upsert(User)
 *   .values({ id: 1, name: 'Alice' })
 *   .onConflict(['id'])
 *   .doNothing()
 *   .execute();
 *
 * // Upsert with constraint name
 * await orm.upsert(User)
 *   .values({ id: 1, name: 'Alice' })
 *   .onConflictConstraint('users_pkey')
 *   .doUpdate()  // Auto-update non-conflict columns
 *   .returning(['id', 'updated_at'])
 *   .execute();
 * ```
 */
export class UpsertBuilder<T = void> extends MutationBuilderBase<
	T,
	UpsertIntent
> {
	private readonly valuesData: readonly Record<string, unknown>[];
	private readonly conflictTarget: UpsertConflictTarget | undefined;
	private readonly conflictAction: UpsertConflictAction | undefined;

	protected readonly operationName = 'upsert';

	constructor(
		opts: MutationBaseOpts & {
			values?: readonly Record<string, unknown>[] | undefined;
			onConflict?: UpsertConflictTarget | undefined;
			action?: UpsertConflictAction | undefined;
			returning?: readonly string[] | undefined;
		},
	) {
		super(opts);
		this.valuesData = opts.values ?? [];
		this.conflictTarget = opts.onConflict;
		this.conflictAction = opts.action;
	}

	/**
	 * Set values to insert.
	 * Accepts a single object or an array for bulk upsert.
	 */
	values(
		data: Record<string, unknown> | readonly Record<string, unknown>[],
	): UpsertBuilder<T> {
		const valueArray = Array.isArray(data) ? data : [data];
		return new UpsertBuilder({
			...this.baseOpts,
			values: valueArray,
			onConflict: this.conflictTarget,
			action: this.conflictAction,
			returning: this.returningColumns,
		});
	}

	/**
	 * Specify conflict target by column names.
	 * These columns determine conflict detection.
	 */
	onConflict(columns: readonly string[]): UpsertBuilder<T> {
		return new UpsertBuilder({
			...this.baseOpts,
			values: this.valuesData,
			onConflict: { columns },
			action: this.conflictAction,
			returning: this.returningColumns,
		});
	}

	/**
	 * Specify conflict target by constraint name.
	 * Alternative to onConflict() for named constraints.
	 */
	onConflictConstraint(constraintName: string): UpsertBuilder<T> {
		return new UpsertBuilder({
			...this.baseOpts,
			values: this.valuesData,
			onConflict: { constraint: constraintName },
			action: this.conflictAction,
			returning: this.returningColumns,
		});
	}

	/**
	 * On conflict, update the specified fields.
	 * If no fields specified, auto-updates all non-conflict columns.
	 *
	 * @param set - Optional fields to update on conflict
	 * @param where - Optional condition for the update
	 */
	doUpdate(
		set?: Record<string, unknown>,
		where?: WhereIntent,
	): UpsertBuilder<T> {
		const action: UpsertConflictAction = {
			type: 'doUpdate',
			...(set && { set }),
			...(where && { where }),
		};
		return new UpsertBuilder({
			...this.baseOpts,
			values: this.valuesData,
			onConflict: this.conflictTarget,
			action,
			returning: this.returningColumns,
		});
	}

	/**
	 * On conflict, do nothing (skip the insert).
	 */
	doNothing(): UpsertBuilder<T> {
		return new UpsertBuilder({
			...this.baseOpts,
			values: this.valuesData,
			onConflict: this.conflictTarget,
			action: { type: 'doNothing' },
			returning: this.returningColumns,
		});
	}

	/**
	 * Specify columns to return after upsert (DX-026).
	 * Requires adapter support for RETURNING clause.
	 */
	returning<R = Record<string, unknown>>(
		columns: readonly (keyof R & string)[],
	): UpsertBuilder<R[]> {
		return new UpsertBuilder<R[]>({
			...this.baseOpts,
			values: this.valuesData,
			onConflict: this.conflictTarget,
			action: this.conflictAction,
			returning: columns,
		});
	}

	protected buildIntent(): UpsertIntent {
		if (this.valuesData.length === 0) {
			throw new InvalidOperationError(
				'upsert',
				'No values provided for upsert',
			);
		}

		if (!this.conflictTarget) {
			throw new InvalidOperationError(
				'upsert',
				'No conflict target specified. Use onConflict() or onConflictConstraint().',
			);
		}

		if (!this.conflictAction) {
			throw new InvalidOperationError(
				'upsert',
				'No conflict action specified. Use doUpdate() or doNothing().',
			);
		}

		const intent: UpsertIntent = {
			type: 'upsert',
			table: this.table,
			values: this.valuesData,
			onConflict: this.conflictTarget,
			action: this.conflictAction,
		};

		if (this.returningColumns && this.returningColumns.length > 0) {
			return { ...intent, returning: this.returningColumns };
		}

		return intent;
	}

	protected compileIntent(
		adapter: Adapter,
		intent: UpsertIntent,
		options?: CompileOptions,
	): CompiledQuery {
		return compileMutationIntent(adapter, intent, options);
	}
}
