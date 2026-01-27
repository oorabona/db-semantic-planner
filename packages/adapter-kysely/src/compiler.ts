/**
 * @module compiler
 * SQL Compiler - Transforms PlanReport into Kysely queries.
 */

import type {
	AggregateIntent,
	ExpressionIntent,
	IncludeIntent,
	ModelIR,
	PlanDecision,
	PlanReport,
	QueryIntent,
	RangeOperator,
	RecursiveExistsOptions,
	RelationIR,
	SelectAggregateIntent,
	SelectIntent,
	SelectWithExpressionsIntent,
	SubqueryRefIntent,
	WhereIntent,
	WhereSubqueryIntent,
	WindowIntent,
} from '@dbsp/core';
import {
	type DialectCapabilities as CoreDialectCapabilities,
	isAggregateWindowFunction,
	isSelectAggregate,
	isSelectWithExpressions,
	isSubqueryRef,
} from '@dbsp/core';
import type {
	CompiledQuery,
	Kysely,
	SelectQueryBuilder,
	SqlBool,
} from 'kysely';
import { type RawBuilder, sql } from 'kysely';
import {
	applyCteIncludes,
	applyJoinIncludes,
	applyJsonAggIncludes,
	applyLateralIncludes,
	applyPendingPseudoJoins,
	type CompilerContext,
	type CompilerState,
	extractRelationFiltersForSharing,
	getExpressionHandler,
	getWhereHandler,
	preprocessWherePseudoColumns,
	registerComplexWhereHandlers,
	registerExpressionHandlers,
	registerIncludeHandlers,
	registerWhereHandlers,
} from './compiler/index.js';
import { CompilationError } from './errors.js';
import { addWhereSimple } from './recursive-compiler.js';
import { UnsupportedOperationError } from './stream.js';

// Initialize handler registrations
registerWhereHandlers();
registerComplexWhereHandlers({
	compileExists,
	compileJoinedRelationConditions,
	compileRelationFilter,
	compileSubquery,
});
registerExpressionHandlers();
registerIncludeHandlers();

// ============================================================================
// Compiler State - imported from ./compiler/types.ts (ARCH-004)
// ============================================================================
// CompilerState now has a single definition in compiler/types.ts to prevent
// shadowing bugs like the one that caused SPEC-001 JOIN issues.

// ============================================================================
// Path Tracking Compiler (ARCH-001) - Extracted to recursive-compiler.ts (AUD-004)
// ============================================================================
// Path tracking helpers moved to recursive-compiler.ts for cohesion

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
	/** Column aliasing mode for included relations (CLI-010) */
	aliasIncludedColumns?: 'always' | 'onCollision';
	/** Dialect capabilities for feature validation (CORE-004) */
	coreCapabilities?: CoreDialectCapabilities;
	/** Dialect name for error messages */
	dialect?: string;

	// ============================================================
	// Global Limits (NQL-ALIGN Block 3)
	// ============================================================

	/** Maximum depth for recursive CTE queries. @default 10 */
	maxDepth?: number;
	/** Maximum number of relation hops. @default 5 */
	maxTableHops?: number;
	/** Maximum nesting depth for CASE expressions. @default 10 */
	maxNestedCase?: number;
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
	// M:N (manyToMany) junction table support
	/** Junction table name for M:N relations (e.g., 'postTags') */
	through?: string;
	/** Column in junction table referencing source (e.g., 'postId') */
	throughSourceKey?: string;
	/** Column in junction table referencing target (e.g., 'tagId') */
	throughTargetKey?: string;
	// NQL-ALIGN Block 5: Subquery optimization
	/** Source/parent table name for subquery optimization */
	sourceTable?: string;
	/** Parent query's WHERE conditions for subquery optimization */
	parentWhere?: WhereIntent;
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
	model?: ModelIR,
	coreCapabilities?: CoreDialectCapabilities,
	dialect?: string,
): CompiledQuery {
	// NQL-ALIGN Block 5: Subquery optimization
	// When no parentIds provided but we have sourceTable info, use subquery instead of 2 queries
	const useSubquery = parentIds.length === 0 && info.sourceTable !== undefined;

	if (parentIds.length === 0 && !useSubquery) {
		// Return an empty result query - no parent IDs and no subquery info
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

	// Helper to apply WHERE conditions using compileWhere
	// biome-ignore lint/suspicious/noExplicitAny: Kysely query builder generic
	const applyWhereConditions = (query: SelectQueryBuilder<any, any, any>) => {
		if (!info.where) return query;

		// Create minimal plan/state for compileWhere (simple filters don't use most fields)
		const minimalPlan: PlanReport = {
			rootTable: info.targetTable,
			intent: { type: 'select', from: info.targetTable },
			decisions: [],
			warnings: [],
			ctes: [],
			metadata: {
				planningTimeMs: 0,
				relationsAnalyzed: 0,
				isAmbiguous: false,
			},
		};

		const minimalState: CompilerState = {
			aliasCounter: 0,
			tableAliases: new Map([[info.targetTable, info.targetTable]]),
			parameters: [],
			joinedFilterRelations: new Map(),
			joinedIncludeRelations: new Map(),
			...(coreCapabilities !== undefined && { coreCapabilities }),
			...(dialect !== undefined && { dialect }),
		};

		// Use compileWhere for consistent WHERE compilation
		return query.where((eb) =>
			compileWhere(
				eb,
				info.where as WhereIntent,
				info.targetTable,
				model ?? ({ tables: {} } as ModelIR), // Minimal model for simple filters
				minimalPlan,
				minimalState,
				schemaName,
			),
		);
	};

	// NQL-ALIGN Block 5: Helper to build parent subquery for optimization
	const buildParentSubquery = (sourceKey: string | readonly string[]) => {
		// sourceTable is guaranteed to be defined when useSubquery is true
		const sourceTable = info.sourceTable;
		if (!sourceTable) {
			throw new Error('buildParentSubquery called without sourceTable');
		}

		const sourceTableName = schemaName
			? `${schemaName}.${sourceTable}`
			: sourceTable;
		const skCols = Array.isArray(sourceKey) ? sourceKey : [sourceKey];

		// biome-ignore lint/suspicious/noExplicitAny: Kysely SelectQueryBuilder types
		let subquery: any = kysely.selectFrom(sourceTableName);

		// Select the source key column(s)
		if (skCols.length === 1) {
			subquery = subquery.select(skCols[0]);
		} else {
			// For composite keys, select all columns (will be used in tuple comparison)
			subquery = subquery.select(skCols as string[]);
		}

		// Apply parent WHERE conditions if present
		if (info.parentWhere) {
			const parentWhere = info.parentWhere;
			const minimalPlan: PlanReport = {
				rootTable: sourceTable,
				intent: { type: 'select', from: sourceTable },
				decisions: [],
				warnings: [],
				ctes: [],
				metadata: {
					planningTimeMs: 0,
					relationsAnalyzed: 0,
					isAmbiguous: false,
				},
			};
			const minimalState: CompilerState = {
				aliasCounter: 0,
				tableAliases: new Map([[sourceTable, sourceTable]]),
				parameters: [],
				joinedFilterRelations: new Map(),
				joinedIncludeRelations: new Map(),
				...(coreCapabilities !== undefined && { coreCapabilities }),
				...(dialect !== undefined && { dialect }),
			};
			// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder generic
			subquery = subquery.where((eb: any) =>
				compileWhere(
					eb,
					parentWhere,
					sourceTable,
					model ?? ({ tables: {} } as ModelIR),
					minimalPlan,
					minimalState,
					schemaName,
				),
			);
		}

		return subquery;
	};

	// M:N (manyToMany) relation with junction table
	if (info.through && info.throughSourceKey && info.throughTargetKey) {
		const junctionTable = schemaName
			? `${schemaName}.${info.through}`
			: info.through;

		// SELECT tags.*, postTags.postId as __sourceKey
		// FROM tags
		// INNER JOIN postTags ON postTags.tagId = tags.id
		// WHERE postTags.postId IN (parentIds | subquery)
		let query = kysely
			.selectFrom(tableName)
			.selectAll(info.targetTable)
			.select(`${info.through}.${info.throughSourceKey} as __sourceKey`)
			.innerJoin(
				junctionTable,
				`${info.through}.${info.throughTargetKey}`,
				`${info.targetTable}.${info.foreignKey as string}`,
			);

		// NQL-ALIGN Block 5: Use subquery or parentIds
		if (useSubquery) {
			const subquery = buildParentSubquery(info.sourceKey);
			query = query.where(
				`${info.through}.${info.throughSourceKey}`,
				'in',
				subquery,
			);
		} else {
			query = query.where(
				`${info.through}.${info.throughSourceKey}`,
				'in',
				parentIds as unknown[],
			);
		}

		// Add additional WHERE conditions from include intent
		query = applyWhereConditions(query);

		return query.compile();
	}

	// Standard 1:N relation (no junction table)
	let query = kysely.selectFrom(tableName).selectAll();

	// Add WHERE foreignKey IN (parentIds | subquery) - handle composite keys
	const fkCols = Array.isArray(info.foreignKey)
		? info.foreignKey
		: [info.foreignKey];

	// NQL-ALIGN Block 5: Use subquery or parentIds
	if (useSubquery) {
		// Use subquery: WHERE fk IN (SELECT pk FROM parent WHERE ...)
		const subquery = buildParentSubquery(info.sourceKey);
		if (fkCols.length === 1) {
			query = query.where(fkCols[0], 'in', subquery);
		} else {
			// Composite key with subquery - use EXISTS instead
			// This is a fallback for composite keys with subquery
			query = query.where((eb) =>
				eb.exists(
					subquery.whereRef(fkCols[0], '=', `${info.targetTable}.${fkCols[0]}`),
				),
			);
		}
	} else if (fkCols.length === 1) {
		// Simple case: single column FK with parentIds
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
	query = applyWhereConditions(query);

	return query.compile();
}

// ============================================================================
// Range Type Helpers (PostgreSQL)
// ============================================================================

/**
 * Range value with lower/upper bounds and optional bounds specification.
 * (Imported from @dbsp/types - ARCH-004)
 */
import type { RangeValue } from '@dbsp/types';

/**
 * Check if a value is a range value (has lower/upper properties).
 */
function isRangeValue(value: unknown): value is RangeValue {
	return (
		typeof value === 'object' &&
		value !== null &&
		'lower' in value &&
		'upper' in value
	);
}

/**
 * Detect PostgreSQL range type from values.
 * - ISO date strings (YYYY-MM-DD) → daterange
 * - ISO timestamps (with T or space and time) → tstzrange
 * - Integers → int4range
 * - Decimals → numrange
 */
function inferRangeType(lower: unknown, upper: unknown): string {
	// Use whichever bound is defined to infer type
	const sample = lower ?? upper;
	if (sample === null || sample === undefined) {
		// Unbounded range - default to text (PostgreSQL will infer from column)
		return '';
	}

	if (typeof sample === 'number') {
		return Number.isInteger(sample) ? '::int4range' : '::numrange';
	}

	if (typeof sample === 'bigint') {
		return '::int8range';
	}

	if (sample instanceof Date) {
		return '::tstzrange';
	}

	if (typeof sample === 'string') {
		// Check if it looks like a date/timestamp
		// ISO date: YYYY-MM-DD (exactly 10 chars)
		// ISO timestamp: YYYY-MM-DDTHH:MM:SS or YYYY-MM-DD HH:MM:SS
		if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) {
			return '::daterange';
		}
		if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(sample)) {
			return '::tstzrange';
		}
		// Check if it's a numeric string
		if (/^-?\d+$/.test(sample)) {
			return '::int4range';
		}
		if (/^-?\d+\.?\d*$/.test(sample)) {
			return '::numrange';
		}
	}

	// Default: no cast, let PostgreSQL infer from column
	return '';
}

/**
 * Infer PostgreSQL scalar type cast for range element operations.
 * This is used when comparing a range with a scalar (e.g., range @> element).
 */
function inferScalarCast(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'number') {
		return Number.isInteger(value) ? '::integer' : '::numeric';
	}

	if (typeof value === 'bigint') {
		return '::bigint';
	}

	if (value instanceof Date) {
		return '::timestamptz';
	}

	if (typeof value === 'string') {
		// Check if it looks like a date/timestamp
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			return '::date';
		}
		if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) {
			return '::timestamptz';
		}
		// Check if it's a numeric string
		if (/^-?\d+$/.test(value)) {
			return '::integer';
		}
		if (/^-?\d+\.?\d*$/.test(value)) {
			return '::numeric';
		}
	}

	// Default: no cast
	return '';
}

/**
 * Build a PostgreSQL range literal from a RangeValue.
 * @example { lower: '2025-01-15', upper: '2025-01-20', bounds: '[)' } → '[2025-01-15,2025-01-20)'
 */
function buildRangeLiteral(value: RangeValue): {
	literal: string;
	cast: string;
} {
	const bounds = value.bounds ?? '[)';
	const leftBound = bounds[0];
	const rightBound = bounds[1];
	// Format values - convert Date objects to ISO strings for PostgreSQL
	const formatValue = (v: unknown): string => {
		if (v === null || v === undefined) return '';
		if (v instanceof Date) return v.toISOString();
		return String(v);
	};
	const lower = formatValue(value.lower);
	const upper = formatValue(value.upper);
	// Escape single quotes in values to prevent SQL injection
	const escapedLower = lower.replace(/'/g, "''");
	const escapedUpper = upper.replace(/'/g, "''");
	// Infer range type from values for explicit casting
	const cast = inferRangeType(value.lower, value.upper);
	// Return literal and cast separately
	return {
		literal: `'${leftBound}${escapedLower},${escapedUpper}${rightBound}'`,
		cast,
	};
}

/**
 * Compile a range WHERE condition to SQL.
 * PostgreSQL operators: && (overlaps), @> (contains), <@ (contained by)
 * Standard SQL: BETWEEN for lower/upper bounds
 */
export function compileRangeExpression(
	column: string,
	operator: RangeOperator,
	value: unknown,
	coreCapabilities?: CoreDialectCapabilities,
	dialect?: string,
): RawBuilder<SqlBool> {
	// Handle BETWEEN operator (standard SQL)
	if (operator === 'between') {
		// Value must be { lower, upper } for BETWEEN
		if (
			typeof value === 'object' &&
			value !== null &&
			'lower' in value &&
			'upper' in value
		) {
			const { lower, upper } = value as { lower: unknown; upper: unknown };
			return sql`${sql.ref(column)} BETWEEN ${sql.val(lower)} AND ${sql.val(upper)}`;
		}
		throw new Error(
			`BETWEEN operator requires value with 'lower' and 'upper' properties`,
		);
	}

	// Validate range capability for PostgreSQL range operators
	if (coreCapabilities && !coreCapabilities.supportsRangeTypes) {
		throw new UnsupportedOperationError(
			'range types',
			`Range operators (overlaps, contains, containedBy) require PostgreSQL. ` +
				`Other databases do not have native range type support.`,
			{ capability: 'supportsRangeTypes', dialect: dialect ?? 'unknown' },
		);
	}

	const sqlOp =
		operator === 'overlaps' ? '&&' : operator === 'contains' ? '@>' : '<@';

	if (isRangeValue(value)) {
		// Range-to-range comparison
		// Build literal with explicit cast: '[2024-01-15,2024-01-20)'::daterange
		const { literal, cast } = buildRangeLiteral(value);
		return sql`${sql.ref(column)} ${sql.raw(sqlOp)} ${sql.raw(literal)}${sql.raw(cast)}`;
	}
	// Scalar value (e.g., range @> element)
	// PostgreSQL needs explicit cast for parameterized values
	const scalarCast = inferScalarCast(value);
	if (scalarCast) {
		return sql`${sql.ref(column)} ${sql.raw(sqlOp)} ${sql.val(value)}${sql.raw(scalarCast)}`;
	}
	return sql`${sql.ref(column)} ${sql.raw(sqlOp)} ${sql.val(value)}`;
}

/**
 * Add simple WHERE conditions (non-relational) to a query.
 * Used for separate include queries.
 *
 * @param coreCapabilities - Optional dialect capabilities for feature validation
 * @param dialect - Optional dialect name for error messages
 */

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
				// NQL-ALIGN Block 5: Subquery optimization info
				sourceTable,
				...(plan.intent.where !== undefined && {
					parentWhere: plan.intent.where,
				}),
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

	const {
		schemaName,
		windows,
		coreCapabilities,
		dialect,
		aliasIncludedColumns,
		// Global limits (NQL-ALIGN Block 3)
		maxDepth,
		maxTableHops,
		maxNestedCase,
	} = options;

	const state: CompilerState = {
		aliasCounter: 0,
		tableAliases: new Map(),
		parameters: [],
		joinedFilterRelations: new Map(),
		joinedIncludeRelations: new Map(),
		...(coreCapabilities !== undefined && { coreCapabilities }),
		...(dialect !== undefined && { dialect }),
		// Global limits with defaults (NQL-ALIGN Block 3)
		maxDepth: maxDepth ?? 10,
		maxTableHops: maxTableHops ?? 5,
		maxNestedCase: maxNestedCase ?? 10,
	};

	const intent = plan.intent;
	const rootTable = intent.from;

	// Get root alias - use semantic table name for readability
	// When schema-scoped, prefix with underscore to avoid PostgreSQL ambiguity
	// (FROM "schema"."table" AS "table" causes "invalid reference to FROM-clause entry")
	state.aliasCounter++;
	const rootAlias = schemaName ? `_${rootTable}` : rootTable;
	state.tableAliases.set(rootTable, rootAlias);

	// Build CTEs first (must come before selectFrom in Kysely)
	const builder = buildCTEs(
		plan,
		model,
		kysely,
		schemaName,
		coreCapabilities,
		dialect,
	);

	// Build the base query using the CTE-enhanced builder
	let query = buildBaseQuery(
		intent,
		rootAlias,
		builder,
		model,
		plan,
		state,
		schemaName,
	);

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

	// SPEC-002: Pre-extract relation filters from WHERE for shared filter optimization
	// This must happen BEFORE include strategies are applied so json_agg can access shared filters
	if (intent.where) {
		extractRelationFiltersForSharing(intent.where, state);
	}

	// Apply CTEs for include-strategy: 'cte' (CLI-011)
	// This handles recursive/self-referential includes
	if (intent.include) {
		query = applyCteIncludes(
			kysely,
			query,
			intent.include,
			plan,
			model,
			state,
			rootTable,
			rootAlias,
			schemaName,
		);
	}

	// Apply LATERAL JOINs for include-strategy: 'lateral' (CORE-006)
	// LATERAL allows correlated subqueries with limit/orderBy per parent
	if (intent.include) {
		query = applyLateralIncludes(
			query,
			intent.include,
			plan,
			model,
			state,
			rootTable,
			rootAlias,
			schemaName,
		);
	}

	// Apply JSON_AGG for include-strategy: 'json_agg' (CORE-006)
	// Aggregates related rows as JSON array, no row duplication
	if (intent.include) {
		query = applyJsonAggIncludes(
			query,
			intent.include,
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
		query = applyJoinIncludes(
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
		query = addIncludeSelectColumns(
			query,
			state,
			model,
			rootTable,
			aliasIncludedColumns,
		);
	}

	// Add WHERE clause
	if (intent.where) {
		// Pre-process WHERE for pseudo-column references (SPEC-001)
		// This registers pending JOINs in state.pendingPseudoJoins
		preprocessWherePseudoColumns(
			intent.where,
			rootTable,
			rootAlias,
			model,
			state,
			schemaName,
		);

		// Apply pending pseudo-column JOINs before WHERE clause
		query = applyPendingPseudoJoins(query, state);

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
	// CLI-NQL: Support relation path expressions (e.g., product.name)
	if (intent.groupBy && intent.groupBy.length > 0) {
		for (const field of intent.groupBy) {
			const resolved = resolveGroupByField(
				field,
				rootAlias,
				rootTable,
				model,
				state,
				query,
				schemaName,
			);
			query = resolved.query;
			query = query.groupBy(resolved.column);
		}
	}

	// Add HAVING clause (DX-034)
	if (intent.having) {
		query = addHaving(
			query,
			intent.having,
			rootAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// Add ORDER BY
	// CLI-NQL: Collect SELECT aliases to avoid table-prefixing them
	const selectAliases = collectSelectAliases(intent.select);
	if (intent.orderBy) {
		for (const order of intent.orderBy) {
			const direction = order.direction === 'desc' ? 'desc' : 'asc';
			// CLI-NQL: If field is an alias from SELECT, use raw SQL (no table prefix)
			if (selectAliases.has(order.field)) {
				query = query.orderBy(sql.ref(order.field), direction);
			} else {
				query = query.orderBy(`${rootAlias}.${order.field}`, direction);
			}
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
// Mutation Compilers (DX-010) - Extracted to mutation-compiler.ts (AUD-004)
// ============================================================================
// Re-export for backwards compatibility
export {
	compileDelete,
	compileInsert,
	compileInsertFrom,
	compileUpdate,
	compileUpsert,
} from './mutation-compiler.js';

// ============================================================================
// Recursive CTE Compiler (RFC-001) - Extracted to recursive-compiler.ts (AUD-004)
// ============================================================================
// Re-export for backwards compatibility
export {
	compileRecursive,
	injectAdvancedRecursiveClauses,
} from './recursive-compiler.js';

// ============================================================================
// Query Building
// ============================================================================

function buildBaseQuery(
	intent: QueryIntent,
	alias: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	const tableName = schemaName ? `${schemaName}.${intent.from}` : intent.from;

	// Start with FROM
	let query = kysely.selectFrom(`${tableName} as ${alias}`);

	// Add SELECT DISTINCT if requested
	if (intent.distinct) {
		query = query.distinct();
	}

	// Add SELECT
	if (!intent.select || intent.select.type === 'all') {
		query = query.selectAll(alias);
	} else if (isSelectAggregate(intent.select)) {
		// Handle aggregate select
		query = buildAggregateSelect(query, intent.select, alias);
	} else if (isSelectWithExpressions(intent.select)) {
		// Handle select with expressions (COALESCE, etc.)
		query = buildSelectWithExpressions(
			query,
			intent.select,
			alias,
			model,
			plan,
			state,
			schemaName,
		);
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
	const useDistinct = agg.distinct === true;

	switch (agg.function) {
		case 'count':
			if (column) {
				return query.select((eb) => {
					const fn = eb.fn.count(column);
					return (useDistinct ? fn.distinct() : fn).as(resultAlias);
				});
			}
			// COUNT(*) - count all rows (distinct doesn't apply to countAll)
			return query.select((eb) => eb.fn.countAll().as(resultAlias));

		case 'sum':
			if (!column) {
				throw new CompilationError('SUM requires a field');
			}
			return query.select((eb) => {
				const fn = eb.fn.sum(column);
				return (useDistinct ? fn.distinct() : fn).as(resultAlias);
			});

		case 'avg':
			if (!column) {
				throw new CompilationError('AVG requires a field');
			}
			return query.select((eb) => {
				const fn = eb.fn.avg(column);
				return (useDistinct ? fn.distinct() : fn).as(resultAlias);
			});

		case 'min':
			if (!column) {
				throw new CompilationError('MIN requires a field');
			}
			return query.select((eb) => {
				const fn = eb.fn.min(column);
				return (useDistinct ? fn.distinct() : fn).as(resultAlias);
			});

		case 'max':
			if (!column) {
				throw new CompilationError('MAX requires a field');
			}
			return query.select((eb) => {
				const fn = eb.fn.max(column);
				return (useDistinct ? fn.distinct() : fn).as(resultAlias);
			});

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
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	let result = query;

	// Process columns in original order (direct ExpressionIntent format)
	for (const col of select.columns) {
		result = addExpressionSelect(
			result,
			col,
			alias,
			model,
			plan,
			state,
			schemaName,
		);
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
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	// Create context for handlers
	const ctx: CompilerContext = { model, plan, state };
	if (schemaName !== undefined) {
		ctx.schemaName = schemaName;
	}

	// Try registry-based dispatch first
	const handler = getExpressionHandler(expr.kind);
	if (handler) {
		return handler(ctx, query, expr, alias);
	}

	// Fallback (should not be reached once all handlers are migrated)
	throw new CompilationError(
		`Unknown expression kind: ${(expr as ExpressionIntent).kind}`,
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

/**
 * Add HAVING clause to query
 */
function addHaving(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	having: WhereIntent,
	alias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	return query.having((eb) =>
		compileWhere(eb, having, alias, model, plan, state, schemaName),
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
	// Create context with recursive dispatcher
	const ctx: CompilerContext = { model, plan, state };
	if (schemaName !== undefined) {
		ctx.schemaName = schemaName;
	}
	// Add compileWhere as dispatcher for recursive handlers
	ctx.compileWhere = (_innerCtx, innerEb, innerWhere, innerAlias) =>
		compileWhere(
			innerEb,
			innerWhere,
			innerAlias,
			model,
			plan,
			state,
			schemaName,
		);

	// Try registry-based dispatch first
	const handler = getWhereHandler(where.kind);
	if (handler) {
		return handler(ctx, eb, where, alias);
	}

	// Fallback to switch for handlers not yet migrated
	switch (where.kind) {
		case 'comparison':
			// Migrated to registry - this case should not be reached
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

		case 'range':
			return compileRangeExpression(
				`${alias}.${where.field}`,
				where.operator,
				where.value,
				state.coreCapabilities,
				state.dialect,
			);

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

		// Complex handlers (exists, notExists, relationFilter, subquery)
		// are now handled by the registry via registerComplexWhereHandlers()

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

/**
 * CLI-NQL Block 7: Compile recursive EXISTS for ancestors/descendants traversal.
 *
 * Generates SQL like:
 * ```sql
 * EXISTS (
 *   WITH RECURSIVE ancestors(id, parent_id, depth) AS (
 *     SELECT id, parent_id, 1 FROM categories WHERE id = outer.parent_id
 *     UNION ALL
 *     SELECT c.id, c.parent_id, a.depth + 1 FROM categories c
 *     JOIN ancestors a ON c.id = a.parent_id WHERE a.depth < 10
 *   )
 *   SELECT 1 FROM ancestors WHERE name = 'Electronics'
 * )
 * ```
 *
 * NOTE: Uses sql template because Kysely's expression builder doesn't support
 * inline recursive CTEs inside EXISTS. This is a documented exception per CLAUDE.md.
 */
function compileRecursiveExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	_eb: any,
	where: {
		relation: string;
		where?: WhereIntent;
		recursive: RecursiveExistsOptions;
	},
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	negate: boolean,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	const { direction, through, maxDepth = 10 } = where.recursive;

	// Get source table
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;
	const sourceTableDef = model.getTable(sourceTable);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);

	// Find the "through" relation (e.g., 'parent' for ancestors)
	const throughRelation = model.getRelation(`${sourceTable}.${through}`);
	if (!throughRelation) {
		throw new CompilationError(
			`Cannot find through relation for recursive traversal: ${sourceTable}.${through}`,
		);
	}

	// Get FK column (e.g., parentId for parent relation)
	const fkCols = normalizeForeignKey(throughRelation.foreignKey, 'parentId');
	const fkCol = fkCols[0];
	const pkCol = sourceKeys[0];

	// Validate we have the required columns
	if (!fkCol) {
		throw new CompilationError(
			`Cannot determine foreign key for recursive traversal: ${sourceTable}.${through}`,
		);
	}
	if (!pkCol) {
		throw new CompilationError(
			`Cannot determine primary key for recursive traversal: ${sourceTable}`,
		);
	}

	// CTE name unique to this query
	const cteName = `_ancestors_${state.aliasCounter++}`;
	const cteAlias = 'r';

	// Table name with optional schema
	const tableName = schemaName
		? sql.raw(`"${schemaName}"."${sourceTable}"`)
		: sql.raw(`"${sourceTable}"`);

	// Build WHERE clause for the CTE result if present
	let cteWhereClause: RawBuilder<unknown> = sql`1=1`;
	if (where.where) {
		// Compile the nested WHERE against the source table alias (src)
		cteWhereClause = compileWhereToRaw(where.where, 'src', model, state);
	}

	// Build the recursive CTE SQL based on direction
	let existsSql: RawBuilder<unknown>;

	// Use fixed alias 'fk' in CTE to avoid column name transformation issues
	// sql.ref() handles camelCase→snake_case transformation for table columns
	const fkCteAlias = 'fk';

	if (direction === 'up') {
		// Ancestors: traverse UP via parent FK
		// Base case: SELECT FROM table WHERE id = outer.parentId
		// Recursive: JOIN on id = fk (go to parent's parent)
		existsSql = sql`EXISTS (
			WITH RECURSIVE ${sql.raw(cteName)}(id, ${sql.raw(fkCteAlias)}, _depth) AS (
				SELECT ${sql.ref('id')}, ${sql.ref(fkCol)}, 1 AS _depth
				FROM ${tableName}
				WHERE ${sql.ref('id')} = ${sql.ref(`${sourceAlias}.${fkCol}`)}
				UNION ALL
				SELECT ${sql.ref('t.id')}, ${sql.ref(`t.${fkCol}`)}, ${sql.raw(cteAlias)}._depth + 1
				FROM ${tableName} t
				INNER JOIN ${sql.raw(cteName)} ${sql.raw(cteAlias)} ON ${sql.ref('t.id')} = ${sql.raw(cteAlias)}.${sql.raw(fkCteAlias)}
				WHERE ${sql.raw(cteAlias)}._depth < ${maxDepth}
			)
			SELECT 1 FROM ${sql.raw(cteName)}
			INNER JOIN ${tableName} src ON ${sql.ref('src.id')} = ${sql.raw(cteName)}.id
			WHERE ${cteWhereClause}
		)`;
	} else {
		// Descendants: traverse DOWN via children (reverse FK direction)
		// Base case: SELECT FROM table WHERE parentId = outer.id
		// Recursive: JOIN on parentId = id (go to children's children)
		existsSql = sql`EXISTS (
			WITH RECURSIVE ${sql.raw(cteName)}(id, ${sql.raw(fkCteAlias)}, _depth) AS (
				SELECT ${sql.ref('id')}, ${sql.ref(fkCol)}, 1 AS _depth
				FROM ${tableName}
				WHERE ${sql.ref(fkCol)} = ${sql.ref(`${sourceAlias}.${pkCol}`)}
				UNION ALL
				SELECT ${sql.ref('t.id')}, ${sql.ref(`t.${fkCol}`)}, ${sql.raw(cteAlias)}._depth + 1
				FROM ${tableName} t
				INNER JOIN ${sql.raw(cteName)} ${sql.raw(cteAlias)} ON ${sql.ref(`t.${fkCol}`)} = ${sql.raw(cteAlias)}.id
				WHERE ${sql.raw(cteAlias)}._depth < ${maxDepth}
			)
			SELECT 1 FROM ${sql.raw(cteName)}
			INNER JOIN ${tableName} src ON ${sql.ref('src.id')} = ${sql.raw(cteName)}.id
			WHERE ${cteWhereClause}
		)`;
	}

	if (negate) {
		return sql`NOT ${existsSql}`;
	}
	return existsSql;
}

/**
 * Compile a simple WHERE clause to raw SQL for use in recursive CTE.
 * Handles basic comparisons; complex cases fall back to true.
 */
function compileWhereToRaw(
	where: WhereIntent,
	alias: string,
	model: ModelIR,
	state: CompilerState,
): RawBuilder<unknown> {
	if (where.kind === 'comparison') {
		const column = `"${alias}"."${where.field}"`;
		const value = where.value;

		switch (where.operator) {
			case 'eq':
				return sql`${sql.raw(column)} = ${value}`;
			case 'neq':
				return sql`${sql.raw(column)} != ${value}`;
			case 'gt':
				return sql`${sql.raw(column)} > ${value}`;
			case 'gte':
				return sql`${sql.raw(column)} >= ${value}`;
			case 'lt':
				return sql`${sql.raw(column)} < ${value}`;
			case 'lte':
				return sql`${sql.raw(column)} <= ${value}`;
			default:
				return sql`1=1`;
		}
	}

	if (where.kind === 'like') {
		const column = `"${alias}"."${where.field}"`;
		return sql`${sql.raw(column)} LIKE ${where.pattern}`;
	}

	if (where.kind === 'and') {
		const conditions = where.conditions.map((c) =>
			compileWhereToRaw(c, alias, model, state),
		);
		if (conditions.length === 0) return sql`1=1`;
		// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
		if (conditions.length === 1) return conditions[0]!;
		return sql`(${sql.join(conditions, sql` AND `)})`;
	}

	if (where.kind === 'or') {
		const conditions = where.conditions.map((c) =>
			compileWhereToRaw(c, alias, model, state),
		);
		if (conditions.length === 0) return sql`1=1`;
		// biome-ignore lint/style/noNonNullAssertion: length check guarantees element exists
		if (conditions.length === 1) return conditions[0]!;
		return sql`(${sql.join(conditions, sql` OR `)})`;
	}

	// For complex cases, return true (no filtering)
	return sql`1=1`;
}

function compileExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: string;
		where?: WhereIntent;
		recursive?: RecursiveExistsOptions;
	},
	sourceAlias: string,
	model: ModelIR,
	plan: PlanReport,
	state: CompilerState,
	negate: boolean,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression
): any {
	// CLI-NQL Block 7: Handle recursive exists (ancestors/descendants)
	if (where.recursive) {
		return compileRecursiveExists(
			eb,
			where as {
				relation: string;
				where?: WhereIntent;
				recursive: RecursiveExistsOptions;
			},
			sourceAlias,
			model,
			plan,
			state,
			negate,
			schemaName,
		);
	}

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

	// Get alias for related table - use relation name for semantic readability
	// When schema-scoped, prefix to avoid PostgreSQL ambiguity
	state.aliasCounter++;
	const relatedAlias = schemaName ? `_${where.relation}` : where.relation;
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
		// Use real junction table name as alias for semantic readability
		// When schema-scoped, prefix to avoid PostgreSQL ambiguity
		state.aliasCounter++;
		const junctionAlias = schemaName
			? `_${relation.through}`
			: relation.through;
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
			// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder requires any
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
				// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder requires any
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
				// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder requires any
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

/**
 * Add SELECT columns for included relations that were JOINed.
 * Columns are aliased as "relationName.columnName" to avoid conflicts.
 *
 * @param aliasIncludedColumns - Aliasing mode:
 *   - 'always' (default): Alias ALL columns from included tables
 *   - 'onCollision': Only alias columns that collide with root table columns
 */
function addIncludeSelectColumns(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	state: CompilerState,
	model: ModelIR,
	rootTable: string,
	aliasIncludedColumns: 'always' | 'onCollision' = 'always',
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): SelectQueryBuilder<any, any, any> {
	if (state.joinedIncludeRelations.size === 0) {
		return query;
	}

	// Collect root table column names for collision detection
	const rootTableDef = model.getTable(rootTable);
	const rootColumnNames = new Set(
		rootTableDef ? rootTableDef.columns.map((c) => c.name) : [],
	);

	let result = query;

	for (const [relationName, joinInfo] of state.joinedIncludeRelations) {
		const { alias, targetTable, strategy } = joinInfo;

		// Skip JSON_AGG relations - the data is already in the _json column
		if (strategy === 'json_agg') {
			continue;
		}

		const tableDef = model.getTable(targetTable);

		if (!tableDef) {
			throw new CompilationError(`Unknown table for include: ${targetTable}`);
		}

		// Add columns from the included table
		for (const column of tableDef.columns) {
			const hasCollision =
				aliasIncludedColumns === 'always' || rootColumnNames.has(column.name);

			if (hasCollision) {
				// Alias as "relationName.columnName" to disambiguate
				const aliasedName = `${relationName}.${column.name}`;
				result = result.select(
					sql`${sql.ref(`${alias}.${column.name}`)}`.as(aliasedName),
				);
			} else {
				// No collision - use plain column name as alias (no relation prefix)
				result = result.select(
					sql`${sql.ref(`${alias}.${column.name}`)}`.as(column.name),
				);
			}
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
		// SPEC-002: Multi-hop relations (array) always use EXISTS, not JOIN
		// Only single-hop (string) relations can use JOIN
		if (Array.isArray(where.relation)) {
			return results; // Multi-hop always uses EXISTS
		}
		// TypeScript narrowing: Array.isArray doesn't narrow readonly string[], use assertion
		const relationName = where.relation as string;
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			relationName,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: relationName,
				where: where.where,
				mode: where.mode,
			});
		}
	} else if (where.kind === 'exists') {
		// Handle exists() helper - maps to mode: 'some'
		if (Array.isArray(where.relation)) {
			return results; // Multi-hop always uses EXISTS
		}
		const relationName = where.relation as string;
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			relationName,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: relationName,
				...(where.where !== undefined && { where: where.where }),
				mode: 'some',
			});
		}
	} else if (where.kind === 'notExists') {
		// Handle notExists() helper - maps to mode: 'none'
		if (Array.isArray(where.relation)) {
			return results; // Multi-hop always uses EXISTS
		}
		const relationName = where.relation as string;
		const decision = findFilterStrategyDecision(
			plan,
			sourceTable,
			relationName,
		);
		if (decision?.choice === 'join') {
			results.push({
				relation: relationName,
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
function lookupResolvedRelation(
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

		const relation = lookupResolvedRelation(
			joinRel.relation,
			rootTable,
			model,
			plan,
		);

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
			// Use semantic names: junction table name for junction, relation name for target
			// When schema-scoped, prefix to avoid PostgreSQL ambiguity
			state.aliasCounter++;
			const junctionAlias = schemaName
				? `_${relation.through}`
				: relation.through;
			state.aliasCounter++;
			const targetAlias = schemaName
				? `_${joinRel.relation}`
				: joinRel.relation;

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
			// Use relation name as alias for semantic readability
			// When schema-scoped, prefix to avoid PostgreSQL ambiguity
			state.aliasCounter++;
			const joinAlias = schemaName ? `_${joinRel.relation}` : joinRel.relation;
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
		relation: string | readonly string[];
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
	// SPEC-002: Normalize relation path to array
	const relationPath = Array.isArray(where.relation)
		? where.relation
		: [where.relation];

	// Single-hop: use existing logic
	if (relationPath.length === 1) {
		return compileSingleHopRelationFilter(
			eb,
			{ relation: relationPath[0], where: where.where, mode: where.mode },
			sourceAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// SPEC-002: Multi-hop relation path
	// Strategy: Build nested EXISTS/JOINs based on relation types
	// - to-one (belongsTo/hasOne): JOIN inside EXISTS
	// - to-many (hasMany): nested EXISTS
	return compileMultiHopRelationFilter(
		eb,
		{ relation: relationPath, where: where.where, mode: where.mode },
		sourceAlias,
		model,
		plan,
		state,
		schemaName,
	);
}

/**
 * SPEC-002: Compile single-hop relation filter (original logic).
 * Used for simple relation paths like 'posts' or ['posts'].
 */
function compileSingleHopRelationFilter(
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

	// SPEC-002: Track relation filter for shared filter optimization in json_agg
	// Only for 'some' mode - the filter should apply to json_agg results too
	if (where.mode === 'some') {
		if (!state.relationFilters) {
			state.relationFilters = new Map();
		}
		state.relationFilters.set(where.relation, where.where);
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
 * SPEC-002: Compile multi-hop relation filter.
 * Example: `posts.author.company.name = 'Acme'` from categories table.
 *
 * Strategy:
 * - First to-many in path → EXISTS subquery start point
 * - to-one relations after → JOINs inside EXISTS
 * - Another to-many → nested EXISTS
 */
function compileMultiHopRelationFilter(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	where: {
		relation: readonly string[];
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
	// Array guaranteed to have at least 2 elements (multi-hop called after length check)
	const firstRel = where.relation[0] as string;
	const restPath = where.relation.slice(1);

	// Find the first relation from source table
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;
	const relation = model.getRelation(`${sourceTable}.${firstRel}`);

	if (!relation) {
		throw new CompilationError(`Unknown relation: ${sourceTable}.${firstRel}`);
	}

	// Determine if first hop is to-one or to-many
	const isFirstToMany =
		relation.type === 'hasMany' || relation.type === 'belongsToMany';

	if (isFirstToMany) {
		// First hop is to-many: Start with EXISTS
		// Remaining path becomes JOINs or nested conditions inside
		return compileMultiHopWithExists(
			eb,
			{
				firstRelation: firstRel,
				remainingPath: restPath,
				where: where.where,
				mode: where.mode,
			},
			sourceAlias,
			model,
			plan,
			state,
			schemaName,
		);
	}

	// First hop is to-one (belongsTo/hasOne): Could optimize with JOIN
	// But for SPEC-002, we start simple with EXISTS that includes JOINs
	return compileMultiHopWithExists(
		eb,
		{
			firstRelation: firstRel,
			remainingPath: restPath,
			where: where.where,
			mode: where.mode,
		},
		sourceAlias,
		model,
		plan,
		state,
		schemaName,
	);
}

/**
 * SPEC-002: Compile multi-hop with EXISTS subquery.
 * Builds EXISTS (SELECT 1 FROM first_table JOIN ... WHERE condition).
 */
function compileMultiHopWithExists(
	// biome-ignore lint/suspicious/noExplicitAny: Kysely expression builder
	eb: any,
	options: {
		firstRelation: string;
		remainingPath: readonly string[];
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
	const { firstRelation, remainingPath, where: whereIntent, mode } = options;

	// Find the first relation
	const sourceTable = getTableFromAlias(state, sourceAlias) ?? plan.rootTable;
	const relation = model.getRelation(`${sourceTable}.${firstRelation}`);

	if (!relation) {
		throw new CompilationError(
			`Unknown relation: ${sourceTable}.${firstRelation}`,
		);
	}

	// Generate alias for first relation
	state.aliasCounter++;
	const firstAlias = schemaName ? `_${firstRelation}` : firstRelation;
	state.tableAliases.set(`${relation.target}_${firstAlias}`, firstAlias);

	// Get primary keys for correlation
	const sourceTableDef = model.getTable(relation.source);
	const sourceKeys = normalizePrimaryKey(sourceTableDef?.primaryKey);
	const targetTableDef = model.getTable(relation.target);
	const targetKeys = normalizePrimaryKey(targetTableDef?.primaryKey);
	const fkCols = normalizeForeignKey(relation.foreignKey, 'id');

	// Apply schema prefix
	const targetTable = schemaName
		? `${schemaName}.${relation.target}`
		: relation.target;

	// Build base subquery
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	let subquery: any = eb
		.selectFrom(`${targetTable} as ${firstAlias}`)
		// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
		.select((innerEb: any) => innerEb.lit(1).as('_exists'));

	// Add FK correlation based on relation type
	if (relation.type === 'belongsTo') {
		// belongsTo: source.fk = target.pk
		if (fkCols.length === 1) {
			subquery = subquery.whereRef(
				`${sourceAlias}.${fkCols[0]}`,
				'=',
				`${firstAlias}.${targetKeys[0]}`,
			);
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder requires any
			subquery = subquery.where((innerEb: any) =>
				buildCompositeKeyCorrelation(
					innerEb,
					sourceAlias,
					firstAlias,
					fkCols,
					targetKeys,
				),
			);
		}
	} else if (relation.type === 'hasMany' || relation.type === 'hasOne') {
		// hasMany/hasOne: target.fk = source.pk
		if (fkCols.length === 1) {
			subquery = subquery.whereRef(
				`${firstAlias}.${fkCols[0]}`,
				'=',
				`${sourceAlias}.${sourceKeys[0]}`,
			);
		} else {
			// biome-ignore lint/suspicious/noExplicitAny: Kysely ExpressionBuilder requires any
			subquery = subquery.where((innerEb: any) =>
				buildCompositeKeyCorrelation(
					innerEb,
					firstAlias,
					sourceAlias,
					fkCols,
					sourceKeys,
				),
			);
		}
	} else if (relation.type === 'belongsToMany' && relation.through) {
		// M:N: Need to JOIN through table first
		const junctionAlias = schemaName
			? `_${relation.through}`
			: relation.through;
		const junctionTable = schemaName
			? `${schemaName}.${relation.through}`
			: relation.through;
		const otherKey = relation.otherKey ?? `${relation.target}Id`;

		// Rebuild subquery starting from junction
		subquery = eb
			.selectFrom(`${junctionTable} as ${junctionAlias}`)
			// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
			.select((innerEb: any) => innerEb.lit(1).as('_exists'))
			.innerJoin(
				`${targetTable} as ${firstAlias}`,
				`${junctionAlias}.${otherKey}`,
				`${firstAlias}.${targetKeys[0]}`,
			);

		// Correlate junction to source
		if (fkCols.length === 1) {
			subquery = subquery.whereRef(
				`${junctionAlias}.${fkCols[0]}`,
				'=',
				`${sourceAlias}.${sourceKeys[0]}`,
			);
		}
	}

	// Now add JOINs for remaining path (to-one relations)
	let currentAlias = firstAlias;
	let currentTable = relation.target;

	for (const relName of remainingPath) {
		const nextRelation = model.getRelation(`${currentTable}.${relName}`);

		if (!nextRelation) {
			throw new CompilationError(
				`Unknown relation in path: ${currentTable}.${relName}`,
			);
		}

		// Generate alias for this relation
		state.aliasCounter++;
		const nextAlias = schemaName
			? `_${relName}_${state.aliasCounter}`
			: relName;
		state.tableAliases.set(`${nextRelation.target}_${nextAlias}`, nextAlias);

		// Get keys for JOIN
		const nextTargetDef = model.getTable(nextRelation.target);
		const nextTargetKeys = normalizePrimaryKey(nextTargetDef?.primaryKey);
		const nextFkCols = normalizeForeignKey(nextRelation.foreignKey, 'id');

		const nextTargetTable = schemaName
			? `${schemaName}.${nextRelation.target}`
			: nextRelation.target;

		// Add JOIN based on relation type
		if (nextRelation.type === 'belongsTo') {
			// belongsTo: current.fk = next.pk (LEFT JOIN to handle nullable FKs)
			subquery = subquery.leftJoin(
				`${nextTargetTable} as ${nextAlias}`,
				`${currentAlias}.${nextFkCols[0]}`,
				`${nextAlias}.${nextTargetKeys[0]}`,
			);
		} else if (
			nextRelation.type === 'hasOne' ||
			nextRelation.type === 'hasMany'
		) {
			// hasOne/hasMany: next.fk = current.pk
			const currentTableDef = model.getTable(currentTable);
			const currentKeys = normalizePrimaryKey(currentTableDef?.primaryKey);
			subquery = subquery.leftJoin(
				`${nextTargetTable} as ${nextAlias}`,
				`${nextAlias}.${nextFkCols[0]}`,
				`${currentAlias}.${currentKeys[0]}`,
			);
		}

		currentAlias = nextAlias;
		currentTable = nextRelation.target;
	}

	// Add the WHERE condition on the final alias
	let finalSubquery = subquery;
	if (whereIntent) {
		finalSubquery = subquery.where((innerEb: unknown) =>
			compileWhere(
				innerEb,
				whereIntent,
				currentAlias,
				model,
				plan,
				state,
				schemaName,
			),
		);
	}

	// Apply mode (some/none/every)
	switch (mode) {
		case 'some':
			return eb.exists(finalSubquery);

		case 'none':
			return eb.not(eb.exists(finalSubquery));

		case 'every': {
			// every: NOT EXISTS (... AND NOT condition) AND EXISTS (...)
			// For simplicity, we rebuild with inverted condition
			const invertedWhere: WhereIntent = {
				kind: 'not',
				condition: whereIntent,
			};

			// Rebuild subquery with inverted condition
			let invertedSubquery = subquery;
			invertedSubquery = subquery.where((innerEb: unknown) =>
				compileWhere(
					innerEb,
					invertedWhere,
					currentAlias,
					model,
					plan,
					state,
					schemaName,
				),
			);

			// Also need to check existence (non-vacuous truth)
			return eb.and([
				eb.not(eb.exists(invertedSubquery)),
				eb.exists(finalSubquery),
			]);
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

/**
 * Find IncludeIntent by sourceIntent path (e.g., "users.posts" or "users.posts.comments")
 * CLI-012b: Helper for finding include filters to apply in CTEs
 */
function findIncludeByPath(
	intent: QueryIntent,
	sourceIntent: string,
): IncludeIntent | undefined {
	const parts = sourceIntent.split('.');
	// parts[0] = source table (e.g., "users" or "posts"), parts[1] = relation name
	// For nested includes, sourceIntent might be "posts.comments" but we need to find
	// it within intent.include[*].include[*] where the parent target table is "posts"

	if (parts.length < 2 || !intent.include) return undefined;

	const sourceTable = parts[0];
	const relationName = parts[1];

	// Helper function to recursively search for the include
	function findInIncludes(
		includes: readonly IncludeIntent[],
		parentTargetTable: string,
	): IncludeIntent | undefined {
		for (const inc of includes) {
			// Check if this include's parent matches the source table
			if (parentTargetTable === sourceTable && inc.relation === relationName) {
				return inc;
			}
			// Recursively search in nested includes
			if (inc.include) {
				// The nested includes have the current relation's target as their parent
				const result = findInIncludes(inc.include, inc.relation);
				if (result) return result;
			}
		}
		return undefined;
	}

	// Start search from root table (intent.from)
	return findInIncludes(intent.include, intent.from);
}

/**
 * CLI-012c: Build a recursive CTE for self-referential includes.
 *
 * Generates SQL like:
 * WITH RECURSIVE cte_name AS (
 *   -- Base case: root nodes (where foreignKey IS NULL)
 *   SELECT *, 0 AS depth FROM table WHERE parentId IS NULL
 *   UNION ALL
 *   -- Recursive case: join children to CTE
 *   SELECT t.*, c.depth + 1 FROM table t
 *   INNER JOIN cte_name c ON t.parentId = c.id
 *   WHERE c.depth < maxDepth
 * )
 *
 * Per ARCH-001: Uses native Kysely APIs, NEVER raw SQL.
 */
function buildRecursiveCTE(
	// biome-ignore lint/suspicious/noExplicitAny: Dynamic Kysely builder
	builder: any,
	cteName: string,
	relation: RelationIR,
	includeIntent: IncludeIntent | undefined,
	targetTable: string,
	_schemaName: string | undefined,
	coreCapabilities?: CoreDialectCapabilities,
	dialect?: string,
): // biome-ignore lint/suspicious/noExplicitAny: Returns Kysely builder
any {
	const recursive = includeIntent?.recursive;
	const maxDepth = recursive?.maxDepth ?? 100;
	const trackDepth = recursive?.track?.depth;
	const trackPath = recursive?.track?.path;

	// Determine foreign key (use explicit or infer from relation)
	const foreignKey = recursive?.foreignKey ?? relation.foreignKey ?? 'parentId';
	const primaryKey = 'id'; // Convention: primary key is 'id'

	// Column aliases
	const depthAlias =
		typeof trackDepth === 'object' && trackDepth.as ? trackDepth.as : 'depth';
	const pathAlias =
		typeof trackPath === 'object' && trackPath.as ? trackPath.as : 'path';

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building
	return builder.withRecursive(cteName, (db: Kysely<any>) => {
		// ============================================================
		// Base case: root nodes (where foreignKey IS NULL)
		// ============================================================
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
		let baseQuery: any = db.selectFrom(targetTable).selectAll();

		// Track depth if requested: SELECT *, 0 AS depth
		if (trackDepth) {
			// biome-ignore lint/suspicious/noExplicitAny: Expression builder
			baseQuery = baseQuery.select((eb: any) => eb.lit(0).as(depthAlias));
		}

		// Track path if requested: SELECT *, ARRAY[id] AS path
		if (trackPath) {
			// biome-ignore lint/suspicious/noExplicitAny: Expression builder
			baseQuery = baseQuery.select((eb: any) =>
				eb.fn('array', [eb.ref(primaryKey)]).as(pathAlias),
			);
		}

		// Base case filter: root nodes (foreignKey IS NULL)
		baseQuery = baseQuery.where(foreignKey, 'is', null);

		// Apply include.where filter to base case
		if (includeIntent?.where) {
			baseQuery = addWhereSimple(
				baseQuery,
				includeIntent.where,
				relation.target,
				coreCapabilities,
				dialect,
			);
		}

		// ============================================================
		// Recursive case: JOIN children to CTE
		// ============================================================
		// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
		let recursiveQuery: any = db
			.selectFrom(`${targetTable} as t`)
			.innerJoin(`${cteName} as c`, `t.${foreignKey}`, `c.${primaryKey}`)
			.selectAll('t');

		// Track depth: c.depth + 1
		if (trackDepth) {
			// biome-ignore lint/suspicious/noExplicitAny: Expression builder
			recursiveQuery = recursiveQuery.select((eb: any) =>
				eb(eb.ref(`c.${depthAlias}`), '+', eb.lit(1)).as(depthAlias),
			);
		}

		// Track path: c.path || ARRAY[t.id]
		if (trackPath) {
			// biome-ignore lint/suspicious/noExplicitAny: Expression builder
			recursiveQuery = recursiveQuery.select((eb: any) =>
				eb
					.fn('array_cat', [
						eb.ref(`c.${pathAlias}`),
						eb.fn('array', [eb.ref(`t.${primaryKey}`)]),
					])
					.as(pathAlias),
			);
		}

		// maxDepth termination: WHERE c.depth < maxDepth
		if (trackDepth) {
			recursiveQuery = recursiveQuery.where(`c.${depthAlias}`, '<', maxDepth);
		}

		// Apply include.where filter to recursive case
		if (includeIntent?.where) {
			recursiveQuery = addWhereSimple(
				recursiveQuery,
				includeIntent.where,
				't',
				coreCapabilities,
				dialect,
			);
		}

		// Combine with UNION ALL (standard for recursive CTEs)
		return baseQuery.unionAll(recursiveQuery);
	});
}

function buildCTEs(
	plan: PlanReport,
	model: ModelIR,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	kysely: Kysely<any>,
	schemaName?: string,
	coreCapabilities?: CoreDialectCapabilities,
	dialect?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Returns Kysely or WithSchemaBuilder
): any {
	if (plan.ctes.length === 0) {
		return kysely;
	}

	// biome-ignore lint/suspicious/noExplicitAny: Dynamic CTE building
	let builder: any = kysely;

	for (const cte of plan.ctes) {
		// Parse sourceIntent to get source table and relation
		// Format: "sourceTable.relationName" or "sourceTable.rel1.rel2" for nested
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

		// CLI-012b: Find the include intent to get filters
		const includeIntent = findIncludeByPath(plan.intent, cte.sourceIntent);

		// Build CTE: SELECT * FROM targetTable [WHERE ...]
		const targetTable = schemaName
			? `${schemaName}.${relation.target}`
			: relation.target;

		// CLI-012c: Check if this is a recursive CTE
		if (cte.recursive) {
			builder = buildRecursiveCTE(
				builder,
				cte.name,
				relation,
				includeIntent,
				targetTable,
				schemaName,
				coreCapabilities,
				dialect,
			);
		} else {
			// Non-recursive CTE (existing CLI-012b logic)
			// biome-ignore lint/suspicious/noExplicitAny: Dynamic table name requires any
			builder = builder.with(cte.name, (db: Kysely<any>) => {
				// biome-ignore lint/suspicious/noExplicitAny: Dynamic query building
				let cteQuery: any = db.selectFrom(targetTable).selectAll();

				// CLI-012b: Apply include.where filter inside the CTE
				if (includeIntent?.where) {
					cteQuery = addWhereSimple(
						cteQuery,
						includeIntent.where,
						relation.target,
						coreCapabilities,
						dialect,
					);
				}

				return cteQuery;
			});
		}
	}

	return builder;
}

// ============================================================================
// DX-005: Emit Join Compilation - Extracted to recursive-compiler.ts (AUD-004)
// ============================================================================
// Re-exported via recursive-compiler.ts, used internally

// ============================================================================
// Utilities
// ============================================================================

/**
 * CLI-NQL: Resolve a GROUP BY field to its proper column reference.
 * Handles relation path expressions like "product.name" by adding JOINs if needed.
 */
function resolveGroupByField(
	field: string,
	rootAlias: string,
	rootTable: string,
	model: ModelIR,
	state: CompilerState,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
	query: SelectQueryBuilder<any, any, any>,
	schemaName?: string,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any
): { query: SelectQueryBuilder<any, any, any>; column: string } {
	// Simple column - no relation path
	if (!field.includes('.')) {
		return { query, column: `${rootAlias}.${field}` };
	}

	// Relation path expression like "product.name" or "category.parent.name"
	const segments = field.split('.');
	const column = segments.pop() ?? field; // Last segment is the column (fallback to field if no dots)
	const relationPath = segments.join('.'); // Remaining is the relation path

	// Check if this relation path is already JOINed
	let joinInfo = state.joinedIncludeRelations.get(relationPath);
	if (!joinInfo) {
		const filterInfo = state.joinedFilterRelations.get(relationPath);
		if (filterInfo) {
			joinInfo = {
				alias: filterInfo.alias,
				targetTable: filterInfo.targetTable,
				relationName: relationPath,
				strategy: 'join' as const,
			};
		}
	}

	if (joinInfo) {
		// Relation already joined - use its alias
		return { query, column: `${joinInfo.alias}.${column}` };
	}

	// Need to create the JOIN - traverse the relation path
	let currentAlias = rootAlias;
	let currentTableName = rootTable;
	let result = query;

	for (let i = 0; i < segments.length; i++) {
		const relName = segments[i];
		if (!relName) continue;
		const relationKey = segments.slice(0, i + 1).join('.');

		// Check if this segment is already joined
		let segmentJoinInfo = state.joinedIncludeRelations.get(relationKey);
		if (!segmentJoinInfo) {
			const filterInfo = state.joinedFilterRelations.get(relationKey);
			if (filterInfo) {
				segmentJoinInfo = {
					alias: filterInfo.alias,
					targetTable: filterInfo.targetTable,
					relationName: relationKey,
					strategy: 'join' as const,
				};
			}
		}

		if (segmentJoinInfo) {
			currentAlias = segmentJoinInfo.alias;
			currentTableName = segmentJoinInfo.targetTable;
			continue;
		}

		// Find the relation definition
		const currentTableDef = model.getTable(currentTableName);
		if (!currentTableDef) {
			throw new Error(`Unknown table: ${currentTableName}`);
		}

		const relDef = model.getRelation(`${currentTableName}.${relName}`);
		if (!relDef) {
			throw new Error(
				`Relation '${relName}' not found from table '${currentTableName}'`,
			);
		}

		// Create alias for the join - use relation name for semantic readability
		// When schema-scoped, prefix to avoid PostgreSQL ambiguity
		state.aliasCounter++;
		const joinAlias = schemaName ? `_${relName}` : relName;
		const targetTable = schemaName
			? `${schemaName}.${relDef.target}`
			: relDef.target;

		// Add LEFT JOIN based on relation type
		if (relDef.type === 'belongsTo') {
			// belongsTo: child.fk = parent.pk
			const fkField = Array.isArray(relDef.foreignKey)
				? relDef.foreignKey[0]
				: relDef.foreignKey;
			result = result.leftJoin(
				`${targetTable} as ${joinAlias}`,
				`${currentAlias}.${fkField}`,
				`${joinAlias}.id`,
			);
		} else {
			// hasOne/hasMany: parent.pk = child.fk
			const fkField = Array.isArray(relDef.foreignKey)
				? relDef.foreignKey[0]
				: relDef.foreignKey;
			result = result.leftJoin(
				`${targetTable} as ${joinAlias}`,
				`${currentAlias}.id`,
				`${joinAlias}.${fkField}`,
			);
		}

		// Track the join
		state.joinedIncludeRelations.set(relationKey, {
			alias: joinAlias,
			targetTable: relDef.target,
			relationName: relationKey,
			strategy: 'join',
		});

		currentAlias = joinAlias;
		currentTableName = relDef.target;
	}

	return { query: result, column: `${currentAlias}.${column}` };
}

/**
 * CLI-NQL: Collect aliases defined in SELECT clause.
 * Used to determine if ORDER BY field is an alias (no table prefix needed).
 */
function collectSelectAliases(select: SelectIntent | undefined): Set<string> {
	const aliases = new Set<string>();
	if (!select) return aliases;

	if (isSelectAggregate(select)) {
		// Aggregate aliases: COUNT(*) AS count, SUM(price) AS total
		for (const agg of select.aggregates) {
			if (agg.as) {
				aliases.add(agg.as);
			} else {
				// Default alias: function_field or function
				const defaultAlias = agg.field
					? `${agg.function}_${agg.field}`
					: agg.function;
				aliases.add(defaultAlias);
			}
		}
	} else if (isSelectWithExpressions(select)) {
		// Direct ExpressionIntent format: each col is an expression
		for (const expr of select.columns) {
			// WindowIntent uses 'alias', other expressions use 'as'
			if (expr.kind === 'window') {
				aliases.add(expr.alias);
			} else if ('as' in expr && expr.as) {
				aliases.add(expr.as);
			} else if (expr.kind === 'column') {
				// Column expressions without alias use the column name
				aliases.add(expr.column);
			}
		}
	}

	return aliases;
}

function getTableFromAlias(
	state: CompilerState,
	alias: string,
): string | undefined {
	for (const [table, a] of state.tableAliases) {
		if (a === alias) {
			// Handle compound keys like "posts_t1" or "categories_join"
			const parts = table.split('_');
			const lastPart = parts[parts.length - 1];
			if (
				parts.length > 1 &&
				(lastPart?.startsWith('t') || lastPart === 'join')
			) {
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
	// biome-ignore lint/style/noNonNullAssertion: Length check guarantees value[0] exists
	return value.length === 1 ? value[0]! : value;
}
