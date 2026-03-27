
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

import type {
	Adapter,
	CompiledQuery,
	CteQueryIntent,
	OrderByIntent,
	QueryIntent,
	RawCteIntent,
	SelectWithExpressionsIntent,
	WhereIntent,
} from '@dbsp/types';
import { InvalidOperationError } from './errors.js';
import { requireAdapter as requireAdapterUtil } from './builder-utils.js';
import type { QueryBuilderImpl } from './query-builder.js';
import type { QueryBuilder } from './query-builder-types.js';

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
	) {
		this.cteName = cteName;
		this.rawCteIntent = rawCteIntent;
		this.adapter = adapter;
		this.schemaName = schemaName;
	}

	/**
	 * Select specific columns from the CTE result.
	 */
	columns(cols: readonly string[]): this {
		this.outerSelect = {
			type: 'expressions',
			columns: cols.map((column) => ({ kind: 'column', column })),
		};
		return this;
	}

	/**
	 * Filter the outer query result.
	 */
	where(condition: WhereIntent): this {
		this.outerWhere = condition;
		return this;
	}

	/**
	 * Order the outer query result.
	 */
	orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): this {
		const clause: OrderByIntent = { field: column, direction };
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
		const compileOptions = this.schemaName ? { schemaName: this.schemaName } : undefined;
		const compiled: CompiledQuery = adapter.compileCteQuery(intent, compileOptions);
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
		const compileOptions = this.schemaName ? { schemaName: this.schemaName } : undefined;
		const compiled = adapter.compileCteQuery(intent, compileOptions) as CompiledQuery<TResult>;
		return adapter.execute(compiled);
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
): RawCteQueryBuilder<TResult> {
	const baseIntent = (options.base as unknown as QueryBuilderImpl<unknown>).buildIntent();
	const stepIntent = (options.step as unknown as QueryBuilderImpl<unknown>).buildIntent();

	const rawCteIntent: RawCteIntent = {
		kind: 'rawCte',
		name: cteName,
		base: baseIntent,
		step: stepIntent,
		unionAll: options.unionAll ?? true,
		...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
		...(options.depthColumn !== undefined && { depthColumn: options.depthColumn }),
	};

	return new RawCteQueryBuilder<TResult>(cteName, rawCteIntent, adapter, schemaName);
}
