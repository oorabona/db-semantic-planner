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
	readonly intent: InsertIntent | UpdateIntent | DeleteIntent;
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
export class InsertBuilder {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly valuesData: readonly Record<string, unknown>[];

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		values?: readonly Record<string, unknown>[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.valuesData = opts.values ?? [];
	}

	/**
	 * Set values to insert.
	 * Accepts a single object or an array for bulk insert.
	 */
	values(
		data: Record<string, unknown> | readonly Record<string, unknown>[],
	): InsertBuilder {
		const valueArray = Array.isArray(data) ? data : [data];
		return new InsertBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			values: valueArray,
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

		return {
			type: 'insert',
			table: this.table,
			values: this.valuesData,
		};
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
	 * Returns void for MVP (no RETURNING support yet).
	 */
	async execute(): Promise<void> {
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
		await this.adapter.execute(compiled);
	}
}

// ============================================================================
// Update Builder
// ============================================================================

/**
 * Builder for UPDATE operations.
 * Immutable - each method returns a new builder instance.
 */
export class UpdateBuilder {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly setData: Record<string, unknown>;
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		set?: Record<string, unknown> | undefined;
		where?: WhereIntent | undefined;
		allowAll?: boolean | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.setData = opts.set ?? {};
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
	}

	/**
	 * Set fields to update.
	 * Multiple calls merge fields (last value wins).
	 */
	set(data: Record<string, unknown>): UpdateBuilder {
		return new UpdateBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			set: { ...this.setData, ...data },
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
		});
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): UpdateBuilder {
		return new UpdateBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			set: this.setData,
			where: condition,
			allowAll: this.allowAllFlag,
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
			return { ...intent, where: this.whereIntent };
		}
		if (this.allowAllFlag) {
			return { ...intent, allowAll: true };
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
	 */
	async execute(): Promise<void> {
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

		await this.adapter.execute(compiled);
	}
}

// ============================================================================
// Delete Builder
// ============================================================================

/**
 * Builder for DELETE operations.
 * Immutable - each method returns a new builder instance.
 */
export class DeleteBuilder {
	private readonly table: string;
	private readonly model: ModelIR;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly whereIntent: WhereIntent | undefined;
	private readonly allowAllFlag: boolean;
	private readonly cascadeRelations: boolean | readonly string[] | undefined;

	constructor(opts: {
		table: string;
		model: ModelIR;
		adapter?: Adapter | undefined;
		schemaName?: string | undefined;
		where?: WhereIntent | undefined;
		allowAll?: boolean | undefined;
		cascade?: boolean | readonly string[] | undefined;
	}) {
		this.table = opts.table;
		this.model = opts.model;
		this.adapter = opts.adapter;
		this.schemaName = opts.schemaName;
		this.whereIntent = opts.where;
		this.allowAllFlag = opts.allowAll ?? false;
		this.cascadeRelations = opts.cascade;
	}

	/**
	 * Add WHERE condition.
	 */
	where(condition: WhereIntent): DeleteBuilder {
		return new DeleteBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			where: condition,
			allowAll: this.allowAllFlag,
			cascade: this.cascadeRelations,
		});
	}

	/**
	 * Enable cascade delete.
	 * Without arguments: deletes ALL related records.
	 * With array: deletes only specified relations.
	 */
	cascade(relations?: readonly string[]): DeleteBuilder {
		return new DeleteBuilder({
			table: this.table,
			model: this.model,
			adapter: this.adapter,
			schemaName: this.schemaName,
			where: this.whereIntent,
			allowAll: this.allowAllFlag,
			cascade: relations ?? true,
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
	 * Note: Cascade deletes are executed as multiple statements.
	 */
	async execute(): Promise<void> {
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

		await this.adapter.execute(compiled);
	}
}
