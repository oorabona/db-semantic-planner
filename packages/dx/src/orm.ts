import { compile, type Dump } from '@db-semantic-planner/adapter-kysely';
import type {
	AggregateIntent,
	IncludeIntent,
	ModelIR,
	PlanOptions,
	PlanReport,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import { AmbiguousPlanError, plan } from '@db-semantic-planner/core';
import type { Kysely } from 'kysely';

import {
	AmbiguousRelationError,
	ExecutionError,
	NotFoundError,
} from './errors.js';
import type {
	AggregateOptions,
	IncludeOptions,
	NestedInclude,
	OrmInstance,
	OrmOptions,
	QueryBuilder,
	RelationHints,
} from './types.js';

/**
 * Create an ORM instance with the specified configuration.
 *
 * @param options - Configuration options including model and strictMode
 * @returns An ORM instance for building and planning queries
 *
 * @example
 * ```typescript
 * const orm = createOrm({
 *   model: mySchema,
 *   strictMode: true,  // Throws on ambiguous relations
 * });
 *
 * const plan = orm.query('users')
 *   .include('posts', { via: 'authoredPosts' })
 *   .plan();
 * ```
 */
export function createOrm(options: OrmOptions): OrmInstance {
	const { model, strictMode = false, relationHints = {}, db } = options;

	return createOrmInstance(model, strictMode, relationHints, db);
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
		query(from: string): QueryBuilder {
			return new QueryBuilderImpl(
				model,
				strictMode,
				from,
				relationHints,
				db,
				schemaName,
			);
		},
		forTenant(tenantSchema: string): OrmInstance {
			return createOrmInstance(
				model,
				strictMode,
				relationHints,
				db,
				tenantSchema,
			);
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
 * Internal query builder implementation.
 */
class QueryBuilderImpl implements QueryBuilder {
	private readonly model: ModelIR;
	private readonly strictMode: boolean;
	private readonly from: string;
	private readonly includes: IncludeIntent[] = [];
	private readonly relationHints: RelationHints;
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	private readonly db: Kysely<any> | undefined;
	private readonly schemaName: string | undefined;
	private selectIntent?: SelectIntent;
	private whereIntent?: WhereIntent;
	private strictModeOverride?: boolean;
	private aggregates: AggregateIntent[] = [];
	private groupByFields: string[] = [];

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

	include(relation: string, options?: IncludeOptions): QueryBuilder {
		const builder = this.clone();
		builder.includes.push(includeOptionsToIntent(relation, options));
		return builder;
	}

	select(fields: readonly string[]): QueryBuilder {
		const builder = this.clone();
		builder.selectIntent = { type: 'fields', fields: [...fields] };
		return builder;
	}

	count(options?: AggregateOptions): QueryBuilder {
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

	sum(field: string, as?: string): QueryBuilder {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'sum', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	avg(field: string, as?: string): QueryBuilder {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'avg', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	min(field: string, as?: string): QueryBuilder {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'min', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	max(field: string, as?: string): QueryBuilder {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'max', field };
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	groupBy(fields: readonly string[]): QueryBuilder {
		const builder = this.clone();
		builder.groupByFields.push(...fields);
		return builder;
	}

	where(condition: WhereIntent): QueryBuilder {
		const builder = this.clone();
		builder.whereIntent = condition;
		return builder;
	}

	withStrictMode(strict: boolean): QueryBuilder {
		const builder = this.clone();
		builder.strictModeOverride = strict;
		return builder;
	}

	withRelationHint(target: string, relation: string): QueryBuilder {
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

	async findMany(): Promise<unknown[]> {
		const db = this.getConfiguredDb();
		const planReport = this.plan();
		const compiled = compile(planReport, this.model, db, this.schemaName);
		const result = await db.executeQuery(compiled);
		return result.rows as unknown[];
	}

	async findFirst(): Promise<unknown | undefined> {
		const rows = await this.findMany();
		return rows[0];
	}

	async findFirstOrThrow(): Promise<unknown> {
		const result = await this.findFirst();
		if (result === undefined) {
			throw new NotFoundError(this.from);
		}
		return result;
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

	execute(): Promise<unknown[]> {
		return this.findMany();
	}

	/**
	 * Get configured db, throwing if not configured.
	 * @throws {ExecutionError} If db is not configured
	 * @returns The configured Kysely instance
	 */
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	private getConfiguredDb(): Kysely<any> {
		if (!this.db) {
			throw new ExecutionError(
				'Database not configured. Pass db option to createOrm() to enable query execution.',
			);
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

		if (this.whereIntent !== undefined) {
			(intent as { where: WhereIntent }).where = this.whereIntent;
		}
		if (this.includes.length > 0) {
			(intent as { include: readonly IncludeIntent[] }).include = this.includes;
		}
		if (this.groupByFields.length > 0) {
			(intent as { groupBy: readonly string[] }).groupBy = [
				...this.groupByFields,
			];
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
	private clone(): QueryBuilderImpl {
		const builder = new QueryBuilderImpl(
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
		if (this.whereIntent !== undefined) {
			builder.whereIntent = this.whereIntent;
		}
		if (this.strictModeOverride !== undefined) {
			builder.strictModeOverride = this.strictModeOverride;
		}
		// Clone aggregates and groupBy
		builder.aggregates.push(...this.aggregates);
		builder.groupByFields.push(...this.groupByFields);
		return builder;
	}
}
