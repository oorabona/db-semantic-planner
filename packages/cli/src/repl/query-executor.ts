/**
 * DX-030: Query Executor using real semantic planner
 *
 * Converts ParsedQuery to ORM API calls and returns the compiled SQL.
 * Uses MockAdapter for compile-only mode (no database required).
 */

import { createMockAdapter } from '@db-semantic-planner/adapter-kysely';
import {
	assertResolvedSchemaToGeneratedSchema,
	buildModelFromSchema,
	createOrm,
	type Dump,
	eq,
	gt,
	gte,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	neq,
} from '@db-semantic-planner/core';
import type { ResolvedSchema } from '@db-semantic-planner/schema';
import type { ParsedQuery, WhereClause } from './parser.js';
import type {
	AliasingMode,
	DialectMode,
	IncludeStrategyMode,
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
 * Convert a WhereClause to a filter expression for the ORM
 */
function whereClauseToFilter(clause: WhereClause) {
	const { column, operator, value } = clause;

	switch (operator) {
		case '=':
			return eq(column, value);
		case '!=':
			return neq(column, value);
		case '>':
			return gt(column, value as number);
		case '<':
			return lt(column, value as number);
		case '>=':
			return gte(column, value as number);
		case '<=':
			return lte(column, value as number);
		case 'like':
			return like(column, value as string);
		case 'is':
			// "is null" or "is not null"
			if (value === null) {
				return isNull(column);
			}
			return isNotNull(column);
		case 'in':
			// For 'in' operator, we need inArray - but for simplicity,
			// we'll use eq for single values for now
			return eq(column, value);
		default:
			throw new Error(`Unsupported operator: ${operator}`);
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
		const orm = createOrm<Record<string, unknown>>({
			model,
			adapter,
			...(strategyToUse && { defaultIncludeStrategy: strategyToUse }),
		});

		// Start building the query (table name comes from user input)
		let builder = orm.select(query.table);

		// Add where clauses
		if (query.where && query.where.length > 0) {
			for (const clause of query.where) {
				const filter = whereClauseToFilter(clause);
				builder = builder.where(filter);
			}
		}

		// Add includes
		if (query.include && query.include.length > 0) {
			for (const rel of query.include) {
				// Parse relation path (e.g., "posts.author" -> table "posts", relation "author")
				// For now, we assume simple relation names from the source table
				builder = builder.include(rel);
			}
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
				tables: [query.table, ...(query.include ?? [])],
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
