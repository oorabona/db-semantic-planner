/**
 * DX-030: Query Executor using real semantic planner
 *
 * Converts ParsedQuery to ORM API calls and returns the compiled SQL.
 * Uses MockAdapter for compile-only mode (no database required).
 */

import { createMockAdapter } from '@db-semantic-planner/adapter-kysely';
import {
	assertResolvedSchemaToGeneratedSchema,
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

/**
 * Result of query execution (compile-only mode)
 */
export interface QueryExecutionResult {
	sql: string;
	params: readonly unknown[];
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
): QueryExecutionResult {
	try {
		// Create ORM with MockAdapter (compile-only)
		// CORE-005: Use safe converter with Valibot validation
		const generatedSchema = assertResolvedSchemaToGeneratedSchema(schema);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const orm = createOrm<any>({
			schema: generatedSchema,
			adapter: createMockAdapter(),
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

		return {
			sql: dump.sql,
			params: dump.params,
			plan: {
				strategy: dump.plan.decisions
					.map((d) => `${d.type}: ${d.choice}`)
					.join(', '),
				tables: [query.table, ...(query.include ?? [])],
				warnings: dump.plan.warnings.map((w) => w.message),
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

	// SQL
	lines.push('SQL:');
	lines.push(result.sql);
	lines.push('');

	// Parameters
	if (result.params.length > 0) {
		lines.push(
			`Parameters: [${result.params.map((p) => JSON.stringify(p)).join(', ')}]`,
		);
		lines.push('');
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
