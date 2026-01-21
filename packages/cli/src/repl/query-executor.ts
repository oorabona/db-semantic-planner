/**
 * DX-030: Query Executor using real semantic planner
 *
 * Converts ParsedQuery to ORM API calls and returns the compiled SQL.
 * Uses MockAdapter for compile-only mode (no database required).
 */

import { createMockAdapter } from '@dbsp/adapter-kysely';
import type { ResolvedSchema } from '@dbsp/core';
import {
	and,
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromSchema,
	createOrm,
	type Dump,
	distinct as distinctField,
	eq,
	exists,
	gt,
	gte,
	type IncludeOptions,
	type IncludeOptionsWithRecursive,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	type MutationDump,
	neq,
	notExists,
	rangeContainedBy,
	rangeContains,
	rangeOverlaps,
	type ScalarSubqueryIntent,
	type WhereIntent,
	type WhereRelationFilterIntent,
	type WhereSubqueryIntent,
} from '@dbsp/core';
import type {
	ParsedAggregate,
	ParsedInclude,
	ParsedQuery,
	WhereClause,
} from './parser.js';
import type {
	AliasingMode,
	DialectMode,
	ExistenceCheck,
	IncludeStrategyMode,
	MutationValue,
	ParsedMutation,
	ParsedSubquery,
	SubqueryValue,
} from './types.js';

/**
 * Options for query execution
 */
export interface QueryExecutionOptions {
	/** Column aliasing mode for included relations (CLI-010) */
	aliasingMode?: AliasingMode;
	/** Include strategy for relations (CLI-011) */
	includeStrategy?: IncludeStrategyMode;
	/** SQL dialect for query compilation (CLI-011) */
	dialect?: DialectMode;
	/** Schema name for schema-scoped queries (CLI-021) */
	schemaName?: string;
}

/**
 * Separate include query for SEPARATE strategy relations
 */
export interface SeparateQuery {
	relation: string;
	sql: string;
	params: readonly unknown[];
}

/**
 * Result of query execution (compile-only mode)
 */
export interface QueryExecutionResult {
	sql: string;
	params: readonly unknown[];
	/** Additional queries for SEPARATE strategy relations (manyToMany, hasMany) */
	separateQueries?: SeparateQuery[];
	plan: {
		strategy: string;
		tables: string[];
		warnings: string[];
	};
	error?: string;
}

/**
 * CLI-MUT: Result of mutation execution (compile-only mode)
 */
export interface MutationExecutionResult {
	/** The mutation type that was executed */
	type: 'insert' | 'update' | 'delete' | 'upsert';
	/** Compiled SQL statement */
	sql: string;
	/** Bound parameters */
	params: readonly unknown[];
	/** Whether this is a dry-run (not executed) */
	dryRun: boolean;
	/** Number of rows affected (only if executed, else undefined) */
	rowsAffected?: number;
	/** Error message if compilation/execution failed */
	error?: string;
}

/**
 * CLI-015: Recursively collect all relation names from nested includes
 */
function collectAllRelations(includes: ParsedInclude[] | undefined): string[] {
	if (!includes || includes.length === 0) return [];

	const relations: string[] = [];
	for (const inc of includes) {
		relations.push(inc.relation);
		// Recursively collect nested relations
		if (inc.include && inc.include.length > 0) {
			relations.push(...collectAllRelations(inc.include));
		}
	}
	return relations;
}

/**
 * CLI-014: Build include options with optional where filter and nested includes
 */
function buildIncludeOptions(
	inc: ParsedInclude,
	schema: ResolvedSchema,
	currentTable: string,
): IncludeOptionsWithRecursive | undefined {
	let whereFilter: WhereIntent | undefined;
	let nestedIncludes: Array<{ relation: string } & IncludeOptions> | undefined;

	// Convert where clauses to filter
	if (inc.where && inc.where.length > 0) {
		const filters = inc.where.map((clause) =>
			whereClauseToFilter(clause, schema),
		);

		if (filters.length > 0) {
			if (filters.length === 1) {
				whereFilter = filters[0];
			} else {
				whereFilter = and(...filters) ?? undefined;
			}
		}
	}

	// Get target table for nested includes
	const qualifiedKey = `${currentTable}.${inc.relation}`;
	const relationDef =
		schema.relations[qualifiedKey] || schema.relations[inc.relation];
	const targetTable = relationDef?.target ?? inc.relation;

	// Convert nested includes recursively
	if (inc.include && inc.include.length > 0) {
		nestedIncludes = inc.include.map((nested) => {
			const nestedOptions = buildIncludeOptions(nested, schema, targetTable);
			return {
				relation: nested.relation,
				...nestedOptions,
			};
		});
	}

	// CLI-017: Handle recursive includes
	if (inc.recursive) {
		// Determine direction from relation type
		// hasMany/hasOne → descendants, belongsTo → ancestors
		const direction: 'ancestors' | 'descendants' =
			relationDef?.kind === 'belongsTo' ? 'ancestors' : 'descendants';

		return {
			recursive: true,
			direction,
			...(inc.maxDepth !== undefined && { maxDepth: inc.maxDepth }),
			...(inc.includeDepth && { includeDepth: true }),
			...(whereFilter && { where: whereFilter }),
			...(nestedIncludes && { include: nestedIncludes }),
		};
	}

	// Return options only if we have any
	if (!whereFilter && !nestedIncludes) {
		return undefined;
	}

	return {
		...(whereFilter && { where: whereFilter }),
		...(nestedIncludes && { include: nestedIncludes }),
	};
}

// =============================================================================
// CLI-NQL Block 9: Path Expression Resolution
// =============================================================================

/**
 * CLI-NQL Block 9: Check if a column is a path expression (contains dots).
 * A path like "category.parent.name" indicates relation traversal.
 * Note: Quoted identifiers (e.g., "table"."column") would contain dots too,
 * but the parser resolves those already, so here we detect unquoted paths.
 */
function isPathExpression(column: string): boolean {
	// Simple check: contains dot and doesn't start/end with quotes
	// More complex quoted identifier handling could be added if needed
	return column.includes('.') && !column.startsWith('"');
}

/**
 * CLI-NQL Block 9: Parse path segments from a column string.
 * "category.parent.name" → ["category", "parent", "name"]
 */
function parsePathSegments(column: string): string[] {
	return column.split('.');
}

/**
 * CLI-NQL Block 9: Create a simple comparison filter for the final column.
 */
function createComparisonFilter(
	field: string,
	operator: WhereClause['operator'],
	value: unknown,
): WhereIntent {
	switch (operator) {
		case '=':
			return eq(field, value);
		case '!=':
			return neq(field, value);
		case '>':
			return gt(field, value as number);
		case '<':
			return lt(field, value as number);
		case '>=':
			return gte(field, value as number);
		case '<=':
			return lte(field, value as number);
		case 'like':
			return like(field, value as string);
		case 'is':
			if (value === null) {
				return isNull(field);
			}
			return isNotNull(field);
		case 'in':
			// CLI-NQL Block 10: IN with array of values
			if (Array.isArray(value)) {
				return inArray(field, value);
			}
			// Subquery case handled separately
			return eq(field, value);
		case 'not in':
			// CLI-NQL Block 10: NOT IN - for simple values, convert to neq
			// Subquery case handled separately
			return neq(field, value);
		case 'overlaps':
			return rangeOverlaps(field, value as { lower: unknown; upper: unknown });
		case 'contains':
			return rangeContains(field, value);
		case 'containedBy':
			return rangeContainedBy(
				field,
				value as { lower: unknown; upper: unknown },
			);
		default:
			throw new Error(`Unsupported operator: ${operator}`);
	}
}

/**
 * CLI-NQL Block 9: Convert a path-based WHERE clause to nested relationFilter.
 *
 * Example: "category.parent.name = 'X'" becomes:
 * {
 *   kind: 'relationFilter',
 *   relation: 'category',
 *   mode: 'some',
 *   where: {
 *     kind: 'relationFilter',
 *     relation: 'parent',
 *     mode: 'some',
 *     where: { kind: 'comparison', field: 'name', operator: 'eq', value: 'X' }
 *   }
 * }
 *
 * This generates N-level JOINs in the SQL compiler.
 */
function pathToRelationFilter(
	clause: WhereClause,
	_schema: ResolvedSchema,
): WhereIntent {
	const segments = parsePathSegments(clause.column);

	if (segments.length < 2) {
		// Not a path, just a simple column - shouldn't happen since we check isPathExpression first
		return createComparisonFilter(clause.column, clause.operator, clause.value);
	}

	// Last segment is the field to compare (guaranteed to exist since length >= 2)
	const fieldName = segments[segments.length - 1] as string;
	// All segments except last are relations to traverse
	const relations = segments.slice(0, -1);

	// Create the innermost comparison
	let currentFilter: WhereIntent = createComparisonFilter(
		fieldName,
		clause.operator,
		clause.value,
	);

	// Wrap in relationFilter from inside out (reverse order)
	for (let i = relations.length - 1; i >= 0; i--) {
		const relationName = relations[i] as string;
		const relationFilter: WhereRelationFilterIntent = {
			kind: 'relationFilter',
			relation: relationName,
			where: currentFilter,
			mode: 'some',
		};
		currentFilter = relationFilter;
	}

	return currentFilter;
}

// =============================================================================
// CLI-NQL Block 10: Subquery Support
// =============================================================================

/**
 * CLI-NQL Block 10: Type guard to check if a value is a SubqueryValue.
 * SubqueryValue has `type: 'subquery'` and a `subquery` property.
 */
function isSubqueryValue(value: unknown): value is SubqueryValue {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		(value as { type: unknown }).type === 'subquery' &&
		'subquery' in value
	);
}

/**
 * CLI-NQL Block 10: Convert a ParsedSubquery to ScalarSubqueryIntent.
 * This creates the intent structure needed by the planner/compiler.
 */
function parsedSubqueryToIntent(subq: ParsedSubquery): ScalarSubqueryIntent {
	// Build WHERE filter if present
	let whereFilter: WhereIntent | undefined;
	if (subq.where && subq.where.length > 0) {
		const filters = subq.where.map((clause) =>
			createComparisonFilter(
				clause.column,
				clause.operator as WhereClause['operator'],
				clause.value,
			),
		);
		whereFilter = filters.length === 1 ? filters[0] : and(filters);
	}

	// Build intent with optional where
	const intent: ScalarSubqueryIntent = whereFilter
		? {
				from: subq.table,
				select: subq.selectColumn ?? 'id',
				where: whereFilter,
			}
		: {
				from: subq.table,
				select: subq.selectColumn ?? 'id',
			};

	return intent;
}

/**
 * CLI-NQL Block 10: Create a WhereSubqueryIntent for scalar subquery comparison.
 * Example: `categoryId = (categories where name = 'X')` generates:
 * { kind: 'subquery', field: 'categoryId', operator: 'eq', subquery: {...} }
 */
function subqueryToWhereIntent(
	field: string,
	operator: WhereClause['operator'],
	subq: ParsedSubquery,
): WhereSubqueryIntent {
	// Map parsed operator to comparison operator
	const opMap: Record<string, 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'> = {
		'=': 'eq',
		'!=': 'neq',
		'>': 'gt',
		'>=': 'gte',
		'<': 'lt',
		'<=': 'lte',
	};

	const comparisonOp = opMap[operator] ?? 'eq';

	return {
		kind: 'subquery',
		field,
		operator: comparisonOp,
		subquery: parsedSubqueryToIntent(subq),
	};
}

/**
 * CLI-NQL Block 10: Convert an ExistenceCheck to WhereIntent.
 * Generates EXISTS or NOT EXISTS subquery.
 */
function existenceCheckToIntent(
	check: ExistenceCheck,
): WhereIntent {
	// Build optional WHERE filter for the existence check
	let whereFilter: WhereIntent | undefined;
	if (check.where && check.where.length > 0) {
		const filters = check.where.map((clause) =>
			createComparisonFilter(
				clause.column,
				clause.operator as WhereClause['operator'],
				clause.value,
			),
		);
		whereFilter = filters.length === 1 ? filters[0] : and(filters);
	}

	// Use exists/notExists helper from core
	if (check.type === 'exists') {
		return exists(check.relation, whereFilter ? { where: whereFilter } : undefined);
	}
	return notExists(check.relation, whereFilter ? { where: whereFilter } : undefined);
}

/**
 * Convert a WhereClause to a filter expression for the ORM.
 * CLI-NQL Block 9: Supports path expressions for N-level JOINs.
 * CLI-NQL Block 10: Supports subquery values in comparisons.
 */
function whereClauseToFilter(
	clause: WhereClause,
	schema?: ResolvedSchema,
): WhereIntent {
	const { column, value, operator } = clause;

	// CLI-NQL Block 10: Check for subquery values
	// Subqueries can appear in scalar comparisons (=, !=, etc.) or IN/NOT IN
	if (isSubqueryValue(value)) {
		return subqueryToWhereIntent(column, operator, value.subquery);
	}

	// CLI-NQL Block 9: Check for path expressions (e.g., "category.parent.name")
	// Path expressions generate nested relationFilter intents for N-level JOINs
	if (schema && isPathExpression(column)) {
		return pathToRelationFilter(clause, schema);
	}

	// Simple column - use direct comparison
	return createComparisonFilter(column, operator, value);
}

/**
 * CLI-016: Apply aggregate to query builder
 * Uses generic type to match QueryBuilder interface
 */
// biome-ignore lint/suspicious/noExplicitAny: QueryBuilder type is complex and context-dependent
function applyAggregate(builder: any, agg: ParsedAggregate): any {
	const { function: func, field, as: alias, distinct } = agg;

	// For distinct aggregates, use the distinctField helper
	const fieldArg = distinct && field ? distinctField(field) : field;

	switch (func) {
		case 'count':
			// count() or count(field) or count(distinct field)
			if (fieldArg) {
				return builder.count(fieldArg, alias);
			}
			return builder.count(alias ? { as: alias } : undefined);
		case 'sum':
			if (!field) throw new Error('SUM requires a field');
			return builder.sum(fieldArg as string, alias);
		case 'avg':
			if (!field) throw new Error('AVG requires a field');
			return builder.avg(fieldArg as string, alias);
		case 'min':
			if (!field) throw new Error('MIN requires a field');
			return builder.min(field, alias);
		case 'max':
			if (!field) throw new Error('MAX requires a field');
			return builder.max(field, alias);
		default:
			throw new Error(`Unknown aggregate function: ${func}`);
	}
}

/**
 * Execute a parsed query using the real semantic planner.
 * Returns SQL and plan without actually executing against a database.
 */
export function executeQuery(
	query: ParsedQuery,
	schema: ResolvedSchema,
	options?: QueryExecutionOptions,
): QueryExecutionResult {
	try {
		// Create ORM with MockAdapter (compile-only)
		// CORE-005: Use safe converter with Valibot validation
		const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
		// Build model from schema and use model-based createOrm overload
		const model = buildModelFromSchema(generatedSchema);
		// Use Record<string, unknown> as DB type since tables are dynamic from user input
		// CLI-010: Pass aliasing mode to MockAdapter
		// CLI-011: Pass include strategy to ORM and dialect to MockAdapter
		// Keep adapter reference to compile separate include queries
		// Note: DuckDB uses PostgreSQL syntax in Kysely, map accordingly
		const dialectToMock = (d: DialectMode | undefined) => {
			if (!d || d === 'postgresql' || d === 'duckdb') return 'postgresql';
			if (d === 'mysql') return 'mysql';
			if (d === 'sqlite') return 'sqlite';
			if (d === 'mssql') return 'mssql';
			return 'postgresql';
		};
		const adapter = createMockAdapter({
			dialect: dialectToMock(options?.dialect),
			aliasIncludedColumns: options?.aliasingMode ?? 'always',
		});
		// CLI-011: 'auto' means let the planner decide (don't force a strategy)
		const strategyToUse =
			options?.includeStrategy === 'auto'
				? undefined
				: options?.includeStrategy;
		const baseOrm = createOrm<Record<string, unknown>>({
			model,
			adapter,
			...(strategyToUse && { defaultIncludeStrategy: strategyToUse }),
		});

		// CLI-021: Apply schema scoping if configured
		const orm = options?.schemaName
			? baseOrm.withSchema(options.schemaName)
			: baseOrm;

		// Start building the query (table name comes from user input)
		let builder = orm.select(query.table);

		// Add where clauses
		if (query.where && query.where.length > 0) {
			for (const clause of query.where) {
				const filter = whereClauseToFilter(clause, schema);
				builder = builder.where(filter);
			}
		}

		// CLI-NQL Block 10: Add existence checks (has/not has)
		if (query.existenceChecks && query.existenceChecks.length > 0) {
			for (const check of query.existenceChecks) {
				const filter = existenceCheckToIntent(check);
				builder = builder.where(filter);
			}
		}

		// Add includes (CLI-014: with optional where filters)
		if (query.include && query.include.length > 0) {
			for (const inc of query.include) {
				// CLI-014: Build include options with where filter if present
				const includeOptions = buildIncludeOptions(inc, schema, query.table);
				builder = builder.include(inc.relation, includeOptions);
			}
		}

		// CLI-016: Add aggregates
		if (query.aggregates && query.aggregates.length > 0) {
			for (const agg of query.aggregates) {
				builder = applyAggregate(builder, agg);
			}
		}

		// CLI-016: Add group by
		if (query.groupBy && query.groupBy.length > 0) {
			builder = builder.groupBy(query.groupBy);
		}

		// CLI-016: Add having
		if (query.having && query.having.length > 0) {
			for (const clause of query.having) {
				const filter = whereClauseToFilter(clause, schema);
				builder = builder.having(filter);
			}
		}

		// CLI-016: Add distinct
		if (query.distinct) {
			builder = builder.distinct();
		}

		// Add order by
		if (query.orderBy && query.orderBy.length > 0) {
			for (const order of query.orderBy) {
				builder = builder.orderBy(order.column, order.direction);
			}
		}

		// Add limit
		if (query.limit !== undefined) {
			builder = builder.limit(query.limit);
		}

		// Add offset
		if (query.offset !== undefined) {
			builder = builder.offset(query.offset);
		}

		// Get the dump (compiled SQL + plan)
		const dump: Dump = builder.dump();

		// Collect warnings from planner
		const warnings = dump.plan.warnings.map((w) => w.message);

		// Compile separate include queries if any
		const separateQueries: SeparateQuery[] = [];

		// Use compileWithIncludes to get separate include metadata
		const compileResult = adapter.compileWithIncludes(dump.plan, { model });

		if (compileResult.separateIncludes.length > 0) {
			const relations = compileResult.separateIncludes
				.map((info) => info.relationName)
				.join(', ');
			warnings.push(
				`Relation(s) [${relations}] use SEPARATE query strategy (to-many).`,
			);

			// Compile each separate include with sample parent IDs
			const sampleParentIds = [1, 2, 3]; // Example IDs for SQL preview
			for (const info of compileResult.separateIncludes) {
				const compiled = adapter.compileSeparateInclude(info, sampleParentIds);
				separateQueries.push({
					relation: info.relationName,
					sql: compiled.sql,
					params: compiled.parameters,
				});
			}
		}

		return {
			sql: dump.sql,
			params: dump.params,
			...(separateQueries.length > 0 && { separateQueries }),
			plan: {
				strategy: dump.plan.decisions
					.map((d) => `${d.type}: ${d.choice}`)
					.join(', '),
				// CLI-015: Recursively extract all relation names including nested
				tables: [query.table, ...collectAllRelations(query.include)],
				warnings,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			sql: '',
			params: [],
			plan: {
				strategy: 'ERROR',
				tables: [],
				warnings: [],
			},
			error: message,
		};
	}
}

/**
 * Format a query execution result for display
 */
export function formatExecutionResult(result: QueryExecutionResult): string {
	if (result.error) {
		return `Error: ${result.error}`;
	}

	const lines: string[] = [];

	// Main SQL
	lines.push('Main SQL:');
	lines.push(result.sql);
	lines.push('');

	// Main Parameters
	if (result.params.length > 0) {
		lines.push(
			`Parameters: [${result.params.map((p) => JSON.stringify(p)).join(', ')}]`,
		);
		lines.push('');
	}

	// Separate Include Queries (SEPARATE strategy)
	if (result.separateQueries && result.separateQueries.length > 0) {
		for (const sq of result.separateQueries) {
			lines.push(`Separate Query (${sq.relation}):`);
			lines.push(sq.sql);
			if (sq.params.length > 0) {
				lines.push(
					`  Parameters: [${sq.params.map((p) => JSON.stringify(p)).join(', ')}]`,
				);
			}
			lines.push('');
		}
	}

	// Plan
	if (result.plan.strategy) {
		lines.push('Plan:');
		lines.push(`  Strategy: ${result.plan.strategy}`);
		if (result.plan.tables.length > 0) {
			lines.push(`  Tables: ${result.plan.tables.join(', ')}`);
		}
		if (result.plan.warnings.length > 0) {
			lines.push('  Warnings:');
			for (const w of result.plan.warnings) {
				lines.push(`    - ${w}`);
			}
		}
	}

	return lines.join('\n');
}

/**
 * CLI-MUT: Convert assignments to values object for INSERT/UPDATE/UPSERT
 */
function assignmentsToValues(
	assignments: Array<{ column: string; value: { value: unknown } }>,
): Record<string, unknown> {
	const values: Record<string, unknown> = {};
	for (const a of assignments) {
		values[a.column] = a.value.value;
	}
	return values;
}


/**
 * CLI-NQL Block 11: Build INSERT FROM SQL (SC-12 to SC-14)
 *
 * Handles two cases:
 * 1. Non-bulk (FK lookup): INSERT with scalar subquery
 *    Example: products insert title = 'Phone', categoryId = id from categories where name = 'X'
 *    SQL: INSERT INTO products (title, "categoryId") VALUES ('Phone', (SELECT id FROM categories WHERE name = $1))
 *
 * 2. Bulk: INSERT...SELECT
 *    Example: products insert title = name, categoryId = cat_id from each source_data where active = true
 *    SQL: INSERT INTO products (title, "categoryId") SELECT name, cat_id FROM source_data WHERE active = true
 */
function buildInsertFromSql(
	mutation: ParsedMutation,
	schemaName?: string,
): { sql: string; params: unknown[] } {
	const fromClause = mutation.fromClause!;
	const assignments = mutation.assignments!;
	const params: unknown[] = [];

	// Build column list
	const columns = assignments.map((a) => `"${a.column}"`).join(', ');
	const tableName = schemaName
		? `"${schemaName}"."${mutation.table}"`
		: `"${mutation.table}"`;
	const sourceTable = schemaName
		? `"${schemaName}"."${fromClause.table}"`
		: `"${fromClause.table}"`;

	// Helper: check if value is a column reference (unquoted identifier in raw)
	const isColumnRef = (val: MutationValue): boolean => {
		const raw = val.raw.trim();
		// If raw doesn't start with quotes and looks like an identifier, it's a column ref
		return (
			val.type === 'string' &&
			!raw.startsWith('"') &&
			!raw.startsWith("'") &&
			/^[a-z_][a-z0-9_]*$/i.test(raw)
		);
	};

	if (fromClause.bulk) {
		// SC-14: Bulk INSERT...SELECT
		// INSERT INTO target (cols) SELECT (exprs) FROM source WHERE ...
		const selectExprs = assignments.map((a) => {
			const val = a.value;
			// If it's an unquoted identifier, treat as column reference
			if (isColumnRef(val)) {
				return `"${val.value}"`;
			}
			// Otherwise it's a literal
			params.push(val.value);
			return `$${params.length}`;
		}).join(', ');

		let sql = `INSERT INTO ${tableName} (${columns}) SELECT ${selectExprs} FROM ${sourceTable}`;

		// Add WHERE clause
		if (fromClause.where && fromClause.where.length > 0) {
			const whereClauses = fromClause.where.map((w) => {
				params.push(w.value);
				return `"${w.column}" ${w.operator} $${params.length}`;
			});
			sql += ` WHERE ${whereClauses.join(' AND ')}`;
		}

		return { sql, params };
	}

	// SC-12, SC-13: Non-bulk (scalar subquery for FK lookup)
	// INSERT INTO target (cols) VALUES (literal, (SELECT col FROM source WHERE ...))
	const valueExprs = assignments.map((a) => {
		const val = a.value;
		// If it's an unquoted identifier, treat as column reference from source
		if (isColumnRef(val)) {
			// Build scalar subquery
			let subquery = `SELECT "${val.value}" FROM ${sourceTable}`;

			if (fromClause.where && fromClause.where.length > 0) {
				const whereClauses = fromClause.where.map((w) => {
					params.push(w.value);
					return `"${w.column}" ${w.operator} $${params.length}`;
				});
				subquery += ` WHERE ${whereClauses.join(' AND ')}`;
			}

			// SC-13: Add FOR UPDATE clause
			if (fromClause.forUpdate) {
				subquery += ' FOR UPDATE';
				if (fromClause.skipLocked) {
					subquery += ' SKIP LOCKED';
				}
			}

			return `(${subquery})`;
		}
		// Literal value
		params.push(val.value);
		return `$${params.length}`;
	}).join(', ');

	const sql = `INSERT INTO ${tableName} (${columns}) VALUES (${valueExprs})`;
	return { sql, params };
}

/**
 * CLI-MUT: Execute a mutation (INSERT/UPDATE/DELETE/UPSERT)
 *
 * Compiles the mutation to SQL using the ORM. Does not actually execute
 * against a database unless explicitly requested.
 */
export function executeMutation(
	mutation: ParsedMutation,
	schema: ResolvedSchema,
	options?: QueryExecutionOptions,
): MutationExecutionResult {
	try {
		// Create ORM with MockAdapter (compile-only) - same setup as executeQuery
		const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
		const model = buildModelFromSchema(generatedSchema);

		const dialectToMock = (d: DialectMode | undefined) => {
			if (!d || d === 'postgresql' || d === 'duckdb') return 'postgresql';
			if (d === 'mysql') return 'mysql';
			if (d === 'sqlite') return 'sqlite';
			if (d === 'mssql') return 'mssql';
			return 'postgresql';
		};

		const adapter = createMockAdapter({
			dialect: dialectToMock(options?.dialect),
			aliasIncludedColumns: options?.aliasingMode ?? 'always',
		});

		const baseOrm = createOrm<Record<string, unknown>>({
			model,
			adapter,
		});

		// CLI-021: Apply schema scoping if configured
		const orm = options?.schemaName
			? baseOrm.withSchema(options.schemaName)
			: baseOrm;

		let dump: MutationDump;

		switch (mutation.type) {
			case 'insert': {
				if (!mutation.assignments || mutation.assignments.length === 0) {
					return {
						type: 'insert',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'INSERT requires at least one assignment',
					};
				}

				// CLI-NQL Block 11: Handle INSERT FROM clause (SC-12 to SC-14)
				if (mutation.fromClause) {
					const { sql, params } = buildInsertFromSql(
						mutation,
						options?.schemaName,
					);
					return {
						type: 'insert',
						sql,
						params,
						dryRun: !mutation.executeImmediate,
					};
				}

				const values = assignmentsToValues(mutation.assignments);
				dump = orm.insert(mutation.table).values(values).dump();
				break;
			}

			case 'update': {
				if (!mutation.assignments || mutation.assignments.length === 0) {
					return {
						type: 'update',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'UPDATE requires at least one SET assignment',
					};
				}
				if (!mutation.where || mutation.where.length === 0) {
					return {
						type: 'update',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'UPDATE requires WHERE clause for safety',
					};
				}
				const setValues = assignmentsToValues(mutation.assignments);
				let updateBuilder = orm.update(mutation.table).set(setValues);
				for (const clause of mutation.where) {
					const filter = whereClauseToFilter(clause, schema);
					updateBuilder = updateBuilder.where(filter);
				}
				dump = updateBuilder.dump();
				break;
			}

			case 'delete': {
				if (!mutation.where || mutation.where.length === 0) {
					return {
						type: 'delete',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'DELETE requires WHERE clause for safety',
					};
				}
				let deleteBuilder = orm.delete(mutation.table);
				for (const clause of mutation.where) {
					const filter = whereClauseToFilter(clause, schema);
					deleteBuilder = deleteBuilder.where(filter);
				}
				dump = deleteBuilder.dump();
				break;
			}

			case 'upsert': {
				if (!mutation.assignments || mutation.assignments.length === 0) {
					return {
						type: 'upsert',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'UPSERT requires at least one assignment',
					};
				}
				if (!mutation.onConflict) {
					return {
						type: 'upsert',
						sql: '',
						params: [],
						dryRun: !mutation.executeImmediate,
						error: 'UPSERT requires ON CONFLICT clause',
					};
				}
				const values = assignmentsToValues(mutation.assignments);
				let upsertBuilder = orm
					.upsert(mutation.table)
					.values(values)
					.onConflict(mutation.onConflict.columns);

				if (mutation.onConflict.action === 'nothing') {
					upsertBuilder = upsertBuilder.doNothing();
				} else if (mutation.onConflict.action === 'update') {
					if (
						mutation.onConflict.updateAssignments &&
						mutation.onConflict.updateAssignments.length > 0
					) {
						const updateValues = assignmentsToValues(
							mutation.onConflict.updateAssignments,
						);
						upsertBuilder = upsertBuilder.doUpdate(updateValues);
					} else {
						// Default: update all inserted values
						upsertBuilder = upsertBuilder.doUpdate(values);
					}
				}
				dump = upsertBuilder.dump();
				break;
			}

			default: {
				const _exhaustive: never = mutation.type;
				return {
					type: mutation.type,
					sql: '',
					params: [],
					dryRun: true,
					error: `Unknown mutation type: ${_exhaustive}`,
				};
			}
		}

		return {
			type: mutation.type,
			sql: dump.sql,
			params: dump.parameters,
			dryRun: !mutation.executeImmediate,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			type: mutation.type,
			sql: '',
			params: [],
			dryRun: !mutation.executeImmediate,
			error: message,
		};
	}
}

/**
 * CLI-MUT: Format a mutation execution result for display
 */
export function formatMutationResult(result: MutationExecutionResult): string {
	if (result.error) {
		return `Error: ${result.error}`;
	}

	const lines: string[] = [];

	// Dry-run indicator
	if (result.dryRun) {
		lines.push(`[DRY-RUN] ${result.type.toUpperCase()} (add ! to execute)`);
	} else {
		lines.push(`[EXECUTED] ${result.type.toUpperCase()}`);
		if (result.rowsAffected !== undefined) {
			lines.push(`Rows affected: ${result.rowsAffected}`);
		}
	}
	lines.push('');

	// SQL
	lines.push('SQL:');
	lines.push(result.sql);
	lines.push('');

	// Parameters
	if (result.params.length > 0) {
		lines.push(
			`Parameters: [${result.params.map((p) => JSON.stringify(p)).join(', ')}]`,
		);
	}

	return lines.join('\n');
}
