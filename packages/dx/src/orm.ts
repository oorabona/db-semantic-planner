import {
	compile,
	type Dump,
	introspect,
	streamQuery,
	validateIdentifier,
} from '@db-semantic-planner/adapter-kysely';
import type {
	AggregateIntent,
	ExpressionIntent,
	IncludeIntent,
	ModelIR,
	OrderByIntent,
	PlanOptions,
	PlanReport,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import { AmbiguousPlanError, plan } from '@db-semantic-planner/core';
import type { Kysely } from 'kysely';

import {
	AmbiguousRelationError,
	ExecutionError,
	NotFoundError,
} from './errors.js';
import { and, eq, inArray } from './filters.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
} from './mutation-builders.js';
import { RecursiveQueryBuilder } from './recursive-query-builder.js';
import type {
	AggregateOptions,
	HierarchyOptions,
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptionsWithDb,
	OrmOptionsWithModel,
	QueryBuilder,
	RelationHints,
	StreamOptions,
} from './types.js';

/**
 * Create an ORM instance with the specified configuration.
 *
 * @param options - Configuration options including model and strictMode
 * @returns An ORM instance for building and planning queries
 *
 * @example With explicit model (sync)
 * ```typescript
 * const orm = createOrm({
 *   model: mySchema,
 *   strictMode: true,
 * });
 * ```
 *
 * @example Zero-config with auto-introspection (async)
 * ```typescript
 * const orm = await createOrm({ db });
 * const users = await orm.query('users').findMany();
 * ```
 */
export function createOrm(options: OrmOptionsWithModel): OrmInstance;
export function createOrm(options: OrmOptionsWithDb): Promise<OrmInstance>;
export function createOrm(
	options: OrmOptionsWithModel | OrmOptionsWithDb,
): OrmInstance | Promise<OrmInstance> {
	const { model, strictMode = false, relationHints = {}, db } = options;

	// If model is provided, create synchronously
	if (model) {
		return createOrmInstance(model, strictMode, relationHints, db);
	}

	// If no model but db is provided, introspect and create async
	if (db) {
		return introspect(db).then((introspectedModel) =>
			createOrmInstance(introspectedModel, strictMode, relationHints, db),
		);
	}

	// Neither model nor db - this shouldn't happen with proper types
	throw new Error('Either model or db must be provided to createOrm');
}

/**
 * Internal factory for creating ORM instances.
 * Supports optional schema name for multi-tenant scenarios.
 */
function createOrmInstance(
	model: ModelIR,
	strictMode: boolean,
	relationHints: RelationHints,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db?: Kysely<any>,
	schemaName?: string,
): OrmInstance {
	return {
		strictMode,
		query<TResult = unknown>(from: string): QueryBuilder<TResult> {
			return new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				from,
				relationHints,
				db,
				schemaName,
			);
		},
		forTenant(tenantSchema: string): OrmInstance {
			// Validate schema name to prevent SQL injection
			validateIdentifier(tenantSchema, 'schema');
			return createOrmInstance(
				model,
				strictMode,
				relationHints,
				db,
				tenantSchema,
			);
		},
		recursive<TResult = unknown>(
			cteName: string,
		): RecursiveQueryBuilder<TResult> {
			if (!db) {
				throw new Error(
					'RecursiveQueryBuilder requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}
			return new RecursiveQueryBuilder<TResult>(model, db, cteName, schemaName);
		},

		ancestors<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: HierarchyOptions,
		): RecursiveQueryBuilder<TResult> {
			if (!db) {
				throw new Error(
					'ancestors() requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}
			const cteName = options.cteName ?? `${table}_ancestors`;
			const nodeId = options.nodeId ?? 'id';
			return new RecursiveQueryBuilder<TResult>(model, db, cteName, schemaName)
				.from(table)
				.nodeId(nodeId)
				.where(eq(nodeId, nodeIdValue))
				.traverseVia(table, {
					parentId: options.parentId,
					direction: 'ancestors',
				});
		},

		descendants<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: HierarchyOptions,
		): RecursiveQueryBuilder<TResult> {
			if (!db) {
				throw new Error(
					'descendants() requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}
			const cteName = options.cteName ?? `${table}_descendants`;
			const nodeId = options.nodeId ?? 'id';
			return new RecursiveQueryBuilder<TResult>(model, db, cteName, schemaName)
				.from(table)
				.nodeId(nodeId)
				.where(eq(nodeId, nodeIdValue))
				.traverseVia(table, {
					parentId: options.parentId,
					direction: 'descendants',
				});
		},

		subtree<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: HierarchyOptions,
		): RecursiveQueryBuilder<TResult> {
			// Subtree is the same as descendants but includes the starting node
			// The starting node is always included by the anchor query in descendants
			if (!db) {
				throw new Error(
					'subtree() requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}
			const cteName = options.cteName ?? `${table}_subtree`;
			const nodeId = options.nodeId ?? 'id';
			return new RecursiveQueryBuilder<TResult>(model, db, cteName, schemaName)
				.from(table)
				.nodeId(nodeId)
				.where(eq(nodeId, nodeIdValue))
				.traverseVia(table, {
					parentId: options.parentId,
					direction: 'descendants',
				});
		},

		// =====================================================================
		// Mutation Methods (DX-010)
		// =====================================================================

		insert(table: string): InsertBuilder {
			return new InsertBuilder({
				table,
				model,
				db,
				schemaName,
			});
		},

		update(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				db,
				schemaName,
			});
		},

		delete(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				db,
				schemaName,
			});
		},

		updateAll(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				db,
				schemaName,
				allowAll: true,
			});
		},

		deleteAll(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				db,
				schemaName,
				allowAll: true,
			});
		},
	};
}

/**
 * Convert IncludeOptions to IncludeIntent.
 * Handles exactOptionalPropertyTypes by only including defined properties.
 */
function includeOptionsToIntent(
	relation: string,
	options?: IncludeOptions,
): IncludeIntent {
	if (!options) {
		return { relation };
	}

	const intent: IncludeIntent = { relation };

	if (options.via !== undefined) {
		(intent as { via: string }).via = options.via;
	}
	if (options.where !== undefined) {
		(intent as { where: WhereIntent }).where = options.where;
	}
	if (options.select !== undefined) {
		(intent as { select: SelectIntent }).select = options.select;
	}
	if (options.include !== undefined && options.include.length > 0) {
		(intent as { include: readonly IncludeIntent[] }).include =
			options.include.map((nested) => nestedIncludeToIntent(nested));
	}

	return intent;
}

/**
 * Convert NestedInclude to IncludeIntent.
 */
function nestedIncludeToIntent(nested: NestedInclude): IncludeIntent {
	const intent: IncludeIntent = { relation: nested.relation };

	if (nested.via !== undefined) {
		(intent as { via: string }).via = nested.via;
	}
	if (nested.where !== undefined) {
		(intent as { where: WhereIntent }).where = nested.where;
	}
	if (nested.select !== undefined) {
		(intent as { select: SelectIntent }).select = nested.select;
	}
	if (nested.include !== undefined && nested.include.length > 0) {
		(intent as { include: readonly IncludeIntent[] }).include =
			nested.include.map((n) => nestedIncludeToIntent(n));
	}

	return intent;
}

/**
 * Parse dot notation include into nested IncludeIntent.
 *
 * @example
 * 'posts.comments.author' becomes:
 * { relation: 'posts', include: [{ relation: 'comments', include: [{ relation: 'author' }] }] }
 */
function parseDotNotationInclude(
	path: string,
	options?: IncludeOptions,
): IncludeIntent {
	const parts = path.split('.');
	if (parts.length === 0) {
		throw new Error('Invalid include path');
	}

	// Build from the end (deepest level) to the beginning
	// Options apply to the deepest (last) relation
	const lastPart = parts[parts.length - 1];
	if (!lastPart) {
		throw new Error('Invalid include path: empty segment');
	}
	let current: IncludeIntent = includeOptionsToIntent(lastPart, options);

	// Work backwards through the path, wrapping each level
	for (let i = parts.length - 2; i >= 0; i--) {
		const part = parts[i];
		if (!part) continue;
		current = { relation: part, include: [current] };
	}

	return current;
}

/**
 * Internal query builder implementation.
 */
class QueryBuilderImpl<TResult = unknown> implements QueryBuilder<TResult> {
	private readonly model: ModelIR;
	private readonly strictMode: boolean;
	private readonly from: string;
	private readonly includes: IncludeIntent[] = [];
	private readonly relationHints: RelationHints;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	private readonly db: Kysely<any> | undefined;
	private readonly schemaName: string | undefined;
	private selectIntent?: SelectIntent;
	private whereIntents: WhereIntent[] = [];
	private strictModeOverride?: boolean;
	private aggregates: AggregateIntent[] = [];
	private groupByFields: string[] = [];
	private orderByIntents: OrderByIntent[] = [];
	private limitValue?: number;
	private offsetValue?: number;

	constructor(
		model: ModelIR,
		strictMode: boolean,
		from: string,
		relationHints: RelationHints = {},
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
		db?: Kysely<any>,
		schemaName?: string,
	) {
		this.model = model;
		this.strictMode = strictMode;
		this.from = from;
		this.relationHints = relationHints;
		this.db = db;
		this.schemaName = schemaName;
	}

	include(relation: string, options?: IncludeOptions): QueryBuilder<TResult> {
		const builder = this.clone();
		// Support dot notation for nested includes: 'posts.comments.author'
		if (relation.includes('.')) {
			builder.includes.push(parseDotNotationInclude(relation, options));
		} else {
			builder.includes.push(includeOptionsToIntent(relation, options));
		}
		return builder;
	}

	select(fields: readonly string[]): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.selectIntent = { type: 'fields', fields: [...fields] };
		return builder;
	}

	selectWithExpressions(
		fields: readonly string[],
		expressions: readonly ExpressionIntent[],
	): QueryBuilder<TResult> {
		const builder = this.clone();
		const select: SelectWithExpressionsIntent = {
			type: 'expressions',
			expressions: [...expressions],
		};
		// Add fields if provided
		if (fields.length > 0) {
			(select as { fields: readonly string[] }).fields = [...fields];
		}
		builder.selectIntent = select;
		return builder;
	}

	count(options?: AggregateOptions): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'count' };
		if (options?.field !== undefined) {
			(agg as { field: string }).field = options.field;
		}
		if (options?.as !== undefined) {
			(agg as { as: string }).as = options.as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	sum(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'sum', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	avg(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'avg', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	min(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'min', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	max(field: string, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'max', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	groupBy(fields: readonly string[]): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.groupByFields.push(...fields);
		return builder;
	}

	orderBy(
		field: string,
		direction: 'asc' | 'desc' = 'asc',
	): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.orderByIntents.push({ field, direction });
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

	where(condition: WhereIntent): QueryBuilder<TResult> {
		const builder = this.clone();
		builder.whereIntents.push(condition);
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

		// Apply relation hints to includes before planning
		const intentWithHints = this.applyRelationHints(intent);

		try {
			return plan(intentWithHints, this.model);
		} catch (error) {
			if (error instanceof AmbiguousPlanError) {
				return this.handleAmbiguity(error, intentWithHints);
			}
			throw error;
		}
	}

	async findMany(): Promise<TResult[]> {
		const db = this.getConfiguredDb();
		const planReport = this.plan();
		const compiled = compile(planReport, this.model, db, this.schemaName);
		const result = await db.executeQuery(compiled);
		return result.rows as TResult[];
	}

	async findFirst(): Promise<TResult | undefined> {
		const rows = await this.findMany();
		return rows[0];
	}

	async findFirstOrThrow(): Promise<TResult> {
		const result = await this.findFirst();
		if (result === undefined) {
			throw new NotFoundError(this.from);
		}
		return result;
	}

	async byId(
		value: string | number | Record<string, unknown>,
	): Promise<TResult | undefined> {
		const condition = this.buildPkCondition(value);
		return this.where(condition).findFirst();
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
		return this.where(inArray('id', [...values])).findMany();
	}

	/**
	 * Build a where condition for a primary key lookup.
	 * Supports simple PKs (string | number) and composite PKs (object).
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

	dump(): Dump {
		const db = this.getConfiguredDb();
		const planReport = this.plan();
		const compiled = compile(planReport, this.model, db, this.schemaName);

		// Build meta with exactOptionalPropertyTypes compliance
		const meta: { compiledAt: Date; tenant?: string } = {
			compiledAt: new Date(),
		};
		if (this.schemaName !== undefined) {
			meta.tenant = this.schemaName;
		}

		return {
			plan: planReport,
			sql: compiled.sql,
			params: compiled.parameters as readonly unknown[],
			meta,
		};
	}

	execute(): Promise<TResult[]> {
		return this.findMany();
	}

	stream(options?: StreamOptions): AsyncIterableIterator<TResult> {
		const db = this.getConfiguredDb();
		const dumpResult = this.dump();

		// Pass options directly - they're already compatible types
		// streamQuery handles undefined options gracefully
		return streamQuery(db, dumpResult, options);
	}

	/**
	 * Get configured db, throwing if not configured.
	 * @throws {ExecutionError} If db is not configured
	 * @returns The configured Kysely instance
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	private getConfiguredDb(): Kysely<any> {
		if (!this.db) {
			throw new ExecutionError({
				operation: 'query execution',
				reason: 'Database not configured',
				fix: 'Pass a Kysely instance to createOrm({ db: yourKyselyInstance })',
			});
		}
		return this.db;
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
	private buildIntent(): QueryIntent {
		const intent: QueryIntent = {
			type: 'select',
			from: this.from,
		};

		// Handle aggregates - convert to SelectAggregateIntent
		if (this.aggregates.length > 0) {
			const aggregateSelect: SelectAggregateIntent = {
				type: 'aggregate',
				aggregates: [...this.aggregates],
			};
			// Add group by fields to the select for projection
			if (this.groupByFields.length > 0) {
				(aggregateSelect as { fields: readonly string[] }).fields = [
					...this.groupByFields,
				];
			}
			(intent as { select: SelectIntent }).select = aggregateSelect;
		} else if (this.selectIntent !== undefined) {
			(intent as { select: SelectIntent }).select = this.selectIntent;
		}

		// Combine multiple where conditions with AND
		if (this.whereIntents.length === 1) {
			const singleWhere = this.whereIntents[0];
			if (singleWhere !== undefined) {
				(intent as { where: WhereIntent }).where = singleWhere;
			}
		} else if (this.whereIntents.length > 1) {
			(intent as { where: WhereIntent }).where = and(...this.whereIntents);
		}
		if (this.includes.length > 0) {
			(intent as { include: readonly IncludeIntent[] }).include = this.includes;
		}
		if (this.groupByFields.length > 0) {
			(intent as { groupBy: readonly string[] }).groupBy = [
				...this.groupByFields,
			];
		}
		if (this.orderByIntents.length > 0) {
			(intent as { orderBy: readonly OrderByIntent[] }).orderBy = [
				...this.orderByIntents,
			];
		}
		if (this.limitValue !== undefined) {
			(intent as { limit: number }).limit = this.limitValue;
		}
		if (this.offsetValue !== undefined) {
			(intent as { offset: number }).offset = this.offsetValue;
		}

		return intent;
	}

	/**
	 * Handle ambiguity based on strict mode setting.
	 */
	private handleAmbiguity(
		error: AmbiguousPlanError,
		intent: QueryIntent,
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
			disambiguate: {
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
			{ ...this.relationHints }, // Clone hints to allow per-query additions
			this.db,
			this.schemaName,
		);
		builder.includes.push(...this.includes);
		if (this.selectIntent !== undefined) {
			builder.selectIntent = this.selectIntent;
		}
		// Clone whereIntents array
		builder.whereIntents.push(...this.whereIntents);
		if (this.strictModeOverride !== undefined) {
			builder.strictModeOverride = this.strictModeOverride;
		}
		// Clone aggregates and groupBy
		builder.aggregates.push(...this.aggregates);
		builder.groupByFields.push(...this.groupByFields);
		// Clone orderBy, limit, offset
		builder.orderByIntents.push(...this.orderByIntents);
		if (this.limitValue !== undefined) {
			builder.limitValue = this.limitValue;
		}
		if (this.offsetValue !== undefined) {
			builder.offsetValue = this.offsetValue;
		}
		return builder;
	}
}
