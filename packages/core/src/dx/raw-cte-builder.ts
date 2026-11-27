/**
 * Raw CTE builder — WITH RECURSIVE support via explicit base/step query builders (FR-8).
 *
 * Provides a fluent API for building arbitrary WITH RECURSIVE queries from
 * a base (anchor) QueryBuilder and a step (recursive) QueryBuilder.
 *
 * @example
 * ```typescript
 * const chain = orm.recursive('parent_chain', {
 *   base: orm.select('symbols').where(eq('id', rootId)),
 *   step: orm.select('parent_chain'),
 *   maxDepth: 10,
 *   unionAll: true,
 * });
 * const results = await chain.columns(['id', 'name', 'depth']).orderBy('depth').all();
 * ```
 */

import {
	type Adapter,
	type CompiledQuery,
	type CteQueryIntent,
	type ExpressionIntent,
	type ModelIR,
	NotYetSupportedError,
	type OrderByIntent,
	type QueryIntent,
	type RawCteIntent,
	type SelectWithExpressionsIntent,
	type SortDirection,
	type WhereIntent,
} from '@dbsp/types';
import { executeCompiledQuery } from '../adapter.js';
import { isBoundPayload } from '../intent-payload.js';
import {
	andWhere,
	requireAdapter as requireAdapterUtil,
} from './builder-utils.js';
import type { OrderByLeaf } from './coerce.js';
import { InvalidOperationError } from './errors.js';
import {
	columnEntry,
	orderingOf,
	type QueryBuilderImpl,
} from './query-builder.js';
import type { QueryBuilder } from './query-builder-types.js';
import type { RefDefinition } from './schema.js';
import { isSubqueryExpression } from './subquery-builder.js';
import { NON_SUBQUERY_BUILDER_BRAND } from './symbols.js';
import { type ColumnRef, isColumnRef } from './table-ref.js';
import type { ColumnSpec } from './types.js';

/**
 * Whether an outer entry reads another query at any depth: a scalar subquery,
 * an EXISTS or IN body, or any other node carrying a query body. Bound and
 * literal payloads are data and are not entered (#1095).
 */
function holdsSubquery(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(holdsSubquery);
	if (typeof node !== 'object' || node === null) return false;
	if (isSubqueryExpression(node)) return true;
	const candidate = node as {
		readonly kind?: unknown;
		readonly type?: unknown;
		readonly from?: unknown;
	};
	if (candidate.kind === 'param' || candidate.kind === 'literal') return false;
	if (candidate.type === 'select' && typeof candidate.from === 'string')
		return true;
	const record = node as Readonly<Record<string, unknown>>;
	return Object.entries(record).some(
		([key, child]) =>
			isSubqueryExpression(child) ||
			(!isBoundPayload(record, key, child) && holdsSubquery(child)),
	);
}

/**
 * Options for `orm.recursive()`.
 */
export interface RecursiveOptions {
	/** Base (anchor) query — produces the starting rows. */
	readonly base: QueryBuilder<unknown>;
	/** Recursive step query — references the CTE name as its FROM table. */
	readonly step: QueryBuilder<unknown>;
	/** Maximum recursion depth (guards against infinite loops). */
	readonly maxDepth?: number;
	/**
	 * Column name in the step query that tracks depth (used with maxDepth).
	 * When set, injects WHERE <depthColumn> < maxDepth into the step during compilation.
	 * @default 'depth'
	 */
	readonly depthColumn?: string;
	/** When true (default), use UNION ALL. When false, use UNION (deduplicates). */
	readonly unionAll?: boolean;
}

/**
 * Result of compiling a recursive CTE query.
 */
export interface RecursiveDump {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly intent: CteQueryIntent;
}

/**
 * Fluent builder for constructing and executing a WITH RECURSIVE query.
 *
 * Obtain via `orm.recursive(name, options)`.
 */
export class RawCteQueryBuilder<TResult = unknown> {
	private readonly cteName: string;
	private readonly rawCteIntent: RawCteIntent;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly model: ModelIR | undefined;

	private outerSelect: SelectWithExpressionsIntent | undefined;
	private outerWhere: WhereIntent | undefined;
	private outerOrderBy: OrderByIntent[] | undefined;
	private outerLimit: number | undefined;
	private outerOffset: number | undefined;

	constructor(
		cteName: string,
		rawCteIntent: RawCteIntent,
		adapter?: Adapter,
		schemaName?: string,
		model?: ModelIR,
	) {
		this.cteName = cteName;
		this.rawCteIntent = rawCteIntent;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.model = model;
	}

	/**
	 * Select columns from the CTE result (ADR 0011 reference leaves): a column
	 * name, an expression named with `.as(alias)`, or a schema `ref()`. A
	 * `ColumnRef`, `null` and a subquery (#1095) are refused.
	 */
	columns(
		cols: readonly (
			| ColumnSpec
			| ColumnRef<string, string, unknown>
			| RefDefinition
		)[],
	): this {
		this.outerSelect = {
			type: 'expressions',
			columns: cols.map((column) => this.outerColumn(column)),
		};
		return this;
	}

	/**
	 * One outer `columns()` entry, under `QueryBuilder.columns`'s leaf rule
	 * (ADR 0011). A `ColumnRef` names a model table, never the CTE, and a
	 * subquery would read without the ORM's default filters (#1095).
	 */
	private outerColumn(column: unknown): ExpressionIntent {
		this.refuseColumnRef(column, 'columns');
		const intent = columnEntry(column, this.cteName);
		if (holdsSubquery(intent))
			throw new NotYetSupportedError('a subquery', 'raw CTE column', 1095);
		return intent;
	}

	private refuseColumnRef(leaf: unknown, helper: string): void {
		if (typeof leaf === 'object' && leaf !== null && isColumnRef(leaf))
			throw new InvalidOperationError(
				helper,
				`a ColumnRef names a model table; the recursive query reads only '${this.cteName}', so use a column name or an expression`,
			);
	}

	/**
	 * Filter the outer query result. Successive calls are combined with AND.
	 */
	where(condition: WhereIntent): this {
		this.outerWhere = andWhere(this.outerWhere, condition);
		return this;
	}

	/**
	 * Order the outer query result by a column name, an expression or an
	 * output-column position. A `ColumnRef`, `null` and a subquery (#1095) are
	 * refused.
	 */
	orderBy(column: OrderByLeaf, direction: SortDirection = 'asc'): this {
		this.refuseColumnRef(column, 'orderBy');
		const clause: OrderByIntent = orderingOf(column, direction, undefined);
		if ('expression' in clause && holdsSubquery(clause.expression))
			throw new NotYetSupportedError('a subquery', 'raw CTE ordering', 1095);
		this.outerOrderBy = [...(this.outerOrderBy ?? []), clause];
		return this;
	}

	/**
	 * Limit the number of rows returned.
	 */
	limit(n: number): this {
		this.outerLimit = n;
		return this;
	}

	/**
	 * Skip the first N rows.
	 */
	offset(n: number): this {
		this.outerOffset = n;
		return this;
	}

	/**
	 * Build the CteQueryIntent AST.
	 */
	buildIntent(): CteQueryIntent {
		const outerIntent: QueryIntent = {
			type: 'select',
			from: this.cteName,
			...(this.outerSelect !== undefined && { select: this.outerSelect }),
			...(this.outerWhere !== undefined && { where: this.outerWhere }),
			...(this.outerOrderBy !== undefined && { orderBy: this.outerOrderBy }),
			...(this.outerLimit !== undefined && { limit: this.outerLimit }),
			...(this.outerOffset !== undefined && { offset: this.outerOffset }),
		};

		return {
			kind: 'cteQuery',
			ctes: [this.rawCteIntent],
			query: outerIntent,
		};
	}

	private requireAdapter(): Adapter {
		return requireAdapterUtil(this.adapter, 'recursive');
	}

	/**
	 * Compile to SQL and return an observability dump.
	 */
	dump(): RecursiveDump {
		const adapter = this.requireAdapter();
		const intent = this.buildIntent();
		const compileOptions =
			this.schemaName !== undefined || this.model !== undefined
				? {
						...(this.schemaName !== undefined && {
							schemaName: this.schemaName,
						}),
						...(this.model !== undefined && { model: this.model }),
					}
				: undefined;
		const compiled: CompiledQuery = adapter.compileCteQuery(
			intent,
			compileOptions,
		);
		return {
			sql: compiled.sql,
			params: compiled.parameters,
			intent,
		};
	}

	/**
	 * Execute the recursive CTE query and return all matching rows.
	 */
	async all(): Promise<TResult[]> {
		const adapter = this.requireAdapter();
		const intent = this.buildIntent();
		const compileOptions =
			this.schemaName !== undefined || this.model !== undefined
				? {
						...(this.schemaName !== undefined && {
							schemaName: this.schemaName,
						}),
						...(this.model !== undefined && { model: this.model }),
					}
				: undefined;
		const compiled = adapter.compileCteQuery<TResult>(intent, compileOptions);
		return executeCompiledQuery(adapter, compiled, 'recursive().all()');
	}

	/**
	 * Alias for `all()`.
	 */
	execute(): Promise<TResult[]> {
		return this.all();
	}
}

/**
 * Create a RawCteQueryBuilder from named builder instances.
 */
export function createRawCteBuilder<TResult = unknown>(
	cteName: string,
	options: RecursiveOptions,
	adapter?: Adapter,
	schemaName?: string,
	model?: ModelIR,
): RawCteQueryBuilder<TResult> {
	const baseIntent = (
		options.base as unknown as QueryBuilderImpl<unknown>
	).buildRelationalReadIntent('raw CTE');
	const stepIntent = (
		options.step as unknown as QueryBuilderImpl<unknown>
	).buildRelationalReadIntent('raw CTE');

	const rawCteIntent: RawCteIntent = {
		kind: 'rawCte',
		name: cteName,
		base: baseIntent,
		step: stepIntent,
		unionAll: options.unionAll ?? true,
		...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
		...(options.depthColumn !== undefined && {
			depthColumn: options.depthColumn,
		}),
	};

	return new RawCteQueryBuilder<TResult>(
		cteName,
		rawCteIntent,
		adapter,
		schemaName,
		model,
	);
}

// ADR 0011: refused by name as a scalar leaf or a subquery, never planned as a
// body nor bound as a parameter (coerce.ts, toSubqueryExpression).
Object.defineProperty(
	RawCteQueryBuilder.prototype,
	NON_SUBQUERY_BUILDER_BRAND,
	{ value: true },
);
