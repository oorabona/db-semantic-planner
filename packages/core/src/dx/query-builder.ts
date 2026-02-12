/* biome-ignore-all lint/style/noNonNullAssertion: Builder internals use non-null assertions on validated state */
import type { Mutable } from '@dbsp/types/internal';
import type { Adapter, Dump } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type {
	AggregateIntent,
	ColumnExpressionIntent,
	ExpressionIntent,
	IncludeIntent,
	OrderByIntent,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions, PlanReport } from '../planner.js';
import { AmbiguousPlanError, plan } from '../planner.js';

import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
} from './errors.js';
import {
	and,
	type DistinctField,
	eq,
	inArray,
	isDistinctField,
} from './filters.js';
import {
	type HookErrorHandler,
	type HookStore,
	hasHooks,
	type QueryHookContext,
	type QueryResultType,
	runAfterQueryHooks,
	runBeforeQueryHooks,
	runOnErrorHooks,
	withReentrancyGuard,
} from './hooks.js';
import {
	includeOptionsToIntent,
	isRecursiveIncludeOptions,
	parseDotNotationInclude,
	type RecursiveIncludeConfig,
	validateRecursiveInclude,
} from './intent-builder.js';
import {
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
import { ResultHydrator } from './result-hydrator.js';
import type { DefaultFilters } from './schema.js';
import {
	type AggregateOptions,
	type ColumnSpec,
	type CursorPaginatedResult,
	type CursorPaginateOptions,
	type IncludeOptionsWithRecursive,
	isExpressionSpec,
	type OrderByRecord,
	type OrderBySpec,
	type PaginatedResult,
	type PaginateOptions,
	type QueryBuilder,
	type RecursiveIncludeOptions,
	type RelationHints,
	type SortDirection,
	type StreamOptions,
} from './types.js';

/**
 * Internal query builder implementation.
 */
export class QueryBuilderImpl<TResult = unknown>
	implements QueryBuilder<TResult>
{
	private readonly model: ModelIR;
	private readonly strictMode: boolean;
	private readonly from: string;
	private readonly includes: IncludeIntent[] = [];
	private readonly recursiveIncludes: RecursiveIncludeConfig[] = [];
	private readonly relationHints: RelationHints;
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly dialectCapabilities: DialectCapabilities | undefined;
	private readonly defaultFilters: DefaultFilters | undefined;
	private readonly hookStore: HookStore | undefined;
	private readonly onHookError: HookErrorHandler | undefined;
	private readonly inTransaction: boolean | undefined;
	private planOptionsOverride: PlanOptions | undefined;
	private selectIntent: SelectIntent | undefined = undefined;
	private whereIntents: WhereIntent[] = [];
	private strictModeOverride: boolean | undefined = undefined;
	private aggregates: AggregateIntent[] = [];
	private groupByFields: string[] = [];
	private orderByIntents: OrderByIntent[] = [];
	private limitValue: number | undefined = undefined;
	private offsetValue: number | undefined = undefined;
	private havingIntents: WhereIntent[] = [];
	private isDistinctQuery = false;
	private skipDefaultFilters = false;
	private lockIntent: import('@dbsp/types').LockIntent | undefined = undefined;

	constructor(
		model: ModelIR,
		strictMode: boolean,
		from: string,
		relationHints: RelationHints = {},
		adapter?: Adapter,
		schemaName?: string,
		dialectCapabilities?: DialectCapabilities,
		globalPlanOptions?: PlanOptions,
		defaultFilters?: DefaultFilters,
		hookStore?: HookStore,
		onHookError?: HookErrorHandler,
		inTransaction?: boolean,
	) {
		this.model = model;
		this.strictMode = strictMode;
		this.from = from;
		this.relationHints = relationHints;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.dialectCapabilities = dialectCapabilities;
		this.planOptionsOverride = globalPlanOptions;
		this.defaultFilters = defaultFilters;
		this.hookStore = hookStore;
		this.onHookError = onHookError;
		this.inTransaction = inTransaction;
	}

	include(
		relation: string,
		options?: IncludeOptionsWithRecursive,
	): QueryBuilder<TResult> {
		const builder = this.clone();

		// Validate recursive includes (DX-017)
		if (isRecursiveIncludeOptions(options)) {
			validateRecursiveInclude(this.model, this.from, relation, options);
			// DX-017: No longer store separately - let includeOptionsToIntent handle conversion
		}

		// Support dot notation for nested includes: 'posts.comments.author'
		if (relation.includes('.')) {
			builder.includes.push(parseDotNotationInclude(relation, options));
		} else {
			builder.includes.push(includeOptionsToIntent(relation, options));
		}
		return builder;
	}

	// Overload: typed columns (string keys only) → Pick<TResult, K>
	columns<K extends keyof TResult & string>(
		columns: readonly K[],
	): QueryBuilder<Pick<TResult, K>>;
	// Overload: mixed columns (strings + expressions) → TResult
	columns(columns: readonly ColumnSpec[]): QueryBuilder<TResult>;
	// Implementation
	columns(columns: readonly ColumnSpec[]): QueryBuilder<unknown> {
		const builder = this.clone();

		// Build columns array (direct ExpressionIntent format - NQL compatible)
		const expressionColumns: ExpressionIntent[] = [];
		let hasExpressions = false;

		for (const col of columns) {
			if (isExpressionSpec(col)) {
				hasExpressions = true;
				expressionColumns.push(col.intent);
			} else {
				// Simple field → ColumnExpressionIntent (kind: 'column')
				expressionColumns.push({ kind: 'column', column: col });
			}
		}

		// Use SelectWithExpressionsIntent if we have any expressions
		if (hasExpressions) {
			builder.selectIntent = {
				type: 'expressions',
				columns: expressionColumns,
			};
		} else {
			// Simple fields only - extract field names
			const fields = expressionColumns.map(
				(c) => (c as ColumnExpressionIntent).column,
			);
			builder.selectIntent = { type: 'fields', fields };
		}

		return builder as QueryBuilder<unknown>;
	}

	coalesce<K extends keyof TResult & string, Alias extends string>(
		fields: readonly K[],
		as: Alias,
	): QueryBuilder<TResult & { [P in Alias]: NonNullable<TResult[K]> }> {
		const builder = this.clone();

		// Create CoalesceExpressionIntent
		const coalesceIntent: ExpressionIntent = {
			kind: 'coalesce',
			fields: fields as readonly string[],
			as,
		};

		// If we already have a SelectWithExpressionsIntent, add to it
		if (builder.selectIntent?.type === 'expressions') {
			builder.selectIntent = {
				type: 'expressions',
				columns: [...builder.selectIntent.columns, coalesceIntent],
			};
		} else if (builder.selectIntent?.type === 'fields') {
			// Convert fields to expressions and add coalesce
			const fieldExpressions: ExpressionIntent[] =
				builder.selectIntent.fields.map(
					(field) => ({ kind: 'column', column: field }) as ExpressionIntent,
				);
			builder.selectIntent = {
				type: 'expressions',
				columns: [...fieldExpressions, coalesceIntent],
			};
		} else {
			// No select intent yet - start with coalesce only
			// This means SELECT * plus the coalesce column
			builder.selectIntent = {
				type: 'expressions',
				columns: [coalesceIntent],
			};
		}

		// SAFETY: coalesce() adds a computed column to the result type.
		// The runtime value is identical (same QueryBuilderImpl), only the
		// phantom TResult type parameter changes — invariant in QueryBuilder,
		// hence the double cast.
		return builder as unknown as QueryBuilder<
			TResult & { [P in Alias]: NonNullable<TResult[K]> }
		>;
	}

	count(
		fieldOrOptions?: AggregateOptions | string | DistinctField,
		as?: string,
	): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: Mutable<AggregateIntent> = { function: 'count' };

		if (fieldOrOptions === undefined) {
			// count() - COUNT(*)
		} else if (typeof fieldOrOptions === 'string') {
			// count('field', 'alias') - COUNT(field)
			agg.field = fieldOrOptions;
			if (as !== undefined) {
				agg.as = as;
			}
		} else if (isDistinctField(fieldOrOptions)) {
			// count(distinct('field'), 'alias') - COUNT(DISTINCT field)
			agg.field = fieldOrOptions.field;
			agg.distinct = true;
			if (as !== undefined) {
				agg.as = as;
			}
		} else {
			// count({ field, as }) - AggregateOptions
			if (fieldOrOptions.field !== undefined) {
				agg.field = fieldOrOptions.field;
			}
			if (fieldOrOptions.as !== undefined) {
				agg.as = fieldOrOptions.as;
			}
		}

		builder.aggregates.push(agg as AggregateIntent);
		return builder;
	}

	sum(field: string | DistinctField, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const isDistinct = isDistinctField(field);
		const fieldName = isDistinct ? field.field : field;
		const agg: Mutable<AggregateIntent> = { function: 'sum', field: fieldName };
		if (isDistinct) {
			agg.distinct = true;
		}
		if (as !== undefined) {
			agg.as = as;
		}
		builder.aggregates.push(agg as AggregateIntent);
		return builder;
	}

	avg(field: string | DistinctField, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const isDistinct = isDistinctField(field);
		const fieldName = isDistinct ? field.field : field;
		const agg: Mutable<AggregateIntent> = { function: 'avg', field: fieldName };
		if (isDistinct) {
			agg.distinct = true;
		}
		if (as !== undefined) {
			agg.as = as;
		}
		builder.aggregates.push(agg as AggregateIntent);
		return builder;
	}

	min(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: Mutable<AggregateIntent> = { function: 'min', field };
		if (as !== undefined) {
			agg.as = as;
		}
		builder.aggregates.push(agg as AggregateIntent);
		return builder;
	}

	max(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: Mutable<AggregateIntent> = { function: 'max', field };
		if (as !== undefined) {
			agg.as = as;
		}
		builder.aggregates.push(agg as AggregateIntent);
		return builder;
	}

	groupBy(fields: readonly string[]): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.groupByFields.push(...fields);
		return builder;
	}

	having(condition: WhereIntent): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.havingIntents.push(condition);
		return builder;
	}

	distinct(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.isDistinctQuery = true;
		return builder;
	}

	// --------------------------------------------------------------------------
	// Row-level locking (E15)
	// --------------------------------------------------------------------------

	forUpdate(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.lockIntent = {
			strength: 'forUpdate',
			waitPolicy: builder.lockIntent?.waitPolicy ?? 'block',
		};
		return builder;
	}

	forShare(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.lockIntent = {
			strength: 'forShare',
			waitPolicy: builder.lockIntent?.waitPolicy ?? 'block',
		};
		return builder;
	}

	forNoKeyUpdate(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.lockIntent = {
			strength: 'forNoKeyUpdate',
			waitPolicy: builder.lockIntent?.waitPolicy ?? 'block',
		};
		return builder;
	}

	forKeyShare(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.lockIntent = {
			strength: 'forKeyShare',
			waitPolicy: builder.lockIntent?.waitPolicy ?? 'block',
		};
		return builder;
	}

	lock(
		strength: import('@dbsp/types').LockStrength,
		waitPolicy?: import('@dbsp/types').LockWaitPolicy,
	): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.lockIntent = { strength, waitPolicy: waitPolicy ?? 'block' };
		return builder;
	}

	skipLocked(): QueryBuilder<TResult> {
		if (!this.lockIntent) {
			throw new Error(
				'skipLocked() requires a preceding lock method (forUpdate, forShare, etc.)',
			);
		}
		const builder = this.clone();
		builder.lockIntent = { ...this.lockIntent, waitPolicy: 'skipLocked' };
		return builder;
	}

	noWait(): QueryBuilder<TResult> {
		if (!this.lockIntent) {
			throw new Error(
				'noWait() requires a preceding lock method (forUpdate, forShare, etc.)',
			);
		}
		const builder = this.clone();
		builder.lockIntent = { ...this.lockIntent, waitPolicy: 'noWait' };
		return builder;
	}

	orderBy(
		fieldOrRecordOrSpecs: string | OrderByRecord | readonly OrderBySpec[],
		direction?: SortDirection,
	): QueryBuilder<TResult> {
		const builder = this.clone();

		// String form: orderBy('field') or orderBy('field', 'desc')
		if (typeof fieldOrRecordOrSpecs === 'string') {
			builder.orderByIntents.push({
				field: fieldOrRecordOrSpecs,
				direction: direction ?? 'asc',
			});
			return builder;
		}

		// Array form: orderBy([{ column, direction, nulls }])
		if (Array.isArray(fieldOrRecordOrSpecs)) {
			for (const spec of fieldOrRecordOrSpecs) {
				builder.orderByIntents.push({
					field: spec.column,
					direction: spec.direction ?? 'asc',
					nulls: spec.nulls,
				});
			}
			return builder;
		}

		// Object form: orderBy({ field1: 'desc', field2: 'asc' })
		for (const [field, dir] of Object.entries(fieldOrRecordOrSpecs)) {
			builder.orderByIntents.push({
				field,
				direction: dir,
			});
		}
		return builder;
	}

	limit(count: number): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.limitValue = count;
		return builder;
	}

	offset(count: number): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.offsetValue = count;
		return builder;
	}

	where(condition: WhereIntent | WhereFilter<TResult>): QueryBuilder<TResult> {
		const builder = this.clone();
		// Convert object filter to WhereIntent if needed
		const intent = isWhereIntent(condition)
			? condition
			: objectToWhereIntent(condition as WhereFilter<Record<string, unknown>>);
		builder.whereIntents.push(intent);
		return builder;
	}

	withStrictMode(strict: boolean): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.strictModeOverride = strict;
		return builder;
	}

	withRelationHint(target: string, relation: string): QueryBuilder<TResult> {
		const builder = this.clone();
		(builder.relationHints as Record<string, string>)[target] = relation;
		return builder;
	}

	withPlanOptions(options: PlanOptions): QueryBuilder<TResult> {
		const builder = this.clone();
		// Merge with existing planOptions (per-query overrides take precedence)
		builder.planOptionsOverride = {
			...builder.planOptionsOverride,
			...options,
		};
		return builder;
	}

	/**
	 * Get effective strict mode (override takes precedence over ORM-level).
	 */
	private getEffectiveStrictMode(): boolean {
		return this.strictModeOverride !== undefined
			? this.strictModeOverride
			: this.strictMode;
	}

	plan(): PlanReport {
		const intent = this.buildIntent();

		// E15: Warn when lock is used outside a transaction context
		if (intent.lock && !this.inTransaction) {
			console.warn(
				'[dbsp] Row-level lock (FOR UPDATE/SHARE) used outside a transaction. ' +
					'Locks are only effective within a transaction.',
			);
		}

		// Apply relation hints to includes before planning
		const intentWithHints = this.applyRelationHints(intent);

		// Build plan options: dialectCapabilities + per-query overrides
		const planOptions: PlanOptions = {
			...(this.dialectCapabilities && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			// planOptions (global + per-query) take highest precedence
			...this.planOptionsOverride,
		};

		try {
			return plan(intentWithHints, this.model, planOptions);
		} catch (error) {
			if (error instanceof AmbiguousPlanError) {
				return this.handleAmbiguity(error, intentWithHints, planOptions);
			}
			throw error;
		}
	}

	async all(): Promise<TResult[]> {
		const adapter = this.getConfiguredAdapter();

		// E17b: Hook-aware execution path
		if (this.hookStore && hasHooks(this.hookStore)) {
			return this.executeWithHooks(adapter, 'all');
		}

		// Fast path: no hooks — existing behavior, zero overhead
		const planReport = this.plan();

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: {
			schemaName?: string;
			model: ModelIR;
		} = { model: this.model };
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		// Use compileWithIncludes to get subquery include info for hasMany relations
		const compiledWithIncludes = adapter.compileWithIncludes(
			planReport,
			compileOptions,
		);
		const mainResults = (await adapter.execute(
			compiledWithIncludes.main,
		)) as TResult[];

		// Create hydrator for result transformation (AUD-005)
		const hydrator = new ResultHydrator<TResult>(
			this.model,
			this.from,
			this.schemaName,
		);

		// E2E-004: Hydrate json_agg includes by parsing JSON columns
		hydrator.hydrateJsonAggIncludes(mainResults, planReport);

		// E2E-004: Hydrate JOIN includes by grouping dot-prefixed columns
		hydrator.hydrateJoinIncludes(mainResults, planReport);

		// Process subquery includes (hasMany hydration - DX-033)
		if (compiledWithIncludes.subqueryIncludes.length > 0) {
			await hydrator.hydrateIncludes(
				mainResults,
				compiledWithIncludes.subqueryIncludes,
				adapter,
				compileOptions,
			);
		}

		// Process recursive includes if any
		if (this.recursiveIncludes.length > 0) {
			await hydrator.processRecursiveIncludes(
				mainResults,
				this.recursiveIncludes,
				adapter,
			);
		}

		return mainResults;
	}

	async first(): Promise<TResult | undefined> {
		// E17b: Hook-aware path — hooks see resultType='first'
		if (this.hookStore && hasHooks(this.hookStore)) {
			const adapter = this.getConfiguredAdapter();
			const rows = await this.executeWithHooks<TResult[]>(adapter, 'first');
			return rows[0];
		}
		const rows = await this.all();
		return rows[0];
	}

	async firstOrThrow(): Promise<TResult> {
		const result = await this.first();
		if (result === undefined) {
			throw new NotFoundError(this.from);
		}
		return result;
	}

	async byId(
		value: string | number | Record<string, unknown>,
	): Promise<TResult | undefined> {
		const condition = this.buildPkCondition(value);
		return this.where(condition).first();
	}

	async byIdOrThrow(
		value: string | number | Record<string, unknown>,
	): Promise<TResult> {
		const result = await this.byId(value);
		if (result === undefined) {
			throw new NotFoundError(
				this.from,
				`No record found with the specified primary key`,
			);
		}
		return result;
	}

	async byIds(values: readonly (string | number)[]): Promise<TResult[]> {
		if (values.length === 0) {
			return [];
		}
		return this.where(inArray(this.getSimplePkColumn(), [...values])).all();
	}

	/**
	 * Get the simple primary key column name for the current table.
	 * Returns the first PK column if composite, falls back to 'id' if undefined.
	 */
	private getSimplePkColumn(): string {
		const table = this.model.getTable(this.from);
		const pk = table?.primaryKey;
		if (typeof pk === 'string') {
			return pk;
		}
		if (Array.isArray(pk) && pk.length > 0) {
			return pk[0]!;
		}
		return 'id'; // fallback for legacy schemas without explicit PK
	}

	/**
	 * Build a where condition for a primary key lookup.
	 * Supports simple PKs (string | number) and composite PKs (object).
	 */
	private buildPkCondition(
		value: string | number | Record<string, unknown>,
	): WhereIntent {
		if (typeof value === 'string' || typeof value === 'number') {
			// Simple PK - use schema-defined PK column
			return eq(this.getSimplePkColumn(), value);
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

	dump(): Dump {
		const adapter = this.getConfiguredAdapter();
		const planReport = this.plan();

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: {
			schemaName?: string;
			model: ModelIR;
		} = { model: this.model };
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiled = adapter.compile(planReport, compileOptions);

		// Use adapter.createDump() to properly capture adapter's schema
		// Then merge with context schema if needed
		const dump = adapter.createDump(planReport, compiled);

		// If adapter didn't set schema but context has one, add it
		if (dump.meta?.schema === undefined && this.schemaName !== undefined) {
			return {
				...dump,
				meta: {
					...dump.meta,
					schema: this.schemaName,
				},
			};
		}

		return dump;
	}

	async exists(): Promise<boolean> {
		const adapter = this.getConfiguredAdapter();

		// E17b: Hook-aware path for exists()
		if (this.hookStore && hasHooks(this.hookStore)) {
			// INV-07: Re-entrancy guard
			return withReentrancyGuard(this.hookStore, (s) =>
				this.existsWithHooks(adapter, s),
			);
		}

		// Fast path: no hooks
		const existsIntent = this.buildExistsIntent();
		const intentWithHints = this.applyRelationHints(existsIntent);

		const planOptions: PlanOptions = {
			...(this.dialectCapabilities && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...this.planOptionsOverride,
		};

		const planReport = plan(intentWithHints, this.model, planOptions);

		const compileOptions: {
			schemaName?: string;
			model: ModelIR;
		} = { model: this.model };
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiled = adapter.compile(planReport, compileOptions);
		const rows = await adapter.execute(compiled);
		return (
			rows.length > 0 && (rows[0] as Record<string, unknown>).exists === true
		);
	}

	private async existsWithHooks(
		adapter: Adapter,
		store: HookStore,
	): Promise<boolean> {
		const startTime = Date.now();

		// Build raw intent (without defaultFilters) for hooks
		const rawIntent = this.buildIntent(false);
		const beforeCtx: QueryHookContext = {
			table: this.from,
			operation: 'select',
			intent: rawIntent,
			resultType: 'exists',
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this.inTransaction && { inTransaction: true }),
		};

		// Run beforeQuery hooks
		let intent: QueryIntent;
		try {
			const afterHookCtx = await runBeforeQueryHooks(
				store.beforeQuery,
				beforeCtx,
				this.onHookError,
			);
			intent = afterHookCtx.intent;
		} catch (error) {
			if (store.onError.length > 0) {
				throw await runOnErrorHooks(store.onError, {
					table: this.from,
					operation: 'select',
					error: error as Error,
					intent: rawIntent,
					phase: 'beforeQuery',
				});
			}
			throw error;
		}

		// Apply defaultFilters AFTER hooks (INV-01)
		intent = this.applyDefaultFiltersToIntent(intent);

		// Build exists-wrapped intent from the (potentially modified) intent
		const existsIntent = this.buildExistsIntentFromIntent(intent);
		const intentWithHints = this.applyRelationHints(existsIntent);
		const planOptions: PlanOptions = {
			...(this.dialectCapabilities && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...this.planOptionsOverride,
		};
		const planReport = plan(intentWithHints, this.model, planOptions);
		const compileOptions: { schemaName?: string; model: ModelIR } = {
			model: this.model,
		};
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}
		const compiled = adapter.compile(planReport, compileOptions);
		const rows = await adapter.execute(compiled);
		const result =
			rows.length > 0 && (rows[0] as Record<string, unknown>).exists === true;

		// afterQuery with boolean result
		const afterCtx: QueryHookContext = {
			table: this.from,
			operation: 'select',
			intent,
			resultType: 'exists',
			sql: compiled.sql,
			parameters: compiled.parameters,
			duration: Date.now() - startTime,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		};
		try {
			return await runAfterQueryHooks(
				store.afterQuery,
				afterCtx,
				result,
				this.onHookError,
			);
		} catch (error) {
			if (store.onError.length > 0) {
				throw await runOnErrorHooks(store.onError, {
					table: this.from,
					operation: 'select',
					error: error as Error,
					intent,
					phase: 'afterQuery',
					sql: compiled.sql,
				});
			}
			throw error;
		}
	}

	existsDump(): Dump {
		const adapter = this.getConfiguredAdapter();
		const existsIntent = this.buildExistsIntent();
		const intentWithHints = this.applyRelationHints(existsIntent);

		const planOptions: PlanOptions = {
			...(this.dialectCapabilities && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...this.planOptionsOverride,
		};

		const planReport = plan(intentWithHints, this.model, planOptions);

		const compileOptions: {
			schemaName?: string;
			model: ModelIR;
		} = { model: this.model };
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiled = adapter.compile(planReport, compileOptions);
		const dump = adapter.createDump(planReport, compiled);

		if (dump.meta?.schema === undefined && this.schemaName !== undefined) {
			return {
				...dump,
				meta: {
					...dump.meta,
					schema: this.schemaName,
				},
			};
		}

		return dump;
	}

	execute(): Promise<TResult[]> {
		return this.all();
	}

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

		// E17b: Fire beforeQuery hook with isStreaming=true (afterQuery does NOT fire for streams)
		const hookStore = this.hookStore;
		const onHookError = this.onHookError;
		const table = this.from;
		const schemaName = this.schemaName;
		const txFlag = this.inTransaction;
		const rawIntent = this.buildIntent(false);

		// Create a lazy wrapper that defers onStart until first next() call
		const onStartCallback = options?.onStart;
		const capturedDump = dumpResult;
		let adapterIterator: AsyncIterableIterator<TResult> | null = null;
		let onStartCalled = false;
		let hooksFired = false;

		const lazyIterator: AsyncIterableIterator<TResult> = {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next() {
				// E17b: Fire beforeQuery on first iteration (lazy)
				if (!hooksFired && hookStore && hasHooks(hookStore)) {
					hooksFired = true;
					const ctx: QueryHookContext = {
						table,
						operation: 'select',
						intent: rawIntent,
						resultType: 'all',
						isStreaming: true,
						...(schemaName !== undefined && { schemaName }),
						...(txFlag && { inTransaction: true }),
					};
					try {
						await runBeforeQueryHooks(hookStore.beforeQuery, ctx, onHookError);
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
				}
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
				return { done: true as const, value: undefined };
			},
			async throw(error?: unknown) {
				// E17b: Fire onError for stream errors
				if (
					hookStore &&
					hookStore.onError.length > 0 &&
					error instanceof Error
				) {
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

	/**
	 * Execute the query with offset-based pagination.
	 */
	async paginate(options?: PaginateOptions): Promise<PaginatedResult<TResult>> {
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
		const paginatedBuilder = this.clone();
		paginatedBuilder.limitValue = perPage;
		paginatedBuilder.offsetValue = offset;

		// Execute main query
		const data = await paginatedBuilder.all();

		// Calculate pagination metadata
		let total: number | undefined;
		let totalPages: number | undefined;

		if (withCount) {
			// Execute count query (without limit/offset) - create fresh builder
			const countBuilder = new QueryBuilderImpl<{ _count: number }>(
				this.model,
				this.strictMode,
				this.from,
				{ ...this.relationHints },
				this.adapter,
				this.schemaName,
				this.dialectCapabilities,
				this.planOptionsOverride,
				this.defaultFilters,
			);
			// Copy where conditions but not limit/offset
			countBuilder.whereIntents.push(...this.whereIntents);
			countBuilder.skipDefaultFilters = this.skipDefaultFilters;
			countBuilder.aggregates = [{ function: 'count', as: '_count' }];

			const countResult = await countBuilder.all();
			total = Number(countResult[0]?._count ?? 0);
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
	 * Execute the query with cursor-based pagination.
	 */
	async cursorPaginate(
		options?: CursorPaginateOptions,
	): Promise<CursorPaginatedResult<TResult>> {
		const limit = options?.limit ?? 20;
		const cursor = options?.cursor ?? null;
		const direction = options?.direction ?? 'forward';

		// Validate inputs
		if (limit < 1) {
			throw new InvalidOperationError('cursorPaginate', 'limit must be >= 1');
		}

		// Require orderBy for stable cursor pagination
		if (this.orderByIntents.length === 0) {
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
		const paginatedBuilder = this.clone();
		if (cursorValues) {
			const cursorConditions = this.buildCursorConditions(
				cursorValues,
				direction,
			);
			if (cursorConditions) {
				paginatedBuilder.whereIntents.push(cursorConditions);
			}
		}

		// Fetch one extra to determine if there's a next page
		paginatedBuilder.limitValue = limit + 1;

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
	 * Build cursor conditions for pagination.
	 */
	private buildCursorConditions(
		cursorValues: Record<string, unknown>,
		direction: 'forward' | 'backward',
	): WhereIntent | null {
		// For single orderBy field, simple comparison
		if (this.orderByIntents.length === 1) {
			const orderBy = this.orderByIntents[0];
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

		for (let i = 0; i < this.orderByIntents.length; i++) {
			const parts: WhereIntent[] = [];

			for (let j = 0; j <= i; j++) {
				const orderBy = this.orderByIntents[j];
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
	 * Build cursor from a row using orderBy fields.
	 */
	private buildCursor(row: Record<string, unknown>): string {
		const cursorData: Record<string, unknown> = {};

		for (const orderBy of this.orderByIntents) {
			if (!orderBy) continue;
			const field =
				typeof orderBy === 'string' ? orderBy : (orderBy.field as string);
			cursorData[field] = row[field];
		}

		return Buffer.from(JSON.stringify(cursorData), 'utf-8').toString('base64');
	}

	/**
	 * Get configured adapter, throwing if not configured.
	 * @throws {ExecutionError} If adapter is not configured
	 * @returns The configured adapter instance
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
	 * Apply relation hints to includes that don't have explicit `via`.
	 */
	private applyRelationHints(intent: QueryIntent): QueryIntent {
		if (!intent.include || Object.keys(this.relationHints).length === 0) {
			return intent;
		}

		const updatedIncludes = intent.include.map((inc) =>
			this.applyHintToInclude(inc),
		);

		return {
			...intent,
			include: updatedIncludes,
		};
	}

	/**
	 * Apply relation hint to a single include (recursively).
	 */
	private applyHintToInclude(inc: IncludeIntent): IncludeIntent {
		// If already has explicit via, don't override
		if (inc.via !== undefined) {
			// But still process nested includes
			if (inc.include && inc.include.length > 0) {
				return {
					...inc,
					include: inc.include.map((nested) => this.applyHintToInclude(nested)),
				};
			}
			return inc;
		}

		// Check if we have a hint for this target
		const hint = this.relationHints[inc.relation];
		const result: IncludeIntent = hint ? { ...inc, via: hint } : inc;

		// Process nested includes
		if (result.include && result.include.length > 0) {
			return {
				...result,
				include: result.include.map((nested) =>
					this.applyHintToInclude(nested),
				),
			};
		}

		return result;
	}

	/**
	 * Build the QueryIntent from current state.
	 * Handles exactOptionalPropertyTypes by only including defined properties.
	 */
	private buildIntent(applyDefaultFilters = true): QueryIntent {
		const intent: Mutable<QueryIntent> = {
			type: 'select',
			from: this.from,
		};

		// Handle aggregates - convert to SelectAggregateIntent
		if (this.aggregates.length > 0) {
			const aggregateSelect: Mutable<SelectAggregateIntent> = {
				type: 'aggregate',
				aggregates: [...this.aggregates],
			};
			// Add group by fields to the select for projection
			if (this.groupByFields.length > 0) {
				aggregateSelect.fields = [...this.groupByFields];
			}
			intent.select = aggregateSelect as SelectAggregateIntent;
		} else if (this.selectIntent !== undefined) {
			intent.select = this.selectIntent;
		}

		// Combine default filter (soft delete) with user-provided where conditions
		const allWhereIntents: WhereIntent[] = [];

		// Prepend default filter for this table (if configured and not skipped)
		if (applyDefaultFilters) {
			const tableDefaultFilter =
				!this.skipDefaultFilters && this.defaultFilters
					? this.defaultFilters[this.from]
					: undefined;
			if (tableDefaultFilter) {
				allWhereIntents.push(tableDefaultFilter);
			}
		}

		// Add user-provided filters
		allWhereIntents.push(...this.whereIntents);

		// Combine with AND
		if (allWhereIntents.length === 1) {
			const singleWhere = allWhereIntents[0];
			if (singleWhere !== undefined) {
				intent.where = singleWhere;
			}
		} else if (allWhereIntents.length > 1) {
			intent.where = and(...allWhereIntents);
		}

		// Combine multiple having conditions with AND (DX-034)
		if (this.havingIntents.length === 1) {
			const singleHaving = this.havingIntents[0];
			if (singleHaving !== undefined) {
				intent.having = singleHaving;
			}
		} else if (this.havingIntents.length > 1) {
			intent.having = and(...this.havingIntents);
		}

		// Add SELECT DISTINCT flag (DX-034)
		if (this.isDistinctQuery) {
			intent.distinct = true;
		}

		if (this.includes.length > 0) {
			intent.include = this.includes;
		}
		if (this.groupByFields.length > 0) {
			intent.groupBy = [...this.groupByFields];
		}
		if (this.orderByIntents.length > 0) {
			intent.orderBy = [...this.orderByIntents];
		}
		if (this.limitValue !== undefined) {
			intent.limit = this.limitValue;
		}
		if (this.offsetValue !== undefined) {
			intent.offset = this.offsetValue;
		}

		// Lock clause (E15)
		if (this.lockIntent) {
			if (this.groupByFields.length > 0) {
				throw new InvalidOperationError(
					'lock',
					'FOR UPDATE/SHARE is incompatible with GROUP BY',
				);
			}
			intent.lock = this.lockIntent;
		}

		return intent as QueryIntent;
	}

	/**
	 * Apply defaultFilters to an intent (E17b: applied AFTER hooks for INV-01).
	 * @internal
	 */
	private applyDefaultFiltersToIntent(intent: QueryIntent): QueryIntent {
		if (this.skipDefaultFilters || !this.defaultFilters) return intent;
		const tableDefaultFilter = this.defaultFilters[this.from];
		if (!tableDefaultFilter) return intent;

		const existingWhere = intent.where;
		const newWhere = existingWhere
			? and(tableDefaultFilter, existingWhere)
			: tableDefaultFilter;

		return { ...intent, where: newWhere };
	}

	/**
	 * Execute a query with hook interception (E17b).
	 * Flow: buildIntent(raw) → beforeQuery → defaultFilters → plan → execute → hydrate → afterQuery
	 * @internal
	 */
	private async executeWithHooks<R>(
		adapter: Adapter,
		resultType: QueryResultType,
	): Promise<R> {
		const store = this.hookStore;
		if (!store) throw new Error('executeWithHooks called without hookStore');
		// INV-07: Re-entrancy guard — prevent infinite loops from hooks issuing queries
		return withReentrancyGuard(store, (s) =>
			this.executeWithHooksInner<R>(adapter, resultType, s),
		);
	}

	private async executeWithHooksInner<R>(
		adapter: Adapter,
		resultType: QueryResultType,
		store: HookStore,
	): Promise<R> {
		const startTime = Date.now();

		// 1. Build intent WITHOUT defaultFilters — hooks see raw intent
		const rawIntent = this.buildIntent(false);

		// 2. Build beforeQuery context
		const beforeCtx: QueryHookContext = {
			table: this.from,
			operation: 'select',
			intent: rawIntent,
			resultType,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
			...(this.inTransaction && { inTransaction: true }),
		};

		// 3. Run beforeQuery hooks (FIFO) — may modify intent
		let intent: QueryIntent;
		try {
			const afterHookCtx = await runBeforeQueryHooks(
				store.beforeQuery,
				beforeCtx,
				this.onHookError,
			);
			intent = afterHookCtx.intent;
		} catch (error) {
			// Run onError hooks for beforeQuery failures
			if (store.onError.length > 0) {
				const finalError = await runOnErrorHooks(store.onError, {
					table: this.from,
					operation: 'select',
					error: error as Error,
					intent: rawIntent,
					phase: 'beforeQuery',
				});
				throw finalError;
			}
			throw error;
		}

		// 4. Apply defaultFilters AFTER hooks (INV-01: cannot be bypassed)
		intent = this.applyDefaultFiltersToIntent(intent);

		// 5. Apply relation hints and plan
		const intentWithHints = this.applyRelationHints(intent);
		const planOptions: PlanOptions = {
			...(this.dialectCapabilities && {
				dialectCapabilities: this.dialectCapabilities,
			}),
			...this.planOptionsOverride,
		};

		let planReport: PlanReport;
		try {
			planReport = plan(intentWithHints, this.model, planOptions);
		} catch (error) {
			if (error instanceof AmbiguousPlanError) {
				planReport = this.handleAmbiguity(error, intentWithHints, planOptions);
			} else {
				throw error;
			}
		}

		// 6. Compile and execute
		const compileOptions: { schemaName?: string; model: ModelIR } = {
			model: this.model,
		};
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiledWithIncludes = adapter.compileWithIncludes(
			planReport,
			compileOptions,
		);

		let mainResults: TResult[];
		try {
			mainResults = (await adapter.execute(
				compiledWithIncludes.main,
			)) as TResult[];
		} catch (error) {
			if (store.onError.length > 0) {
				const finalError = await runOnErrorHooks(store.onError, {
					table: this.from,
					operation: 'select',
					error: error as Error,
					intent,
					phase: 'afterQuery',
					sql: compiledWithIncludes.main.sql,
				});
				throw finalError;
			}
			throw error;
		}

		// 7. Hydrate
		const hydrator = new ResultHydrator<TResult>(
			this.model,
			this.from,
			this.schemaName,
		);
		hydrator.hydrateJsonAggIncludes(mainResults, planReport);
		hydrator.hydrateJoinIncludes(mainResults, planReport);
		if (compiledWithIncludes.subqueryIncludes.length > 0) {
			await hydrator.hydrateIncludes(
				mainResults,
				compiledWithIncludes.subqueryIncludes,
				adapter,
				compileOptions,
			);
		}
		if (this.recursiveIncludes.length > 0) {
			await hydrator.processRecursiveIncludes(
				mainResults,
				this.recursiveIncludes,
				adapter,
			);
		}

		// 8. Build afterQuery context with timing + SQL info
		const duration = Date.now() - startTime;
		const afterCtx: QueryHookContext = {
			table: this.from,
			operation: 'select',
			intent,
			resultType,
			sql: compiledWithIncludes.main.sql,
			parameters: compiledWithIncludes.main.parameters,
			duration,
			...(this.schemaName !== undefined && { schemaName: this.schemaName }),
		};

		// 9. Run afterQuery hooks (LIFO) — may transform results
		try {
			// SAFETY: R defaults to TResult[] from callers; afterQuery hooks may
			// transform the shape, hence the generic.  The double cast bridges
			// the gap between the concrete TResult[] and the generic R.
			const finalResults = await runAfterQueryHooks(
				store.afterQuery,
				afterCtx,
				mainResults as unknown as R,
				this.onHookError,
			);
			return finalResults;
		} catch (error) {
			if (store.onError.length > 0) {
				const finalError = await runOnErrorHooks(store.onError, {
					table: this.from,
					operation: 'select',
					error: error as Error,
					intent,
					phase: 'afterQuery',
					sql: compiledWithIncludes.main.sql,
				});
				throw finalError;
			}
			throw error;
		}
	}

	/**
	 * Build an existence-check intent from current state.
	 * Strips orderBy and include (irrelevant), preserves groupBy/having/offset.
	 */
	private buildExistsIntent(): QueryIntent {
		const baseIntent = this.buildIntent();
		const {
			orderBy: _orderBy,
			include: _include,
			...rest
		} = baseIntent as QueryIntent & {
			orderBy?: unknown;
			include?: unknown;
		};
		return {
			...rest,
			existsWrap: true,
			limit: 1,
		};
	}

	/**
	 * Build exists-wrapped intent from a pre-built intent (E17b: for hook-aware path).
	 * @internal
	 */
	private buildExistsIntentFromIntent(baseIntent: QueryIntent): QueryIntent {
		const {
			orderBy: _orderBy,
			include: _include,
			...rest
		} = baseIntent as QueryIntent & {
			orderBy?: unknown;
			include?: unknown;
		};
		return {
			...rest,
			existsWrap: true,
			limit: 1,
		};
	}

	/**
	 * Handle ambiguity based on strict mode setting.
	 */
	private handleAmbiguity(
		error: AmbiguousPlanError,
		intent: QueryIntent,
		basePlanOptions: PlanOptions = {},
	): PlanReport {
		if (this.getEffectiveStrictMode()) {
			// Strict mode: convert to AmbiguousRelationError and throw
			throw new AmbiguousRelationError(
				error.sourceTable,
				error.targetTable,
				error.options,
			);
		}

		// Lenient mode: use first relation and add warning
		const firstRelation = error.options[0];
		if (!firstRelation) {
			throw error; // Safety: should never happen
		}

		const disambiguateKey = `${error.sourceTable}.${error.targetTable}`;
		const planOptions: PlanOptions = {
			...basePlanOptions,
			disambiguate: {
				...basePlanOptions.disambiguate,
				[disambiguateKey]: firstRelation,
			},
		};

		// Re-plan with disambiguation
		const result = plan(intent, this.model, planOptions);

		// Add warning about automatic disambiguation
		const warning = {
			code: 'AMBIGUOUS_RELATION' as const,
			message:
				`Ambiguous relation to '${error.targetTable}' from '${error.sourceTable}' ` +
				`was automatically resolved to '${firstRelation}'. ` +
				`Available options: ${error.options.join(', ')}.`,
			suggestion: `Use { via: '${firstRelation}' } or another option to make this explicit.`,
		};

		return {
			...result,
			warnings: [...result.warnings, warning],
		};
	}

	/**
	 * Create a shallow clone of this builder.
	 */
	private clone(): QueryBuilderImpl<TResult> {
		const builder = new QueryBuilderImpl<TResult>(
			this.model,
			this.strictMode,
			this.from,
			{ ...this.relationHints },
			this.adapter,
			this.schemaName,
			this.dialectCapabilities,
			this.planOptionsOverride,
			this.defaultFilters,
			this.hookStore,
			this.onHookError,
			this.inTransaction,
		);
		// Clone array state
		builder.includes.push(...this.includes);
		builder.recursiveIncludes.push(...this.recursiveIncludes);
		builder.whereIntents.push(...this.whereIntents);
		builder.havingIntents.push(...this.havingIntents);
		builder.aggregates.push(...this.aggregates);
		builder.groupByFields.push(...this.groupByFields);
		builder.orderByIntents.push(...this.orderByIntents);
		// Clone scalar state
		builder.selectIntent = this.selectIntent;
		builder.isDistinctQuery = this.isDistinctQuery;
		builder.skipDefaultFilters = this.skipDefaultFilters;
		builder.strictModeOverride = this.strictModeOverride;
		builder.limitValue = this.limitValue;
		builder.offsetValue = this.offsetValue;
		builder.planOptionsOverride = this.planOptionsOverride
			? { ...this.planOptionsOverride }
			: undefined;
		builder.lockIntent = this.lockIntent;
		return builder;
	}

	/**
	 * Disable default filters (e.g., soft delete) for this query.
	 * Use when you need to query deleted/inactive records.
	 *
	 * @example
	 * ```typescript
	 * // Query all products including soft-deleted ones
	 * const allProducts = await orm
	 *   .select('products')
	 *   .withoutDefaultFilters()
	 *   .all();
	 * ```
	 */
	withoutDefaultFilters(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.skipDefaultFilters = true;
		return builder;
	}
}
