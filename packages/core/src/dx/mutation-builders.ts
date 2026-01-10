/**
 * @module mutation-builders
 * Mutation builders for insert, update, and delete operations.
 * Part of DX-010: Mutations.
 */

import type { Adapter } from '../adapter.js';
import type {
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
	readonly intent: InsertIntent | UpdateIntent | DeleteIntent | UpsertIntent;
	/** Optional metadata */
	readonly meta?: {
		readonly tenant?: string;
		readonly compiledAt?: Date;
	};
}

// ============================================================================
// Insert Builder
// ============================================================================

/**
 * Builder for INSERT operations.
 * Immutable - each method returns a new builder instance.
 */
export class InsertBuilder<T = void> {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly valuesData: readonly Record<string, unknown>[];
	private readonly returningColumns: readonly string[] | undefined;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		values?: readonly Record<string, unknown>[] | undefined;
		returning?: readonly string[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.valuesData = opts.values ?? [];
		this.returningColumns = opts.returning;
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
		columns: readonly string[],
	): InsertBuilder<R[]> {
		return new InsertBuilder<R[]>({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			values: this.valuesData,
			returning: columns,
		});
	}

	/**
	 * Build the insert intent.
	 */
	private buildIntent(): InsertIntent {
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

	/**
	 * Compile and return the dump without executing.
	 * Useful for observability and debugging.
	 */
	dump(): MutationDump {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'dump',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileInsert(intent, compileOptions);

		const meta: { compiledAt: Date; tenant?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.tenant = this.schemaName;
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	/**
	 * Execute the insert operation.
	 * Returns void if no returning() specified, or array of returned rows.
	 */
	async execute(): Promise<T> {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'insert',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileInsert(intent, compileOptions);

		// Execute the compiled query
		if (this.returningColumns && this.returningColumns.length > 0) {
			const result = await this.adapter.execute(compiled);
			return result as T;
		}
		await this.adapter.execute(compiled);
		return undefined as T;
	}
}

// ============================================================================
// Update Builder
// ============================================================================

/**
 * Builder for UPDATE operations.
 * Immutable - each method returns a new builder instance.
 */
export class UpdateBuilder<T = void> {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly setData: Record<string, unknown>;
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;
	private readonly returningColumns: readonly string[] | undefined;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		set?: Record<string, unknown> | undefined;
		where?: WhereIntent | undefined;
		allowAll?: boolean | undefined;
		returning?: readonly string[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.setData = opts.set ?? {};
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
		this.returningColumns = opts.returning;
	}

	/**
	 * Set fields to update.
	 * Multiple calls merge fields (last value wins).
	 */
	set(data: Record<string, unknown>): UpdateBuilder<T> {
		return new UpdateBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			set: { ...this.setData, ...data },
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			returning: this.returningColumns,
		});
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): UpdateBuilder<T> {
		return new UpdateBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			set: this.setData,
			where: condition,
			allowAll: this.allowAllFlag,
			returning: this.returningColumns,
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
		columns: readonly string[],
	): UpdateBuilder<R[]> {
		return new UpdateBuilder<R[]>({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			set: this.setData,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			returning: columns,
		});
	}

	/**
	 * Build the update intent.
	 */
	private buildIntent(): UpdateIntent {
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

	/**
	 * Compile and return the dump without executing.
	 */
	dump(): MutationDump {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'dump',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileUpdate(intent, compileOptions);

		const meta: { compiledAt: Date; tenant?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.tenant = this.schemaName;
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	/**
	 * Execute the update operation.
	 * Returns void if no returning() specified, or array of returned rows.
	 */
	async execute(): Promise<T> {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'update',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileUpdate(intent, compileOptions);

		if (this.returningColumns && this.returningColumns.length > 0) {
			const result = await this.adapter.execute(compiled);
			return result as T;
		}
		await this.adapter.execute(compiled);
		return undefined as T;
	}
}

// ============================================================================
// Delete Builder
// ============================================================================

/**
 * Builder for DELETE operations.
 * Immutable - each method returns a new builder instance.
 */
export class DeleteBuilder<T = void> {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;
	private readonly cascadeRelations: boolean | readonly string[] | undefined;
	private readonly returningColumns: readonly string[] | undefined;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		where?: WhereIntent | undefined;
		allowAll?: boolean | undefined;
		cascade?: boolean | readonly string[] | undefined;
		returning?: readonly string[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
		this.cascadeRelations = opts.cascade;
		this.returningColumns = opts.returning;
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): DeleteBuilder<T> {
		return new DeleteBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
		columns: readonly string[],
	): DeleteBuilder<R[]> {
		return new DeleteBuilder<R[]>({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			cascade: this.cascadeRelations,
			returning: columns,
		});
	}

	/**
	 * Build the delete intent.
	 */
	private buildIntent(): DeleteIntent {
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

	/**
	 * Compile and return the dump without executing.
	 */
	dump(): MutationDump {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'dump',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileDelete(intent, compileOptions);

		const meta: { compiledAt: Date; tenant?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.tenant = this.schemaName;
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	/**
	 * Execute the delete operation.
	 * Returns void if no returning() specified, or array of returned rows.
	 * Note: Cascade deletes are executed as multiple statements.
	 */
	async execute(): Promise<T> {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'delete',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		// TODO: Implement cascade delete logic (multiple statements)
		// For now, just execute the single delete
		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileDelete(intent, compileOptions);

		if (this.returningColumns && this.returningColumns.length > 0) {
			const result = await this.adapter.execute(compiled);
			return result as T;
		}
		await this.adapter.execute(compiled);
		return undefined as T;
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
export class UpsertBuilder<T = void> {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly valuesData: readonly Record<string, unknown>[];
	private readonly conflictTarget: UpsertConflictTarget | undefined;
	private readonly conflictAction: UpsertConflictAction | undefined;
	private readonly returningColumns: readonly string[] | undefined;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		values?: readonly Record<string, unknown>[] | undefined;
		onConflict?: UpsertConflictTarget | undefined;
		action?: UpsertConflictAction | undefined;
		returning?: readonly string[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.valuesData = opts.values ?? [];
		this.conflictTarget = opts.onConflict;
		this.conflictAction = opts.action;
		this.returningColumns = opts.returning;
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
	doUpdate(set?: Record<string, unknown>, where?: WhereIntent): UpsertBuilder<T> {
		const action: UpsertConflictAction = {
			type: 'doUpdate',
			...(set && { set }),
			...(where && { where }),
		};
		return new UpsertBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
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
		columns: readonly string[],
	): UpsertBuilder<R[]> {
		return new UpsertBuilder<R[]>({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			values: this.valuesData,
			onConflict: this.conflictTarget,
			action: this.conflictAction,
			returning: columns,
		});
	}

	/**
	 * Build the upsert intent.
	 */
	private buildIntent(): UpsertIntent {
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

	/**
	 * Compile and return the dump without executing.
	 */
	dump(): MutationDump {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'dump',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileUpsert(intent, compileOptions);

		const meta: { compiledAt: Date; tenant?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.tenant = this.schemaName;
		}

		return {
			sql: compiled.sql,
			parameters: compiled.parameters,
			intent,
			meta,
		};
	}

	/**
	 * Execute the upsert operation.
	 * Returns void if no returning() specified, or array of returned rows.
	 */
	async execute(): Promise<T> {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'upsert',
				reason: 'Adapter not configured',
				fix: 'Pass adapter option when creating ORM: createOrm({ model, adapter })',
			});
		}

		const intent = this.buildIntent();
		const compileOptions = this.schemaName
			? { schemaName: this.schemaName }
			: undefined;
		const compiled = this.adapter.compileUpsert(intent, compileOptions);

		if (this.returningColumns && this.returningColumns.length > 0) {
			const result = await this.adapter.execute(compiled);
			return result as T;
		}
		await this.adapter.execute(compiled);
		return undefined as T;
	}
}
