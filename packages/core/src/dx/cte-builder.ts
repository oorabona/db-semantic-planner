/**
 * CTE builder with unnest() support (BATCH-001 Block 5).
 *
 * Provides a fluent API for building CTE queries backed by unnest() arrays,
 * optionally with WITH ORDINALITY for 0-based indexing.
 *
 * @example
 * ```typescript
 * const result = orm.withCte('lookups')
 *   .fromUnnest({ parent_file_id: [1, 2, 3], parent_name: ['Foo', 'Bar', 'Baz'] })
 *   .withIndex('idx')
 *   .query(orm.select('symbols'))
 *   .dump();
 * ```
 */

import type {
	Adapter,
	CompiledQuery,
	CteQueryIntent,
	ModelIR,
	UnnestCteIntent,
} from '@dbsp/types';
import { requireAdapter as requireAdapterUtil } from './builder-utils.js';
import { InvalidOperationError } from './errors.js';
import type { QueryBuilderImpl } from './query-builder.js';
import type { QueryBuilder } from './query-builder-types.js';

// ============================================================================
// CteBuilder
// ============================================================================

/**
 * Fluent builder for constructing a CTE definition backed by unnest() arrays.
 *
 * Obtain via `orm.withCte(name)`.
 */
export class CteBuilder {
	private readonly cteName: string;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly model: ModelIR | undefined;
	private unnestColumns: Record<string, readonly unknown[]> | undefined;
	private indexColumnName: string | undefined;

	constructor(
		name: string,
		adapter?: Adapter,
		schemaName?: string,
		model?: ModelIR,
	) {
		this.cteName = name;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.model = model;
	}

	/**
	 * Provide the column arrays for the unnest() CTE.
	 * All arrays must have the same length.
	 *
	 * @param columns - A record of column name → array of values.
	 */
	fromUnnest(columns: Record<string, readonly unknown[]>): this {
		const lengths = Object.values(columns).map((arr) => arr.length);
		if (lengths.length > 1 && !lengths.every((l) => l === lengths[0])) {
			throw new InvalidOperationError(
				'withCte',
				`Array length mismatch in CTE unnest columns: lengths are [${lengths.join(', ')}]`,
			);
		}
		this.unnestColumns = columns;
		return this;
	}

	/**
	 * Add a 0-based ordinality index column (uses WITH ORDINALITY).
	 *
	 * @param columnName - The name of the index column in the CTE.
	 */
	withIndex(columnName: string): this {
		this.indexColumnName = columnName;
		return this;
	}

	/**
	 * Attach an outer query and produce a CteQueryBuilder for execution.
	 *
	 * @param selectBuilder - A QueryBuilder (from orm.select(...))
	 */
	query<TResult = unknown>(
		selectBuilder: QueryBuilder<TResult>,
	): CteQueryBuilder<TResult> {
		if (!this.unnestColumns) {
			throw new InvalidOperationError(
				'withCte',
				'CTE requires a data source — call .fromUnnest() first',
			);
		}

		const cteIntent: UnnestCteIntent = {
			kind: 'unnestCte',
			name: this.cteName,
			columns: this.unnestColumns,
			...(this.indexColumnName !== undefined && {
				indexColumn: this.indexColumnName,
			}),
		};

		return new CteQueryBuilder<TResult>(
			cteIntent,
			selectBuilder as QueryBuilderImpl<TResult>,
			this.adapter,
			this.schemaName,
			this.model,
		);
	}
}

// ============================================================================
// CteQueryBuilder
// ============================================================================

/**
 * Result of compiling a CTE query.
 */
export interface CteDump {
	readonly sql: string;
	readonly params: readonly unknown[];
	readonly intent: CteQueryIntent;
}

/**
 * Fluent builder for executing a WITH ... SELECT query.
 *
 * Produced by `CteBuilder.query()`.
 */
export class CteQueryBuilder<TResult = unknown> {
	private readonly cteIntent: UnnestCteIntent;
	private readonly outerBuilder: QueryBuilderImpl<TResult>;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly model: ModelIR | undefined;

	constructor(
		cteIntent: UnnestCteIntent,
		outerBuilder: QueryBuilderImpl<TResult>,
		adapter?: Adapter,
		schemaName?: string,
		model?: ModelIR,
	) {
		this.cteIntent = cteIntent;
		this.outerBuilder = outerBuilder;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.model = model;
	}

	/**
	 * Build the CteQueryIntent AST.
	 */
	buildIntent(): CteQueryIntent {
		const queryIntent = this.outerBuilder.buildIntent();
		return {
			kind: 'cteQuery',
			ctes: [this.cteIntent],
			query: queryIntent,
		};
	}

	private requireAdapter(): Adapter {
		return requireAdapterUtil(this.adapter, 'withCte');
	}

	private compileOptions():
		| { readonly schemaName?: string; readonly model?: ModelIR }
		| undefined {
		if (this.schemaName === undefined && this.model === undefined) {
			return undefined;
		}
		return {
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this.model !== undefined && { model: this.model }),
		};
	}

	/**
	 * Compile to SQL and return an observability dump.
	 */
	dump(): CteDump {
		const adapter = this.requireAdapter();
		const intent = this.buildIntent();
		const compileOptions = this.compileOptions();

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
	 * Execute the CTE query and return all results.
	 */
	async all(): Promise<TResult[]> {
		const adapter = this.requireAdapter();
		const intent = this.buildIntent();
		const compileOptions = this.compileOptions();

		const compiled = adapter.compileCteQuery<TResult>(intent, compileOptions);

		return adapter.execute(compiled);
	}

	/**
	 * Alias for all().
	 */
	execute(): Promise<TResult[]> {
		return this.all();
	}
}
