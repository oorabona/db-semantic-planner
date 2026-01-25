/**
 * QueryExecutor - Handles query execution via adapter.
 *
 * DX-103: Extracted from QueryBuilderImpl to separate execution logic
 * from intent building and result hydration.
 *
 * @module query-executor
 */

import type { Adapter, Dump } from '../adapter.js';
import type { OrderByIntent, WhereIntent } from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanReport } from '../planner.js';

import {
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
} from './errors.js';
import { and, eq, inArray } from './filters.js';
import type { RecursiveIncludeConfig } from './intent-builder.js';
import type { HydrateOptions } from './result-hydrator.js';
import { ResultHydrator } from './result-hydrator.js';
import type {
	CursorPaginatedResult,
	CursorPaginateOptions,
	PaginatedResult,
	PaginateOptions,
	StreamOptions,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Execution context passed from QueryBuilder.
 */
export interface ExecutionContext<TResult = unknown> {
	/** The ModelIR for planning */
	model: ModelIR;
	/** Source table name */
	from: string;
	/** Optional schema name for schema-scoped queries */
	schemaName?: string;
	/** OrderBy intents for cursor pagination */
	orderByIntents: readonly OrderByIntent[];
	/** Recursive includes to process */
	recursiveIncludes: readonly RecursiveIncludeConfig[];
	/** Function to plan the query */
	plan: () => PlanReport;
	/** Function to clone the builder (returns new context) */
	clone: () => ExecutionContext<TResult>;
	/** Add a where condition */
	addWhere: (condition: WhereIntent) => void;
	/** Set limit */
	setLimit: (count: number) => void;
	/** Set offset */
	setOffset: (count: number) => void;
	/** Get count via aggregation */
	getCount: () => Promise<number>;
}

// ============================================================================
// QueryExecutor
// ============================================================================

/**
 * Handles query execution including:
 * - all(), first(), byId() etc.
 * - stream() for streaming results
 * - paginate() and cursorPaginate() for pagination
 * - dump() for observability
 *
 * @typeParam TResult - The expected result type
 */
export class QueryExecutor<TResult = unknown> {
	private readonly adapter: Adapter;
	private readonly hydrator: ResultHydrator<TResult>;
	private readonly ctx: ExecutionContext<TResult>;

	constructor(adapter: Adapter, ctx: ExecutionContext<TResult>) {
		this.adapter = adapter;
		this.ctx = ctx;
		this.hydrator = new ResultHydrator<TResult>(
			ctx.model,
			ctx.from,
			ctx.schemaName,
		);
	}

	/**
	 * Ensure adapter is configured.
	 */
	private getConfiguredAdapter(): Adapter {
		if (!this.adapter) {
			throw new ExecutionError({
				operation: 'query execution',
				reason: 'Adapter not configured',
				fix: 'Pass an adapter to createOrm({ adapter: yourAdapter })',
			});
		}
		return this.adapter;
	}

	/**
	 * Build compile options.
	 */
	private buildCompileOptions(): HydrateOptions {
		return {
			model: this.ctx.model,
			...(this.ctx.schemaName !== undefined && {
				schemaName: this.ctx.schemaName,
			}),
		};
	}

	/**
	 * Execute query and return all results.
	 */
	async all(): Promise<TResult[]> {
		const adapter = this.getConfiguredAdapter();
		const planReport = this.ctx.plan();
		const compileOptions = this.buildCompileOptions();

		// Use compileWithIncludes to get separate include info for hasMany relations
		const compiledWithIncludes = adapter.compileWithIncludes(
			planReport,
			compileOptions,
		);
		const mainResults = (await adapter.execute(
			compiledWithIncludes.main,
		)) as TResult[];

		// Hydrate json_agg includes (E2E-004: parse JSON columns from json_agg strategy)
		this.hydrateJsonAggIncludes(mainResults, planReport);

		// Process separate includes (hasMany hydration - DX-033)
		if (compiledWithIncludes.separateIncludes.length > 0) {
			await this.hydrator.hydrateIncludes(
				mainResults,
				compiledWithIncludes.separateIncludes,
				adapter,
				compileOptions,
			);
		}

		// Process recursive includes if any
		if (this.ctx.recursiveIncludes.length > 0) {
			await this.hydrator.processRecursiveIncludes(
				mainResults,
				this.ctx.recursiveIncludes,
				adapter,
			);
		}

		return mainResults;
	}

	/**
	 * Hydrate json_agg includes by parsing JSON columns and renaming them.
	 * E2E-004: json_agg strategy returns data as JSON string in *_json columns.
	 */
	private hydrateJsonAggIncludes(
		results: TResult[],
		planReport: PlanReport,
	): void {
		// Find all json_agg include decisions
		const jsonAggDecisions = planReport.decisions.filter(
			(d) => d.type === 'include-strategy' && d.choice === 'json_agg',
		);

		if (jsonAggDecisions.length === 0) {
			return;
		}

		// Build map of relation name -> relation type
		// STRAT-SIMPLIFY: Track to-one relations for [0] extraction
		const relationInfo = new Map<string, { isToOne: boolean }>();
		for (const decision of jsonAggDecisions) {
			const relationName = decision.context?.relation;
			const relationType = decision.context?.relationType;
			if (typeof relationName === 'string') {
				// belongsTo and hasOne are to-one relations
				const isToOne =
					relationType === 'belongsTo' || relationType === 'hasOne';
				relationInfo.set(relationName, { isToOne });
			}
		}

		if (relationInfo.size === 0) {
			return;
		}

		// Process each result row
		for (const row of results) {
			if (typeof row !== 'object' || row === null) {
				continue;
			}

			const record = row as Record<string, unknown>;

			for (const [relationName, info] of relationInfo) {
				const jsonColumnName = `${relationName}_json`;

				// Check if the JSON column exists
				if (jsonColumnName in record) {
					const jsonValue = record[jsonColumnName];

					// Parse JSON if it's a string
					let parsed: unknown;
					if (typeof jsonValue === 'string') {
						try {
							parsed = JSON.parse(jsonValue);
						} catch {
							// If parsing fails, use empty array or null depending on relation type
							parsed = info.isToOne ? null : [];
						}
					} else if (Array.isArray(jsonValue)) {
						// Already an array (some drivers auto-parse)
						parsed = jsonValue;
					} else if (jsonValue === null || jsonValue === undefined) {
						parsed = info.isToOne ? null : [];
					} else {
						// Unknown format, use as-is
						parsed = jsonValue;
					}

					// STRAT-SIMPLIFY: For to-one relations, unwrap array to single object
					if (info.isToOne && Array.isArray(parsed)) {
						// Return first element or null if empty
						parsed = parsed.length > 0 ? parsed[0] : null;
					}

					// Set the relation property and remove the JSON column
					record[relationName] = parsed;
					delete record[jsonColumnName];
				}
			}
		}
	}

	/**
	 * Execute and return the first result.
	 */
	async first(): Promise<TResult | undefined> {
		const rows = await this.all();
		return rows[0];
	}

	/**
	 * Execute and return the first result, or throw if not found.
	 */
	async firstOrThrow(): Promise<TResult> {
		const result = await this.first();
		if (result === undefined) {
			throw new NotFoundError(this.ctx.from);
		}
		return result;
	}

	/**
	 * Find by primary key.
	 */
	async byId(
		value: string | number | Record<string, unknown>,
		addConditionAndExecute: (
			condition: WhereIntent,
		) => Promise<TResult | undefined>,
	): Promise<TResult | undefined> {
		const condition = this.buildPkCondition(value);
		return addConditionAndExecute(condition);
	}

	/**
	 * Find by primary key or throw.
	 */
	async byIdOrThrow(
		value: string | number | Record<string, unknown>,
		addConditionAndExecute: (
			condition: WhereIntent,
		) => Promise<TResult | undefined>,
	): Promise<TResult> {
		const result = await this.byId(value, addConditionAndExecute);
		if (result === undefined) {
			throw new NotFoundError(
				this.ctx.from,
				`No record found with the specified primary key`,
			);
		}
		return result;
	}

	/**
	 * Find by multiple IDs.
	 */
	async byIds(
		values: readonly (string | number)[],
		addConditionAndExecuteAll: (condition: WhereIntent) => Promise<TResult[]>,
	): Promise<TResult[]> {
		if (values.length === 0) {
			return [];
		}
		const condition = inArray('id', [...values]);
		return addConditionAndExecuteAll(condition);
	}

	/**
	 * Alias for all().
	 */
	execute(): Promise<TResult[]> {
		return this.all();
	}

	/**
	 * Stream results.
	 */
	stream(options?: StreamOptions): AsyncIterableIterator<TResult> {
		const adapter = this.getConfiguredAdapter();
		const dumpResult = this.dump();

		// Prepare compiled query for adapter
		const compiled = {
			sql: dumpResult.sql,
			parameters: dumpResult.params as readonly unknown[],
		};
		// Only pass chunkSize to adapter, onStart is handled in wrapper
		const adapterOptions =
			options?.chunkSize !== undefined
				? { chunkSize: options.chunkSize }
				: undefined;

		// Create a lazy wrapper that defers onStart until first next() call
		const onStartCallback = options?.onStart;
		const capturedDump = dumpResult;
		let adapterIterator: AsyncIterableIterator<TResult> | null = null;
		let onStartCalled = false;

		const lazyIterator: AsyncIterableIterator<TResult> = {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next() {
				// Initialize adapter iterator lazily on first next() call
				if (!adapterIterator) {
					adapterIterator = adapter.stream<TResult>(compiled, adapterOptions);
				}
				// Call onStart only once, on first next() call
				if (!onStartCalled && onStartCallback) {
					onStartCalled = true;
					onStartCallback(capturedDump);
				}
				return adapterIterator.next();
			},
			async return(value?: TResult) {
				if (adapterIterator?.return) {
					return adapterIterator.return(value);
				}
				return { done: true, value: undefined as unknown as TResult };
			},
			async throw(error?: unknown) {
				if (adapterIterator?.throw) {
					return adapterIterator.throw(error);
				}
				throw error;
			},
		};

		return lazyIterator;
	}

	/**
	 * Offset-based pagination.
	 */
	async paginate(
		options: PaginateOptions | undefined,
		cloneBuilder: () => {
			setLimit: (n: number) => void;
			setOffset: (n: number) => void;
			all: () => Promise<TResult[]>;
		},
		getCount: () => Promise<number>,
	): Promise<PaginatedResult<TResult>> {
		const page = options?.page ?? 1;
		const perPage = options?.perPage ?? 20;
		const withCount = options?.withCount ?? true;

		// Validate inputs
		if (page < 1) {
			throw new InvalidOperationError(
				'paginate',
				'Page must be >= 1. Use page: 1 for the first page',
			);
		}
		if (perPage < 1) {
			throw new InvalidOperationError('paginate', 'perPage must be >= 1');
		}

		// Calculate offset
		const offset = (page - 1) * perPage;

		// Build paginated query
		const paginatedBuilder = cloneBuilder();
		paginatedBuilder.setLimit(perPage);
		paginatedBuilder.setOffset(offset);

		// Execute main query
		const data = await paginatedBuilder.all();

		// Calculate pagination metadata
		let total: number | undefined;
		let totalPages: number | undefined;

		if (withCount) {
			total = await getCount();
			totalPages = Math.ceil(total / perPage);
		}

		// Determine hasNextPage/hasPrevPage
		const hasNextPage = withCount
			? page < (totalPages ?? 1)
			: data.length === perPage; // Optimistic: assume more if full page
		const hasPrevPage = page > 1;

		return {
			data,
			pagination: {
				page,
				perPage,
				...(total !== undefined && { total }),
				...(totalPages !== undefined && { totalPages }),
				hasNextPage,
				hasPrevPage,
			},
		};
	}

	/**
	 * Cursor-based pagination.
	 */
	async cursorPaginate(
		options: CursorPaginateOptions | undefined,
		cloneBuilder: () => {
			setLimit: (n: number) => void;
			addWhere: (condition: WhereIntent) => void;
			all: () => Promise<TResult[]>;
		},
	): Promise<CursorPaginatedResult<TResult>> {
		const limit = options?.limit ?? 20;
		const cursor = options?.cursor ?? null;
		const direction = options?.direction ?? 'forward';

		// Validate inputs
		if (limit < 1) {
			throw new InvalidOperationError('cursorPaginate', 'limit must be >= 1');
		}

		// Require orderBy for stable cursor pagination
		if (this.ctx.orderByIntents.length === 0) {
			throw new InvalidOperationError(
				'cursorPaginate',
				'Cursor pagination requires an orderBy clause. Add .orderBy("id") or similar before .cursorPaginate()',
			);
		}

		// Decode cursor if provided
		let cursorValues: Record<string, unknown> | null = null;
		if (cursor) {
			try {
				cursorValues = JSON.parse(
					Buffer.from(cursor, 'base64').toString('utf-8'),
				);
			} catch {
				throw new InvalidOperationError(
					'cursorPaginate',
					'Invalid cursor format. Use a cursor returned from a previous cursorPaginate() call',
				);
			}
		}

		// Build cursor conditions based on orderBy fields
		const paginatedBuilder = cloneBuilder();
		if (cursorValues) {
			const cursorConditions = this.buildCursorConditions(
				cursorValues,
				direction,
			);
			if (cursorConditions) {
				paginatedBuilder.addWhere(cursorConditions);
			}
		}

		// Fetch one extra to determine if there's a next page
		paginatedBuilder.setLimit(limit + 1);

		// Execute query
		const results = await paginatedBuilder.all();

		// Determine if there are more items
		const hasMore = results.length > limit;
		const data = hasMore ? results.slice(0, limit) : results;

		// Build cursors
		const nextCursor =
			hasMore && data.length > 0
				? this.buildCursor(data[data.length - 1] as Record<string, unknown>)
				: null;
		const prevCursor =
			data.length > 0
				? this.buildCursor(data[0] as Record<string, unknown>)
				: null;

		return {
			data,
			nextCursor: direction === 'forward' ? nextCursor : prevCursor,
			prevCursor:
				direction === 'forward' ? (cursor ? prevCursor : null) : nextCursor,
			hasNextPage: direction === 'forward' ? hasMore : cursor !== null,
			hasPrevPage: direction === 'forward' ? cursor !== null : hasMore,
		};
	}

	/**
	 * Get query plan and SQL for observability.
	 */
	dump(): Dump {
		const adapter = this.getConfiguredAdapter();
		const planReport = this.ctx.plan();
		const compileOptions = this.buildCompileOptions();

		const compiled = adapter.compile(planReport, compileOptions);

		// Use adapter.createDump() to properly capture adapter's schema
		// Then merge with context schema if needed
		const dump = adapter.createDump(planReport, compiled);

		// If adapter didn't set schema but context has one, add it
		if (dump.meta?.schema === undefined && this.ctx.schemaName !== undefined) {
			return {
				...dump,
				meta: {
					...dump.meta,
					schema: this.ctx.schemaName,
				},
			};
		}

		return dump;
	}

	/**
	 * Build primary key condition.
	 */
	private buildPkCondition(
		value: string | number | Record<string, unknown>,
	): WhereIntent {
		if (typeof value === 'string' || typeof value === 'number') {
			// Simple PK
			return eq('id', value);
		}
		// Composite PK - build AND condition
		const entries = Object.entries(value);
		if (entries.length === 0) {
			throw new Error('Composite primary key cannot be empty');
		}
		if (entries.length === 1) {
			const entry = entries[0];
			if (!entry) {
				throw new Error('Composite primary key entry missing');
			}
			const [field, fieldValue] = entry;
			return eq(field, fieldValue);
		}
		const conditions = entries.map(([field, fieldValue]) =>
			eq(field, fieldValue),
		);
		return and(...conditions);
	}

	/**
	 * Build cursor conditions for cursor pagination.
	 */
	private buildCursorConditions(
		cursorValues: Record<string, unknown>,
		direction: 'forward' | 'backward',
	): WhereIntent | null {
		// For single orderBy field, simple comparison
		if (this.ctx.orderByIntents.length === 1) {
			const orderBy = this.ctx.orderByIntents[0];
			if (!orderBy) return null;

			const field =
				typeof orderBy === 'string' ? orderBy : (orderBy.field as string);
			const sortDir =
				typeof orderBy === 'string'
					? 'asc'
					: ((orderBy.direction as string) ?? 'asc');
			const cursorValue = cursorValues[field];

			if (cursorValue === undefined) {
				return null;
			}

			// Determine comparison based on sort direction and pagination direction
			const isAsc =
				sortDir === 'asc' ? direction === 'forward' : direction === 'backward';
			return {
				kind: 'comparison',
				field,
				operator: isAsc ? 'gt' : 'lt',
				value: cursorValue,
			};
		}

		// For multiple orderBy fields, build compound condition
		// (a > v1) OR (a = v1 AND b > v2) OR (a = v1 AND b = v2 AND c > v3)
		const conditions: WhereIntent[] = [];

		for (let i = 0; i < this.ctx.orderByIntents.length; i++) {
			const parts: WhereIntent[] = [];

			for (let j = 0; j <= i; j++) {
				const orderBy = this.ctx.orderByIntents[j];
				if (!orderBy) continue;

				const field =
					typeof orderBy === 'string' ? orderBy : (orderBy.field as string);
				const sortDir =
					typeof orderBy === 'string'
						? 'asc'
						: ((orderBy.direction as string) ?? 'asc');
				const cursorValue = cursorValues[field];

				if (cursorValue === undefined) {
					return null;
				}

				if (j < i) {
					// Equality for all but the last field in this condition
					parts.push({
						kind: 'comparison',
						field,
						operator: 'eq',
						value: cursorValue,
					});
				} else {
					// Comparison for the last field
					const isAsc =
						sortDir === 'asc'
							? direction === 'forward'
							: direction === 'backward';
					parts.push({
						kind: 'comparison',
						field,
						operator: isAsc ? 'gt' : 'lt',
						value: cursorValue,
					});
				}
			}

			if (parts.length > 0) {
				conditions.push(
					// biome-ignore lint/style/noNonNullAssertion: length check guarantees first element
					parts.length === 1 ? parts[0]! : { kind: 'and', conditions: parts },
				);
			}
		}

		if (conditions.length === 0) {
			return null;
		}

		// Safe: length check guarantees first element exists
		const firstCondition = conditions[0];
		return conditions.length === 1 && firstCondition !== undefined
			? firstCondition
			: { kind: 'or', conditions };
	}

	/**
	 * Build cursor from a result row.
	 */
	private buildCursor(row: Record<string, unknown>): string {
		const cursorData: Record<string, unknown> = {};

		for (const orderBy of this.ctx.orderByIntents) {
			if (!orderBy) continue;
			const field =
				typeof orderBy === 'string' ? orderBy : (orderBy.field as string);
			cursorData[field] = row[field];
		}

		return Buffer.from(JSON.stringify(cursorData), 'utf-8').toString('base64');
	}
}
