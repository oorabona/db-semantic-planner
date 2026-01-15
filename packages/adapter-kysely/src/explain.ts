/**
 * @module explain
 * EXPLAIN/ANALYZE support for query plan analysis.
 * ADAPTER-004: Enhanced Observability
 * DIALECT-001: Multi-dialect EXPLAIN syntax
 */

import { CompiledQuery, type Kysely } from 'kysely';
import { type DialectName, detectDialect } from './dialect.js';
import type { ExplainOptions, ExplainResult } from './types.js';

/**
 * Build EXPLAIN SQL prefix based on options and dialect.
 */
function buildExplainPrefix(
	options: ExplainOptions,
	dialect: DialectName,
): string {
	switch (dialect) {
		case 'postgresql':
			return buildPostgresExplainPrefix(options);
		case 'mysql':
			return buildMysqlExplainPrefix(options);
		case 'sqlite':
			return buildSqliteExplainPrefix(options);
		default:
			// Default to PostgreSQL syntax for unknown dialects
			return buildPostgresExplainPrefix(options);
	}
}

/**
 * Build PostgreSQL EXPLAIN prefix.
 * Syntax: EXPLAIN [(option, ...)] statement
 */
function buildPostgresExplainPrefix(options: ExplainOptions): string {
	const parts: string[] = ['EXPLAIN'];
	const optionClauses: string[] = [];

	if (options.analyze) {
		optionClauses.push('ANALYZE');
	}

	if (options.format && options.format !== 'text') {
		optionClauses.push(`FORMAT ${options.format.toUpperCase()}`);
	}

	if (options.costs === false) {
		optionClauses.push('COSTS OFF');
	}

	if (options.buffers) {
		optionClauses.push('BUFFERS');
	}

	if (options.analyze && options.timing === false) {
		optionClauses.push('TIMING OFF');
	}

	if (optionClauses.length > 0) {
		parts.push(`(${optionClauses.join(', ')})`);
	}

	return parts.join(' ');
}

/**
 * Build MySQL EXPLAIN prefix.
 * Syntax: EXPLAIN [FORMAT=format_type] statement
 * Note: MySQL's EXPLAIN doesn't support ANALYZE as an option like PostgreSQL.
 *       MySQL 8.0.18+ has EXPLAIN ANALYZE but with different syntax.
 */
function buildMysqlExplainPrefix(options: ExplainOptions): string {
	const parts: string[] = ['EXPLAIN'];

	// MySQL 8.0.18+ supports EXPLAIN ANALYZE but it works differently
	if (options.analyze) {
		parts.push('ANALYZE');
	}

	if (options.format && options.format !== 'text') {
		// MySQL uses FORMAT=JSON syntax (no space after FORMAT)
		parts.push(`FORMAT=${options.format.toUpperCase()}`);
	}

	return parts.join(' ');
}

/**
 * Build SQLite EXPLAIN prefix.
 * Syntax: EXPLAIN QUERY PLAN statement
 * Note: SQLite doesn't support ANALYZE as part of EXPLAIN.
 *       SQLite returns a simpler tree structure, not JSON.
 */
function buildSqliteExplainPrefix(_options: ExplainOptions): string {
	// SQLite only has EXPLAIN and EXPLAIN QUERY PLAN
	// EXPLAIN shows VM opcodes, EXPLAIN QUERY PLAN shows query plan
	// For our purposes, EXPLAIN QUERY PLAN is more useful
	return 'EXPLAIN QUERY PLAN';
}

/**
 * Parse execution time from EXPLAIN ANALYZE JSON output.
 */
function parseExecutionTime(jsonPlan: unknown): number | undefined {
	if (
		Array.isArray(jsonPlan) &&
		jsonPlan.length > 0 &&
		typeof jsonPlan[0] === 'object' &&
		jsonPlan[0] !== null
	) {
		const plan = jsonPlan[0] as Record<string, unknown>;
		if (typeof plan['Execution Time'] === 'number') {
			return plan['Execution Time'];
		}
	}
	return undefined;
}

/**
 * Run EXPLAIN on a compiled query to get the execution plan.
 *
 * @param compiled - The compiled query from Kysely
 * @param db - Kysely database instance
 * @param options - EXPLAIN options
 * @returns ExplainResult with the query plan
 *
 * @example
 * ```typescript
 * import { compile, explain } from '@dbsp/adapter-kysely';
 *
 * const compiled = compile(planReport, model, db);
 *
 * // Basic EXPLAIN (no execution)
 * const result = await explain(compiled, db);
 * console.log(result.plan);
 *
 * // EXPLAIN ANALYZE (executes the query!)
 * const analyzed = await explain(compiled, db, { analyze: true });
 * console.log(analyzed.executionTime); // ms
 *
 * // JSON format for programmatic access
 * const json = await explain(compiled, db, { format: 'json' });
 * console.log(json.jsonPlan);
 * ```
 *
 * @warning
 * When using `analyze: true`, the query WILL be executed, including any
 * side effects from INSERT, UPDATE, or DELETE statements. Use with caution
 * on write operations.
 */
export async function explain(
	compiled: CompiledQuery,
	// biome-ignore lint/suspicious/noExplicitAny: Kysely generic requires any for database schema
	db: Kysely<any>,
	options: ExplainOptions = {},
): Promise<ExplainResult> {
	// Detect dialect for appropriate EXPLAIN syntax
	const dialect = detectDialect(db);
	const prefix = buildExplainPrefix(options, dialect);

	// Build EXPLAIN query by prepending prefix to the compiled query
	const explainSql = `${prefix} ${compiled.sql}`;

	// Create a new CompiledQuery using the factory method
	const explainQuery = CompiledQuery.raw(
		explainSql,
		compiled.parameters as unknown[],
	);

	const result = await db.executeQuery(explainQuery);
	const resultRows = result.rows as Record<string, unknown>[];

	// Format the output based on the requested format
	if (options.format === 'json') {
		// PostgreSQL returns JSON as a single row with 'QUERY PLAN' column
		let jsonPlan: unknown;

		if (resultRows.length > 0) {
			const firstRow = resultRows[0];
			if (firstRow && typeof firstRow === 'object') {
				// PostgreSQL wraps JSON in 'QUERY PLAN' column
				const planColumn = firstRow['QUERY PLAN'] ?? firstRow['query plan'];
				if (planColumn !== undefined) {
					jsonPlan =
						typeof planColumn === 'string'
							? JSON.parse(planColumn)
							: planColumn;
				} else {
					// Some dialects might return the plan directly
					jsonPlan = resultRows;
				}
			}
		}

		const executionTime = options.analyze
			? parseExecutionTime(jsonPlan)
			: undefined;

		// Build result with optional executionTime
		const baseResult: ExplainResult = {
			plan: JSON.stringify(jsonPlan, null, 2),
			jsonPlan,
			options,
		};

		if (executionTime !== undefined) {
			return { ...baseResult, executionTime };
		}
		return baseResult;
	}

	// For text format, concatenate all rows
	const planLines = resultRows.map((row) => {
		if (row && typeof row === 'object') {
			// PostgreSQL returns 'QUERY PLAN' column
			const planColumn = row['QUERY PLAN'] ?? row['query plan'] ?? '';
			return String(planColumn);
		}
		return String(row ?? '');
	});

	return {
		plan: planLines.join('\n'),
		options,
	};
}
