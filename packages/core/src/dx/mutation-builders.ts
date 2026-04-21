/**
 * @module mutation-builders
 * Mutation builders for insert, update, and delete operations.
 * Part of DX-010: Mutations.
 */

import type { Adapter, CompiledQuery, CompileOptions } from '../adapter.js';
import type {
	BatchUpdateIntent,
	DeleteIntent,
	InsertIntent,
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
} from './hooks.js';
import {
	hasHooks,
	runAfterMutationHooks,
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
	readonly intent:
		| InsertIntent
		| UpdateIntent
		| BatchUpdateIntent
		| DeleteIntent
		| UpsertIntent;
	/** Optional metadata */
	readonly meta?: {
		readonly schema?: string;
		readonly compiledAt?: Date;
	};
}

/** Shared base options for all mutation builders */
type MutationBaseOpts = {
	table: string;
	model: ModelIR;
	adapter?: Adapter | undefined;
	schemaName?: string | undefined;
	hookStore?: HookStore | undefined;
	onHookError?: HookErrorHandler | undefined;
	inTransaction?: boolean | undefined;
};

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
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...extraOptions,
		};
		const compiled = this.compileIntent(
			adapter,
			intent,
			Object.keys(compileOptions).length > 0 ? compileOptions : undefined,
		);

		const meta: { compiledAt: Date; schema?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.schema = this.schemaName;
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	async execute(): Promise<T> {
		const adapter = this.requireAdapter(this.operationName);

		// Fast path: no hooks registered
		if (!this.hookStore || !hasHooks(this.hookStore)) {
			return this.executeWithoutHooks(adapter);
		}

		return this.executeWithHooks(adapter);
	}

	private async executeWithoutHooks(adapter: Adapter): Promise<T> {
		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.compileIntent(adapter, intent, compileOptions);

		if (this.returningColumns && this.returningColumns.length > 0) {
			const result = await adapter.execute(compiled);
			return result as T;
		}
		await adapter.execute(compiled);
		return undefined as T;
	}

	private async executeWithHooks(adapter: Adapter): Promise<T> {
		const store = this.hookStore;
		if (!store) throw new Error('executeWithHooks called without hookStore');
		// INV-07: Re-entrancy guard
		return withReentrancyGuard(store, (s) =>
			this.executeWithHooksInner(adapter, s),
		);
	}

	private async executeWithHooksInner(
		adapter: Adapter,
		store: HookStore,
	): Promise<T> {
		const intent = this.buildIntent();
		const operation = intent.type as MutationOperation;
		const startTime = Date.now();

		// Determine cardinality and data from intent
		const { cardinality, data } = this.extractIntentData(intent);

		// Build before-mutation context (no sql/duration yet)
		let ctx: MutationHookContext = Object.freeze({
			table: this.table,
			operation,
			intent,
			cardinality,
			data,
			...(this.schemaName !== undefined ? { schemaName: this.schemaName } : {}),
			...(this.inTransaction ? { inTransaction: true } : {}),
		});

		try {
			// Run beforeMutation hooks (FIFO)
			if (store.beforeMutation.length > 0) {
				ctx = await runBeforeMutationHooks(
					store.beforeMutation,
					ctx,
					this.onHookError,
				);
			}

			// Compile and execute
			const compileOptions = this.schemaName
				? { schemaName: this.schemaName }
				: undefined;
			const compiled = this.compileIntent(adapter, intent, compileOptions);
			const duration = Date.now() - startTime;

			if (this.returningColumns && this.returningColumns.length > 0) {
				const result = await adapter.execute(compiled);

				// Build after-mutation context with sql/duration
				const afterCtx: MutationHookContext = Object.freeze({
					...ctx,
					sql: compiled.sql,
					parameters: compiled.parameters,
					duration,
				});

				// Run afterMutation hooks (LIFO)
				if (store.afterMutation.length > 0) {
					const transformed = await runAfterMutationHooks(
						store.afterMutation,
						afterCtx,
						result as unknown[],
						this.onHookError,
					);
					return transformed as T;
				}
				return result as T;
			}

			await adapter.execute(compiled);

			// Even without RETURNING, fire afterMutation with empty results
			if (store.afterMutation.length > 0) {
				const afterCtx: MutationHookContext = Object.freeze({
					...ctx,
					sql: compiled.sql,
					parameters: compiled.parameters,
					duration,
				});
				await runAfterMutationHooks(
					store.afterMutation,
					afterCtx,
					[],
					this.onHookError,
				);
			}

			return undefined as T;
		} catch (error) {
			// Run onError hooks
			if (store.onError.length > 0) {
				const errorCtx = {
					table: this.table,
					operation,
					error: error as Error,
					intent,
					phase: 'beforeMutation' as const,
					...(this.schemaName !== undefined
						? { schemaName: this.schemaName }
						: {}),
				};
				const transformed = await runOnErrorHooks(store.onError, errorCtx);
				throw transformed;
			}
			throw error;
		}
	}

	/** Extract cardinality and data from mutation intent */
	private extractIntentData(intent: TIntent): {
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
			const updates = (intent as BatchUpdateIntent).updates;
			return {
				cardinality: 'bulk',
				data: updates,
			};
		}
		// delete — no data
		return { cardinality: 'single', data: undefined };
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
		return adapter.compileInsert(intent, options);
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
		if (intent.type === 'batchUpdate') {
			return adapter.compileBatchUpdate(intent, options);
		}
		return adapter.compileUpdate(intent, options);
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
		return adapter.compileDelete(intent, options);
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
		return adapter.compileUpsert(intent, options);
	}
}
