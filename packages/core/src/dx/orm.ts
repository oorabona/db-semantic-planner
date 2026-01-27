import type { Adapter, Dump } from '../adapter.js';
import type { DialectCapabilities } from '../dialects/index.js';
import type {
	AggregateIntent,
	ExpressionIntent,
	IncludeIntent,
	OrderByIntent,
	QueryIntent,
	SelectAggregateIntent,
	SelectIntent,
	WhereIntent,
} from '../intent-ast.js';
import type { IncludeStrategy, ModelIR } from '../model-ir.js';
import type { PlanOptions, PlanReport } from '../planner.js';
import { AmbiguousPlanError, plan } from '../planner.js';

import {
	AmbiguousRelationError,
	ExecutionError,
	InvalidOperationError,
	NamingConventionMismatchError,
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
	includeOptionsToIntent,
	parseDotNotationInclude,
	validateRecursiveInclude,
} from './intent-builder.js';
import {
	DeleteBuilder,
	InsertBuilder,
	UpdateBuilder,
	UpsertBuilder,
} from './mutation-builders.js';
import { createNqlTag, type NqlCompilerFn, type NqlTag } from './nql.js';
import {
	isWhereIntent,
	objectToWhereIntent,
	type WhereFilter,
} from './object-filter.js';
import { ResultHydrator } from './result-hydrator.js';
import type { InferDB, Schema, SchemaDefinition } from './schema.js';
import {
	type AggregateOptions,
	type ColumnSpec,
	type CursorPaginatedResult,
	type CursorPaginateOptions,
	type IncludeOptionsWithRecursive,
	isExpressionSpec,
	isRecursiveIncludeOptions,
	type ListHierarchyOptions,
	type OrderByRecord,
	type OrderBySpec,
	type OrmInstance,
	type PaginatedResult,
	type PaginateOptions,
	type QueryBuilder,
	type RecursiveIncludeOptions,
	type RelationHints,
	type SortDirection,
	type StreamOptions,
} from './types.js';

// ============================================================================
// ARCH-006: Simplified ORM Entry Point
// ============================================================================

/**
 * ARCH-006: Simplified ORM options.
 *
 * Uses the unified Schema API with required schema and optional adapter.
 * The schema must be created with `schema()` + `ref()`.
 *
 * @example Compile-only (no adapter)
 * ```typescript
 * const orm = createOrm({ schema: mySchema });
 * const { sql, params } = orm.select('users').dump();
 * ```
 *
 * @example Full ORM with adapter
 * ```typescript
 * const orm = createOrm({ schema: mySchema, adapter });
 * const users = await orm.select('users').all();
 * ```
 */
export interface SimplifiedOrmOptions<
	T extends SchemaDefinition = SchemaDefinition,
> {
	/**
	 * Schema created with schema() + ref().
	 * Either schema or model is required.
	 */
	readonly schema?: Schema<T>;

	/**
	 * ModelIR directly (alternative to schema).
	 * Use this when you have ModelIR from introspection or external source.
	 * Either schema or model is required.
	 */
	readonly model?: ModelIR;

	/**
	 * Adapter for database execution (optional for compile-only).
	 */
	readonly adapter?: Adapter<unknown>;

	/**
	 * Enable strict mode validation (default: false).
	 */
	readonly strictMode?: boolean;

	/**
	 * NQL compiler function for template literal queries (DX-040).
	 *
	 * @example
	 * ```typescript
	 * const orm = createOrm({ schema, adapter });
	 * const users = await orm.nql<{ name: string }>`users | select name`.all();
	 * ```
	 *
	 * @deprecated Since DX-040: NQL compiler is now integrated directly.
	 * This option is ignored - @dbsp/nql is automatically used.
	 */
	readonly nqlCompiler?: NqlCompilerFn;

	/**
	 * Optional dialect capabilities for strategy selection.
	 */
	readonly dialectCapabilities?: DialectCapabilities;
}

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
 * @example With schema() + ref() API (recommended)
 * ```typescript
 * import { schema, ref, createOrm } from '@dbsp/core';
 *
 * const mySchema = schema({
 *   users: {
 *     id: 'uuid',
 *     name: 'string',
 *   },
 *   posts: {
 *     id: 'uuid',
 *     title: 'string',
 *     authorId: ref('users.id'),
 *   },
 * });
 *
 * const orm = createOrm({ schema: mySchema, adapter });
 *
 * // Table names autocomplete, results are typed!
 * const users = await orm.select('users').all();
 *
 * // Include relations with type inference
 * const usersWithPosts = await orm.select('users').include('posts').all();
 * ```
 */
/**
 * ARCH-006: Creates an ORM instance from a schema.
 *
 * This is the single entry point for creating ORM instances.
 * The schema must be created with `schema()` + `ref()`.
 *
 * For database introspection, use `getSchemaFromDb()` from @dbsp/adapter-kysely:
 * ```typescript
 * import { getSchemaFromDb } from '@dbsp/adapter-kysely';
 * const schema = await getSchemaFromDb(adapter);
 * const orm = createOrm({ schema, adapter });
 * ```
 *
 * @param options - ORM options with required schema
 * @returns ORM instance for querying
 *
 * @example Compile-only (no adapter)
 * ```typescript
 * const orm = createOrm({ schema: mySchema });
 * const { sql, params } = orm.select('users').dump();
 * ```
 *
 * @example Full ORM with adapter
 * ```typescript
 * const orm = createOrm({ schema: mySchema, adapter });
 * const users = await orm.select('users').all();
 * ```
 */
export function createOrm<T extends SchemaDefinition>(
	options: SimplifiedOrmOptions<T>,
): OrmInstance<InferDB<T>> {
	const {
		schema: schemaObj,
		model: modelDirect,
		adapter,
		strictMode = false,
		dialectCapabilities,
		// nqlCompiler is deprecated - @dbsp/nql is integrated directly
	} = options;

	// ARCH-006: Either schema or model is required
	// Schema provides full type inference; model is simpler for introspection/tests
	let model: ModelIR;
	let schemaDefinition: unknown;

	if (schemaObj && 'model' in schemaObj) {
		// Full schema object provided
		model = schemaObj.model;
		schemaDefinition = schemaObj.definition;

		// ARCH-006: Validate naming convention consistency
		if (
			adapter &&
			schemaObj.namingConvention &&
			adapter.namingConvention &&
			schemaObj.namingConvention !== adapter.namingConvention
		) {
			throw new NamingConventionMismatchError({
				schemaConvention: schemaObj.namingConvention,
				adapterConvention: adapter.namingConvention,
			});
		}
	} else if (modelDirect) {
		// ModelIR provided directly (simpler API for introspection/tests)
		model = modelDirect;
		schemaDefinition = undefined; // NQL will work without schema validation
	} else {
		throw new Error(
			'Invalid options: must provide either schema (from schema() function) ' +
				'or model (ModelIR). For database introspection, use getSchemaFromDb() ' +
				'from @dbsp/adapter-kysely.',
		);
	}

	// Create ORM instance with ModelIR
	// Cast to InferDB<T> since createOrmInstance uses internal types
	return createOrmInstance(
		model,
		strictMode,
		{}, // relationHints removed in ARCH-006
		adapter,
		undefined, // schemaName
		undefined, // defaultIncludeStrategy removed in ARCH-006
		dialectCapabilities,
		schemaDefinition,
	) as OrmInstance<InferDB<T>>;
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
	adapter?: Adapter<DB>,
	schemaName?: string,
	defaultIncludeStrategy?: IncludeStrategy,
	dialectCapabilities?: DialectCapabilities,
	schemaDefinition?: unknown,
): OrmInstance<DB> {
	// Create NQL template tag (DX-040)
	// NQL compiler is now integrated directly - @dbsp/nql is imported in nql.ts
	const nql: NqlTag = createNqlTag(
		schemaDefinition,
		model,
		adapter as Adapter<unknown> | undefined,
		schemaName,
	);

	return {
		strictMode,
		nql,
		select<K extends keyof DB & string, TResult = DB[K]>(
			from: K,
		): QueryBuilder<TResult> {
			return new QueryBuilderImpl<TResult>(
				model,
				strictMode,
				from as string,
				relationHints,
				adapter,
				schemaName,
				defaultIncludeStrategy,
				dialectCapabilities,
			);
		},
		withSchema(schemaName: string): OrmInstance<DB> {
			// Validate schema name to prevent SQL injection
			if (adapter) {
				adapter.validateIdentifier(schemaName, 'schema');
			}
			// Create a schema-scoped adapter if we have one
			const scopedAdapter = adapter?.withSchema(schemaName);
			return createOrmInstance(
				model,
				strictMode,
				relationHints,
				scopedAdapter as Adapter<DB> | undefined,
				schemaName,
				defaultIncludeStrategy,
				dialectCapabilities,
				schemaDefinition,
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
			if (!adapter) {
				throw new Error(
					'listAncestors() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
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
				adapter,
				schemaName,
				defaultIncludeStrategy,
				dialectCapabilities,
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
			if (!adapter) {
				throw new Error(
					'listDescendants() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
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
				adapter,
				schemaName,
				defaultIncludeStrategy,
				dialectCapabilities,
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
				adapter,
				schemaName,
			});
		},

		update(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				adapter,
				schemaName,
			});
		},

		delete(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				adapter,
				schemaName,
			});
		},

		updateAll(table: string): UpdateBuilder {
			return new UpdateBuilder({
				table,
				model,
				adapter,
				schemaName,
				allowAll: true,
			});
		},

		deleteAll(table: string): DeleteBuilder {
			return new DeleteBuilder({
				table,
				model,
				adapter,
				schemaName,
				allowAll: true,
			});
		},

		// DX-026: Upsert support
		upsert(table: string): UpsertBuilder {
			return new UpsertBuilder({
				table,
				model,
				adapter,
				schemaName,
			});
		},

		// =====================================================================
		// Transaction Methods (DX-025)
		// =====================================================================

		async transaction<T>(fn: (tx: OrmInstance<DB>) => Promise<T>): Promise<T> {
			if (!adapter) {
				throw new Error(
					'transaction() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Passthrough to adapter's transaction API
			return adapter.transaction(async (txAdapter) => {
				// Create a transaction-scoped ORM instance
				const txOrm = createOrmInstance<DB>(
					model,
					strictMode,
					relationHints,
					txAdapter as Adapter<DB>,
					schemaName,
					defaultIncludeStrategy,
					dialectCapabilities,
					schemaDefinition,
				);
				return fn(txOrm);
			});
		},

		// =====================================================================
		// Raw SQL Execution (DX-027)
		// =====================================================================

		/**
		 * Execute raw SQL directly - escape hatch for queries that cannot
		 * be expressed via the intent system.
		 *
		 * @warning **SECURITY RISK: POTENTIAL SQL INJECTION**
		 *
		 * This method bypasses the semantic planner and all type safety.
		 * Always use parameter placeholders ($1, $2, etc.) for values.
		 *
		 * **SAFE:**
		 * ```typescript
		 * orm.raw('SELECT * FROM users WHERE id = $1', [userId]);
		 * ```
		 *
		 * **DANGEROUS - NEVER DO THIS:**
		 * ```typescript
		 * orm.raw(`SELECT * FROM users WHERE id = ${userId}`);
		 * ```
		 *
		 * @param sqlString - SQL with parameter placeholders ($1, $2, etc.)
		 * @param parameters - Values to bind (safely escaped by driver)
		 * @returns Promise resolving to typed results
		 *
		 * @see {@link https://owasp.org/www-community/attacks/SQL_Injection | OWASP SQL Injection}
		 */
		async raw<T = unknown>(
			sqlString: string,
			parameters: readonly unknown[] = [],
		): Promise<T[]> {
			if (!adapter) {
				throw new Error(
					'raw() requires an adapter. ' +
						'Pass an adapter when creating the ORM.',
				);
			}

			// Passthrough to adapter's executeRaw API
			return adapter.executeRaw<T>(sqlString, parameters);
		},
	};
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
	private readonly adapter: Adapter | undefined;
	private readonly schemaName: string | undefined;
	private readonly defaultIncludeStrategy: IncludeStrategy | undefined;
	private readonly dialectCapabilities: DialectCapabilities | undefined;
	private selectIntent?: SelectIntent;
	private whereIntents: WhereIntent[] = [];
	private strictModeOverride?: boolean;
	private aggregates: AggregateIntent[] = [];
	private groupByFields: string[] = [];
	private orderByIntents: OrderByIntent[] = [];
	private limitValue?: number;
	private offsetValue?: number;
	private havingIntents: WhereIntent[] = [];
	private isDistinctQuery = false;

	constructor(
		model: ModelIR,
		strictMode: boolean,
		from: string,
		relationHints: RelationHints = {},
		adapter?: Adapter,
		schemaName?: string,
		defaultIncludeStrategy?: IncludeStrategy,
		dialectCapabilities?: DialectCapabilities,
	) {
		this.model = model;
		this.strictMode = strictMode;
		this.from = from;
		this.relationHints = relationHints;
		this.adapter = adapter;
		this.schemaName = schemaName;
		this.defaultIncludeStrategy = defaultIncludeStrategy;
		this.dialectCapabilities = dialectCapabilities;
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
				(c) => (c as { column: string }).column,
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
			fields: fields as unknown as readonly string[],
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

		return builder as unknown as QueryBuilder<
			TResult & { [P in Alias]: NonNullable<TResult[K]> }
		>;
	}

	count(
		fieldOrOptions?: AggregateOptions | string | DistinctField,
		as?: string,
	): QueryBuilder<TResult> {
		const builder = this.clone();
		const agg: AggregateIntent = { function: 'count' };

		if (fieldOrOptions === undefined) {
			// count() - COUNT(*)
		} else if (typeof fieldOrOptions === 'string') {
			// count('field', 'alias') - COUNT(field)
			(agg as { field: string }).field = fieldOrOptions;
			if (as !== undefined) {
				(agg as { as: string }).as = as;
			}
		} else if (isDistinctField(fieldOrOptions)) {
			// count(distinct('field'), 'alias') - COUNT(DISTINCT field)
			(agg as { field: string }).field = fieldOrOptions.field;
			(agg as { distinct: boolean }).distinct = true;
			if (as !== undefined) {
				(agg as { as: string }).as = as;
			}
		} else {
			// count({ field, as }) - AggregateOptions
			if (fieldOrOptions.field !== undefined) {
				(agg as { field: string }).field = fieldOrOptions.field;
			}
			if (fieldOrOptions.as !== undefined) {
				(agg as { as: string }).as = fieldOrOptions.as;
			}
		}

		builder.aggregates.push(agg);
		return builder;
	}

	sum(field: string | DistinctField, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const isDistinct = isDistinctField(field);
		const fieldName = isDistinct ? field.field : field;
		const agg: AggregateIntent = { function: 'sum', field: fieldName };
		if (isDistinct) {
			(agg as { distinct: boolean }).distinct = true;
		}
		if (as !== undefined) {
			(agg as { as: string }).as = as;
		}
		builder.aggregates.push(agg);
		return builder;
	}

	avg(field: string | DistinctField, as?: string): QueryBuilder<TResult> {
		const builder = this.clone();
		const isDistinct = isDistinctField(field);
		const fieldName = isDistinct ? field.field : field;
		const agg: AggregateIntent = { function: 'avg', field: fieldName };
		if (isDistinct) {
			(agg as { distinct: boolean }).distinct = true;
		}
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

		// Build plan options with defaultIncludeStrategy and dialectCapabilities if set
		const planOptions: PlanOptions = {};
		if (this.defaultIncludeStrategy) {
			planOptions.defaultIncludeStrategy = this.defaultIncludeStrategy;
		}
		if (this.dialectCapabilities) {
			planOptions.dialectCapabilities = this.dialectCapabilities;
		}

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
		const planReport = this.plan();

		// Build compile options with exactOptionalPropertyTypes compliance
		const compileOptions: {
			schemaName?: string;
			model: ModelIR;
		} = { model: this.model };
		if (this.schemaName !== undefined) {
			compileOptions.schemaName = this.schemaName;
		}

		// Use compileWithIncludes to get separate include info for hasMany relations
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

		// Process separate includes (hasMany hydration - DX-033)
		if (compiledWithIncludes.separateIncludes.length > 0) {
			await hydrator.hydrateIncludes(
				mainResults,
				compiledWithIncludes.separateIncludes,
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
				this.defaultIncludeStrategy,
				this.dialectCapabilities,
			);
			// Copy where conditions but not limit/offset
			countBuilder.whereIntents.push(...this.whereIntents);
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

		// Combine multiple having conditions with AND (DX-034)
		if (this.havingIntents.length === 1) {
			const singleHaving = this.havingIntents[0];
			if (singleHaving !== undefined) {
				(intent as { having: WhereIntent }).having = singleHaving;
			}
		} else if (this.havingIntents.length > 1) {
			(intent as { having: WhereIntent }).having = and(...this.havingIntents);
		}

		// Add SELECT DISTINCT flag (DX-034)
		if (this.isDistinctQuery) {
			(intent as { distinct: boolean }).distinct = true;
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
			{ ...this.relationHints }, // Clone hints to allow per-query additions
			this.adapter,
			this.schemaName,
			this.defaultIncludeStrategy,
			this.dialectCapabilities,
		);
		builder.includes.push(...this.includes);
		builder.recursiveIncludes.push(...this.recursiveIncludes);
		if (this.selectIntent !== undefined) {
			builder.selectIntent = this.selectIntent;
		}
		// Clone whereIntents array
		builder.whereIntents.push(...this.whereIntents);
		// Clone havingIntents array (DX-034)
		builder.havingIntents.push(...this.havingIntents);
		// Clone isDistinctQuery (DX-034)
		builder.isDistinctQuery = this.isDistinctQuery;
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
