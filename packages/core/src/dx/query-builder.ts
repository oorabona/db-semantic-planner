/* biome-ignore-all lint/style/noNonNullAssertion: Builder internals use non-null assertions on validated state */
import type { Mutable } from '@dbsp/types/internal';
import type { Adapter, Dump } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type {
	AggregateIntent,
	ColumnExpressionIntent,
	ExpressionIntent,
	IncludeIntent,
	JoinIntent,
	OrderByIntent,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { ModelIR } from '../model-ir.js';
import type { PlanOptions, PlanReport } from '../planner.js';
import { AmbiguousPlanError, plan } from '../planner.js';
import type { BatchValuesRef } from './batch-values.js';
import { isBatchValuesRef } from './batch-values.js';
import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
	validateIdentifier,
} from './errors.js';
import { ExpressionRef } from './expressions.js';
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
import * as paginationImpl from './pagination-impl.js';
import type { QueryBuilderContext } from './query-builder-context.js';
import type { DumpMetaInput } from './query-builder-types.js';
import { ResultHydrator } from './result-hydrator.js';
import type { DefaultFilters } from './schema.js';
import {
	buildSetOperationIntent,
	type QueryIntentSource,
	type SetOperationBuilder,
	SetOperationBuilderImpl,
} from './set-operation-builder.js';
import * as streamImpl from './stream-impl.js';
import {
	type AggregateOptions,
	type AliasedExprColumn,
	type ColumnSpec,
	type CursorPaginatedResult,
	type CursorPaginateOptions,
	type ExpressionSpec,
	type IncludeOptionsWithRecursive,
	isExpressionSpec,
	type OrderByRecord,
	type OrderBySpec,
	type PaginatedResult,
	type PaginateOptions,
	type QueryBuilder,
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
	private readonly ctx: QueryBuilderContext;
	/** @internal — read by pagination-impl and stream-impl */
	readonly model: ModelIR;
	private readonly strictMode: boolean;
	/** @internal — read by stream-impl */
	readonly from: string;
	/** @internal — mutated by pagination-impl on clones */
	readonly includes: IncludeIntent[] = [];
	/** @internal — mutated by pagination-impl on clones */
	readonly recursiveIncludes: RecursiveIncludeConfig[] = [];
	private readonly relationHints: RelationHints;
	private readonly adapter: Adapter | undefined;
	/** @internal — read by pagination-impl and stream-impl */
	readonly schemaName: string | undefined;
	/** @internal — read by stream-impl */
	readonly dialectCapabilities: DialectCapabilities | undefined;
	private readonly defaultFilters: DefaultFilters | undefined;
	/** @internal — read by stream-impl */
	readonly hookStore: HookStore | undefined;
	/** @internal — read by stream-impl */
	readonly onHookError: HookErrorHandler | undefined;
	/** @internal — read by stream-impl */
	readonly inTransaction: boolean | undefined;
	/** @internal — read by stream-impl */
	planOptionsOverride: PlanOptions | undefined;
	/** @internal — mutated by pagination-impl on clones */
	selectIntent: SelectIntent | undefined = undefined;
	/** @internal — mutated by pagination-impl on clones */
	whereIntents: WhereIntent[] = [];
	private strictModeOverride: boolean | undefined = undefined;
	/** @internal — mutated by pagination-impl on clones */
	aggregates: AggregateIntent[] = [];
	/** @internal — read by pagination-impl */
	groupByFields: string[] = [];
	/** @internal — read by pagination-impl and cursor helpers */
	orderByIntents: OrderByIntent[] = [];
	/** @internal — mutated by pagination-impl on clones */
	limitValue: number | undefined = undefined;
	/** @internal — mutated by pagination-impl on clones */
	offsetValue: number | undefined = undefined;
	private havingIntents: WhereIntent[] = [];
	private isDistinctQuery = false;
	private distinctOnColumns: string[] = [];
	private skipDefaultFilters = false;
	private lockIntent: import('@dbsp/types').LockIntent | undefined = undefined;
	/** @internal — read by pagination-impl */
	joinIntents: JoinIntent[] = [];
	/** When set, FROM clause is a BatchValues unnest() source, not a table */
	batchValuesSource?: import('@dbsp/types').BatchValuesJoinPayload;

	constructor(
		ctx: QueryBuilderContext,
		from: string,
		relationHints: RelationHints = {},
	) {
		this.ctx = ctx;
		this.model = ctx.model;
		this.strictMode = ctx.strictMode;
		this.from = from;
		this.relationHints = relationHints;
		this.adapter = ctx.adapter;
		this.schemaName = ctx.schemaName;
		this.dialectCapabilities = ctx.dialectCapabilities;
		this.planOptionsOverride = ctx.planOptionsOverride;
		this.defaultFilters = ctx.defaultFilters;
		this.hookStore = ctx.hookStore;
		this.onHookError = ctx.onHookError;
		this.inTransaction = ctx.inTransaction;
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
	// Overload: mixed strings + AliasedExprColumn → extends result type with aliased props
	columns<
		const T extends readonly (
			| (keyof TResult & string)
			| AliasedExprColumn<string>
		)[],
	>(
		columns: T,
	): QueryBuilder<
		Pick<TResult, Extract<T[number], keyof TResult & string>> & {
			[E in Extract<
				T[number],
				AliasedExprColumn<string>
			> as E['__alias']]: E['__value'];
		}
	>;
	// Overload: mixed columns (strings + expressions) → TResult
	columns(columns: readonly ColumnSpec[]): QueryBuilder<TResult>;
	// Implementation — cast to TResult to match the most general overload signature.
	// The overloads above refine the type; the implementation signature is intentionally
	// broad to satisfy all three overloads (TypeScript requires an assignable
	// implementation signature).
	// biome-ignore lint/suspicious/noExplicitAny: implementation signature accepts erased type — public overloads above guarantee the correct narrowed return type for callers
	columns(columns: readonly ColumnSpec[]): QueryBuilder<any> {
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

		// Cast is safe: the public overloads above guarantee the correct narrowed type.
		// biome-ignore lint/suspicious/noExplicitAny: implementation signature cast — public overloads above guarantee the correct narrowed type for callers
		return builder as QueryBuilder<any>;
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

	/**
	 * Apply PostgreSQL DISTINCT ON (...) to the query.
	 *
	 * @param columns - One or more column names to deduplicate on
	 * @returns A new QueryBuilder with DISTINCT ON applied
	 *
	 * @example
	 * ```typescript
	 * orm.select('users').distinctOn('department').all();
	 * // SQL: SELECT DISTINCT ON ("department") * FROM "users"
	 *
	 * orm.select('logs').distinctOn('user_id', 'action').all();
	 * // SQL: SELECT DISTINCT ON ("user_id", "action") * FROM "logs"
	 * ```
	 */
	distinctOn(...columns: string[]): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.distinctOnColumns = columns;
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
		fieldOrRecordOrSpecs:
			| string
			| OrderByRecord
			| readonly OrderBySpec[]
			| ExpressionRef
			| ExpressionSpec,
		direction?: SortDirection,
		options?: { nulls?: import('./types.js').NullsPosition },
	): QueryBuilder<TResult> {
		const builder = this.clone();

		// ExpressionRef form: orderBy(expr) or orderBy(expr, 'desc') or orderBy(expr, 'desc', { nulls: 'last' })
		if (fieldOrRecordOrSpecs instanceof ExpressionRef) {
			builder.orderByIntents.push({
				expression: fieldOrRecordOrSpecs.intent,
				direction: direction ?? 'asc',
				...(options?.nulls !== undefined ? { nulls: options.nulls } : {}),
			});
			return builder;
		}

		// ExpressionSpec form: orderBy(relationColumn(...)) or other plain ExpressionSpec objects
		if (isExpressionSpec(fieldOrRecordOrSpecs as ColumnSpec)) {
			builder.orderByIntents.push({
				expression: (fieldOrRecordOrSpecs as { intent: ExpressionIntent })
					.intent,
				direction: direction ?? 'asc',
				...(options?.nulls !== undefined ? { nulls: options.nulls } : {}),
			});
			return builder;
		}

		// String form: orderBy('field') or orderBy('field', 'desc') or orderBy('field', 'desc', { nulls: 'last' })
		if (typeof fieldOrRecordOrSpecs === 'string') {
			builder.orderByIntents.push({
				field: fieldOrRecordOrSpecs,
				direction: direction ?? 'asc',
				...(options?.nulls !== undefined ? { nulls: options.nulls } : {}),
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
		if (!Number.isSafeInteger(count) || count < 0) {
			throw new InvalidOperationError(
				'limit',
				'limit must be a non-negative safe integer',
			);
		}
		const builder = this.clone();
		builder.limitValue = count;
		return builder;
	}

	offset(count: number): QueryBuilder<TResult> {
		if (!Number.isSafeInteger(count) || count < 0) {
			throw new InvalidOperationError(
				'offset',
				'offset must be a non-negative safe integer',
			);
		}
		const builder = this.clone();
		builder.offsetValue = count;
		return builder;
	}

	where(condition: WhereIntent | WhereFilter<TResult>): QueryBuilder<TResult> {
		const builder = this.clone();
		// Detect ExpressionRef used as a standalone boolean WHERE predicate.
		// op('!=', exprRef('a'), exprRef('b')) returns ExpressionRef which has __expr:true
		// but no `kind` property, so isWhereIntent() returns false and objectToWhereIntent()
		// would map `__expr: true` as a column field. Handle this before the WhereIntent check.
		if (condition instanceof ExpressionRef) {
			// Wrap the expression intent in a WhereExpressionIntent with no value/operator.
			// The WHERE handler detects this and emits the expression node directly.
			const whereExpr = {
				kind: 'expression',
				expr: condition.intent,
			} as unknown as WhereIntent;
			builder.whereIntents.push(whereExpr);
			return builder;
		}
		// Convert object filter to WhereIntent if needed
		const intent = isWhereIntent(condition)
			? condition
			: objectToWhereIntent(condition as WhereFilter<Record<string, unknown>>);
		builder.whereIntents.push(intent);
		return builder;
	}

	join(
		relationOrTableOrBatch: string | BatchValuesRef,
		opts?: { type?: 'inner' | 'left'; on?: WhereIntent; as?: string },
	): QueryBuilder<TResult> {
		const builder = this.clone();
		const type = opts?.type ?? 'inner';

		if (isBatchValuesRef(relationOrTableOrBatch)) {
			const bv = relationOrTableOrBatch;
			if (!opts?.on) {
				throw new Error(
					'join(batchValuesRef): an `on` condition is required for BatchValues joins',
				);
			}
			const joinIntent: JoinIntent = {
				batchValues: {
					data: bv.data,
					columns: bv.columns,
					types: bv.types,
					alias: bv.alias,
					ordinality: bv.ordinality,
				},
				on: opts.on,
				type,
				...(opts.as !== undefined ? { alias: opts.as } : { alias: bv.alias }),
			};
			builder.joinIntents.push(joinIntent);
		} else {
			// FIND-011: Validate string table/relation argument
			validateIdentifier(relationOrTableOrBatch, 'table');
			const joinIntent: JoinIntent = opts?.on
				? {
						table: relationOrTableOrBatch,
						on: opts.on,
						type,
						...(opts.as !== undefined && { alias: opts.as }),
					}
				: {
						relation: relationOrTableOrBatch,
						type,
						...(opts?.as !== undefined && { alias: opts.as }),
					};
			builder.joinIntents.push(joinIntent);
		}
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
		// FIND-009: Validate composite PK keys against schema-defined primary key columns
		const table = this.model.getTable(this.from);
		if (!table) {
			throw new InvalidOperationError('byId', 'Unknown table');
		}
		const rawPk = table.primaryKey ?? [];
		const knownPkCols = new Set(typeof rawPk === 'string' ? [rawPk] : rawPk);
		// Composite PK - validate keys then build AND condition
		const entries = Object.entries(value);
		if (entries.length === 0) {
			throw new Error('Composite primary key cannot be empty');
		}
		if (knownPkCols.size > 0) {
			for (const key of Object.keys(value)) {
				if (!knownPkCols.has(key)) {
					throw new InvalidOperationError(
						'byId',
						`Unknown primary key column: ${key}`,
					);
				}
			}
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

	dump(meta?: DumpMetaInput): Dump {
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

		// Build DumpMeta: adapter-level schema + caller-supplied queryName/correlationId
		const dumpMeta: DumpMetaInput = {
			...(meta?.queryName !== undefined && { queryName: meta.queryName }),
			...(meta?.correlationId !== undefined && {
				correlationId: meta.correlationId,
			}),
		};

		// Use adapter.createDump() to properly capture adapter's schema
		// Then merge with context schema if needed
		const dump = adapter.createDump(planReport, compiled, dumpMeta);

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

		const planReport = this.planWithAmbiguityHandling(
			intentWithHints,
			planOptions,
		);

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
		const planReport = this.planWithAmbiguityHandling(
			intentWithHints,
			planOptions,
		);
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

		const planReport = this.planWithAmbiguityHandling(
			intentWithHints,
			planOptions,
		);

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
		return streamImpl.stream(this, options);
	}

	/**
	 * Execute the query with offset-based pagination.
	 */
	async paginate(options?: PaginateOptions): Promise<PaginatedResult<TResult>> {
		return paginationImpl.paginate(this, options);
	}

	/**
	 * Execute the query with cursor-based pagination.
	 */
	async cursorPaginate(
		options?: CursorPaginateOptions,
	): Promise<CursorPaginatedResult<TResult>> {
		return paginationImpl.cursorPaginate(this, options);
	}

	/**
	 * Get configured adapter, throwing if not configured.
	 * @throws {ExecutionError} If adapter is not configured
	 * @returns The configured adapter instance
	 */
	/** @internal — called by pagination-impl and stream-impl */
	getConfiguredAdapter(): Adapter {
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
	/** @internal — called by stream-impl */
	applyRelationHints(intent: QueryIntent): QueryIntent {
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
	/** @internal Used by CteQueryBuilder to access query intent without executing. */
	buildIntent(applyDefaultFilters = true): QueryIntent {
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

		// Add DISTINCT ON columns (PostgreSQL-specific)
		if (this.distinctOnColumns.length > 0) {
			intent.distinctOn = [...this.distinctOnColumns];
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

		// JOIN clauses (FR-10)
		if (this.joinIntents.length > 0) {
			intent.joins = [...this.joinIntents];
		}

		// BatchValues as primary FROM source
		if (this.batchValuesSource) {
			intent.batchValuesSource = this.batchValuesSource;
		}

		return intent as QueryIntent;
	}

	/**
	 * Apply defaultFilters to an intent (E17b: applied AFTER hooks for INV-01).
	 * @internal
	 */
	/** @internal — called by stream-impl */
	applyDefaultFiltersToIntent(intent: QueryIntent): QueryIntent {
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

		const planReport = this.planWithAmbiguityHandling(
			intentWithHints,
			planOptions,
		);

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

	/**
	 * Thin wrapper around the planner that applies the same ambiguity-handling
	 * logic as `plan()` (the builder method).  Used by exists/existsDump paths
	 * which build their own planOptions and therefore cannot call `this.plan()`
	 * directly (which would rebuild the intent from scratch).
	 *
	 * FIND-016: exists() / existsDump() called the raw planner function directly,
	 * bypassing the ambiguity catch that lives in the builder's plan() wrapper.
	 */
	/** @internal — called by stream-impl */
	planWithAmbiguityHandling(
		intent: QueryIntent,
		planOptions: PlanOptions,
	): PlanReport {
		try {
			return plan(intent, this.model, planOptions);
		} catch (error) {
			if (error instanceof AmbiguousPlanError) {
				return this.handleAmbiguity(error, intent, planOptions);
			}
			throw error;
		}
	}

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

		// Lenient mode: deterministic tie-break — sort alphabetically so that
		// schema definition order does not influence which relation is chosen.
		// This ensures stable query results across schema refactoring.
		// FIND-015: picking options[0] without sorting is non-deterministic.
		const sortedOptions = error.options.slice().sort();
		const firstRelation = sortedOptions[0];
		if (!firstRelation) {
			throw error; // Safety: should never happen
		}

		const disambiguateKey = `${error.sourceTable}.${error.targetTable}`;
		const planOptions: PlanOptions = {
			...basePlanOptions,
			disambiguate: {
				...basePlanOptions.disambiguate,
				[disambiguateKey]: firstRelation, // alphabetically-first (see sortedOptions)
			},
		};

		// Re-plan with disambiguation
		const result = plan(intent, this.model, planOptions);

		// Add warning about automatic disambiguation.
		// The chosen relation is the alphabetically-first name (deterministic
		// tie-break), not insertion order, so schema refactoring cannot silently
		// change query results.
		const warning = {
			code: 'AMBIGUOUS_RELATION' as const,
			message:
				`Ambiguous relation to '${error.targetTable}' from '${error.sourceTable}' ` +
				`was automatically resolved to '${firstRelation}' (alphabetical tie-break). ` +
				`Available options: ${sortedOptions.join(', ')}.`,
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
	/** @internal — called by pagination-impl and stream-impl */
	clone(): QueryBuilderImpl<TResult> {
		const builder = new QueryBuilderImpl<TResult>(
			// Shallow-clone planOptionsOverride into ctx so both ctx.planOptionsOverride
			// and this.planOptionsOverride (set by the constructor from ctx) reference
			// the same new object — no dual-state divergence.
			{
				...this.ctx,
				...(this.planOptionsOverride !== undefined
					? { planOptionsOverride: { ...this.planOptionsOverride } }
					: {}),
			},
			this.from,
			{ ...this.relationHints },
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
		builder.distinctOnColumns = [...this.distinctOnColumns];
		builder.skipDefaultFilters = this.skipDefaultFilters;
		builder.strictModeOverride = this.strictModeOverride;
		builder.limitValue = this.limitValue;
		builder.offsetValue = this.offsetValue;
		// planOptionsOverride already shallow-cloned via ctx spread above; no separate assignment needed.
		builder.lockIntent = this.lockIntent;
		builder.joinIntents.push(...this.joinIntents);
		if (this.batchValuesSource) {
			builder.batchValuesSource = this.batchValuesSource;
		}
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
	// --------------------------------------------------------------------------
	// Set operations (UNION / INTERSECT / EXCEPT)
	// --------------------------------------------------------------------------

	union(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'union',
				false,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	unionAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'union',
				true,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	intersect(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'intersect',
				false,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	intersectAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'intersect',
				true,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	except(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'except',
				false,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	exceptAll(other: QueryBuilder<TResult>): SetOperationBuilder<TResult> {
		return new SetOperationBuilderImpl(
			buildSetOperationIntent(
				'except',
				true,
				this,
				other as unknown as QueryIntentSource,
			),
			this.model,
			this.adapter,
			this.schemaName,
		);
	}

	withoutDefaultFilters(): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.skipDefaultFilters = true;
		return builder;
	}
}
