/**
 * @module compiler
 * SQL Compiler - Transforms PlanReport into Kysely queries.
 */

import type {
	AggregateIntent,
	DeleteIntent,
	EmitJoinClause,
	ExpressionIntent,
	IncludeIntent,
	InsertIntent,
	ModelIR,
	PlanDecision,
	PlanReport,
	QueryIntent,
	RecursiveAdvancedOptions,
	RecursiveIntent,
	RecursiveNodeIdExpr,
	RecursivePlanReport,
	RecursiveTrackOptions,
	RelationIR,
	SelectAggregateIntent,
	SelectWithExpressionsIntent,
	SubqueryRefIntent,
	UpdateIntent,
	UpsertIntent,
	WhereIntent,
	WhereSubqueryIntent,
	WindowIntent,
} from '@db-semantic-planner/core';
import {
	POSTGRESQL_CAPABILITIES as CORE_POSTGRESQL_CAPABILITIES,
	type DialectCapabilities as CoreDialectCapabilities,
	getDialectCapabilities,
	isAdjacencyTraversal,
	isAggregateWindowFunction,
	isEdgeTableTraversal,
	isKnownDialect,
	isSelectAggregate,
	isSelectWithExpressions,
	isSubqueryRef,
} from '@db-semantic-planner/core';
import type {
	AliasedExpression,
	CompiledQuery,
	ExpressionBuilder,
	Kysely,
	SelectQueryBuilder,
} from 'kysely';
import { type RawBuilder, sql } from 'kysely';
import {
	type DialectCapabilities as AdapterDialectCapabilities,
	type DialectName,
	detectDialect,
	getCapabilitiesForDialect,
} from './dialect.js';
import { CompilationError } from './errors.js';
import { UnsupportedOperationError } from './stream.js';

// ============================================================================
// Compiler State
// ============================================================================

interface CompilerState {
	/** Current table alias counter */
	aliasCounter: number;
	/** Map of table name to alias */
	tableAliases: Map<string, string>;
	/** Collected parameters */
	parameters: unknown[];
	/** Track relations that have been JOINed for filter-strategy: 'join' */
	joinedFilterRelations: Map<string, { alias: string; targetTable: string }>;
	/** Track relations that have been JOINed for include-strategy: 'join' */
	joinedIncludeRelations: Map<
		string,
		{ alias: string; targetTable: string; relationName: string }
	>;
}

// ============================================================================
// Path Tracking Compiler (ARCH-001)
// ============================================================================

/**
 * Map adapter dialect name to core dialect capabilities.
 * This bridges the adapter's dialect detection with core's capabilities registry.
 *
 * @param dialectName - Adapter dialect name (from detectDialect)
 * @returns Core dialect capabilities for SQL generation
 */
function getCoreCapabilitiesForDialect(
	dialectName: DialectName,
): CoreDialectCapabilities {
	// Map adapter dialect names to core dialect identifiers
	const coreDialectMap: Record<DialectName, string> = {
		postgresql: 'postgresql',
		mysql: 'mysql',
		sqlite: 'sqlite',
		mssql: 'mssql',
		unknown: 'postgresql', // Default to PostgreSQL as most feature-rich
	};

	const coreDialect = coreDialectMap[dialectName];

	if (isKnownDialect(coreDialect)) {
		return getDialectCapabilities(coreDialect);
	}

	// Fallback to PostgreSQL capabilities
	return CORE_POSTGRESQL_CAPABILITIES;
}

/**
 * Determine the path tracking strategy based on intent and core capabilities.
 *
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities
 * @returns The resolved strategy ('array' or 'string')
 */
function resolvePathStrategy(
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
): 'array' | 'string' {
	if (pathOptions?.strategy) {
		return pathOptions.strategy;
	}
	// Infer from core capabilities' recursivePathStyle
	// JSON style maps to 'string' for now (could be extended later)
	return coreCapabilities.recursivePathStyle === 'array' ? 'array' : 'string';
}

/**
 * Compile path tracking expression for base case (anchor query).
 *
 * @param eb - Kysely expression builder
 * @param columnRef - Reference to the node ID column (e.g., 't0.id')
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities for SQL generation
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingBaseCase(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	columnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, coreCapabilities);
	const alias = pathOptions?.as ?? 'path';

	if (strategy === 'array') {
		if (!coreCapabilities.supportsArrayType) {
			throw new UnsupportedOperationError(
				'array path tracking',
				`Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.`,
				{ capability: 'supportsArrayType', dialect },
			);
		}
		// PostgreSQL: ARRAY[node_id]
		return sql`ARRAY[${sql.ref(columnRef)}]`.as(alias);
	}

	// String strategy: CAST(node_id AS TEXT)
	return eb.cast(eb.ref(columnRef), 'text').as(alias);
}

/**
 * Compile path tracking expression for recursive step.
 *
 * @param eb - Kysely expression builder
 * @param nodeColumnRef - Reference to the new node ID column (e.g., 'node.id')
 * @param pathOptions - Path tracking options from intent
 * @param coreCapabilities - Core dialect capabilities for SQL generation
 * @param dialect - Dialect name for error messages
 * @returns AliasedExpression for the path column
 */
function compilePathTrackingRecursive(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder generic
	eb: ExpressionBuilder<any, any>,
	nodeColumnRef: string,
	pathOptions: RecursiveTrackOptions['path'],
	coreCapabilities: CoreDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic return type
): AliasedExpression<any, string> {
	const strategy = resolvePathStrategy(pathOptions, coreCapabilities);
	const alias = pathOptions?.as ?? 'path';
	const separator = pathOptions?.separator ?? '/';

	if (strategy === 'array') {
		if (!coreCapabilities.supportsArrayType) {
			throw new UnsupportedOperationError(
				'array path tracking',
				`Array path tracking requires PostgreSQL. Use strategy: 'string' or remove path tracking.`,
				{ capability: 'supportsArrayType', dialect },
			);
		}
		// PostgreSQL: prev.path || node.id (array concat)
		return eb(eb.ref('prev.path'), '||', eb.ref(nodeColumnRef)).as(alias);
	}

	// String strategy: Use dialect-appropriate concatenation
	// - 'operator' (PostgreSQL, SQLite): prev.path || '/' || CAST(node.id AS TEXT)
	// - 'function' (MySQL): CONCAT(prev.path, '/', CAST(node.id AS TEXT))
	if (coreCapabilities.stringConcatStyle === 'function') {
		// MySQL: CONCAT function
		return eb
			.fn('concat', [
				eb.ref('prev.path'),
				eb.val(separator),
				eb.cast(eb.ref(nodeColumnRef), 'text'),
			])
			.as(alias);
	}

	// PostgreSQL/SQLite: || operator
	const escapedSeparator = separator.replace(/'/g, "''");
	return sql`${eb.ref('prev.path')} || ${sql.lit(`'${escapedSeparator}'`)} || ${eb.cast(eb.ref(nodeColumnRef), 'text')}`.as(
		alias,
	);
}

// ============================================================================
// Main Compiler
// ============================================================================

/**
 * Options for compile function
 */
export interface InternalCompileOptions {
	/** Schema name for multi-tenant queries */
	schemaName?: string;
	/** Window functions to add to SELECT clause (P3-A) */
	windows?: readonly WindowIntent[];
}

// ============================================================================
// Separate Include Types (CORE-001 Block 4)
// ============================================================================

/**
 * Metadata for a separate include query.
 * Used when planner decides include-strategy: 'separate' for hasMany relations.
 */
export interface SeparateIncludeInfo {
	/** Name of the relation being included */
	relationName: string;
	/** Target table to fetch from */
	targetTable: string;
	/** Foreign key column(s) in target table (e.g., 'userId' for posts, or ['tenantId', 'userId'] for composite) */
	foreignKey: string | readonly string[];
	/** Source key column(s) in parent table (usually 'id', or ['tenantId', 'id'] for composite) */
	sourceKey: string | readonly string[];
	/** Optional select clause from include intent */
	select?: IncludeIntent['select'];
	/** Optional where clause from include intent */
	where?: IncludeIntent['where'];
}

/**
 * Result of compiling a query with separate includes.
 * Returned by compileWithIncludes() when there are includes with strategy 'separate'.
 */
export interface CompileResultWithIncludes {
	/** The main query (includes any JOIN includes) */
	main: CompiledQuery;
	/** Metadata for separate include queries (empty if all includes use JOIN) */
	separateIncludes: SeparateIncludeInfo[];
}

/**
 * Compile a separate include query with the given parent IDs.
 * This is called by the executor after running the main query.
 *
 * @param info - Separate include metadata from compileWithIncludes()
 * @param parentIds - IDs from the main query result
 * @param kysely - Kysely instance
 * @param schemaName - Optional schema name for multi-tenant
 * @returns Compiled query for fetching the related records
 */
export function compileSeparateInclude(
	info: SeparateIncludeInfo,
	parentIds: readonly unknown[],
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	if (parentIds.length === 0) {
		// Return an empty result query - no parent IDs means no includes to fetch
		const tableName = schemaName
			? `${schemaName}.${info.targetTable}`
			: info.targetTable;
		return kysely
			.selectFrom(tableName)
			.selectAll()
			.where((eb) => eb.lit(false)) // Always false - returns empty result
			.compile();
	}

	const tableName = schemaName
		? `${schemaName}.${info.targetTable}`
		: info.targetTable;

	let query = kysely.selectFrom(tableName).selectAll();

	// Add WHERE foreignKey IN (parentIds) - handle composite keys
	const fkCols = Array.isArray(info.foreignKey)
		? info.foreignKey
		: [info.foreignKey];
	if (fkCols.length === 1) {
		// Simple case: single column FK
		query = query.where(fkCols[0], 'in', parentIds as unknown[]);
	} else {
		// Composite key: parentIds should be tuples, use OR conditions
		// Each parentId is expected to be a tuple [val1, val2, ...]
		query = query.where((eb) => {
			const conditions = (parentIds as unknown[][]).map((tuple) => {
				const colConditions = fkCols.map((col, i) => eb(col, '=', tuple[i]));
				return eb.and(colConditions);
			});
			return eb.or(conditions);
		});
	}

	// Add additional WHERE conditions from include intent
	if (info.where) {
		query = addSimpleWhere(query, info.where, info.targetTable);
	}

	return query.compile();
}

/**
 * Add simple WHERE conditions (non-relational) to a query.
 * Used for separate include queries.
 */
function addSimpleWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	tableName: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	switch (where.kind) {
		case 'comparison': {
			const column = `${tableName}.${where.field}`;
			switch (where.operator) {
				case 'eq':
					return query.where(column, '=', where.value);
				case 'neq':
					return query.where(column, '!=', where.value);
				case 'gt':
					return query.where(column, '>', where.value);
				case 'gte':
					return query.where(column, '>=', where.value);
				case 'lt':
					return query.where(column, '<', where.value);
				case 'lte':
					return query.where(column, '<=', where.value);
				default:
					return query;
			}
		}
		case 'like':
			return where.caseInsensitive
				? query.where(`${tableName}.${where.field}`, 'ilike', where.pattern)
				: query.where(`${tableName}.${where.field}`, 'like', where.pattern);
		case 'in':
			return query.where(
				`${tableName}.${where.field}`,
				'in',
				where.values as unknown[],
			);
		case 'null':
			return where.operator === 'isNull'
				? query.where(`${tableName}.${where.field}`, 'is', null)
				: query.where(`${tableName}.${where.field}`, 'is not', null);
		case 'and':
			for (const condition of where.conditions) {
				query = addSimpleWhere(query, condition, tableName);
			}
			return query;
		case 'or':
			return query.where((eb) => {
				const conditions = where.conditions.map((c: WhereIntent) => {
					switch (c.kind) {
						case 'comparison': {
							const col = `${tableName}.${c.field}`;
							switch (c.operator) {
								case 'eq':
									return eb(col, '=', c.value);
								case 'neq':
									return eb(col, '!=', c.value);
								case 'gt':
									return eb(col, '>', c.value);
								case 'gte':
									return eb(col, '>=', c.value);
								case 'lt':
									return eb(col, '<', c.value);
								case 'lte':
									return eb(col, '<=', c.value);
								default:
									return eb.lit(true);
							}
						}
						case 'like': {
							const col = `${tableName}.${c.field}`;
							return c.caseInsensitive
								? eb(col, 'ilike', c.pattern)
								: eb(col, 'like', c.pattern);
						}
						case 'in': {
							const col = `${tableName}.${c.field}`;
							if (c.values.length === 0) {
								return eb.lit(false);
							}
							return eb(col, 'in', [...c.values]);
						}
						case 'null': {
							const col = `${tableName}.${c.field}`;
							return c.operator === 'isNull'
								? eb(col, 'is', null)
								: eb(col, 'is not', null);
						}
						default:
							return eb.lit(true);
					}
				});
				return eb.or(conditions);
			});
		default:
			return query;
	}
}

/**
 * Collect separate includes from intent based on planner decisions.
 */
function collectSeparateIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	sourceTable: string,
): SeparateIncludeInfo[] {
	if (!includes || includes.length === 0) {
		return [];
	}

	const result: SeparateIncludeInfo[] = [];

	for (const include of includes) {
		const relationName = include.relation;

		// Find the include-strategy decision for this relation
		const decision = plan.decisions.find(
			(d) =>
				d.type === 'include-strategy' &&
				d.context?.sourceTable === sourceTable &&
				d.context?.relation === relationName,
		);

		// If planner decided 'separate', collect the info
		if (decision?.choice === 'separate') {
			// Get relation definition from model
			const relation = model.getRelation(`${sourceTable}.${relationName}`);
			if (!relation) {
				continue; // Skip if relation not found
			}

			// Determine FK and source key based on relation type - supports composite keys
			let foreignKey: string | readonly string[];
			let sourceKey: string | readonly string[];

			// Get source table's primary key
			const sourceTableDef = model.getTable(sourceTable);
			const sourcePkCols = normalizePrimaryKey(sourceTableDef?.primaryKey);

			// Get target table's primary key
			const targetTableDef = model.getTable(relation.target);
			const targetPkCols = normalizePrimaryKey(targetTableDef?.primaryKey);

			if (relation.type === 'hasMany' || relation.type === 'hasOne') {
				// hasMany/hasOne: FK is in target table (e.g., posts.userId), points to source's PK
				const fkCols = normalizeForeignKey(
					relation.foreignKey,
					`${sourceTable.replace(/s$/, '')}Id`,
				);
				foreignKey = unwrapSingletonArray(fkCols);
				sourceKey = unwrapSingletonArray(sourcePkCols); // Source table's PK (supports composite)
			} else {
				// belongsTo: FK is in source table (rare for 'separate', but handle it)
				// For separate include, we need target's PK
				foreignKey = unwrapSingletonArray(targetPkCols); // Target table's PK (supports composite)
				const skCols = normalizeForeignKey(
					relation.foreignKey,
					`${relation.target.replace(/s$/, '')}Id`,
				);
				sourceKey = unwrapSingletonArray(skCols);
			}

			result.push({
				relationName,
				targetTable: relation.target,
				foreignKey,
				sourceKey,
				select: include.select,
				where: include.where,
			});
		}
	}

	return result;
}

/**
 * Compile a PlanReport with full support for separate includes.
 * Returns both the main query and metadata for separate include queries.
 *
 * @param plan - The plan report from the planner
 * @param model - The model IR
 * @param kysely - Kysely instance
 * @param schemaNameOrOptions - Schema name or options
 * @returns Compile result with main query and separate includes info
 */
export function compileWithIncludes(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaNameOrOptions?: string | InternalCompileOptions,
): CompileResultWithIncludes {
	// Compile the main query (uses existing compile function)
	const main = compile(plan, model, kysely, schemaNameOrOptions);

	// Collect separate includes
	const separateIncludes = collectSeparateIncludes(
		plan.intent.include,
		plan,
		model,
		plan.intent.from,
	);

	return {
		main,
		separateIncludes,
	};
}

/**
 * Compile a PlanReport into a Kysely CompiledQuery
 */
export function compile(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaNameOrOptions?: string | InternalCompileOptions,
): CompiledQuery {
	// Handle both legacy (string schemaName) and new (options object) signatures
	const options: InternalCompileOptions =
		typeof schemaNameOrOptions === 'string'
			? { schemaName: schemaNameOrOptions }
			: (schemaNameOrOptions ?? {});

	const { schemaName, windows } = options;

	const state: CompilerState = {
		aliasCounter: 0,
		tableAliases: new Map(),
		parameters: [],
		joinedFilterRelations: new Map(),
		joinedIncludeRelations: new Map(),
	};

	const intent = plan.intent;
	const rootTable = intent.from;

	// Get root alias
	const rootAlias = getNextAlias(state);
	state.tableAliases.set(rootTable, rootAlias);

	// Build CTEs first (must come before selectFrom in Kysely)
	const builder = buildCTEs(plan, model, kysely, schemaName);

	// Build the base query using the CTE-enhanced builder
	let query = buildBaseQuery(intent, rootAlias, builder, schemaName);

	// Add Window functions (P3-A)
	if (windows && windows.length > 0) {
		for (const window of windows) {
			query = compileWindowSelect(query, window, rootAlias);
		}
	}

	// Apply JOIN filters for filter-strategy: 'join' (before WHERE clause)
	// This adds INNER JOINs for relation filters that the planner decided to use JOIN
	if (intent.where) {
		query = applyJoinFilters(
			query,
			intent.where,
			plan,
			model,
			state,
			rootTable,
			rootAlias,
			schemaName,
		);
	}

	// Apply LEFT JOINs for include-strategy: 'join' (CORE-001)
	// This adds LEFT JOINs for includes that the planner decided to use JOIN
	if (intent.include) {
		query = applyIncludeJoins(
			query,
			intent.include,
			plan,
			model,
			state,
			rootTable,
			rootAlias,
			schemaName,
		);

		// Add SELECT columns for included relations
		query = addIncludeSelectColumns(query, state, model);
	}

	// Add WHERE clause
	if (intent.where) {
		query = addWhere(
			query,
			intent.where,
			rootAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// Add GROUP BY
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const field of intent.groupBy) {
			query = query.groupBy(`${rootAlias}.${field}`);
		}
	}

	// Add ORDER BY
	if (intent.orderBy) {
		for (const order of intent.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			query = query.orderBy(`${rootAlias}.${order.field}`, direction);
		}
	}

	// Add LIMIT
	if (intent.limit !== undefined) {
		query = query.limit(intent.limit);
	}

	// Add OFFSET
	if (intent.offset !== undefined) {
		query = query.offset(intent.offset);
	}

	return query.compile();
}

// ============================================================================
// Mutation Compilers (DX-010)
// ============================================================================

/**
 * Compile an InsertIntent into a Kysely CompiledQuery.
 * Supports single and bulk inserts with multi-tenant schema prefix.
 * DX-026: Supports RETURNING clause.
 */
export function compileInsert(
	intent: InsertIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the INSERT query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely
		.insertInto(tableName)
		.values(intent.values as Record<string, unknown>[]);

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile an UpdateIntent into a Kysely CompiledQuery.
 * Requires WHERE clause unless allowAll is explicitly true.
 * DX-026: Supports RETURNING clause.
 */
export function compileUpdate(
	intent: UpdateIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	// Safety check: require WHERE unless allowAll is true
	if (!intent.where && !intent.allowAll) {
		throw new CompilationError(
			'UPDATE without WHERE clause is unsafe. Use allowAll: true to explicitly allow.',
		);
	}

	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the UPDATE query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely.updateTable(tableName).set(intent.set);

	// Add WHERE clause if present
	if (intent.where) {
		query = addMutationWhere(query, intent.where);
	}

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile a DeleteIntent into a Kysely CompiledQuery.
 * Requires WHERE clause unless allowAll is explicitly true.
 * Note: Cascade handling is application-level (not SQL CASCADE).
 * DX-026: Supports RETURNING clause.
 */
export function compileDelete(
	intent: DeleteIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	// Safety check: require WHERE unless allowAll is true
	if (!intent.where && !intent.allowAll) {
		throw new CompilationError(
			'DELETE without WHERE clause is unsafe. Use allowAll: true to explicitly allow.',
		);
	}

	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the DELETE query
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely.deleteFrom(tableName);

	// Add WHERE clause if present
	if (intent.where) {
		query = addMutationWhere(query, intent.where);
	}

	// DX-026: Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Compile an UpsertIntent into a Kysely CompiledQuery (DX-026).
 * Implements INSERT ... ON CONFLICT ... DO UPDATE/NOTHING pattern.
 * Supports RETURNING clause.
 */
export function compileUpsert(
	intent: UpsertIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const tableName = schemaName ? `${schemaName}.${intent.table}` : intent.table;

	// Build the INSERT part
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let query: any = kysely
		.insertInto(tableName)
		.values(intent.values as Record<string, unknown>[]);

	// Add ON CONFLICT clause
	// biome-ignore lint/suspicious/noExplicitAny: Kysely's onConflict callback requires any for builder chaining
	query = query.onConflict((oc: any) => {
		// Set conflict target (columns or constraint)
		if ('columns' in intent.onConflict) {
			oc = oc.columns(intent.onConflict.columns as string[]);
		} else {
			oc = oc.constraint(intent.onConflict.constraint);
		}

		// Set action (doNothing or doUpdate)
		if (intent.action.type === 'doNothing') {
			return oc.doNothing();
		}

		// doUpdate action
		if (intent.action.set) {
			// Use provided set values
			oc = oc.doUpdateSet(intent.action.set);
		} else {
			// Update all non-conflict columns from the excluded row
			// Get all keys from the first value object
			const allKeys = Object.keys(intent.values[0] || {});
			const conflictColumns =
				'columns' in intent.onConflict ? intent.onConflict.columns : [];
			const updateKeys = allKeys.filter(
				(k) => !(conflictColumns as readonly string[]).includes(k),
			);

			if (updateKeys.length > 0) {
				// biome-ignore lint/suspicious/noExplicitAny: Kysely's doUpdateSet accepts Record<string, any>
				const updateSet: Record<string, any> = {};
				for (const key of updateKeys) {
					// Reference the excluded row
					updateSet[key] = sql.ref(`excluded.${key}`);
				}
				oc = oc.doUpdateSet(updateSet);
			} else {
				// All columns are conflict columns, nothing to update
				return oc.doNothing();
			}
		}

		// Add WHERE clause if present on doUpdate
		if (intent.action.type === 'doUpdate' && intent.action.where) {
			oc = addOnConflictWhere(oc, intent.action.where);
		}

		return oc;
	});

	// Add RETURNING clause if specified
	if (intent.returning && intent.returning.length > 0) {
		query = query.returning(intent.returning as string[]);
	}

	return query.compile();
}

/**
 * Add WHERE clause to ON CONFLICT DO UPDATE.
 * Similar to addMutationWhere but for conflict context.
 */
function addOnConflictWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	oc: any,
	where: WhereIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): any {
	// Handle comparison operators
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		switch (w.operator) {
			case 'eq':
				return oc.where(w.field, '=', w.value);
			case 'neq':
				return oc.where(w.field, '!=', w.value);
			case 'gt':
				return oc.where(w.field, '>', w.value);
			case 'gte':
				return oc.where(w.field, '>=', w.value);
			case 'lt':
				return oc.where(w.field, '<', w.value);
			case 'lte':
				return oc.where(w.field, '<=', w.value);
			default:
				return oc;
		}
	}

	// Handle AND
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = oc;
		for (const condition of w.conditions) {
			result = addOnConflictWhere(result, condition);
		}
		return result;
	}

	return oc;
}

/**
 * Add WHERE clause to UPDATE/DELETE mutation queries.
 * Simplified version that doesn't require table aliases.
 */
function addMutationWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: any,
	where: WhereIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): any {
	// Handle comparison operators
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		switch (w.operator) {
			case 'eq':
				return query.where(w.field, '=', w.value);
			case 'neq':
				return query.where(w.field, '!=', w.value);
			case 'gt':
				return query.where(w.field, '>', w.value);
			case 'gte':
				return query.where(w.field, '>=', w.value);
			case 'lt':
				return query.where(w.field, '<', w.value);
			case 'lte':
				return query.where(w.field, '<=', w.value);
			default:
				return query;
		}
	}

	// Handle like
	if ('kind' in where && where.kind === 'like') {
		const w = where as { kind: 'like'; field: string; pattern: string };
		return query.where(w.field, 'like', w.pattern);
	}

	// Handle in
	if ('kind' in where && where.kind === 'in') {
		const w = where as { kind: 'in'; field: string; values: unknown[] };
		return query.where(w.field, 'in', w.values);
	}

	// Handle null
	if ('kind' in where && where.kind === 'null') {
		const w = where as {
			kind: 'null';
			field: string;
			operator: 'isNull' | 'isNotNull';
		};
		if (w.operator === 'isNull') {
			return query.where(w.field, 'is', null);
		}
		return query.where(w.field, 'is not', null);
	}

	// Handle AND
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = query;
		for (const condition of w.conditions) {
			result = addMutationWhere(result, condition);
		}
		return result;
	}

	// Handle OR - requires expression builder for proper grouping
	if ('kind' in where && where.kind === 'or') {
		const w = where as { kind: 'or'; conditions: WhereIntent[] };
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic WHERE building
		return (query as any).where((eb: any) => {
			const ors = w.conditions.map((c) => {
				if ('kind' in c && c.kind === 'comparison') {
					const cmp = c as {
						kind: 'comparison';
						field: string;
						operator: string;
						value: unknown;
					};
					if (cmp.operator === 'eq') return eb(cmp.field, '=', cmp.value);
					if (cmp.operator === 'neq') return eb(cmp.field, '!=', cmp.value);
					if (cmp.operator === 'gt') return eb(cmp.field, '>', cmp.value);
					if (cmp.operator === 'gte') return eb(cmp.field, '>=', cmp.value);
					if (cmp.operator === 'lt') return eb(cmp.field, '<', cmp.value);
					if (cmp.operator === 'lte') return eb(cmp.field, '<=', cmp.value);
				}
				return eb.lit(true); // Fallback
			});
			return eb.or(ors);
		});
	}

	return query;
}

// ============================================================================
// Recursive CTE Compiler (RFC-001)
// ============================================================================

/**
 * Compile a RecursivePlanReport into a Kysely CompiledQuery.
 * Per RFC-001: Uses native Kysely APIs, NEVER raw SQL.
 */
export function compileRecursive(
	plan: RecursivePlanReport,
	_model: ModelIR, // Reserved for future use (e.g., relation metadata lookups)
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	kysely: Kysely<any>,
	schemaName?: string,
): CompiledQuery {
	const intent = plan.intent;
	const cteName = intent.cteName;

	// ARCH-001: Detect dialect capabilities for path tracking strategy
	const dialect = detectDialect(kysely);
	const capabilities = getCapabilitiesForDialect(dialect);

	// Determine if we need UNION (distinct) or UNION ALL
	const bidirectionalDecision = plan.decisions.find(
		(d: { type: string; choice: string }) => d.type === 'bidirectional-edges',
	);
	const useUnionAll = bidirectionalDecision?.choice !== 'union';

	// Build column list for CTE definition
	const cteColumns = buildCteColumnList(intent);
	const cteNameWithColumns = `${cteName}(${cteColumns.join(', ')})`;

	// Build the recursive CTE
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building requires any
	let builder: any = kysely;

	// Use withRecursive for the recursive CTE
	builder = builder.withRecursive(
		cteNameWithColumns,
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE callback
		(db: Kysely<any>) => {
			// Build base case (anchor)
			const baseQuery = buildRecursiveBaseCase(
				intent,
				db,
				schemaName,
				capabilities,
				dialect,
			);

			// Build recursive case
			const recursiveQuery = buildRecursiveStep(
				intent,
				db,
				cteName,
				schemaName,
				capabilities,
				dialect,
			);

			// Combine with UNION or UNION ALL
			if (useUnionAll) {
				return baseQuery.unionAll(recursiveQuery);
			}
			return baseQuery.union(recursiveQuery);
		},
	);

	// Build the final SELECT from the CTE
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	let finalQuery: any = builder.selectFrom(`${cteName} as ${cteName}`);

	// DX-005: Apply emit.joinWith for CTE composition
	const joinAliases: string[] = [cteName];
	if (intent.emit?.joinWith && intent.emit.joinWith.length > 0) {
		finalQuery = compileEmitJoins(
			finalQuery,
			intent.emit.joinWith,
			joinAliases,
			schemaName,
		);
	}

	// Build SELECT clause
	finalQuery = buildEmitSelect(finalQuery, intent, joinAliases);

	// DX-005: Apply emit.distinct
	if (intent.emit?.distinct) {
		finalQuery = finalQuery.distinct();
	}

	// Apply dedupe strategy (DISTINCT ON - PostgreSQL specific)
	if (intent.dedupe === 'final' && !intent.emit?.distinct) {
		// Per RFC-001: 1 row per nodeId, keep first (shallowest depth)
		const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);
		finalQuery = finalQuery.distinctOn(nodeIdAlias);
		// Order by node_id, depth to ensure we get shallowest first
		if (intent.track?.depth) {
			finalQuery = finalQuery.orderBy(nodeIdAlias).orderBy('depth');
		} else {
			finalQuery = finalQuery.orderBy(nodeIdAlias);
		}
	}

	// Apply emit filters if specified
	if (intent.emit?.where) {
		// Apply custom WHERE filter on final results
		finalQuery = addWhereSimple(finalQuery, intent.emit.where, cteName);
	}

	// Apply ordering from emit options
	if (intent.emit?.orderBy) {
		for (const order of intent.emit.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			finalQuery = finalQuery.orderBy(order.field, direction);
		}
	}

	// Compile the query
	const compiled = finalQuery.compile();

	// CORE-007: Apply CYCLE/SEARCH clauses if advancedOptions specified and supported
	if (intent.advancedOptions && capabilities.supportsCycleDetection) {
		return injectAdvancedRecursiveClauses(
			compiled,
			intent.advancedOptions,
			cteName,
			getNodeIdAlias(intent.start.nodeIdExpr),
			capabilities,
		);
	}

	return compiled;
}

/**
 * CORE-007: Inject PostgreSQL 14+ CYCLE and SEARCH clauses into compiled SQL.
 *
 * These clauses are added after the CTE definition but before the final SELECT:
 * ```sql
 * WITH RECURSIVE cte(cols) AS (...)
 * CYCLE node_id SET is_cycle USING path
 * SEARCH DEPTH FIRST BY node_id SET ordercol
 * SELECT ... FROM cte
 * ```
 */
/** @internal exported for testing */
export function injectAdvancedRecursiveClauses(
	compiled: CompiledQuery,
	options: RecursiveAdvancedOptions,
	_cteName: string, // Reserved for future use
	nodeIdColumn: string,
	capabilities: AdapterDialectCapabilities,
): CompiledQuery {
	let sql = compiled.sql;
	const clauses: string[] = [];

	// Build CYCLE clause if cycle detection is requested
	if (options.cycle && capabilities.supportsCycleDetection) {
		// CYCLE column_list SET is_cycle USING path
		// - 'mark' mode adds is_cycle column (standard CYCLE behavior)
		// - 'stop' mode is implicit (CYCLE stops traversal by default)
		// - 'error' mode would need application-level handling (throw on is_cycle=true)
		clauses.push(`CYCLE ${nodeIdColumn} SET is_cycle USING path`);
	}

	// Build SEARCH clause if search order is requested
	if (options.search && capabilities.supportsSearchClause) {
		const searchType =
			options.search === 'depth' ? 'DEPTH FIRST' : 'BREADTH FIRST';
		clauses.push(`SEARCH ${searchType} BY ${nodeIdColumn} SET ordercol`);
	}

	if (clauses.length === 0) {
		return compiled;
	}

	// Find the position to inject clauses: after the CTE definition's closing )
	// Pattern: ") SELECT" or ") select" (case-insensitive)
	// We need to find the last ) before SELECT that closes the CTE
	const cteClosePattern = /\)\s*SELECT/i;
	const match = sql.match(cteClosePattern);

	if (match?.index !== undefined) {
		const clauseText = ` ${clauses.join(' ')} `;
		const insertPos = match.index + 1; // After the )
		sql = sql.slice(0, insertPos) + clauseText + sql.slice(insertPos);
	}

	return {
		...compiled,
		sql,
	};
}

/**
 * Build the list of columns for the CTE definition.
 */
function buildCteColumnList(intent: RecursiveIntent): string[] {
	const columns: string[] = [];

	// node_id is always first
	columns.push(getNodeIdAlias(intent.start.nodeIdExpr));

	// select fields (if specified)
	if (intent.start.select) {
		columns.push(...intent.start.select);
	}

	// tracked columns
	if (intent.track?.depth) {
		columns.push('depth');
	}
	if (intent.track?.path) {
		columns.push('path');
	}

	return columns;
}

/**
 * Get the alias for the node_id expression.
 */
function getNodeIdAlias(expr: RecursiveNodeIdExpr): string {
	if (expr.as) return expr.as;
	if (expr.kind === 'column') return expr.name;
	return 'node_id';
}

/**
 * Build the base case (anchor) of the recursive CTE.
 */
function buildRecursiveBaseCase(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const startTable = schemaName
		? `${schemaName}.${intent.start.from}`
		: intent.start.from;

	let query = db.selectFrom(`${startTable} as t0`);

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id expression
		const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);
		if (intent.start.nodeIdExpr.kind === 'column') {
			selections.push(
				eb.ref(`t0.${intent.start.nodeIdExpr.name}`).as(nodeIdAlias),
			);
		} else if (intent.start.nodeIdExpr.kind === 'literal') {
			selections.push(eb.val(intent.start.nodeIdExpr.value).as(nodeIdAlias));
		}
		// Binary expressions would need more complex handling

		// Additional select fields
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`t0.${field}`).as(field));
			}
		}

		// Tracked columns - base case initializations
		if (intent.track?.depth) {
			selections.push(eb.lit(0).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			if (intent.start.nodeIdExpr.kind === 'column') {
				const columnRef = `t0.${intent.start.nodeIdExpr.name}`;
				// Get core capabilities for path tracking SQL generation
				const coreCapabilities = getCoreCapabilitiesForDialect(
					dialect as DialectName,
				);
				selections.push(
					compilePathTrackingBaseCase(
						eb,
						columnRef,
						intent.track.path,
						coreCapabilities,
						dialect,
					),
				);
			}
		}

		return selections;
	});

	// Apply start WHERE clause
	if (intent.start.where) {
		query = addWhereSimple(query, intent.start.where, 't0');
	}

	return query;
}

/**
 * Build the recursive step of the CTE.
 */
function buildRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	schemaName: string | undefined,
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const traversal = intent.traversal;
	const nodeIdAlias = getNodeIdAlias(intent.start.nodeIdExpr);

	if (isAdjacencyTraversal(traversal)) {
		return buildAdjacencyRecursiveStep(
			intent,
			db,
			cteName,
			traversal,
			nodeIdAlias,
			schemaName,
			capabilities,
			dialect,
		);
	}

	if (isEdgeTableTraversal(traversal)) {
		return buildEdgeTableRecursiveStep(
			intent,
			db,
			cteName,
			traversal,
			nodeIdAlias,
			schemaName,
			capabilities,
			dialect,
		);
	}

	throw new CompilationError(
		`Unsupported traversal kind: ${traversal.kind}`,
		'recursive-step',
	);
}

/**
 * Build recursive step for adjacency-list traversal (self-referential parent_id).
 */
function buildAdjacencyRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	traversal: Extract<RecursiveIntent['traversal'], { kind: 'adjacency' }>,
	nodeIdAlias: string,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;

	// Join CTE with node table
	// For descendants: prev.node_id = node.parent_id
	// For ancestors: prev.node_id = node.id AND node.parent_id = prev.node_id
	let query = db.selectFrom(`${cteName} as prev`);

	if (traversal.direction === 'descendants') {
		// Find children: node.parent_id = prev.node_id
		query = query.innerJoin(`${nodeTable} as node`, (join) =>
			join.onRef(`node.${traversal.parentId}`, '=', `prev.${nodeIdAlias}`),
		);
	} else {
		// Find parents: prev.parent_id = node.id (ancestors)
		query = query.innerJoin(`${nodeTable} as node`, (join) =>
			join.onRef(`prev.${traversal.parentId}`, '=', `node.${traversal.nodeId}`),
		);
	}

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id from the joined table
		selections.push(eb.ref(`node.${traversal.nodeId}`).as(nodeIdAlias));

		// Additional select fields
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`node.${field}`).as(field));
			}
		}

		// Tracked columns - recursive expressions
		if (intent.track?.depth) {
			// depth = prev.depth + 1, using native Kysely expression builder
			selections.push(eb('prev.depth', '+', eb.lit(1)).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			const nodeColumnRef = `node.${traversal.nodeId}`;
			// Get core capabilities for path tracking SQL generation
			const coreCapabilities = getCoreCapabilitiesForDialect(
				dialect as DialectName,
			);
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					coreCapabilities,
					dialect,
				),
			);
		}

		return selections;
	});

	// Apply maxDepth constraint
	if (intent.track?.depth && intent.maxDepth > 0) {
		query = query.where('prev.depth', '<', intent.maxDepth);
	}

	// Apply step WHERE clause
	if (traversal.stepWhere) {
		query = addWhereSimple(query, traversal.stepWhere, 'node');
	}

	return query;
}

/**
 * Build recursive step for edge-table traversal (separate join table).
 */
function buildEdgeTableRecursiveStep(
	intent: RecursiveIntent,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	db: Kysely<any>,
	cteName: string,
	traversal: Extract<RecursiveIntent['traversal'], { kind: 'edge-table' }>,
	nodeIdAlias: string,
	schemaName: string | undefined,
	// biome-ignore lint/correctness/noUnusedFunctionParameters: passed for API consistency
	capabilities: AdapterDialectCapabilities,
	dialect: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const nodeTable = schemaName
		? `${schemaName}.${traversal.nodeTable}`
		: traversal.nodeTable;
	const edgeTable = schemaName
		? `${schemaName}.${traversal.edgeTable}`
		: traversal.edgeTable;

	// Start from CTE
	let query = db.selectFrom(`${cteName} as prev`);

	// Join with edge table and node table based on direction
	if (traversal.direction === 'out') {
		// Outgoing edges: prev -> edge.from -> edge.to -> node
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeFrom}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(`node.${traversal.nodeId}`, '=', `edge.${traversal.edgeTo}`),
			);
	} else if (traversal.direction === 'in') {
		// Incoming edges: prev <- edge.to <- edge.from <- node
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeTo}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(
					`node.${traversal.nodeId}`,
					'=',
					`edge.${traversal.edgeFrom}`,
				),
			);
	} else {
		// Both directions: handled by UNION in the calling code
		// Here we just do outgoing, the UNION handles combining both
		query = query
			.innerJoin(`${edgeTable} as edge`, (join) =>
				join.onRef(`edge.${traversal.edgeFrom}`, '=', `prev.${nodeIdAlias}`),
			)
			.innerJoin(`${nodeTable} as node`, (join) =>
				join.onRef(`node.${traversal.nodeId}`, '=', `edge.${traversal.edgeTo}`),
			);
	}

	// Build SELECT clause
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic select expressions
	query = query.select((eb: any) => {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic selections array
		const selections: any[] = [];

		// node_id from the joined node table
		selections.push(eb.ref(`node.${traversal.nodeId}`).as(nodeIdAlias));

		// Additional select fields from node table
		if (intent.start.select) {
			for (const field of intent.start.select) {
				selections.push(eb.ref(`node.${field}`).as(field));
			}
		}

		// Tracked columns - recursive expressions
		if (intent.track?.depth) {
			selections.push(eb('prev.depth', '+', eb.lit(1)).as('depth'));
		}
		if (intent.track?.path) {
			// ARCH-001: Use dialect-agnostic path tracking
			const nodeColumnRef = `node.${traversal.nodeId}`;
			// Get core capabilities for path tracking SQL generation
			const coreCapabilities = getCoreCapabilitiesForDialect(
				dialect as DialectName,
			);
			selections.push(
				compilePathTrackingRecursive(
					eb,
					nodeColumnRef,
					intent.track.path,
					coreCapabilities,
					dialect,
				),
			);
		}

		return selections;
	});

	// Apply maxDepth constraint
	if (intent.track?.depth && intent.maxDepth > 0) {
		query = query.where('prev.depth', '<', intent.maxDepth);
	}

	// Apply edge WHERE clause
	if (traversal.edgeWhere) {
		query = addWhereSimple(query, traversal.edgeWhere, 'edge');
	}

	// Apply node WHERE clause
	if (traversal.nodeWhere) {
		query = addWhereSimple(query, traversal.nodeWhere, 'node');
	}

	return query;
}

/**
 * Simplified WHERE clause builder for recursive CTEs.
 * Handles basic comparisons without the full complexity of the main addWhere.
 */
function addWhereSimple(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	// Handle comparison operators (WhereComparisonIntent has kind='comparison', field, operator, value)
	if ('kind' in where && where.kind === 'comparison') {
		const w = where as {
			kind: 'comparison';
			field: string;
			operator: string;
			value: unknown;
		};
		const fieldRef = `${alias}.${w.field}`;
		switch (w.operator) {
			case 'eq':
				return query.where(fieldRef, '=', w.value);
			case 'neq':
				return query.where(fieldRef, '!=', w.value);
			case 'gt':
				return query.where(fieldRef, '>', w.value);
			case 'gte':
				return query.where(fieldRef, '>=', w.value);
			case 'lt':
				return query.where(fieldRef, '<', w.value);
			case 'lte':
				return query.where(fieldRef, '<=', w.value);
			default:
				return query;
		}
	}

	// Handle like (WhereLikeIntent has kind='like')
	if ('kind' in where && where.kind === 'like') {
		const w = where as {
			kind: 'like';
			field: string;
			pattern: string;
			caseInsensitive?: boolean;
		};
		return w.caseInsensitive
			? query.where(`${alias}.${w.field}`, 'ilike', w.pattern)
			: query.where(`${alias}.${w.field}`, 'like', w.pattern);
	}

	// Handle in (WhereInIntent has kind='in')
	if ('kind' in where && where.kind === 'in') {
		const w = where as { kind: 'in'; field: string; values: unknown[] };
		return query.where(`${alias}.${w.field}`, 'in', w.values);
	}

	// Handle null (WhereNullIntent has kind='null')
	if ('kind' in where && where.kind === 'null') {
		const w = where as {
			kind: 'null';
			field: string;
			operator: 'isNull' | 'isNotNull';
		};
		if (w.operator === 'isNull') {
			return query.where(`${alias}.${w.field}`, 'is', null);
		}
		return query.where(`${alias}.${w.field}`, 'is not', null);
	}

	// Handle AND (WhereAndIntent has kind='and')
	if ('kind' in where && where.kind === 'and') {
		const w = where as { kind: 'and'; conditions: WhereIntent[] };
		let result = query;
		for (const condition of w.conditions) {
			result = addWhereSimple(result, condition, alias);
		}
		return result;
	}

	// Handle OR (WhereOrIntent has kind='or')
	if ('kind' in where && where.kind === 'or') {
		const w = where as { kind: 'or'; conditions: WhereIntent[] };
		return query.where((eb) => {
			const ors = w.conditions.map((c) => {
				if ('kind' in c && 'field' in c) {
					const col = `${alias}.${c.field as string}`;
					switch (c.kind) {
						case 'comparison': {
							const cmp = c as { operator: string; value: unknown };
							switch (cmp.operator) {
								case 'eq':
									return eb(col, '=', cmp.value);
								case 'neq':
									return eb(col, '!=', cmp.value);
								case 'gt':
									return eb(col, '>', cmp.value);
								case 'gte':
									return eb(col, '>=', cmp.value);
								case 'lt':
									return eb(col, '<', cmp.value);
								case 'lte':
									return eb(col, '<=', cmp.value);
								default:
									return eb.lit(true);
							}
						}
						case 'like': {
							const like = c as { pattern: string; caseInsensitive?: boolean };
							return like.caseInsensitive
								? eb(col, 'ilike', like.pattern)
								: eb(col, 'like', like.pattern);
						}
						case 'in': {
							const inC = c as { values: readonly unknown[] };
							if (inC.values.length === 0) {
								return eb.lit(false);
							}
							return eb(col, 'in', [...inC.values]);
						}
						case 'null': {
							const nullC = c as { operator: 'isNull' | 'isNotNull' };
							return nullC.operator === 'isNull'
								? eb(col, 'is', null)
								: eb(col, 'is not', null);
						}
					}
				}
				return eb.lit(true); // Fallback
			});
			return eb.or(ors);
		});
	}

	return query;
}

// ============================================================================
// Query Building
// ============================================================================

function buildBaseQuery(
	intent: QueryIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const tableName = schemaName ? `${schemaName}.${intent.from}` : intent.from;

	// Start with FROM
	let query = kysely.selectFrom(`${tableName} as ${alias}`);

	// Add SELECT
	if (!intent.select || intent.select.type === 'all') {
		query = query.selectAll(alias);
	} else if (isSelectAggregate(intent.select)) {
		// Handle aggregate select
		query = buildAggregateSelect(query, intent.select, alias);
	} else if (isSelectWithExpressions(intent.select)) {
		// Handle select with expressions (COALESCE, etc.)
		query = buildSelectWithExpressions(query, intent.select, alias);
	} else {
		const fields = intent.select.fields.map((f: string) => `${alias}.${f}`);
		query = query.select(fields);
	}

	return query;
}

/**
 * Build aggregate SELECT expressions
 */
function buildAggregateSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	select: SelectAggregateIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	let result = query;

	// Add non-aggregate fields first (for GROUP BY)
	if (select.fields && select.fields.length > 0) {
		const fields = select.fields.map((f: string) => `${alias}.${f}`);
		result = result.select(fields);
	}

	// Add aggregate expressions
	for (const agg of select.aggregates) {
		result = addAggregateExpression(result, agg, alias);
	}

	return result;
}

/**
 * Add a single aggregate expression to the query
 */
function addAggregateExpression(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	agg: AggregateIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const column = agg.field ? `${alias}.${agg.field}` : null;
	const resultAlias =
		agg.as ?? `${agg.function}${agg.field ? `_${agg.field}` : ''}`;

	switch (agg.function) {
		case 'count':
			if (column) {
				return query.select((eb) => eb.fn.count(column).as(resultAlias));
			}
			// COUNT(*) - count all rows
			return query.select((eb) => eb.fn.countAll().as(resultAlias));

		case 'sum':
			if (!column) {
				throw new CompilationError('SUM requires a field');
			}
			return query.select((eb) => eb.fn.sum(column).as(resultAlias));

		case 'avg':
			if (!column) {
				throw new CompilationError('AVG requires a field');
			}
			return query.select((eb) => eb.fn.avg(column).as(resultAlias));

		case 'min':
			if (!column) {
				throw new CompilationError('MIN requires a field');
			}
			return query.select((eb) => eb.fn.min(column).as(resultAlias));

		case 'max':
			if (!column) {
				throw new CompilationError('MAX requires a field');
			}
			return query.select((eb) => eb.fn.max(column).as(resultAlias));

		default:
			throw new CompilationError(`Unknown aggregate function: ${agg.function}`);
	}
}

// ============================================================================
// Expression Compilation (COALESCE, etc.)
// ============================================================================

/**
 * Build SELECT with expressions (COALESCE, raw, etc.)
 */
function buildSelectWithExpressions(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	select: SelectWithExpressionsIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	let result = query;

	// Add regular fields first
	if (select.fields && select.fields.length > 0) {
		const fields = select.fields.map((f: string) => `${alias}.${f}`);
		result = result.select(fields);
	}

	// Add expressions
	for (const expr of select.expressions) {
		result = addExpressionSelect(result, expr, alias);
	}

	return result;
}

/**
 * Add a single expression to the SELECT clause
 */
function addExpressionSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	expr: ExpressionIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	switch (expr.kind) {
		case 'coalesce':
			return compileCoalesceSelect(query, expr.fields, expr.as, alias);

		case 'raw':
			// Raw SQL expression - use with caution!
			return query.select(sql`${sql.raw(expr.sql)}`.as(expr.as));

		case 'window':
			// Window function expression (DX-021)
			return compileWindowSelect(query, expr, alias);

		default:
			throw new CompilationError(
				`Unknown expression kind: ${(expr as ExpressionIntent).kind}`,
			);
	}
}

/**
 * Compile COALESCE expression for SELECT
 * COALESCE(field1, field2, ...) AS alias
 */
function compileCoalesceSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	fields: readonly string[],
	resultAlias: string,
	tableAlias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (fields.length === 0) {
		throw new CompilationError('COALESCE requires at least one field');
	}

	// Build COALESCE(t0.field1, t0.field2, ...) using Kysely's native expression builder
	return query.select((eb) =>
		eb
			.fn(
				'coalesce',
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic column references
				fields.map((f) => eb.ref(`${tableAlias}.${f}` as any)),
			)
			.as(resultAlias),
	);
}

// ============================================================================
// Window Function Compiler (P3-A)
// ============================================================================

/**
 * Compile a WindowIntent into a SQL window function expression.
 *
 * Produces SQL like:
 * - ROW_NUMBER() OVER (PARTITION BY "category_id" ORDER BY "price" DESC) AS "rn"
 * - SUM("amount") OVER (PARTITION BY "account_id" ORDER BY "date") AS "running_total"
 *
 * @param query - The current query builder
 * @param window - The window intent to compile
 * @param tableAlias - The table alias for column references
 * @returns The query with window function added to SELECT
 */
export function compileWindowSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	window: WindowIntent,
	tableAlias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const { function: fn, field, alias, over } = window;

	// Build the OVER clause parts
	const partitionByParts = over.partitionBy?.length
		? over.partitionBy.map((col) => `"${col}"`).join(', ')
		: '';

	const orderByParts = over.orderBy?.length
		? over.orderBy
				.map((o) => {
					const dir = o.direction?.toUpperCase() ?? 'ASC';
					return `"${o.field}" ${dir}`;
				})
				.join(', ')
		: '';

	// Build OVER clause
	const overParts: string[] = [];
	if (partitionByParts) {
		overParts.push(`PARTITION BY ${partitionByParts}`);
	}
	if (orderByParts) {
		overParts.push(`ORDER BY ${orderByParts}`);
	}
	const overClause = overParts.length ? overParts.join(' ') : '';

	// Build the function call
	let functionCall: string;
	if (isAggregateWindowFunction(fn)) {
		// Aggregate window functions: SUM("field"), AVG("field"), etc.
		if (!field) {
			throw new CompilationError(
				`Window function '${fn}' requires a field parameter`,
			);
		}
		functionCall = `${fn.toUpperCase()}("${tableAlias}"."${field}")`;
	} else {
		// Ranking functions: ROW_NUMBER(), RANK(), DENSE_RANK()
		functionCall = `${fn.toUpperCase()}()`;
	}

	// Build the full expression: FUNCTION() OVER (...) AS "alias"
	const fullExpr = overClause
		? `${functionCall} OVER (${overClause})`
		: `${functionCall} OVER ()`;

	// Use sql template tag to add the window function as a select expression
	return query.select(sql<unknown>`${sql.raw(fullExpr)}`.as(alias));
}

// ============================================================================
// WHERE Compilation
// ============================================================================

function addWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	return query.where((eb) =>
		compileWhere(eb, where, alias, model, plan, state, schemaName),
	);
}

function compileWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	switch (where.kind) {
		case 'comparison':
			return compileComparison(eb, where, alias);

		case 'like':
			return where.caseInsensitive
				? eb(`${alias}.${where.field}`, 'ilike', where.pattern)
				: eb(`${alias}.${where.field}`, 'like', where.pattern);

		case 'in':
			// Empty IN is always false (no values can match)
			if (where.values.length === 0) {
				return eb.lit(false);
			}
			return eb(`${alias}.${where.field}`, 'in', where.values);

		case 'null':
			if (where.operator === 'isNull') {
				return eb(`${alias}.${where.field}`, 'is', null);
			}
			return eb(`${alias}.${where.field}`, 'is not', null);

		case 'and':
			// Empty AND is always true (no conditions to fail)
			if (where.conditions.length === 0) {
				return eb.lit(true);
			}
			return eb.and(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state, schemaName),
				),
			);

		case 'or':
			// Empty OR is always false (no conditions can pass)
			if (where.conditions.length === 0) {
				return eb.lit(false);
			}
			return eb.or(
				where.conditions.map((c: WhereIntent) =>
					compileWhere(eb, c, alias, model, plan, state, schemaName),
				),
			);

		case 'not':
			return eb.not(
				compileWhere(
					eb,
					where.condition,
					alias,
					model,
					plan,
					state,
					schemaName,
				),
			);

		case 'exists':
			// Check if relation was already JOINed via filter-strategy: 'join'
			if (state.joinedFilterRelations.has(where.relation)) {
				return compileJoinedRelationConditions(
					eb,
					{
						relation: where.relation,
						...(where.where !== undefined && { where: where.where }),
						mode: 'some',
					},
					alias,
					model,
					plan,
					state,
					schemaName,
				);
			}
			return compileExists(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				false,
				schemaName,
			);

		case 'notExists':
			// Check if relation was already JOINed via filter-strategy: 'join'
			if (state.joinedFilterRelations.has(where.relation)) {
				return compileJoinedRelationConditions(
					eb,
					{
						relation: where.relation,
						...(where.where !== undefined && { where: where.where }),
						mode: 'none',
					},
					alias,
					model,
					plan,
					state,
					schemaName,
				);
			}
			return compileExists(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				true,
				schemaName,
			);

		case 'relationFilter':
			return compileRelationFilter(
				eb,
				where,
				alias,
				model,
				plan,
				state,
				schemaName,
			);

		case 'subquery':
			return compileSubquery(eb, where, alias, model, plan, state, schemaName);

		default:
			throw new CompilationError(
				`Unknown where kind: ${(where as WhereIntent).kind}`,
			);
	}
}

function compileComparison(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		kind: 'comparison';
		field: string;
		operator: string;
		value: unknown;
	},
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const column = `${alias}.${where.field}`;

	switch (where.operator) {
		case 'eq':
			return eb(column, '=', where.value);
		case 'neq':
			return eb(column, '!=', where.value);
		case 'gt':
			return eb(column, '>', where.value);
		case 'gte':
			return eb(column, '>=', where.value);
		case 'lt':
			return eb(column, '<', where.value);
		case 'lte':
			return eb(column, '<=', where.value);
		default:
			throw new CompilationError(
				`Unknown comparison operator: ${where.operator}`,
			);
	}
}

// ============================================================================
// EXISTS Compilation
// ============================================================================

function compileExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: { relation: string; where?: WhereIntent },
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	negate: boolean,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// Find the relation
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;

	// Try direct lookup first
	let relation = model.getRelation(`${sourceTable}.${where.relation}`);

	// If not found, check if planner resolved it to a different relation name
	// This happens when disambiguate option is used
	if (!relation) {
		// Look for planner decision that resolved this relation
		const decision = plan.decisions.find(
			(d) =>
				d.type === 'filter-strategy' &&
				d.context.sourceTable === sourceTable &&
				d.context.target === where.relation,
		);
		if (decision?.context.relation) {
			relation = model.getRelation(
				`${sourceTable}.${decision.context.relation}`,
			);
		}
	}

	// Also try to find relation by target table (for ambiguous cases resolved by planner)
	if (!relation) {
		const relationsFromSource = model.getRelationsFrom(sourceTable);
		const byTarget = relationsFromSource.filter(
			(r) => r.target === where.relation,
		);
		if (byTarget.length === 1) {
			// Unambiguous - only one relation to target
			relation = byTarget[0];
		}
	}

	if (!relation) {
		throw new CompilationError(
			`Unknown relation: ${sourceTable}.${where.relation}`,
		);
	}

	// Get alias for related table
	const relatedAlias = getNextAlias(state);
	state.tableAliases.set(`${relation.target}_${relatedAlias}`, relatedAlias);

	// Get source table's primary key (supports composite)
	const sourceTableDef = model.getTable(relation.source);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

	// Get target table's primary key (supports composite)
	const targetTableDef = model.getTable(relation.target);
	const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);

	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	let subquery: any;

	// Handle M:N (belongsToMany) with through table
	if (relation.through) {
		// M:N EXISTS: SELECT 1 FROM junction JOIN target WHERE junction.fk = source.pk AND target.<conditions>
		const junctionAlias = getNextAlias(state);
		const targetAlias = relatedAlias;

		// FK from junction to source (default: {source}Id) - supports composite keys
		const fkCols = normalizeForeignKey(
			relation.foreignKey,
			`${relation.source}Id`,
		);

		// FK from junction to target (default: {target}Id)
		const otherKey = relation.otherKey ?? `${relation.target}Id`;

		// Apply schema prefix
		const junctionTable = schemaName
			? `${schemaName}.${relation.through}`
			: relation.through;
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// Build subquery starting from junction table
		subquery = eb
			.selectFrom(`${junctionTable} as ${junctionAlias}`)
			// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
			.select((innerEb: any) => innerEb.lit(1).as('_exists'))
			// JOIN target table (single column otherKey for now - M:N composite key is rare)
			.innerJoin(
				`${targetTable} as ${targetAlias}`,
				`${junctionAlias}.${otherKey}`,
				`${targetAlias}.${targetKeys[0]}`,
			);

		// Correlate junction to source with composite key support
		if (fkCols.length === 1) {
			subquery = subquery.whereRef(
				`${junctionAlias}.${fkCols[0]}`,
				'=',
				`${sourceAlias}.${sourceKeys[0]}`,
			);
		} else {
			// Composite key correlation
			subquery = subquery.where((innerEb: any) =>
				buildCompositeKeyCorrelation(
					innerEb,
					junctionAlias,
					sourceAlias,
					fkCols,
					sourceKeys,
				),
			);
		}
	} else {
		// Non-M:N relations
		// Build EXISTS subquery
		// FK direction depends on relation type:
		// - belongsTo: source.foreignKey = target.primaryKey
		// - hasMany/hasOne: target.foreignKey = source.primaryKey
		const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

		// Apply schema prefix for multi-tenant support
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// Build base subquery
		subquery = eb
			.selectFrom(`${targetTable} as ${relatedAlias}`)
			// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
			.select((innerEb: any) => innerEb.lit(1).as('_exists'));

		// Add FK correlation based on relation type with composite key support
		if (relation.type === 'belongsTo') {
			// belongsTo: source.fk = target.pk (e.g., posts.authorId = users.id)
			if (fkCols.length === 1) {
				subquery = subquery.whereRef(
					`${sourceAlias}.${fkCols[0]}`,
					'=',
					`${relatedAlias}.${targetKeys[0]}`,
				);
			} else {
				// Composite key: source.fk[] = target.pk[]
				subquery = subquery.where((innerEb: any) =>
					buildCompositeKeyCorrelation(
						innerEb,
						sourceAlias,
						relatedAlias,
						fkCols,
						targetKeys,
					),
				);
			}
		} else {
			// hasMany/hasOne: target.fk = source.pk (e.g., posts.userId = users.id)
			if (fkCols.length === 1) {
				subquery = subquery.whereRef(
					`${relatedAlias}.${fkCols[0]}`,
					'=',
					`${sourceAlias}.${sourceKeys[0]}`,
				);
			} else {
				// Composite key: target.fk[] = source.pk[]
				subquery = subquery.where((innerEb: any) =>
					buildCompositeKeyCorrelation(
						innerEb,
						relatedAlias,
						sourceAlias,
						fkCols,
						sourceKeys,
					),
				);
			}
		}
	}

	// Add nested WHERE if present
	let finalSubquery = subquery;
	if (where.where) {
		finalSubquery = subquery.where((innerEb: unknown) =>
			compileWhere(
				innerEb,
				where.where as WhereIntent,
				relatedAlias,
				model,
				plan,
				state,
				schemaName,
			),
		);
	}

	if (negate) {
		return eb.not(eb.exists(finalSubquery));
	}
	return eb.exists(finalSubquery);
}

/**
 * Find the planner decision for a relation filter.
 */
function findFilterStrategyDecision(
	plan: PlanReport,
	sourceTable: string,
	relationTarget: string,
): PlanDecision | undefined {
	return plan.decisions.find(
		(d) =>
			d.type === 'filter-strategy' &&
			d.context.sourceTable === sourceTable &&
			(d.context.target === relationTarget ||
				d.context.relation === relationTarget),
	);
}

/**
 * Find the planner decision for an include relation.
 */
function findIncludeStrategyDecision(
	plan: PlanReport,
	sourceTable: string,
	relationName: string,
): PlanDecision | undefined {
	return plan.decisions.find(
		(d) =>
			d.type === 'include-strategy' &&
			d.context.sourceTable === sourceTable &&
			d.context.relation === relationName,
	);
}

/**
 * Collect all includes that should use JOIN strategy (decision.choice === 'join').
 */
function collectJoinIncludes(
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	sourceTable: string,
): Array<{ include: IncludeIntent; relationName: string }> {
	if (!includes) return [];

	const results: Array<{ include: IncludeIntent; relationName: string }> = [];

	for (const include of includes) {
		const decision = findIncludeStrategyDecision(
			plan,
			sourceTable,
			include.relation,
		);
		if (decision?.choice === 'join') {
			results.push({
				include,
				relationName: include.relation,
			});
		}
	}

	return results;
}

/**
 * Apply LEFT JOINs for all includes that use 'join' strategy.
 * Returns the modified query with JOINs applied.
 */
function applyIncludeJoins(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	includes: readonly IncludeIntent[] | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (!includes) return query;

	const joinIncludes = collectJoinIncludes(includes, plan, rootTable);

	let result = query;

	for (const { include: _include, relationName } of joinIncludes) {
		// Skip if already joined
		if (state.joinedIncludeRelations.has(relationName)) {
			continue;
		}

		const relation = resolveRelation(relationName, rootTable, model, plan);

		if (!relation) {
			throw new CompilationError(
				`Unknown relation for include JOIN: ${rootTable}.${relationName}`,
			);
		}

		// Get table definitions - supports composite keys
		const targetTableDef = model.getTable(relation.target);
		const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);

		const sourceTableDef = model.getTable(relation.source);
		const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

		// Handle M:N (belongsToMany) with through table
		if (relation.through) {
			// M:N requires two LEFT JOINs: source → junction → target
			const junctionAlias = getNextAlias(state);
			const targetAlias = getNextAlias(state);

			// FK from junction to source (default: {source}Id) - supports composite keys
			const fkCols = normalizeForeignKey(
				relation.foreignKey,
				`${relation.source}Id`,
			);

			// FK from junction to target (default: {target}Id)
			const otherKey = relation.otherKey ?? `${relation.target}Id`;

			// Apply schema prefix
			const junctionTable = schemaName
				? `${schemaName}.${relation.through}`
				: relation.through;
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// LEFT JOIN 1: source → junction (source.pk = junction.fk) - supports composite keys
			if (fkCols.length === 1) {
				result = result.leftJoin(
					`${junctionTable} as ${junctionAlias}`,
					`${rootAlias}.${sourceKeys[0]}`,
					`${junctionAlias}.${fkCols[0]}`,
				);
			} else {
				// Composite key: multiple ON conditions
				result = result.leftJoin(
					`${junctionTable} as ${junctionAlias}`,
					(join) => {
						let j = join.onRef(
							`${rootAlias}.${sourceKeys[0]}`,
							'=',
							`${junctionAlias}.${fkCols[0]}`,
						);
						for (let i = 1; i < fkCols.length; i++) {
							j = j.onRef(
								`${rootAlias}.${sourceKeys[i]}`,
								'=',
								`${junctionAlias}.${fkCols[i]}`,
							);
						}
						return j;
					},
				);
			}

			// LEFT JOIN 2: junction → target (junction.otherKey = target.pk) - single key for now
			result = result.leftJoin(
				`${targetTable} as ${targetAlias}`,
				`${junctionAlias}.${otherKey}`,
				`${targetAlias}.${targetKeys[0]}`,
			);

			// Track the target alias (not junction) for column selection
			state.tableAliases.set(`${relation.target}_include`, targetAlias);
			state.joinedIncludeRelations.set(relationName, {
				alias: targetAlias,
				targetTable: relation.target,
				relationName,
			});
		} else {
			// Non-M:N relations (hasOne, hasMany, belongsTo)
			const joinAlias = getNextAlias(state);
			state.tableAliases.set(`${relation.target}_include`, joinAlias);
			state.joinedIncludeRelations.set(relationName, {
				alias: joinAlias,
				targetTable: relation.target,
				relationName,
			});

			// Build JOIN condition based on relation type - supports composite keys
			const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

			// Apply schema prefix
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// Determine join condition based on relation type
			// belongsTo: source.foreignKey = target.primaryKey
			// hasMany/hasOne: source.primaryKey = target.foreignKey
			if (relation.type === 'belongsTo') {
				if (fkCols.length === 1) {
					result = result.leftJoin(
						`${targetTable} as ${joinAlias}`,
						`${rootAlias}.${fkCols[0]}`,
						`${joinAlias}.${targetKeys[0]}`,
					);
				} else {
					// Composite key: multiple ON conditions
					result = result.leftJoin(`${targetTable} as ${joinAlias}`, (join) => {
						let j = join.onRef(
							`${rootAlias}.${fkCols[0]}`,
							'=',
							`${joinAlias}.${targetKeys[0]}`,
						);
						for (let i = 1; i < fkCols.length; i++) {
							j = j.onRef(
								`${rootAlias}.${fkCols[i]}`,
								'=',
								`${joinAlias}.${targetKeys[i]}`,
							);
						}
						return j;
					});
				}
			} else {
				// hasMany or hasOne
				if (fkCols.length === 1) {
					result = result.leftJoin(
						`${targetTable} as ${joinAlias}`,
						`${joinAlias}.${fkCols[0]}`,
						`${rootAlias}.${sourceKeys[0]}`,
					);
				} else {
					// Composite key: multiple ON conditions
					result = result.leftJoin(`${targetTable} as ${joinAlias}`, (join) => {
						let j = join.onRef(
							`${joinAlias}.${fkCols[0]}`,
							'=',
							`${rootAlias}.${sourceKeys[0]}`,
						);
						for (let i = 1; i < fkCols.length; i++) {
							j = j.onRef(
								`${joinAlias}.${fkCols[i]}`,
								'=',
								`${rootAlias}.${sourceKeys[i]}`,
							);
						}
						return j;
					});
				}
			}
		}
	}

	return result;
}

/**
 * Add SELECT columns for included relations that were JOINed.
 * Columns are aliased as "relationName.columnName" to avoid conflicts.
 */
function addIncludeSelectColumns(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	state: CompilerState,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (state.joinedIncludeRelations.size === 0) {
		return query;
	}

	let result = query;

	for (const [relationName, joinInfo] of state.joinedIncludeRelations) {
		const { alias, targetTable } = joinInfo;
		const tableDef = model.getTable(targetTable);

		if (!tableDef) {
			throw new CompilationError(`Unknown table for include: ${targetTable}`);
		}

		// Add all columns from the included table with aliased names
		for (const column of tableDef.columns) {
			const aliasedName = `${relationName}.${column.name}`;
			result = result.select(
				sql`${sql.ref(`${alias}.${column.name}`)}`.as(aliasedName),
			);
		}
	}

	return result;
}

/**
 * Recursively collect all relationFilter nodes from a WHERE intent
 * that should use JOIN strategy (decision.choice === 'join').
 */
function collectJoinFilterRelations(
	where: WhereIntent,
	plan: PlanReport,
	model: ModelIR,
	sourceTable: string,
): Array<{
	relation: string;
	where?: WhereIntent;
	mode: 'some' | 'every' | 'none';
}> {
	const results: Array<{
		relation: string;
		where?: WhereIntent;
		mode: 'some' | 'every' | 'none';
	}> = [];

	if (where.kind === 'relationFilter') {
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			where.relation,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: where.relation,
				where: where.where,
				mode: where.mode,
			});
		}
	} else if (where.kind === 'exists') {
		// Handle exists() helper - maps to mode: 'some'
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			where.relation,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: where.relation,
				...(where.where !== undefined && { where: where.where }),
				mode: 'some',
			});
		}
	} else if (where.kind === 'notExists') {
		// Handle notExists() helper - maps to mode: 'none'
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			where.relation,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: where.relation,
				...(where.where !== undefined && { where: where.where }),
				mode: 'none',
			});
		}
	} else if (where.kind === 'and' || where.kind === 'or') {
		for (const condition of where.conditions) {
			results.push(
				...collectJoinFilterRelations(condition, plan, model, sourceTable),
			);
		}
	} else if (where.kind === 'not') {
		results.push(
			...collectJoinFilterRelations(where.condition, plan, model, sourceTable),
		);
	}

	return results;
}

/**
 * Resolve relation info from a relation name, handling disambiguation.
 */
function resolveRelation(
	relationName: string,
	sourceTable: string,
	model: ModelIR,
	plan: PlanReport,
): RelationIR | undefined {
	// Try direct lookup first
	let relation = model.getRelation(`${sourceTable}.${relationName}`);

	// If not found, check if planner resolved it to a different relation name
	if (!relation) {
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			relationName,
		);
		if (decision?.context.relation) {
			relation = model.getRelation(
				`${sourceTable}.${decision.context.relation}`,
			);
		}
	}

	// Also try to find relation by target table
	if (!relation) {
		const relationsFromSource = model.getRelationsFrom(sourceTable);
		const byTarget = relationsFromSource.filter(
			(r) => r.target === relationName,
		);
		if (byTarget.length === 1) {
			relation = byTarget[0];
		}
	}

	return relation;
}

/**
 * Apply INNER JOINs for all relationFilters that use 'join' strategy.
 * Returns the modified query with JOINs applied.
 */
function applyJoinFilters(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	where: WhereIntent | undefined,
	plan: PlanReport,
	model: ModelIR,
	state: CompilerState,
	rootTable: string,
	rootAlias: string,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (!where) return query;

	const joinRelations = collectJoinFilterRelations(
		where,
		plan,
		model,
		rootTable,
	);

	let result = query;

	for (const joinRel of joinRelations) {
		// Skip if already joined
		if (state.joinedFilterRelations.has(joinRel.relation)) {
			continue;
		}

		const relation = resolveRelation(joinRel.relation, rootTable, model, plan);

		if (!relation) {
			throw new CompilationError(
				`Unknown relation for JOIN filter: ${rootTable}.${joinRel.relation}`,
			);
		}

		// Get table definitions - supports composite keys
		const sourceTableDef = model.getTable(relation.source);
		const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

		const targetTableDef = model.getTable(relation.target);
		const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);

		// Handle M:N (belongsToMany) with through table
		if (relation.through) {
			// M:N requires two JOINs: source → junction → target
			const junctionAlias = getNextAlias(state);
			const targetAlias = getNextAlias(state);

			// FK from junction to source (default: {source}Id) - supports composite keys
			const fkCols = normalizeForeignKey(
				relation.foreignKey,
				`${relation.source}Id`,
			);

			// FK from junction to target (default: {target}Id)
			const otherKey = relation.otherKey ?? `${relation.target}Id`;

			// Apply schema prefix
			const junctionTable = schemaName
				? `${schemaName}.${relation.through}`
				: relation.through;
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// JOIN 1: source → junction (source.pk = junction.fk) - supports composite keys
			if (fkCols.length === 1) {
				result = result.innerJoin(
					`${junctionTable} as ${junctionAlias}`,
					`${rootAlias}.${sourceKeys[0]}`,
					`${junctionAlias}.${fkCols[0]}`,
				);
			} else {
				// Composite key: multiple ON conditions
				result = result.innerJoin(
					`${junctionTable} as ${junctionAlias}`,
					(join) => {
						let j = join.onRef(
							`${rootAlias}.${sourceKeys[0]}`,
							'=',
							`${junctionAlias}.${fkCols[0]}`,
						);
						for (let i = 1; i < fkCols.length; i++) {
							j = j.onRef(
								`${rootAlias}.${sourceKeys[i]}`,
								'=',
								`${junctionAlias}.${fkCols[i]}`,
							);
						}
						return j;
					},
				);
			}

			// JOIN 2: junction → target (junction.otherKey = target.pk) - single key for now
			result = result.innerJoin(
				`${targetTable} as ${targetAlias}`,
				`${junctionAlias}.${otherKey}`,
				`${targetAlias}.${targetKeys[0]}`,
			);

			// Track the target alias (not junction) for WHERE compilation
			state.tableAliases.set(`${relation.target}_join`, targetAlias);
			state.joinedFilterRelations.set(joinRel.relation, {
				alias: targetAlias,
				targetTable: relation.target,
			});
		} else {
			// Non-M:N relations (hasOne, hasMany, belongsTo)
			const joinAlias = getNextAlias(state);
			state.tableAliases.set(`${relation.target}_join`, joinAlias);
			state.joinedFilterRelations.set(joinRel.relation, {
				alias: joinAlias,
				targetTable: relation.target,
			});

			// Build JOIN condition based on relation type - supports composite keys
			// belongsTo: source.foreignKey = target.primaryKey
			// hasMany/hasOne: target.foreignKey = source.primaryKey
			const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

			// Apply schema prefix
			const targetTable = schemaName
				? `${schemaName}.${relation.target}`
				: relation.target;

			// Add INNER JOIN with correct FK direction - supports composite keys
			if (relation.type === 'belongsTo') {
				// belongsTo: source.fk = target.pk (e.g., posts.authorId = users.id)
				if (fkCols.length === 1) {
					result = result.innerJoin(
						`${targetTable} as ${joinAlias}`,
						`${rootAlias}.${fkCols[0]}`,
						`${joinAlias}.${targetKeys[0]}`,
					);
				} else {
					// Composite key: multiple ON conditions
					result = result.innerJoin(
						`${targetTable} as ${joinAlias}`,
						(join) => {
							let j = join.onRef(
								`${rootAlias}.${fkCols[0]}`,
								'=',
								`${joinAlias}.${targetKeys[0]}`,
							);
							for (let i = 1; i < fkCols.length; i++) {
								j = j.onRef(
									`${rootAlias}.${fkCols[i]}`,
									'=',
									`${joinAlias}.${targetKeys[i]}`,
								);
							}
							return j;
						},
					);
				}
			} else {
				// hasMany/hasOne: target.fk = source.pk (e.g., posts.userId = users.id)
				if (fkCols.length === 1) {
					result = result.innerJoin(
						`${targetTable} as ${joinAlias}`,
						`${joinAlias}.${fkCols[0]}`,
						`${rootAlias}.${sourceKeys[0]}`,
					);
				} else {
					// Composite key: multiple ON conditions
					result = result.innerJoin(
						`${targetTable} as ${joinAlias}`,
						(join) => {
							let j = join.onRef(
								`${joinAlias}.${fkCols[0]}`,
								'=',
								`${rootAlias}.${sourceKeys[0]}`,
							);
							for (let i = 1; i < fkCols.length; i++) {
								j = j.onRef(
									`${joinAlias}.${fkCols[i]}`,
									'=',
									`${rootAlias}.${sourceKeys[i]}`,
								);
							}
							return j;
						},
					);
				}
			}
		}
	}

	return result;
}

/**
 * Compile WHERE conditions for a relation that was already JOINed.
 * Instead of EXISTS, we just compile the nested conditions against the joined table.
 */
function compileJoinedRelationConditions(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: string;
		where?: WhereIntent;
		mode: 'some' | 'every' | 'none';
	},
	_sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const joinInfo = state.joinedFilterRelations.get(where.relation);
	if (!joinInfo) {
		throw new CompilationError(
			`Relation ${where.relation} was not joined but JOIN strategy was requested`,
		);
	}

	const joinAlias = joinInfo.alias;

	// Handle different modes
	switch (where.mode) {
		case 'some': {
			// For 'some', just compile the nested WHERE conditions if present
			// The INNER JOIN already filters to rows that have at least one match
			if (where.where) {
				return compileWhere(
					eb,
					where.where,
					joinAlias,
					model,
					plan,
					state,
					schemaName,
				);
			}
			// If no nested where, the JOIN itself is sufficient (return true)
			return eb.lit(true);
		}

		case 'none': {
			// For 'none' with JOIN, we need a different approach:
			// This is NOT ideal with JOIN (row explosion), but user explicitly chose it
			// We would need LEFT JOIN + IS NULL pattern
			// For now, throw error suggesting EXISTS for 'none' mode
			throw new CompilationError(
				`filter-strategy: 'join' is not supported for mode 'none'. ` +
					`Use EXISTS strategy or remove the filterStrategy hint.`,
			);
		}

		case 'every': {
			// For 'every' with JOIN, this is also problematic
			// We would need complex NOT EXISTS of negated condition
			throw new CompilationError(
				`filter-strategy: 'join' is not supported for mode 'every'. ` +
					`Use EXISTS strategy or remove the filterStrategy hint.`,
			);
		}
	}
}

function compileRelationFilter(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: string;
		where: WhereIntent;
		mode: 'some' | 'every' | 'none';
	},
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// Check planner decision for filter strategy
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;
	const decision = findFilterStrategyDecision(
		plan,
		sourceTable,
		where.relation,
	);
	const useJoin = decision?.choice === 'join';

	// If JOIN strategy and table was already joined, use the joined conditions
	if (useJoin && state.joinedFilterRelations.has(where.relation)) {
		return compileJoinedRelationConditions(
			eb,
			where,
			sourceAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// Default: EXISTS strategy
	switch (where.mode) {
		case 'some':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				false,
				schemaName,
			);

		case 'none':
			return compileExists(
				eb,
				{ relation: where.relation, where: where.where },
				sourceAlias,
				model,
				plan,
				state,
				true,
				schemaName,
			);

		case 'every': {
			// every = NOT EXISTS (records that DON'T match)
			// Implemented as: NOT EXISTS (SELECT 1 FROM rel WHERE NOT (condition))
			const invertedWhere: WhereIntent = {
				kind: 'not',
				condition: where.where,
			};
			return compileExists(
				eb,
				{ relation: where.relation, where: invertedWhere },
				sourceAlias,
				model,
				plan,
				state,
				true,
				schemaName,
			);
		}
	}
}

/**
 * Compile a scalar subquery WHERE condition.
 * Produces: field op (SELECT scalar FROM table WHERE ...)
 */
function compileSubquery(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: WhereSubqueryIntent,
	parentAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const { field, operator, subquery } = where;

	// Determine the full table name (with schema if multi-tenant)
	const tableName = schemaName
		? `${schemaName}.${subquery.from}`
		: subquery.from;

	// Build subquery
	const subqueryBuilder = eb
		.selectFrom(tableName)
		.select(
			subquery.aggregate
				? buildSubqueryAggregate(subquery.aggregate, subquery.from)
				: `${subquery.from}.${subquery.select}`,
		);

	// Add WHERE clause if present (handling ref() for correlated subqueries)
	let finalSubquery = subqueryBuilder;
	const subqueryWhere = subquery.where;
	if (subqueryWhere) {
		// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder type
		finalSubquery = subqueryBuilder.where((sqEb: any) =>
			compileSubqueryWhere(
				sqEb,
				subqueryWhere,
				subquery.from,
				parentAlias,
				model,
				plan,
				state,
				schemaName,
			),
		);
	}

	// Map operator to SQL operator
	const sqlOp = mapOperatorToSql(operator);

	// Return comparison: parentAlias.field op (subquery)
	return eb(`${parentAlias}.${field}`, sqlOp, finalSubquery);
}

/**
 * Build aggregate expression for subquery (e.g., MAX(price))
 */
function buildSubqueryAggregate(
	aggregate: { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; field: string },
	tableAlias: string,
): RawBuilder<unknown> {
	const { fn, field } = aggregate;
	return sql`${sql.raw(fn.toUpperCase())}(${sql.ref(`${tableAlias}.${field}`)})`;
}

/**
 * Compile WHERE for a subquery, handling ref() column references to parent.
 */
function compileSubqueryWhere(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: WhereIntent,
	subqueryAlias: string,
	parentAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// Check if this is a comparison with a ref() value
	if (where.kind === 'comparison') {
		const value = where.value;
		if (isSubqueryRef(value)) {
			// This is a correlated reference to parent column
			const refColumn = resolveRef(value, parentAlias);
			return eb(
				`${subqueryAlias}.${where.field}`,
				mapOperatorToSql(where.operator),
				sql.ref(refColumn),
			);
		}
	}

	// For other cases, delegate to normal compileWhere with subquery alias
	return compileWhere(eb, where, subqueryAlias, model, plan, state, schemaName);
}

/**
 * Resolve a SubqueryRefIntent to a column reference string.
 * Handles both simple refs ('id') and qualified refs ('alias.column').
 */
function resolveRef(ref: SubqueryRefIntent, defaultAlias: string): string {
	const { column } = ref;
	// If already qualified (contains '.'), use as-is
	if (column.includes('.')) {
		return column;
	}
	// Otherwise, qualify with parent alias
	return `${defaultAlias}.${column}`;
}

/**
 * Map intent operator to SQL operator string.
 */
function mapOperatorToSql(
	operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte',
): string {
	const map: Record<string, string> = {
		eq: '=',
		neq: '!=',
		gt: '>',
		gte: '>=',
		lt: '<',
		lte: '<=',
	};
	return map[operator] ?? '=';
}

// ============================================================================
// CTE Compilation
// ============================================================================

/**
 * Build CTEs before the main query using Kysely's .with() method.
 *
 * Returns a builder that can be used to construct the main SELECT.
 * CTEs are generated for relations that are accessed multiple times.
 */
function buildCTEs(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Returns Kysely or WithSchemaBuilder
): any {
	if (plan.ctes.length === 0) {
		return kysely;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building
	let builder: any = kysely;

	for (const cte of plan.ctes) {
		// Parse sourceIntent to get source table and relation
		// Format: "sourceTable.relationName"
		const parts = cte.sourceIntent.split('.');
		const sourceTable = parts[0];
		const relationName = parts[1];

		if (!sourceTable || !relationName) {
			continue;
		}

		// Get the relation to find target table
		const relation = model.getRelation(`${sourceTable}.${relationName}`);
		if (!relation) {
			continue;
		}

		// Build CTE: SELECT * FROM targetTable
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// biome-ignore lint/suspicious/noExplicitAny: Dynamic table name requires any
		builder = builder.with(cte.name, (db: Kysely<any>) =>
			db.selectFrom(targetTable).selectAll(),
		);
	}

	return builder;
}

// ============================================================================
// DX-005: Emit Join Compilation
// ============================================================================

/**
 * Compile emit.joinWith clauses into Kysely JOIN statements.
 * Supports chained joins with schema prefix for multi-tenant.
 */
function compileEmitJoins(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	query: any,
	joins: readonly EmitJoinClause[],
	joinAliases: string[],
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
): any {
	let result = query;
	let aliasCounter = 0;

	for (const join of joins) {
		const tableAlias = join.as || `j${aliasCounter++}`;
		const tableName = schemaName ? `${schemaName}.${join.table}` : join.table;
		const tableRef = `${tableName} as ${tableAlias}`;

		// Resolve left column: could be from CTE or previous joined table
		const leftColumn = resolveJoinColumn(join.on.left, joinAliases);
		const rightColumn = `${tableAlias}.${join.on.right}`;

		if (join.type === 'left') {
			result = result.leftJoin(tableRef, leftColumn, rightColumn);
		} else {
			result = result.innerJoin(tableRef, leftColumn, rightColumn);
		}

		// Track this alias for subsequent joins
		joinAliases.push(tableAlias);
	}

	return result;
}

/**
 * Resolve a column reference for join conditions.
 * Supports: 'column' (from first alias), 'alias.column' (qualified), 'prev.column' (previous join)
 */
function resolveJoinColumn(column: string, joinAliases: string[]): string {
	// Already qualified
	if (column.includes('.')) {
		// Check if it's a 'prev.' reference
		if (column.startsWith('prev.')) {
			const col = column.substring(5);
			const prevAlias = joinAliases[joinAliases.length - 1];
			return `${prevAlias}.${col}`;
		}
		return column;
	}
	// Unqualified: use first alias (CTE)
	return `${joinAliases[0]}.${column}`;
}

/**
 * Build SELECT clause for emit options.
 * If joinWith has select fields, use those. Otherwise, selectAll from CTE.
 */
function buildEmitSelect(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
	query: any,
	intent: RecursiveIntent,
	joinAliases: string[],
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
): any {
	// Collect all select fields from joinWith clauses
	const selectFields: string[] = [];

	// Add CTE fields if emit.select specified
	if (intent.emit?.select) {
		for (const field of intent.emit.select) {
			// If field has no qualifier, assume it's from CTE or a joined table
			selectFields.push(field);
		}
	}

	// Add fields from joinWith clauses
	if (intent.emit?.joinWith) {
		for (let i = 0; i < intent.emit.joinWith.length; i++) {
			const join = intent.emit.joinWith[i];
			if (!join) continue;
			const tableAlias = join.as || `j${i}`;

			if (join.select) {
				for (const sel of join.select) {
					if (typeof sel === 'string') {
						selectFields.push(`${tableAlias}.${sel}`);
					} else {
						// { column, as } - aliased select
						selectFields.push(`${tableAlias}.${sel.column} as ${sel.as}`);
					}
				}
			}
		}
	}

	// If we have specific fields, select only those
	if (selectFields.length > 0) {
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic select building
		return query.select(selectFields.map((f: string) => sql.raw(f) as any));
	}

	// Default: select all from CTE
	return query.selectAll(joinAliases[0]);
}

// ============================================================================
// Utilities
// ============================================================================

function getNextAlias(state: CompilerState): string {
	const alias = `t${state.aliasCounter}`;
	state.aliasCounter++;
	return alias;
}

function getTableFromAlias(
	state: CompilerState,
	alias: string,
): string | undefined {
	for (const [table, a] of state.tableAliases) {
		if (a === alias) {
			// Handle compound keys like "posts_t1"
			const parts = table.split('_');
			if (parts.length > 1 && parts[parts.length - 1]?.startsWith('t')) {
				return parts.slice(0, -1).join('_');
			}
			return table;
		}
	}
	return undefined;
}

/**
 * Normalize foreignKey to array for consistent handling of composite keys.
 */
function normalizeForeignKey(
	foreignKey: string | readonly string[] | undefined,
	defaultValue: string,
): readonly string[] {
	if (Array.isArray(foreignKey)) {
		return foreignKey;
	}
	// After Array.isArray check, foreignKey is string | undefined
	return foreignKey !== undefined ? [foreignKey as string] : [defaultValue];
}

/**
 * Normalize primaryKey to array for consistent handling of composite keys.
 */
function normalizePrimaryKey(
	primaryKey: string | readonly string[] | undefined,
): readonly string[] {
	if (Array.isArray(primaryKey)) {
		return primaryKey;
	}
	// After Array.isArray check, primaryKey is string | undefined
	return primaryKey !== undefined ? [primaryKey as string] : ['id'];
}

/**
 * Build composite key correlation for EXISTS subqueries.
 * Returns an AND expression for all FK/PK column pairs.
 */
function buildCompositeKeyCorrelation(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	sourceAlias: string,
	targetAlias: string,
	sourceCols: readonly string[],
	targetCols: readonly string[],
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	if (sourceCols.length !== targetCols.length) {
		throw new CompilationError(
			`Composite key mismatch: source has ${sourceCols.length} columns, target has ${targetCols.length}`,
		);
	}

	if (sourceCols.length === 1) {
		// Single key - simple whereRef
		return eb.and([
			eb(
				`${sourceAlias}.${sourceCols[0]}`,
				'=',
				eb.ref(`${targetAlias}.${targetCols[0]}`),
			),
		]);
	}

	// Composite key - AND all column pairs
	const conditions = sourceCols.map((srcCol, i) =>
		eb(
			`${sourceAlias}.${srcCol}`,
			'=',
			eb.ref(`${targetAlias}.${targetCols[i]}`),
		),
	);
	return eb.and(conditions);
}

/**
 * Unwrap single-element arrays to strings for backward compatibility.
 * Used by SeparateIncludeInfo to maintain the original API contract.
 */
function unwrapSingletonArray(
	value: readonly string[],
): string | readonly string[] {
	// With noUncheckedIndexedAccess, value[0] is string | undefined
	// We know length === 1 means value[0] exists, so use non-null assertion
	return value.length === 1 ? value[0]! : value;
}
