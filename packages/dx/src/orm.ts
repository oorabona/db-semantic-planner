import {
	compile,
	compileRecursive,
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
	RecursiveIntent,
	SelectAggregateIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	WhereIntent,
} from '@db-semantic-planner/core';
import {
	AmbiguousPlanError,
	plan,
	planRecursive,
} from '@db-semantic-planner/core';
import { CompiledQuery, type Kysely } from 'kysely';

import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NotFoundError,
} from './errors.js';
import { and, eq, inArray } from './filters.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
} from './mutation-builders.js';
import {
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
import {
	type AggregateOptions,
	type ColumnSpec,
	type IncludeOptions,
	type IncludeOptionsWithRecursive,
	isExpressionSpec,
	isRecursiveIncludeOptions,
	type ListHierarchyOptions,
	type NestedInclude,
	type OrderByRecord,
	type OrderBySpec,
	type OrmInstance,
	type OrmOptionsWithDb,
	type OrmOptionsWithModel,
	type QueryBuilder,
	type RecursiveIncludeOptions,
	type RelationHints,
	type SortDirection,
	type StreamOptions,
} from './types.js';

/**
 * Create an ORM instance with the specified configuration.
 *
 * @typeParam DB - Database schema type (Kysely-like).
 *   Keys are table names, values are row types.
 *   When provided, query() provides autocomplete and type inference.
 *
 * @param options - Configuration options including model and strictMode
 * @returns An ORM instance for building and planning queries
 *
 * @example With explicit model and typed schema (sync)
 * ```typescript
 * interface Database {
 *   users: { id: number; name: string };
 *   posts: { id: number; title: string; authorId: number };
 * }
 *
 * const orm = createOrm<Database>({
 *   model: mySchema,
 *   strictMode: true,
 * });
 *
 * // Table names autocomplete, results are typed
 * const users = await orm.select('users').all();
 * // users: { id: number; name: string }[]
 * ```
 *
 * @example Zero-config with auto-introspection (async)
 * ```typescript
 * const orm = await createOrm({ db });
 * const users = await orm.select('users').all();
 * ```
 */
export function createOrm<DB = Record<string, unknown>>(
	options: OrmOptionsWithModel,
): OrmInstance<DB>;
export function createOrm<DB = Record<string, unknown>>(
	options: OrmOptionsWithDb,
): Promise<OrmInstance<DB>>;
export function createOrm<DB = Record<string, unknown>>(
	options: OrmOptionsWithModel | OrmOptionsWithDb,
): OrmInstance<DB> | Promise<OrmInstance<DB>> {
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
 *
 * @typeParam DB - Database schema type (passed through from createOrm)
 */
function createOrmInstance<DB = Record<string, unknown>>(
	model: ModelIR,
	strictMode: boolean,
	relationHints: RelationHints,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db?: Kysely<any>,
	schemaName?: string,
): OrmInstance<DB> {
	return {
		strictMode,
		select<K extends keyof DB & string, TResult = DB[K]>(
			from: K,
		): QueryBuilder<TResult> {
			return new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				from as string,
				relationHints,
				db,
				schemaName,
			);
		},
		forTenant(tenantSchema: string): OrmInstance<DB> {
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

		// =====================================================================
		// Hierarchy List Methods (DX-022)
		// Returns flat arrays, uses include() with recursive: true internally
		// =====================================================================

		/**
		 * List all ancestors of a node as a flat array.
		 * Uses the new include({ recursive: true }) API internally.
		 *
		 * @param table - The table name
		 * @param nodeIdValue - The starting node's ID value
		 * @param options - Options including parentId column name
		 * @returns Promise resolving to array of ancestor records
		 */
		async listAncestors<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: ListHierarchyOptions,
		): Promise<TResult[]> {
			if (!db) {
				throw new Error(
					'listAncestors() requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}

			// Find the self-referential relation that matches the parent direction
			const selfRefRelation = findSelfRefRelation(model, table, 'ancestors');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listAncestors',
					`Table '${table}' has no self-referential belongsTo/hasOne relation for ancestor traversal`,
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';
			const maxDepth = options.maxDepth ?? 100;

			const builder = new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				table,
				relationHints,
				db,
				schemaName,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'ancestors',
					flat: true,
					omitSelf: true,
					maxDepth,
				})
				.first();

			// Result shape: { id, ..., ancestors: [...] }
			// Return the ancestors array or empty if no result
			// biome-ignore lint/suspicious/noExplicitAny: Result shape depends on relation name
			return (result as any)?.ancestors ?? [];
		},

		/**
		 * List all descendants of a node as a flat array.
		 * Uses the new include({ recursive: true }) API internally.
		 *
		 * @param table - The table name
		 * @param nodeIdValue - The starting node's ID value
		 * @param options - Options including parentId column name
		 * @returns Promise resolving to array of descendant records
		 */
		async listDescendants<TResult = unknown>(
			table: string,
			nodeIdValue: unknown,
			options: ListHierarchyOptions,
		): Promise<TResult[]> {
			if (!db) {
				throw new Error(
					'listDescendants() requires a database connection. ' +
						'Pass a Kysely instance when creating the ORM.',
				);
			}

			// Find the self-referential relation that matches the children direction
			const selfRefRelation = findSelfRefRelation(model, table, 'descendants');
			if (!selfRefRelation) {
				throw new InvalidOperationError(
					'listDescendants',
					`Table '${table}' has no self-referential hasMany relation for descendant traversal`,
				);
			}

			const nodeIdCol = options.nodeId ?? 'id';
			const maxDepth = options.maxDepth ?? 100;

			const builder = new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				table,
				relationHints,
				db,
				schemaName,
			);

			const result = await builder
				.where(eq(nodeIdCol, nodeIdValue))
				.include(selfRefRelation.name, {
					recursive: true,
					direction: 'descendants',
					flat: true,
					omitSelf: true,
					maxDepth,
				})
				.first();

			// Result shape: { id, ..., descendants: [...] }
			// Return the descendants array or empty if no result
			// biome-ignore lint/suspicious/noExplicitAny: Result shape depends on relation name
			return (result as any)?.descendants ?? [];
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
 * Validate recursive include options.
 * Throws InvalidOperationError if:
 * - Relation is not self-referential (source !== target)
 * - Direction is missing
 * - Direction conflicts with relation cardinality
 *
 * @param model - The model IR
 * @param sourceTable - The source table name
 * @param relationName - The relation name
 * @param options - The recursive include options
 */
function validateRecursiveInclude(
	model: ModelIR,
	sourceTable: string,
	relationName: string,
	options: RecursiveIncludeOptions,
): void {
	// Get the relation from the model
	const qualifiedName = `${sourceTable}.${relationName}`;
	const relation = model.getRelation(qualifiedName);

	if (!relation) {
		// Let the planner handle the "relation not found" error
		return;
	}

	// Check if direction is provided (INV-2)
	if (!options.direction) {
		throw new InvalidOperationError(
			'recursive include',
			`'direction' is required when using recursive: true. ` +
				`Use 'ancestors' for parent traversal or 'descendants' for children traversal.`,
		);
	}

	// Check if relation is self-referential (INV-1, PRE-1)
	if (relation.source !== relation.target) {
		throw new InvalidOperationError(
			'recursive include',
			`Recursive include requires a self-referential relation. ` +
				`Relation '${relationName}' connects '${relation.source}' to '${relation.target}', ` +
				`but both must be the same table for recursive traversal.`,
		);
	}

	// Check direction vs relation type (PRE-2, PRE-3, ERR-3)
	// ancestors requires belongsTo/hasOne (to-one), descendants requires hasMany (to-many)
	const { direction } = options;
	const relType = relation.type;

	if (direction === 'ancestors') {
		// ancestors traversal: follow the "parent" direction (N:1 or 1:1)
		// The relation should be belongsTo or hasOne (e.g., category -> parent category)
		if (relType === 'hasMany' || relType === 'belongsToMany') {
			throw new InvalidOperationError(
				'recursive include',
				`Direction 'ancestors' requires a to-one relation (belongsTo or hasOne). ` +
					`Relation '${relationName}' has type '${relType}'. ` +
					`Use 'descendants' for hasMany/belongsToMany relations.`,
			);
		}
	} else if (direction === 'descendants') {
		// descendants traversal: follow the "children" direction (1:N)
		// The relation should be hasMany (e.g., category -> child categories)
		if (relType === 'belongsTo' || relType === 'hasOne') {
			throw new InvalidOperationError(
				'recursive include',
				`Direction 'descendants' requires a to-many relation (hasMany). ` +
					`Relation '${relationName}' has type '${relType}'. ` +
					`Use 'ancestors' for belongsTo/hasOne relations.`,
			);
		}
	}
}

/**
 * Find a self-referential relation on a table that matches the desired direction.
 *
 * @param model - The model IR
 * @param table - The table name
 * @param direction - 'ancestors' (needs belongsTo/hasOne) or 'descendants' (needs hasMany)
 * @returns The matching relation or null if not found
 */
function findSelfRefRelation(
	model: ModelIR,
	table: string,
	direction: 'ancestors' | 'descendants',
): { name: string; type: string } | null {
	// Get all relations from this table
	const tableRelations = model.getRelationsFrom(table);
	if (!tableRelations || tableRelations.length === 0) {
		return null;
	}

	// Find self-referential relations that match the direction
	for (const relation of tableRelations) {
		// Must be self-referential
		if (relation.source !== relation.target) {
			continue;
		}

		// Check if direction matches relation type
		if (direction === 'ancestors') {
			// Need belongsTo or hasOne for ancestor traversal
			if (relation.type === 'belongsTo' || relation.type === 'hasOne') {
				return { name: relation.name, type: relation.type };
			}
		} else {
			// Need hasMany for descendant traversal
			if (relation.type === 'hasMany') {
				return { name: relation.name, type: relation.type };
			}
		}
	}

	return null;
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
 * Configuration for a recursive include.
 * Stores the relation name and recursive options for later processing.
 */
interface RecursiveIncludeConfig {
	readonly relation: string;
	readonly options: RecursiveIncludeOptions;
}

/**
 * Internal query builder implementation.
 */
class QueryBuilderImpl<TResult = unknown> implements QueryBuilder<TResult> {
	private readonly model: ModelIR;
	private readonly strictMode: boolean;
	private readonly from: string;
	private readonly includes: IncludeIntent[] = [];
	private readonly recursiveIncludes: RecursiveIncludeConfig[] = [];
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

	include(
		relation: string,
		options?: IncludeOptionsWithRecursive,
	): QueryBuilder<TResult> {
		const builder = this.clone();

		// Handle recursive includes separately - they require CTE execution
		if (isRecursiveIncludeOptions(options)) {
			validateRecursiveInclude(this.model, this.from, relation, options);
			// Store for separate CTE processing during execution
			builder.recursiveIncludes.push({ relation, options });
			return builder;
		}

		// Support dot notation for nested includes: 'posts.comments.author'
		if (relation.includes('.')) {
			builder.includes.push(parseDotNotationInclude(relation, options));
		} else {
			builder.includes.push(includeOptionsToIntent(relation, options));
		}
		return builder;
	}

	columns(columns: readonly ColumnSpec[]): QueryBuilder<TResult> {
		const builder = this.clone();

		// Separate strings and expressions
		const fields: string[] = [];
		const expressions: ExpressionIntent[] = [];

		for (const col of columns) {
			if (isExpressionSpec(col)) {
				expressions.push(col.intent);
			} else {
				fields.push(col);
			}
		}

		// If we have expressions, use SelectWithExpressionsIntent
		if (expressions.length > 0) {
			const select: SelectWithExpressionsIntent = {
				type: 'expressions',
				expressions,
			};
			if (fields.length > 0) {
				(select as { fields: readonly string[] }).fields = fields;
			}
			builder.selectIntent = select;
		} else {
			// Simple fields only
			builder.selectIntent = { type: 'fields', fields };
		}

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

	async all(): Promise<TResult[]> {
		const db = this.getConfiguredDb();
		const planReport = this.plan();

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: {
			schemaName?: string;
		} = {};
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiled = compile(planReport, this.model, db, compileOptions);
		const result = await db.executeQuery(compiled);
		const mainResults = result.rows as TResult[];

		// Process recursive includes if any
		if (this.recursiveIncludes.length > 0) {
			await this.processRecursiveIncludes(mainResults, db);
		}

		return mainResults;
	}

	/**
	 * Process recursive includes by executing CTE queries and merging results.
	 * For each recursive include, builds a RecursiveIntent, executes it, and
	 * attaches the results to the appropriate parent records.
	 */
	private async processRecursiveIncludes(
		// biome-ignore lint/suspicious/noExplicitAny: Result rows can have any shape
		results: any[],
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
		db: Kysely<any>,
	): Promise<void> {
		if (results.length === 0) return;

		for (const config of this.recursiveIncludes) {
			await this.processOneRecursiveInclude(results, config, db);
		}
	}

	/**
	 * Process a single recursive include.
	 */
	private async processOneRecursiveInclude(
		// biome-ignore lint/suspicious/noExplicitAny: Result rows can have any shape
		results: any[],
		config: RecursiveIncludeConfig,
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
		db: Kysely<any>,
	): Promise<void> {
		const { relation, options } = config;
		const {
			direction,
			flat = false,
			omitSelf = false,
			maxDepth = 100,
			includeDepth = false,
		} = options;

		// Get relation metadata
		const qualifiedName = `${this.from}.${relation}`;
		const relationMeta = this.model.getRelation(qualifiedName);
		if (!relationMeta) {
			throw new InvalidOperationError(
				'recursive include execution',
				`Relation '${relation}' not found on '${this.from}'`,
			);
		}

		// Determine the foreign key column from relation metadata
		const fkColumn = this.getForeignKeyColumn(relationMeta.foreignKey);

		// Collect IDs from the main results (primary key values)
		// For ancestors: we start from the record's own ID and traverse up via parent
		// For descendants: we start from the record's own ID and traverse down via children
		const startIds = results
			.map((r) => r.id as unknown)
			.filter((id) => id !== undefined && id !== null);

		if (startIds.length === 0) return;

		// Build RecursiveIntent
		const cteName = `_recursive_${relation}_${direction}`;
		const recursiveIntent = this.buildRecursiveIntent(
			cteName,
			relationMeta,
			startIds,
			direction,
			maxDepth,
			includeDepth,
		);

		// Plan and compile the recursive query
		const report = planRecursive(recursiveIntent, this.model);
		const compiledRecursive = compileRecursive(
			report,
			this.model,
			db,
			this.schemaName,
		);

		// Execute
		const compiledQuery = CompiledQuery.raw(
			compiledRecursive.sql,
			compiledRecursive.parameters as unknown[],
		);
		const recursiveResult = await db.executeQuery(compiledQuery);
		// biome-ignore lint/suspicious/noExplicitAny: Recursive result rows can have any shape
		const recursiveRows = recursiveResult.rows as any[];

		// Merge results back into main results
		this.mergeRecursiveResults(
			results,
			recursiveRows,
			relation,
			direction,
			fkColumn,
			flat,
			omitSelf,
		);
	}

	/**
	 * Build a RecursiveIntent from the include options.
	 */
	private buildRecursiveIntent(
		cteName: string,
		relationMeta: ReturnType<ModelIR['getRelation']> & object,
		startIds: unknown[],
		direction: 'ancestors' | 'descendants',
		maxDepth: number,
		includeDepth: boolean,
	): RecursiveIntent {
		const { source, foreignKey } = relationMeta;

		// Get the foreign key as a string (use first element if array)
		const fkColumn = this.getForeignKeyColumn(foreignKey);

		// For self-referential relations:
		// - ancestors: traverse via parent (belongsTo) - follow foreignKey to parent
		// - descendants: traverse via children (hasMany) - find rows where foreignKey = our id

		// Build the start WHERE clause to filter by the starting IDs
		const startWhere: WhereIntent =
			startIds.length === 1
				? {
						kind: 'comparison',
						field: 'id',
						operator: 'eq',
						value: startIds[0],
					}
				: {
						kind: 'in',
						field: 'id',
						values: startIds as (string | number | boolean)[],
					};

		// Build traversal config based on direction
		const traversal = this.buildTraversalConfig(source, fkColumn, direction);

		// Build the intent
		const intent: RecursiveIntent = {
			type: 'recursive',
			cteName,
			start: {
				from: source,
				nodeIdExpr: { kind: 'column', name: 'id' },
				where: startWhere,
			},
			traversal,
			maxDepth,
		};

		// Add depth tracking if requested
		if (includeDepth) {
			(intent as { track?: RecursiveIntent['track'] }).track = { depth: {} };
		}

		return intent;
	}

	/**
	 * Extract foreign key column name from RelationIR foreignKey.
	 */
	private getForeignKeyColumn(
		foreignKey: string | readonly string[] | undefined,
	): string {
		if (!foreignKey) {
			return 'parent_id'; // Default convention for self-referential
		}
		if (typeof foreignKey === 'string') {
			return foreignKey;
		}
		// It's a readonly array - use first column for composite FK
		const first = foreignKey[0];
		return first ?? 'parent_id'; // Fallback for empty array
	}

	/**
	 * Build traversal config for recursive CTE.
	 */
	private buildTraversalConfig(
		nodeTable: string,
		parentIdColumn: string,
		direction: 'ancestors' | 'descendants',
	): RecursiveIntent['traversal'] {
		// For self-referential adjacency list:
		// - ancestors: currentRow.foreignKey = nextRow.id (follow parent pointer)
		// - descendants: currentRow.id = nextRow.foreignKey (find children)
		return {
			kind: 'adjacency',
			nodeTable,
			nodeId: 'id',
			parentId: parentIdColumn,
			direction,
		};
	}

	/**
	 * Merge recursive query results back into the main results.
	 */
	private mergeRecursiveResults(
		// biome-ignore lint/suspicious/noExplicitAny: Result rows can have any shape
		results: any[],
		// biome-ignore lint/suspicious/noExplicitAny: Recursive result rows can have any shape
		recursiveRows: any[],
		relation: string,
		direction: 'ancestors' | 'descendants',
		foreignKey: string,
		flat: boolean,
		omitSelf: boolean,
	): void {
		// Build a map from start ID to recursive results
		// biome-ignore lint/suspicious/noExplicitAny: Recursive result rows can have any shape
		const resultsByStartId = new Map<unknown, any[]>();

		for (const row of recursiveRows) {
			// The recursive CTE returns rows with a _start_id or similar marker
			// For now, we group by the root ID that started the traversal
			const startId = row._root_id ?? row.id;
			const existing = resultsByStartId.get(startId) ?? [];

			// Apply omitSelf filter
			if (omitSelf && row.depth === 0) {
				continue;
			}

			existing.push(row);
			resultsByStartId.set(startId, existing);
		}

		// Determine output property name based on direction
		const outputProperty =
			direction === 'ancestors'
				? relation === 'parent'
					? 'ancestors'
					: `${relation}_ancestors`
				: relation === 'children'
					? 'descendants'
					: `${relation}_descendants`;

		// Attach to main results
		for (const result of results) {
			const id = result.id as unknown;
			const recursiveData = resultsByStartId.get(id) ?? [];

			if (flat) {
				// Flat: array of all results
				result[outputProperty] = recursiveData;
			} else {
				// Nested: build tree structure
				result[outputProperty] = this.buildNestedHierarchy(
					recursiveData,
					direction,
					foreignKey,
				);
			}
		}
	}

	/**
	 * Build nested hierarchy from flat recursive results.
	 */
	private buildNestedHierarchy(
		// biome-ignore lint/suspicious/noExplicitAny: Recursive result rows can have any shape
		rows: any[],
		direction: 'ancestors' | 'descendants',
		foreignKey: string,
		// biome-ignore lint/suspicious/noExplicitAny: Nested result can have any shape
	): any {
		if (rows.length === 0) return direction === 'ancestors' ? null : [];

		// Sort by depth
		const sorted = [...rows].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

		if (direction === 'ancestors') {
			// For ancestors, build a chain: self -> parent -> grandparent
			// Return the immediate parent with nested ancestors
			let current = null;
			for (let i = sorted.length - 1; i >= 0; i--) {
				const row = sorted[i];
				const node = { ...row };
				if (current !== null) {
					node[direction === 'ancestors' ? 'parent' : 'children'] = current;
				}
				current = node;
			}
			return current;
		}

		// For descendants, build a tree structure
		// biome-ignore lint/suspicious/noExplicitAny: Building nested tree structure
		const nodeMap = new Map<unknown, any>();
		// biome-ignore lint/suspicious/noExplicitAny: Building nested tree structure
		const roots: any[] = [];

		for (const row of sorted) {
			const node = { ...row, children: [] };
			nodeMap.set(row.id, node);

			const parentId = row[foreignKey] as unknown;
			if (parentId !== null && parentId !== undefined) {
				const parent = nodeMap.get(parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					roots.push(node);
				}
			} else {
				roots.push(node);
			}
		}

		return roots;
	}

	async first(): Promise<TResult | undefined> {
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
		return this.where(inArray('id', [...values])).all();
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

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: {
			schemaName?: string;
		} = {};
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		const compiled = compile(planReport, this.model, db, compileOptions);

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
		return this.all();
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
		builder.recursiveIncludes.push(...this.recursiveIncludes);
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
