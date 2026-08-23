/**
 * @fileoverview Type-safe query builder using TableRef/ColumnRef.
 *
 * This module provides a type-safe query builder that works with the
 * schema.tables TableRef objects for full type inference.
 *
 * @module typed-query-builder
 * @since DX-040
 */

import { type Adapter, type Dump, executeCompiledQuery } from '../adapter.js';
import type { QueryIntent, SelectIntent, WhereIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';
import { plan as executePlan } from '../planner.js';
import { getColumnName } from './column-utils.js';
import { InvalidOperationError } from './errors.js';
import { buildExistsIntent } from './exists-intent.js';
import {
	hasPredicateRefDiscriminator,
	isPredicateRef,
	type PredicateRef,
	predicateWhereIntent,
} from './expressions.js';
import { and } from './filters.js';
import type { DumpMetaInput } from './query-builder-types.js';
import {
	BRAND,
	type ColumnRef,
	type InferTableRow,
	TABLE_META,
	type TableRef,
} from './table-ref.js';

// ============================================================================
// Type Utilities
// ============================================================================

/**
 * Extract the table name from a TableRef.
 */
type ExtractTableName<T> =
	T extends TableRef<infer TName, any, any> ? TName : never;

/**
 * Infer the result type from picked columns.
 */
type InferPickedColumns<TCols extends readonly ColumnRef<any, any, any>[]> = {
	[K in TCols[number] as K extends ColumnRef<any, infer CName, any>
		? CName
		: never]: K extends ColumnRef<any, any, infer CType> ? CType : never;
};

/**
 * Helper to extract table name from TableRef.
 */
function getTableName(table: TableRef<any, any, any>): string {
	const name = table[TABLE_META];
	if (name === undefined) {
		throw new Error('Invalid TableRef: missing TABLE_META');
	}
	return name;
}

// ============================================================================
// FromBuilder Interface
// ============================================================================

/**
 * Builder interface for queries starting from a table.
 *
 * @typeParam TTable - The TableRef type
 * @typeParam TResult - The current result type (defaults to full row)
 */
export interface FromBuilder<
	TTable extends TableRef<any, any, any>,
	TResult = InferTableRow<TTable>,
> {
	/**
	 * Execute query and return all matching rows.
	 */
	all(): Promise<TResult[]>;

	/**
	 * Execute query and return first matching row or null.
	 */
	first(): Promise<TResult | null>;

	/**
	 * Pick specific columns to select.
	 * Returns a new builder with narrowed result type.
	 */
	pick<TCols extends ColumnRef<ExtractTableName<TTable>, any, any>[]>(
		...columns: TCols
	): FromBuilder<TTable, InferPickedColumns<TCols>>;

	/**
	 * Add a WHERE condition.
	 * Multiple where() calls are combined with AND.
	 */
	where(condition: WhereIntent | PredicateRef): FromBuilder<TTable, TResult>;

	/**
	 * Add ORDER BY clause.
	 */
	orderBy(
		column: ColumnRef<ExtractTableName<TTable>, any, any>,
		direction?: 'asc' | 'desc',
	): FromBuilder<TTable, TResult>;

	/**
	 * Limit number of results.
	 */
	limit(n: number): FromBuilder<TTable, TResult>;

	/**
	 * Skip first n results.
	 */
	offset(n: number): FromBuilder<TTable, TResult>;

	/**
	 * Check whether any matching rows exist.
	 * Compiles to SELECT EXISTS(SELECT 1 FROM ...).
	 */
	exists(): Promise<boolean>;

	/**
	 * Get the SQL dump for an existence check without executing.
	 */
	existsDump(): Dump;

	/**
	 * Get the query plan without executing.
	 */
	plan(): PlanReport;

	/**
	 * Get SQL dump without executing.
	 */
	dump(meta?: DumpMetaInput): Dump;
}

// ============================================================================
// FromBuilder Implementation
// ============================================================================

/**
 * Internal implementation of FromBuilder.
 */
class FromBuilderImpl<
	TTable extends TableRef<any, any, any>,
	TResult = InferTableRow<TTable>,
> implements FromBuilder<TTable, TResult>
{
	private tableName: string;
	private model: ModelIR;
	private adapter: Adapter<unknown> | undefined;
	private schemaName: string | undefined;

	private selectColumns: string[] | undefined;
	private whereConditions: WhereIntent[];
	private orderByItems: Array<{ field: string; direction: 'asc' | 'desc' }>;
	private limitValue: number | undefined;
	private offsetValue: number | undefined;

	constructor(
		table: TTable,
		model: ModelIR,
		adapter: Adapter<unknown> | undefined,
		schemaName: string | undefined,
	) {
		this.tableName = getTableName(table);
		this.model = model;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.whereConditions = [];
		this.orderByItems = [];
	}

	/**
	 * Create a clone with modified state.
	 * @typeParam R - Result type override (defaults to TResult). Allows callers
	 * like `pick()` to re-type the clone without an unsafe double cast.
	 */
	private clone<R = TResult>(): FromBuilderImpl<TTable, R> {
		const copy = new FromBuilderImpl<TTable, R>(
			{ [TABLE_META]: this.tableName, [BRAND]: 'TableRef' } as TTable,
			this.model,
			this.adapter,
			this.schemaName,
		);
		copy.selectColumns = this.selectColumns
			? [...this.selectColumns]
			: undefined;
		copy.whereConditions = [...this.whereConditions];
		copy.orderByItems = [...this.orderByItems];
		copy.limitValue = this.limitValue;
		copy.offsetValue = this.offsetValue;
		return copy;
	}

	pick<TCols extends ColumnRef<ExtractTableName<TTable>, any, any>[]>(
		...columns: TCols
	): FromBuilder<TTable, InferPickedColumns<TCols>> {
		const copy = this.clone<InferPickedColumns<TCols>>();
		copy.selectColumns = columns.map((col) => getColumnName(col));
		return copy;
	}

	where(condition: WhereIntent | PredicateRef): FromBuilder<TTable, TResult> {
		const copy = this.clone();
		if (isPredicateRef(condition)) {
			copy.whereConditions.push(predicateWhereIntent(condition));
			return copy;
		}
		if (hasPredicateRefDiscriminator(condition)) {
			throw new InvalidOperationError(
				'where',
				"predicate belongs to another @dbsp/core copy; reconstruct it with this copy's predicate factories",
			);
		}
		if (
			typeof condition === 'object' &&
			condition !== null &&
			'__expr' in condition &&
			condition.__expr === true
		) {
			throw new InvalidOperationError(
				'where',
				'expected a PredicateRef; use unsafeAsPredicate() to assert a deliberate boolean expression',
			);
		}
		copy.whereConditions.push(condition);
		return copy;
	}

	orderBy(
		column: ColumnRef<ExtractTableName<TTable>, any, any>,
		direction: 'asc' | 'desc' = 'asc',
	): FromBuilder<TTable, TResult> {
		const copy = this.clone();
		copy.orderByItems.push({ field: getColumnName(column), direction });
		return copy;
	}

	limit(n: number): FromBuilder<TTable, TResult> {
		const copy = this.clone();
		copy.limitValue = n;
		return copy;
	}

	offset(n: number): FromBuilder<TTable, TResult> {
		const copy = this.clone();
		copy.offsetValue = n;
		return copy;
	}

	/**
	 * Build an existence-check intent from current state.
	 * Strips orderBy (irrelevant once wrapped in EXISTS), sets existsWrap and
	 * limit: 1, and keeps every include unchanged; the compiler decides which
	 * include contributions still need to be emitted (see exists-intent.ts
	 * and shouldEmitInclude() in the pgsql compiler) (#230).
	 */
	private buildExistsIntent(): QueryIntent {
		return buildExistsIntent(this.buildIntent());
	}

	async exists(): Promise<boolean> {
		if (!this.adapter) {
			throw new Error(
				'Cannot execute query without adapter. Create ORM with an adapter to use exists().',
			);
		}

		const intent = this.buildExistsIntent();
		const planReport = executePlan(intent, this.model);
		const compiled = this.adapter.compile(planReport, {
			model: this.model,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		});
		const rows = await executeCompiledQuery(
			this.adapter,
			compiled,
			'typed exists()',
		);
		return (
			rows.length > 0 && (rows[0] as Record<string, unknown>).exists === true
		);
	}

	existsDump(): Dump {
		if (!this.adapter) {
			throw new Error(
				'Cannot dump query without adapter. Create ORM with an adapter to use existsDump().',
			);
		}

		const intent = this.buildExistsIntent();
		const planReport = executePlan(intent, this.model);
		const compiled = this.adapter.compile(planReport, {
			model: this.model,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		});
		return this.adapter.createDump(planReport, compiled);
	}

	/**
	 * Build the QueryIntent from current state.
	 */
	private buildIntent(): QueryIntent {
		// Build SELECT
		const select: SelectIntent | undefined =
			this.selectColumns && this.selectColumns.length > 0
				? { type: 'fields', fields: this.selectColumns }
				: undefined;

		// Build WHERE
		let where: WhereIntent | undefined;
		if (this.whereConditions.length === 1) {
			where = this.whereConditions[0];
		} else if (this.whereConditions.length > 1) {
			where = and(...this.whereConditions);
		}

		// Build ORDER BY
		const orderBy =
			this.orderByItems.length > 0
				? this.orderByItems.map((item) => ({
						kind: 'field' as const,
						field: item.field,
						direction: item.direction,
					}))
				: undefined;

		// Build intent object conditionally to avoid undefined properties
		// with exactOptionalPropertyTypes
		const intent: QueryIntent = {
			type: 'select',
			from: this.tableName,
			...(select !== undefined && { select }),
			...(where !== undefined && { where }),
			...(orderBy !== undefined && { orderBy }),
			...(this.limitValue !== undefined && { limit: this.limitValue }),
			...(this.offsetValue !== undefined && { offset: this.offsetValue }),
		};

		return intent;
	}

	plan(): PlanReport {
		const intent = this.buildIntent();
		return executePlan(intent, this.model);
	}

	dump(meta?: DumpMetaInput): Dump {
		if (!this.adapter) {
			throw new Error(
				'Cannot dump query without adapter. Create ORM with an adapter to use dump().',
			);
		}

		const planReport = this.plan();
		const compiled = this.adapter.compile(planReport, {
			model: this.model,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		});
		const dumpMeta: DumpMetaInput = {
			...(meta?.queryName !== undefined && { queryName: meta.queryName }),
			...(meta?.correlationId !== undefined && {
				correlationId: meta.correlationId,
			}),
		};
		return this.adapter.createDump(planReport, compiled, dumpMeta);
	}

	async all(): Promise<TResult[]> {
		if (!this.adapter) {
			throw new Error(
				'Cannot execute query without adapter. Create ORM with an adapter to use all().',
			);
		}

		const planReport = this.plan();
		const compiled = this.adapter.compile<TResult>(planReport, {
			model: this.model,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		});
		return executeCompiledQuery(this.adapter, compiled, 'typed all()');
	}

	async first(): Promise<TResult | null> {
		// Add limit 1 for efficiency
		const copy = this.clone();
		copy.limitValue = 1;
		const results = await copy.all();
		return results[0] ?? null;
	}
}

// ============================================================================
// TypedOrm Interface
// ============================================================================

/**
 * Type-safe ORM interface that uses TableRef for queries.
 */
export interface TypedOrm {
	/**
	 * Start a query from a table.
	 *
	 * @param table - TableRef from schema.tables
	 * @returns FromBuilder for chaining query operations
	 *
	 * @example
	 * ```typescript
	 * const { users } = schema.tables;
	 * const activeUsers = await orm.from(users).where(eq(users.active, true)).all();
	 * ```
	 */
	from<TTable extends TableRef<any, any, any>>(
		table: TTable,
	): FromBuilder<TTable>;
}

/**
 * Create a TypedOrm instance.
 *
 * @param model - The ModelIR for query planning
 * @param adapter - Optional adapter for query execution
 * @param schemaName - Optional schema name for multi-tenant queries
 * @returns TypedOrm instance
 */
export function createTypedOrm(
	model: ModelIR,
	adapter?: Adapter<unknown>,
	schemaName?: string,
): TypedOrm {
	return {
		from<TTable extends TableRef<any, any, any>>(
			table: TTable,
		): FromBuilder<TTable> {
			return new FromBuilderImpl(table, model, adapter, schemaName);
		},
	};
}

// ============================================================================
